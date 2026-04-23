import * as vscode from 'vscode';
import type { LLMMessage, LLMOptions, LLMProvider } from './types.js';
import { parseSSEStream } from './sse.js';
import { AuthError, NetworkError, ProviderError, isAbortError } from '../errors.js';
import { getSseTimeoutMs } from '../utils/settings.js';
import { sanitizeHeaderName, sanitizeHeaderPrefix } from '../utils/auth.js';

export class ClaudeProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKeyId: string;
  private readonly secrets: vscode.SecretStorage;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private apiKey: string | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: { id: string; name: string; endpoint: string; model: string; apiKeyId: string; authHeader?: string; authPrefix?: string },
    secrets: vscode.SecretStorage
  ) {
    this.id = config.id;
    this.displayName = config.name;
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKeyId = config.apiKeyId;
    this.authHeader = sanitizeHeaderName(config.authHeader, 'x-api-key');
    this.authPrefix = sanitizeHeaderPrefix(config.authPrefix, '');
    this.secrets = secrets;
  }

  async authenticate(): Promise<boolean> {
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
    if (!this.apiKey) return false;
    try {
      // Exercise the same code path as chat() so the result reflects what a
      // real generation will see: model exists, credentials accepted by the
      // streaming endpoint, custom auth headers honoured by the proxy, etc.
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
    if (!this.apiKey) throw new AuthError(`${this.displayName}: Not authenticated`);

    // Abort any previous in-flight request before starting a new one.
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const signal = options?.signal
      ? anySignal(options.signal, controller.signal)
      : controller.signal;

    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
      messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (systemMessage) body.system = systemMessage.content;
    if (options?.temperature !== undefined) body.temperature = options.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [this.authHeader]: this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
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
          if (obj?.type === 'content_block_delta') {
            const delta = obj.delta as Record<string, unknown> | undefined;
            return (delta?.text as string) ?? null;
          }
          return null;
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
