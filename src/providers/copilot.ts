import * as vscode from 'vscode';
import type { LLMMessage, LLMOptions, LLMProvider } from './types.js';

export class CopilotProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;
  private model: vscode.LanguageModelChat | undefined;
  private modelFamily: string;

  constructor(id: string, name: string, family: string) {
    this.id = id;
    this.displayName = name;
    this.modelFamily = family;
  }

  async authenticate(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: this.modelFamily });
    if (models.length > 0) {
      this.model = models[0];
      return true;
    }
    return false;
  }

  async isAvailable(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.length > 0;
  }

  async *chat(messages: LLMMessage[], options?: LLMOptions): AsyncIterable<string> {
    // Re-select model in case family was changed
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: options?.model ?? this.modelFamily,
    });

    if (models.length === 0) {
      throw new Error('No Copilot model available. Is GitHub Copilot installed and active?');
    }

    const model = models[0];

    // vscode.lm only supports User and Assistant roles — no system role
    // Prepend system content as a User message
    const vsMessages: vscode.LanguageModelChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        vsMessages.push(vscode.LanguageModelChatMessage.User(`[Instructions]\n${msg.content}`));
      } else if (msg.role === 'user') {
        vsMessages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else if (msg.role === 'assistant') {
        vsMessages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }

    const cts = new vscode.CancellationTokenSource();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => cts.cancel(), { once: true });
    }

    const response = await model.sendRequest(
      vsMessages,
      {
        justification: 'Caramelo uses language models to generate and analyze specifications.',
        modelOptions: {
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      },
      cts.token
    );

    for await (const chunk of response.text) {
      yield chunk;
    }
  }

  dispose(): void {
    this.model = undefined;
  }
}

/**
 * Fetch all available Copilot models for the provider picker.
 */
export async function getCopilotModels(): Promise<Array<{ id: string; name: string; family: string }>> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m) => ({
      id: m.id,
      name: `${m.name} (${m.family})`,
      family: m.family,
    }));
  } catch {
    return [];
  }
}
