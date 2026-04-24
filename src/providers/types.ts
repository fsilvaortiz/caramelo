import type {
  AgentEvent,
  ProviderToolCallRequest,
} from '../agent/types.js';

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

/**
 * Capability tags a provider may advertise. Constitution VI mandates that
 * runtime code branches on **capabilities**, never on provider type
 * strings. Add new tags here as providers gain features; every tag MUST
 * have graceful-degradation behaviour elsewhere in the codebase.
 */
export type Capability =
  | 'streaming'
  | 'tool-calling'
  | 'reasoning'
  | 'prompt-caching'
  | 'citations'
  | 'multimodal'
  | 'vision';

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  authenticate(): Promise<boolean>;
  isAvailable(): Promise<boolean>;
  chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string>;
  dispose(): void;
  /**
   * Set of capabilities this provider supports right now (may depend on
   * auth state — e.g. Claude only advertises `tool-calling` after the
   * API key is loaded). Callers use this to branch on features instead
   * of on provider type. See Constitution principle VI.
   */
  capabilities(): Set<Capability>;
  /**
   * Optional tool-calling path. Present iff `capabilities().has('tool-calling')`.
   * Returns the normalised AgentEvent stream defined in src/agent/types.ts.
   */
  chatWithTools?(req: ProviderToolCallRequest): AsyncIterable<AgentEvent>;
}
