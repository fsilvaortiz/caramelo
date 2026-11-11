import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeProvider } from '../claude.js';
import { OpenAICompatibleProvider } from '../openai-compatible.js';
import { ApiKeyHelper } from '../../utils/api-key-helper.js';

const secrets = {
  get: vi.fn().mockResolvedValue('stored-key'),
  store: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
} as unknown as import('vscode').SecretStorage;

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

const claudeOk = () => new Response(sse([
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
]), { status: 200 });

const openaiOk = () => new Response(sse([
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
  'data: [DONE]\n\n',
]), { status: 200 });

async function drain(iter: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const c of iter) out += c;
  return out;
}

function makeHelper(keys: string[]) {
  const run = vi.fn();
  for (const k of keys) run.mockResolvedValueOnce(k);
  return { run, helper: new ApiKeyHelper('get-key', 'Test', { run, isTrusted: () => true, cwd: () => '/' }) };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('ClaudeProvider with apiKeyHelper', () => {
  const config = { id: 'c', name: 'Claude', endpoint: 'https://api.example', model: 'm', apiKeyId: 'k' };

  it('uses the helper key instead of SecretStorage and never prompts', async () => {
    const { helper } = makeHelper(['helper-key']);
    const provider = new ClaudeProvider(config, secrets, helper);
    const fetchMock = vi.fn().mockResolvedValue(claudeOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await provider.authenticate()).toBe(true);
    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('helper-key');
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('refreshes the key and retries once on 401', async () => {
    const { run, helper } = makeHelper(['old', 'new']);
    const provider = new ClaudeProvider({ ...config, authHeader: 'Authorization', authPrefix: 'Bearer' }, secrets, helper);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(claudeOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer old');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });

  it('surfaces AuthError when the retry also fails', async () => {
    const { helper } = makeHelper(['a', 'b']);
    const provider = new ClaudeProvider(config, secrets, helper);
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(drain(provider.chat([{ role: 'user', content: 'x' }]))).rejects.toThrow(/401/);
  });
});

describe('OpenAICompatibleProvider with apiKeyHelper', () => {
  const config = { id: 'o', name: 'Gateway', endpoint: 'https://gw.example/v1', model: 'm' };

  it('sends the helper key as Bearer token even without a stored key id', async () => {
    const { helper } = makeHelper(['tok']);
    const provider = new OpenAICompatibleProvider(config, secrets, helper);
    const fetchMock = vi.fn().mockResolvedValue(openaiOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(provider.capabilities().has('tool-calling')).toBe(false);
    await provider.authenticate();
    expect(provider.capabilities().has('tool-calling')).toBe(true);
    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('refreshes the key and retries once on 403', async () => {
    const { run, helper } = makeHelper(['old', 'new']);
    const provider = new OpenAICompatibleProvider(config, secrets, helper);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 403 }))
      .mockResolvedValueOnce(openaiOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });
});

describe('apiKeyHelper in its own header (Azure APIM + Bearer token)', () => {
  const apim = {
    authHeader: 'Ocp-Apim-Subscription-Key',
    authPrefix: '',
    apiKeyHelperHeader: 'Authorization',
  };

  it('Claude sends the stored subscription key and the helper token as Bearer', async () => {
    const { helper } = makeHelper(['tok']);
    const stored = { ...secrets, get: vi.fn().mockResolvedValue('sub-key') } as unknown as import('vscode').SecretStorage;
    const provider = new ClaudeProvider(
      { id: 'c', name: 'Claude', endpoint: 'https://apim.example', model: 'm', apiKeyId: 'k', ...apim },
      stored,
      helper,
    );
    const fetchMock = vi.fn().mockResolvedValue(claudeOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await provider.authenticate()).toBe(true);
    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('sub-key');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('OpenAI-compatible sends both headers and refreshes only the token on 401', async () => {
    const { run, helper } = makeHelper(['old', 'new']);
    const stored = { ...secrets, get: vi.fn().mockResolvedValue('sub-key') } as unknown as import('vscode').SecretStorage;
    const provider = new OpenAICompatibleProvider(
      { id: 'o', name: 'GW', endpoint: 'https://apim.example/v1', model: 'm', apiKeyId: 'k', ...apim, apiKeyHelperPrefix: 'Bearer' },
      stored,
      helper,
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(openaiOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await provider.authenticate();
    expect(await drain(provider.chat([{ role: 'user', content: 'x' }]))).toBe('hi');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'Ocp-Apim-Subscription-Key': 'sub-key', Authorization: 'Bearer old' });
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ 'Ocp-Apim-Subscription-Key': 'sub-key', Authorization: 'Bearer new' });
  });
});
