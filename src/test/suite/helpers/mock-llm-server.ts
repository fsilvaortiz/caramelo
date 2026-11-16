import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * A local HTTP server that speaks the Anthropic Messages streaming API
 * (`POST /v1/messages`, SSE). Unlike `MockLLMProvider`, which replaces the
 * provider object, this lets e2e tests drive the REAL provider adapters —
 * request building, auth headers, SSE parsing, tool_use decoding and
 * request cancellation — end to end, with no network.
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface MessagesRequestBody {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string }>;
  stream?: boolean;
}

/** What the scripted "model" answers for one request. */
export interface MockTurn {
  /** Plain assistant text. */
  text?: string;
  /** A single tool call. */
  toolUse?: { name: string; input: Record<string, unknown> };
  /** Keep the stream open this long before answering (forces overlap between parallel requests). */
  delayMs?: number;
}

export interface RecordedRequest {
  body: MessagesRequestBody;
  headers: http.IncomingHttpHeaders;
  /** True when the client closed the connection before the response finished. */
  aborted: boolean;
}

export type TurnHandler = (body: MessagesRequestBody) => MockTurn;

export class MockAnthropicServer {
  readonly requests: RecordedRequest[] = [];
  private server: http.Server | undefined;
  private handler: TurnHandler = () => ({ text: 'ok' });
  private toolSeq = 0;

  setHandler(handler: TurnHandler): void {
    this.handler = handler;
  }

  reset(): void {
    this.requests.length = 0;
    this.handler = () => ({ text: 'ok' });
  }

  /** Starts listening on a random localhost port; resolves to the endpoint URL. */
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as MessagesRequestBody;
    const record: RecordedRequest = { body, headers: req.headers, aborted: false };
    this.requests.push(record);

    let finished = false;
    res.on('close', () => {
      if (!finished) record.aborted = true;
    });

    const turn = this.handler(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

    send('message_start', {
      message: { id: `msg_${this.requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [] },
    });
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    if (record.aborted) return;

    let index = 0;
    if (turn.text) {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: turn.text } });
      send('content_block_stop', { index });
      index++;
    }
    if (turn.toolUse) {
      const id = `toolu_${++this.toolSeq}`;
      send('content_block_start', { index, content_block: { type: 'tool_use', id, name: turn.toolUse.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.toolUse.input) } });
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: turn.toolUse ? 'tool_use' : 'end_turn' } });
    send('message_stop', {});
    finished = true;
    res.end();
  }
}

/** First line of the first user message — `Task: T1 …` for task runs. */
export function taskLine(body: MessagesRequestBody): string {
  const first = body.messages.find((m) => m.role === 'user');
  const text = typeof first?.content === 'string'
    ? first.content
    : (first?.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
  return text.split('\n', 1)[0];
}

/** Text of every tool_result the client has sent back so far. */
export function toolResults(body: MessagesRequestBody): string[] {
  const out: string[] = [];
  for (const m of body.messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue;
      const c = block.content;
      out.push(typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? '').join('') : '');
    }
  }
  return out;
}
