import * as vscode from 'vscode';
import { MockLLMProvider } from './mock-provider.js';

const EXTENSION_ID = 'fsilvaortiz.caramelo';

/**
 * Local mirror of `CarameloApi` from src/extension.ts. Re-declared here
 * (instead of imported) so the test tsconfig does not have to pull in
 * the markdown.d.ts shim required by `src/speckit/templates.ts` and the
 * surrounding production module graph. Whenever the runtime contract
 * changes, this interface must be updated in lockstep — small surface
 * area is the point.
 */
export interface CarameloApi {
  registry: {
    activeProvider: { id: string; displayName: string } | undefined;
    register(provider: unknown): void;
    unregister(id: string): void;
    setActive(id: string): Promise<void>;
  };
  workflowEngine: unknown;
  templateManager: unknown;
}

/**
 * Activate the extension if it hasn't activated yet and return the
 * public test surface (`{ registry, workflowEngine, templateManager }`).
 * VS Code caches the activate() return on `Extension.exports`, so
 * re-entry is cheap.
 */
export async function getApi(): Promise<CarameloApi> {
  const ext = vscode.extensions.getExtension<CarameloApi>(EXTENSION_ID);
  if (!ext) {
    throw new Error(`extension ${EXTENSION_ID} not found in extension host`);
  }
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (!api || !api.registry) {
    throw new Error(`activate() did not return CarameloApi (got ${JSON.stringify(api)})`);
  }
  return api;
}

/**
 * Install a MockLLMProvider into the registry and make it active.
 * Returns the mock + a teardown that removes it again.
 */
export async function installMockProvider(opts: { id?: string; displayName?: string } = {}): Promise<{
  mock: MockLLMProvider;
  api: CarameloApi;
  uninstall: () => void;
}> {
  const api = await getApi();
  const mock = new MockLLMProvider(opts);
  api.registry.register(mock);
  await api.registry.setActive(mock.id);
  return {
    mock,
    api,
    uninstall: () => {
      try {
        api.registry.unregister(mock.id);
      } catch { /* ignore */ }
    },
  };
}
