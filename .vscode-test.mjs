import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  workspaceFolder: 'src/test/fixtures/empty-workspace',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    color: true,
  },
  // Match the engine declared in package.json so we exercise the same API
  // surface in CI as our users have at minimum.
  version: 'stable',
});
