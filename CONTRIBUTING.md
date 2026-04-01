# Contributing to Caramelo

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/fsilvaortiz/caramelo.git
cd caramelo
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host for testing.

## Project Structure

```
src/
├── extension.ts          # Entry point — wires everything
├── constants.ts          # IDs, paths, defaults
├── progress.ts           # Status bar progress indicator
├── providers/            # LLM provider abstraction (types, registry, SSE parser)
├── jira/                 # Jira Cloud API client and provider
├── speckit/              # Template sync and management
├── specs/                # Spec model, workspace, workflow engine
├── views/
│   ├── sidebar/          # Workflow webview, providers tree
│   ├── codelens/         # Phase actions, tasks, analysis CodeLens
│   ├── webview/          # DAG visualization
│   └── editor-context.ts # Context keys for editor toolbar
└── commands/             # All command handlers
```

## Making Changes

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b my-feature`
3. **Make your changes** — keep them focused on one thing
4. **Build and verify**: `npm run build && npx tsc --noEmit`
5. **Test manually** in the Extension Development Host (F5)
6. **Submit a PR** with a clear description

## Code Style

- TypeScript strict mode
- No SDK dependencies for LLM/Jira — use native `fetch`
- Prefer VS Code native APIs (TreeView, CodeLens, QuickPick) over custom webviews
- Use status bar progress (`src/progress.ts`) instead of notification popups
- Keep the bundle small — currently ~165KB

## Adding a New LLM Provider Type

1. Create `src/providers/my-provider.ts` implementing the `LLMProvider` interface from `src/providers/types.ts`
2. The `chat()` method must return `AsyncIterable<string>` for streaming
3. Register it in `src/commands/select-provider.ts` preset list
4. No SDK dependencies — use `fetch` + the shared SSE parser in `src/providers/sse.ts`

## Adding a New Integration (like Jira)

1. Create a directory `src/my-integration/` with client and provider classes
2. Add the integration type to `ProviderType` in `src/constants.ts`
3. Add the setup wizard in `src/commands/select-provider.ts`
4. Add UI elements in `src/views/sidebar/workflow-view.ts`
5. Register commands in `src/extension.ts`

## Adding a New Command

1. Add the command ID to `src/constants.ts`
2. Declare it in `package.json` under `contributes.commands`
3. Create the handler in `src/commands/`
4. Register in `src/extension.ts`
5. If it's a quality tool, add it to the `caramelo.editorMenu` submenu in `package.json`

## Adding Editor Context Actions

1. Add a context key in `src/views/editor-context.ts`
2. Use the key in `when` clauses in `package.json` under `caramelo.editorMenu`
3. Context keys follow the pattern `caramelo.editorXxx`

## Reporting Issues

Open an issue at [github.com/fsilvaortiz/caramelo/issues](https://github.com/fsilvaortiz/caramelo/issues) with:
- VS Code version
- Caramelo version
- LLM provider being used
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
