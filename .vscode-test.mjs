import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The smoke suite drives start-task, whose git-safety step runs
// `git stash push -u` in the workspace. Opening the fixture in place
// (inside this repo) made that stash the developer's uncommitted work.
// Copy it to a temp dir outside any repository instead.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'caramelo-smoke-'));
fs.cpSync('src/test/fixtures/empty-workspace', workspaceFolder, { recursive: true });

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  workspaceFolder,
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    color: true,
  },
  // Defaults to current stable. CI also runs a floor job with
  // VSCODE_TEST_VERSION set to the engines.vscode minimum so post-floor
  // API usage fails there instead of on users' machines.
  version: process.env.VSCODE_TEST_VERSION || 'stable',
});
