export class CarameloError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class TimeoutError extends CarameloError {}

export class NetworkError extends CarameloError {}

export class AuthError extends CarameloError {}

export class ProviderError extends CarameloError {
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
