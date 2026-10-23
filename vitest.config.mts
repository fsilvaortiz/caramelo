import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The src/test/** tree holds extension-host smoke tests run by
    // @vscode/test-electron + Mocha — vitest can't load `vscode` for real.
    exclude: ['node_modules/**', 'dist/**', 'out/**', 'src/test/**'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      vscode: path.resolve(dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
