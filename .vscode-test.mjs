import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  workspaceFolder: 'src/test/fixtures/empty-workspace',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    color: true,
  },
  // Pin to current stable VS Code. This intentionally exceeds the
  // engines.vscode minimum — a separate floor-check would be needed to
  // guarantee we don't accidentally rely on post-1.95 API.
  version: 'stable',
});
