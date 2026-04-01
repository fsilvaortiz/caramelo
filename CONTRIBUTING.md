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
├── providers/            # LLM provider abstraction
├── speckit/              # Template sync and management
├── specs/                # Spec model, workspace, workflow engine
├── views/                # Sidebar trees, CodeLens, webviews
└── commands/             # Command handlers
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
- No SDK dependencies for LLM providers — use native `fetch`
- Prefer VS Code native APIs (TreeView, CodeLens) over custom webviews
- Keep the bundle small — currently ~70KB

## Adding a New LLM Provider Type

1. Create `src/providers/my-provider.ts` implementing the `LLMProvider` interface
2. The `chat()` method must return `AsyncIterable<string>` for streaming
3. Register it in `src/commands/select-provider.ts` preset list
4. No SDK dependencies — use `fetch` + the shared SSE parser in `src/providers/sse.ts`

## Adding a New Command

1. Add the command ID to `src/constants.ts`
2. Declare it in `package.json` under `contributes.commands`
3. Create the handler in `src/commands/`
4. Register in `src/extension.ts`

## Reporting Issues

Open an issue at [github.com/fsilvaortiz/caramelo/issues](https://github.com/fsilvaortiz/caramelo/issues) with:
- VS Code version
- Caramelo version
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
