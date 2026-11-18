# Contract: Commands and settings

## Commands (`package.json` → `contributes.commands`, registered in `src/extension.ts`)

| Command | Arguments | Behaviour |
|---|---|---|
| `caramelo.generateQuickSpec` | `specName: string` | Generates (or regenerates) all three documents of a quick spec. It is fire-and-forget for the UI; the exported function returns `Promise<QuickSpecParse['kind'] \| 'aborted'>` for tests. |
| `caramelo.approveQuickSpec` | `specName: string` | Marks requirements, design and tasks `approved` in one write. |
| `caramelo.promoteQuickSpec` | `specName: string` | Switches to the full flow, keeping the files. |

Existing commands:
- `caramelo.runPhase` / `caramelo.regeneratePhase` on a quick spec delegate to `generateQuickSpec`.
- `caramelo.approvePhase` on a quick spec delegates to `approveQuickSpec`, so CodeLens and the editor menu keep working.

## Setting

```jsonc
"caramelo.quickSpec.enabled": {
  "type": "boolean",
  "default": true,
  "scope": "resource",
  "markdownDescription": "Offer **Quick** in the New Spec form: one description → a short spec, plan and task list approved in one step. Turn off to require the full Requirements → Design → Tasks flow."
}
```
