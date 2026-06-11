import { log } from '../utils/log.js';

export interface JiraBoard {
  id: string;
  name: string;
  type: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
  assignee: string;
  comments: string[];
  url: string;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  hasMore: boolean;
}

type RawIssue = {
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string };
    assignee: { displayName: string } | null;
    comment?: { comments: Array<{ body: unknown }> };
  };
};

// Acceptance-criteria description payloads larger than this are not worth
// scanning byte-by-byte and historically have been the trigger for the
// ReDoS-prone Gherkin heuristic. Truncating bounds the regex work.
const AC_SCAN_MAX_CHARS = 16_000;

export class JiraClient {
  private readonly authHeader: string;

  constructor(
    private readonly instanceUrl: string,
    email: string,
    apiToken: string,
    private readonly boardId?: string
  ) {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.instanceUrl}/rest/api/3/myself`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getBoards(): Promise<JiraBoard[]> {
    const res = await fetch(`${this.instanceUrl}/rest/agile/1.0/board?maxResults=100`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Failed to fetch boards: ${res.status} ${res.statusText}`);
    const data = await safeJson(res, 'getBoards');
    const values = (data as { values?: unknown })?.values;
    if (!Array.isArray(values)) {
      throw new Error('Jira returned unexpected board list shape (no `values` array).');
    }
    const out: JiraBoard[] = [];
    for (const raw of values) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as { id?: unknown; name?: unknown; type?: unknown };
      if (b.id === undefined || typeof b.name !== 'string' || typeof b.type !== 'string') continue;
      out.push({ id: String(b.id), name: b.name, type: b.type });
    }
    return out;
  }

  async searchIssues(_query?: string, maxResults = 50, startAt = 0): Promise<JiraSearchResult> {
    if (!this.boardId) {
      throw new Error('No board configured');
    }

    // Fetch from both endpoints in parallel to get all issues
    const fields = 'summary,description,status,assignee,comment';
    const endpoints = [
      `${this.instanceUrl}/rest/agile/1.0/board/${this.boardId}/issue?maxResults=${maxResults}&startAt=${startAt}&fields=${fields}`,
      `${this.instanceUrl}/rest/agile/1.0/board/${this.boardId}/backlog?maxResults=${maxResults}&startAt=${startAt}&fields=${fields}`,
    ];

    const allIssues = new Map<string, JiraIssue>();
    let total = 0;
    const failures: Array<{ url: string; reason: string }> = [];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          failures.push({ url, reason: `HTTP ${res.status} ${res.statusText}` });
          continue;
        }
        const data = await safeJson(res, `searchIssues:${endpointLabel(url)}`);
        const shaped = data as { issues?: unknown; total?: unknown };
        const issues = Array.isArray(shaped.issues) ? (shaped.issues as RawIssue[]) : [];
        if (typeof shaped.total === 'number') {
          total = Math.max(total, shaped.total);
        }
        for (const issue of issues) {
          if (issue && typeof issue.key === 'string' && !allIssues.has(issue.key)) {
            allIssues.set(issue.key, this.mapIssue(issue));
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ url, reason });
        log.warn(`[jira] searchIssues endpoint failed: ${endpointLabel(url)} — ${reason}`);
      }
    }

    // Also try the project-level search via API v2 as last resort
    const projectKey = await this.getBoardProjectKey();
    if (projectKey) {
      const v2Url = `${this.instanceUrl}/rest/api/2/search?jql=${encodeURIComponent(`project = ${projectKey} ORDER BY updated DESC`)}&maxResults=${maxResults}&startAt=${startAt}&fields=${fields}`;
      try {
        const res = await fetch(v2Url, { headers: this.headers(), signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await safeJson(res, 'searchIssues:v2');
          const shaped = data as { issues?: unknown; total?: unknown };
          const issues = Array.isArray(shaped.issues) ? (shaped.issues as RawIssue[]) : [];
          if (typeof shaped.total === 'number') {
            total = Math.max(total, shaped.total);
          }
          for (const issue of issues) {
            if (issue && typeof issue.key === 'string' && !allIssues.has(issue.key)) {
              allIssues.set(issue.key, this.mapIssue(issue));
            }
          }
        } else {
          // v2 search not available — that's OK, we have Agile results. Still
          // worth a debug breadcrumb in case the agile endpoints also failed.
          log.debug(`[jira] v2 search returned ${res.status}; continuing with agile results`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.debug(`[jira] v2 search threw: ${reason}`);
      }
    }

    if (allIssues.size === 0) {
      if (failures.length > 0) {
        const summary = failures.map((f) => `${endpointLabel(f.url)} (${f.reason})`).join('; ');
        throw new Error(`No issues fetched. All board endpoints failed: ${summary}`);
      }
      throw new Error('No issues found on this board');
    }

    const issues = Array.from(allIssues.values());
    return { issues, total, hasMore: issues.length < total };
  }

  async getIssue(key: string): Promise<JiraIssue> {
    // Try API v2 first (returns description as string), then v3 (returns ADF)
    const fields = 'summary,description,status,assignee,comment';
    let res = await fetch(
      `${this.instanceUrl}/rest/api/2/issue/${key}?fields=${fields}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) {
      // Fallback to v3
      res = await fetch(
        `${this.instanceUrl}/rest/api/3/issue/${key}?fields=${fields}`,
        { headers: this.headers(), signal: AbortSignal.timeout(10000) }
      );
    }

    if (!res.ok) throw new Error(`Failed to fetch issue ${key}: ${res.status}`);
    const data = await safeJson(res, `getIssue:${key}`) as RawIssue;
    return this.mapIssue(data);
  }

  private mapIssue(raw: RawIssue): JiraIssue {
    const desc = adfToPlainText(raw.fields.description);
    const comments = (raw.fields.comment?.comments ?? [])
      .slice(-5)
      .map((c) => adfToPlainText(c.body));

    return {
      key: raw.key,
      summary: raw.fields.summary,
      description: desc,
      acceptanceCriteria: extractAcceptanceCriteria(desc),
      status: raw.fields.status.name,
      assignee: raw.fields.assignee?.displayName ?? 'Unassigned',
      comments,
      url: `${this.instanceUrl}/browse/${raw.key}`,
    };
  }

  private boardProjectKey: string | null = null;

  private async getBoardProjectKey(): Promise<string | null> {
    if (this.boardProjectKey) return this.boardProjectKey;
    if (!this.boardId) return null;

    try {
      const res = await fetch(
        `${this.instanceUrl}/rest/agile/1.0/board/${this.boardId}/configuration`,
        { headers: this.headers(), signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await safeJson(res, 'getBoardProjectKey') as { location?: { projectKey?: string } };
      this.boardProjectKey = data.location?.projectKey ?? null;
      return this.boardProjectKey;
    } catch (err) {
      log.debug(`[jira] getBoardProjectKey threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': this.authHeader,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }
}

/**
 * Convert Atlassian Document Format (ADF) JSON or plain string to text.
 */
function adfToPlainText(adf: unknown): string {
  // If it's already a string (API v2), return as-is
  if (typeof adf === 'string') return adf;

  if (!adf || typeof adf !== 'object') return '';

  const node = adf as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };

  // Text node
  if (node.type === 'text' && node.text) return node.text;

  // Mention node
  if (node.type === 'mention') return `@${(node.attrs?.text as string) ?? 'user'}`;

  // Emoji
  if (node.type === 'emoji') return (node.attrs?.shortName as string) ?? '';

  // Inline card (links)
  if (node.type === 'inlineCard') return (node.attrs?.url as string) ?? '';

  if (Array.isArray(node.content)) {
    const parts = node.content.map((child) => adfToPlainText(child));
    const blockTypes = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'panel', 'table'];
    const lineTypes = ['listItem', 'tableRow', 'tableCell'];

    if (node.type && blockTypes.includes(node.type)) {
      return parts.join('') + '\n\n';
    }
    if (node.type && lineTypes.includes(node.type)) {
      return parts.join('') + '\n';
    }
    if (node.type === 'hardBreak') return '\n';
    return parts.join('');
  }

  return '';
}

/**
 * Parse a fetch Response as JSON, surfacing a clear error when the body
 * is not JSON (proxy/SSO interstitials, gateway HTML pages). The native
 * SyntaxError leaks zero context — this wrapper attaches the source.
 */
async function safeJson(res: Response, source: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Jira returned non-JSON response in ${source} (HTTP ${res.status}). ` +
      `Likely a proxy / SSO interstitial. Original parse error: ${detail}`
    );
  }
}

function endpointLabel(url: string): string {
  // Strip the host so logs read like "/rest/agile/1.0/board/123/issue".
  return url.replace(/^https?:\/\/[^/]+/, '') || url;
}

const AC_HEADING_RE = /(?:^|\n)\s*(?:#+\s*)?(?:acceptance criteria|AC)\b[\s:]*\n?([\s\S]{0,4000}?)(?=\n\s*\n|\n\s*#|$)/i;
const GHERKIN_RE = /(?:^|\n)\s*given\b[^\n]{0,500}\n[\s\S]{0,500}?\bwhen\b[^\n]{0,500}\n[\s\S]{0,500}?\bthen\b[^\n]{0,500}/i;

/**
 * Heuristic extraction of acceptance criteria. Two narrow regexes,
 * each anchored on its own marker, so we never run an unbounded
 * `given.*when.*then` over a multi-MB description (the previous shape
 * could catastrophically backtrack on tickets that had "given" and
 * "when" but no "then"). Inputs are also truncated before scanning.
 */
function extractAcceptanceCriteria(desc: string): string {
  if (!desc) return '';
  const scan = desc.length > AC_SCAN_MAX_CHARS ? desc.slice(0, AC_SCAN_MAX_CHARS) : desc;
  const heading = scan.match(AC_HEADING_RE);
  if (heading?.[1]) return heading[1].trim();
  const gherkin = scan.match(GHERKIN_RE);
  if (gherkin) return gherkin[0].trim();
  return '';
}
