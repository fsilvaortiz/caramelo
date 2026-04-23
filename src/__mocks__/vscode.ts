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
  withProgress: <T>(_options: unknown, task: () => Promise<T>) => task(),
};

export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
    update: () => Promise.resolve(),
    inspect: () => undefined,
  }),
};

export const commands = {
  executeCommand: () => Promise.resolve(undefined),
};
