import * as vscode from 'vscode';
import type { LLMMessage, LLMOptions, LLMProvider } from './types.js';
import { parseSSEStream } from './sse.js';

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
    this.authHeader = config.authHeader ?? 'Authorization';
    this.authPrefix = config.authPrefix ?? 'Bearer';
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
      const headers: Record<string, string> = {};
      if (this.apiKey) headers[this.authHeader] = this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey;
      const res = await fetch(`${this.endpoint}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    this.abortController = new AbortController();
    const signal = options?.signal
      ? anySignal(options.signal, this.abortController.signal)
      : this.abortController.signal;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers[this.authHeader] = this.authPrefix ? `${this.authPrefix} ${this.apiKey}` : this.apiKey;

    const body = JSON.stringify({
      model: options?.model ?? this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    });

    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.displayName}: ${res.status} ${res.statusText} - ${text}`);
    }

    if (!res.body) throw new Error(`${this.displayName}: No response body`);

    const reader = res.body.getReader();
    yield* parseSSEStream(reader, (json) => {
      const obj = json as Record<string, unknown>;
      const choices = obj?.choices as Array<{ delta?: { content?: string } }> | undefined;
      return choices?.[0]?.delta?.content ?? null;
    });
  }

  dispose(): void {
    this.abortController?.abort();
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
