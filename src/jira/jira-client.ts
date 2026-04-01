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
    const data = await res.json() as { values: Array<{ id: number; name: string; type: string }> };
    return data.values.map((b) => ({ id: String(b.id), name: b.name, type: b.type }));
  }

  async searchIssues(query?: string, maxResults = 50, startAt = 0): Promise<JiraSearchResult> {
    // Use Agile API to get board issues (works on all Jira Cloud instances)
    const url = this.boardId
      ? `${this.instanceUrl}/rest/agile/1.0/board/${this.boardId}/backlog?maxResults=${maxResults}&startAt=${startAt}&fields=summary,description,status,assignee,comment`
      : `${this.instanceUrl}/rest/api/2/search?jql=ORDER+BY+updated+DESC&maxResults=${maxResults}&startAt=${startAt}&fields=summary,description,status,assignee,comment`;

    let res = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });

    // Fallback: if backlog endpoint fails, try the board/issue endpoint
    if (!res.ok && this.boardId) {
      res = await fetch(
        `${this.instanceUrl}/rest/agile/1.0/board/${this.boardId}/issue?maxResults=${maxResults}&startAt=${startAt}&fields=summary,description,status,assignee,comment`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );
    }

    if (!res.ok) throw new Error(`Failed to search issues: ${res.status} ${res.statusText}`);
    const data = await res.json() as {
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          description: unknown;
          status: { name: string };
          assignee: { displayName: string } | null;
          comment?: { comments: Array<{ body: unknown }> };
        };
      }>;
      total: number;
    };

    const issues = data.issues.map((i) => this.mapIssue(i));
    return {
      issues,
      total: data.total,
      hasMore: startAt + maxResults < data.total,
    };
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const res = await fetch(
      `${this.instanceUrl}/rest/api/3/issue/${key}?fields=summary,description,status,assignee,comment`,
      { headers: this.headers(), signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`Failed to fetch issue ${key}: ${res.status}`);
    const data = await res.json() as {
      key: string;
      fields: {
        summary: string;
        description: unknown;
        status: { name: string };
        assignee: { displayName: string } | null;
        comment?: { comments: Array<{ body: unknown }> };
      };
    };
    return this.mapIssue(data);
  }

  private mapIssue(raw: {
    key: string;
    fields: {
      summary: string;
      description: unknown;
      status: { name: string };
      assignee: { displayName: string } | null;
      comment?: { comments: Array<{ body: unknown }> };
    };
  }): JiraIssue {
    const desc = adfToPlainText(raw.fields.description);
    const comments = (raw.fields.comment?.comments ?? [])
      .slice(-5)
      .map((c) => adfToPlainText(c.body));

    // Extract acceptance criteria from description (common patterns)
    let acceptanceCriteria = '';
    const acMatch = desc.match(/(?:acceptance criteria|AC|given.*when.*then)[\s:]*(.+?)(?=\n\n|\n#|$)/is);
    if (acMatch) acceptanceCriteria = acMatch[1].trim();

    return {
      key: raw.key,
      summary: raw.fields.summary,
      description: desc,
      acceptanceCriteria,
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
      const data = await res.json() as { location?: { projectKey?: string } };
      this.boardProjectKey = data.location?.projectKey ?? null;
      return this.boardProjectKey;
    } catch {
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
 * Convert Atlassian Document Format (ADF) JSON to plain text.
 * Walks the tree extracting text nodes.
 */
function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return String(adf ?? '');

  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === 'text' && node.text) return node.text;

  if (Array.isArray(node.content)) {
    const parts = node.content.map((child) => adfToPlainText(child));
    // Add newlines for block-level elements
    const blockTypes = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote'];
    if (node.type && blockTypes.includes(node.type)) {
      return parts.join('') + '\n';
    }
    return parts.join('');
  }

  return '';
}
