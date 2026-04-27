// Minimal stub of the `vscode` module surface that Caramelo uses, for unit
// tests run outside the extension host. Only the parts touched by tested code
// are implemented; expand on demand.

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners = [];
  }
}

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
} as const;

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  showTextDocument: () => Promise.resolve(undefined),
  // The real withProgress invokes the task with (progress, token); the
  // task's cancellation handler subscribes via token.onCancellationRequested.
  // Tests that don't care about cancellation get a no-op token.
  withProgress: <T>(
    _options: unknown,
    task: (progress: { report: () => void }, token: { isCancellationRequested: boolean; onCancellationRequested: () => { dispose(): void } }) => Promise<T>,
  ) =>
    task(
      { report: () => { /* noop */ } },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => { /* noop */ } }),
      },
    ),
};


export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
    update: () => Promise.resolve(),
    inspect: () => undefined,
  }),
  // Tests default to a trusted workspace; the handful that exercise
  // the untrusted-workspace gate override this value directly.
  isTrusted: true as boolean,
  workspaceFolders: undefined as ReadonlyArray<{ uri: { fsPath: string } }> | undefined,
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => { /* noop */ } }),
    onDidCreate: () => ({ dispose: () => { /* noop */ } }),
    onDidDelete: () => ({ dispose: () => { /* noop */ } }),
    dispose: () => { /* noop */ },
  }),
  onDidSaveTextDocument: () => ({ dispose: () => { /* noop */ } }),
  openTextDocument: () => Promise.resolve({}),
};

export const env = {
  openExternal: () => Promise.resolve(true),
};

export class Uri {
  static file(p: string): { fsPath: string; toString: () => string } {
    return { fsPath: p, toString: () => p };
  }
  static parse(s: string): { toString: () => string } {
    return { toString: () => s };
  }
}

export const commands = {
  executeCommand: () => Promise.resolve(undefined),
};

// --- Language Model API stubs (vscode.lm.*) -----------------------------
// Real classes in the extension host; stubbed here so tests can check
// identity via `instanceof`.

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: Record<string, unknown>,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: Array<LanguageModelTextPart>,
  ) {}
}

export const LanguageModelChatToolMode = { Auto: 0, Required: 1 } as const;

export class LanguageModelChatMessage {
  private constructor(
    public readonly role: number,
    public readonly content: Array<
      LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart
    >,
  ) {}
  static User(
    content:
      | string
      | Array<LanguageModelTextPart | LanguageModelToolResultPart>,
  ): LanguageModelChatMessage {
    const parts = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    return new LanguageModelChatMessage(1, parts);
  }
  static Assistant(
    content:
      | string
      | Array<LanguageModelTextPart | LanguageModelToolCallPart>,
  ): LanguageModelChatMessage {
    const parts = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    return new LanguageModelChatMessage(2, parts);
  }
}

export class CancellationTokenSource {
  private _cancelled = false;
  readonly token = {
    get isCancellationRequested() {
      return false;
    },
    onCancellationRequested: () => ({ dispose: () => { /* noop */ } }),
  };
  cancel(): void {
    this._cancelled = true;
  }
  dispose(): void { /* noop */ }
}

// Tests override `lm.selectChatModels` with vi.fn() to inject mock models.
export const lm = {
  selectChatModels: (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]),
  // Real API also has `registerTool`; unused by Caramelo so we don't stub it.
};
