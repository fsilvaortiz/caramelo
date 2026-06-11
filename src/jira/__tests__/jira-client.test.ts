import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JiraClient } from '../jira-client.js';

const ORIGINAL_FETCH = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0, shouldAdvanceTime: true });
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('JiraClient.getBoards', () => {
  it('throws a contextual error when response body is HTML (proxy/SSO page)', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(textResponse(200, '<html>SSO challenge</html>')),
    ) as unknown as typeof fetch;

    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
    await expect(client.getBoards()).rejects.toThrow(/non-JSON response/i);
  });

  it('throws when JSON does not contain a values array', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, {}))) as unknown as typeof fetch;
    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
    await expect(client.getBoards()).rejects.toThrow(/unexpected board list shape/i);
  });

  it('throws when values is null (observed in older Jira Server)', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { values: null })),
    ) as unknown as typeof fetch;
    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
    await expect(client.getBoards()).rejects.toThrow(/unexpected board list shape/i);
  });

  it('silently drops malformed board entries instead of crashing the whole call', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          values: [
            { id: 1, name: 'Good board', type: 'scrum' },
            { id: 2 /* missing name/type */ },
            null,
            { id: 3, name: 'Other', type: 'kanban' },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token');
    const boards = await client.getBoards();
    expect(boards).toEqual([
      { id: '1', name: 'Good board', type: 'scrum' },
      { id: '3', name: 'Other', type: 'kanban' },
    ]);
  });
});

describe('JiraClient.searchIssues — silent-catch fix (#15)', () => {
  it('throws with all endpoint failures listed when every fetch fails', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('/configuration')) {
        // No project key — keep the v2 fallback inert.
        return Promise.resolve(jsonResponse(200, { location: {} }));
      }
      return Promise.reject(new Error('ECONNRESET'));
    }) as unknown as typeof fetch;

    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
    await expect(client.searchIssues()).rejects.toThrow(/All board endpoints failed/);
    await expect(client.searchIssues()).rejects.toThrow(/ECONNRESET/);
  });

  it('returns issues when only one endpoint succeeds (no false alarms)', async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.includes('/configuration')) {
        return Promise.resolve(jsonResponse(200, { location: {} }));
      }
      if (url.includes('/backlog')) {
        return Promise.reject(new Error('backlog down'));
      }
      return Promise.resolve(
        jsonResponse(200, {
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 'foo',
                description: 'desc',
                status: { name: 'Open' },
                assignee: null,
              },
            },
          ],
          total: 1,
        }),
      );
    }) as unknown as typeof fetch;

    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
    const result = await client.searchIssues();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].key).toBe('PROJ-1');
  });
});

describe('Acceptance-criteria heuristic — ReDoS hardening (#16)', () => {
  it('does not hang on adversarial input with given/when but no then', async () => {
    // The previous regex with `s` flag and unbounded .* could backtrack
    // catastrophically here. Cap the assertion at 200ms.
    const adversarial = 'given a user when they do ' + 'x '.repeat(5000);
    global.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 'foo',
                description: adversarial,
                status: { name: 'Open' },
                assignee: null,
              },
            },
          ],
          total: 1,
        }),
      ),
    ) as unknown as typeof fetch;

    vi.useRealTimers();
    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
    const start = Date.now();
    const result = await client.searchIssues();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    // No real "then" in the input, so we should NOT have extracted criteria.
    expect(result.issues[0].acceptanceCriteria).toBe('');
  });

  it('still extracts an explicit "Acceptance Criteria" heading block', async () => {
    const desc = [
      'Some summary text.',
      '',
      'Acceptance Criteria:',
      '- user can log in',
      '- error message on bad password',
      '',
      '## Out of scope',
    ].join('\n');
    global.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 's',
                description: desc,
                status: { name: 'Open' },
                assignee: null,
              },
            },
          ],
          total: 1,
        }),
      ),
    ) as unknown as typeof fetch;

    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
    const result = await client.searchIssues();
    expect(result.issues[0].acceptanceCriteria).toMatch(/user can log in/);
  });

  it('extracts a complete given/when/then block', async () => {
    const desc = [
      'Some narrative.',
      '',
      'Given a logged-in user',
      'When they click delete',
      'Then a confirmation modal is shown',
    ].join('\n');
    global.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 's',
                description: desc,
                status: { name: 'Open' },
                assignee: null,
              },
            },
          ],
          total: 1,
        }),
      ),
    ) as unknown as typeof fetch;

    const client = new JiraClient('https://jira.example.com', 'a@b.com', 'token', '42');
    const result = await client.searchIssues();
    expect(result.issues[0].acceptanceCriteria).toMatch(/confirmation modal/);
  });
});
