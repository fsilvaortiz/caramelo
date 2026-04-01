export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  authenticate(): Promise<boolean>;
  isAvailable(): Promise<boolean>;
  chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string>;
  dispose(): void;
}
