# Contract: Workflow sidebar ↔ extension messages

The sidebar (`src/views/sidebar/workflow-view.ts`) posts messages that are parsed by `parseMessage` and handled by `dispatch`.

| Message | Fields | Change | Handling |
|---|---|---|---|
| `createSpec` | `name: string`, `description: string`, `mode?: 'full' \| 'quick'` | **`mode` added** (absent means `full`) | `quick` creates the folder and meta (`mode: "quick"`), then runs `caramelo.generateQuickSpec` with no toast. `quick` is refused when `caramelo.quickSpec.enabled` is false. A quick spec also requires a non-empty description. |
| `approveQuickSpec` | `specName: string` | **new** | `caramelo.approveQuickSpec` |
| `promoteQuickSpec` | `specName: string` | **new** | `caramelo.promoteQuickSpec` |
| `createFullInstead` | `specName: string` | **new** (from the "too large" notice) | Promote, then `runPhase(requirements)` |

Validation: unknown fields are ignored. `specName` must match an existing spec folder, otherwise the message is dropped and logged at debug level.
