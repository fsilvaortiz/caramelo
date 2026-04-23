import * as vscode from 'vscode';
import type { LLMMessage, LLMOptions, LLMProvider } from './types.js';
import { parseSSEStream } from './sse.js';
import { AuthError, NetworkError, ProviderError, isAbortError } from '../errors.js';
import { getSseTimeoutMs } from '../utils/settings.js';
import { sanitizeHeaderName, sanitizeHeaderPrefix } from '../utils/auth.js';

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKeyId: string | null;
  private readonly secrets: vscode.SecretStorage;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private apiKey: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: { id: string; name: string; endpoint: string; model: string; apiKeyId?: string; authHeader?: string; authPrefix?: string },
    secrets: vscode.SecretStorage
  ) {
    this.id = config.id;
    this.displayName = config.name;
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKeyId = config.apiKeyId ?? null;
    this.authHeader = sanitizeHeaderName(config.authHeader, 'Authorization');
    this.authPrefix = sanitizeHeaderPrefix(config.authPrefix, 'Bearer');
    this.secrets = secrets;
  }

  async authenticate(): Promise<boolean> {
    if (!this.apiKeyId) return true;
    const key = await this.secrets.get(this.apiKeyId);
    if (!key) {
      const input = await vscode.window.showInputBox({
        prompt: `Enter API key for ${this.displayName}`,
        password: true,
      });
      if (!input) return false;
      await this.secrets.store(this.apiKeyId, input);
      this.apiKey = input;
    } else {
      this.apiKey = key;
    }
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Hitting /models only proves the endpoint is reachable; it doesn't
      // prove that the configured model is loaded (Ollama returns 200 even
      // for models that aren't pulled) or that this key can call /chat
      // through the corporate proxy. Run a tiny streaming generation so the
      // health check matches what real chats will do.
      for await (const _chunk of this.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 1, signal: AbortSignal.timeout(15_000) },
      )) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = options?.signal
      ? anySignal(options.signal, controller.signal)
      : controller.signal;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers[this.authHeader] = this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey;

    const body = JSON.stringify({
      model: options?.model ?? this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    });

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new NetworkError(`${this.displayName}: request failed`, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `${this.displayName}: ${res.status} ${res.statusText} - ${text}`;
      if (res.status === 401 || res.status === 403) throw new AuthError(message);
      throw new ProviderError(message, res.status);
    }

    if (!res.body) throw new ProviderError(`${this.displayName}: No response body`);

    const reader = res.body.getReader();
    try {
      yield* parseSSEStream(
        reader,
        (json) => {
          const obj = json as Record<string, unknown>;
          const choices = obj?.choices as Array<{ delta?: { content?: string } }> | undefined;
          return choices?.[0]?.delta?.content ?? null;
        },
        { timeoutMs: getSseTimeoutMs() },
      );
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
