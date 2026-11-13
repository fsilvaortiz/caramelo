# Plan de mejoras — Caramelo (post v0.5.0)

## Estado actual (diagnóstico, 2026-11-13)

| Aspecto | Estado |
|---|---|
| Typecheck (`tsc --noEmit`) | Sin errores |
| Lint (`eslint src`) | Sin errores |
| Tests unitarios (vitest) | 44 archivos, 594 tests, todos pasan (~3 s) |
| Smoke tests (VS Code real) | Matriz Linux/macOS/Windows + piso VS Code 1.95 |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| Bundle `dist/extension.js` | ~740 KB sin minificar |
| Issues abiertas en GitHub | 0 |

La base es sana. Las mejoras se concentran en **seguridad de webviews**, **portabilidad del agente**, **mantenibilidad de las vistas grandes** y **cobertura de los módulos sin tests**.

---

## Fase 1 — Seguridad y robustez (prioridad alta, ~1 semana)

1. **CSP en todos los webviews.** Solo `workflow-view.ts` y `central-editor.ts` declaran `Content-Security-Policy`. Faltan en:
   - `src/views/sidebar/providers-view.ts`: es el más sensible, porque maneja API keys, endpoints y `apiKeyHelper`.
   - `src/views/webview/dag-view.ts`
   - `src/commands/edit-constitution.ts`

   Acción: helper común `buildWebviewHtml({ cspSource, nonce })` con `default-src 'none'` y scripts con `nonce`, más un test que verifique la CSP en cada vista.
2. **Quitar los handlers inline (`onclick="msg(...)"`).** `providers-view.ts` interpola IDs dentro de strings JS en atributos HTML. Pasar a `data-action` / `data-id` con un único listener delegado, lo que además permite eliminar `'unsafe-inline'` de `script-src`.
3. **Herramienta `bash` del agente en Windows.** `src/agent/tools/bash.ts` lanza siempre `/bin/sh -c`, que no existe en Windows. Hay que elegir el shell según la plataforma (`cmd.exe /d /s /c` o PowerShell, o `shell: true`) y cubrirlo en la matriz de CI de Windows.
4. **Reintentos y errores de red de los proveedores.** Hoy no hay backoff para 429/5xx en `claude.ts`, `openai-compatible.ts` ni `copilot.ts`. Acción: un `withRetry()` compartido (respetando `Retry-After` y `AbortSignal`) y mensajes de error accionables vía `errors.ts`.

## Fase 2 — Mantenibilidad (prioridad media, ~2 semanas)

1. **Partir las vistas monolíticas:**
   - `providers-view.ts` (1282 líneas) y `workflow-view.ts` (1148): separar *estado/mensajes* (testeable) de *render HTML* y *CSS/JS estático* (mover a `resources/webview/*.css|js`, cargados con `asWebviewUri`).
   - `edit-constitution.ts` (842) y `start-task.ts` (651): extraer la lógica pura a módulos `*-core.ts`, como ya se hizo con `converge-core.ts`.
2. **`extension.ts` (497 líneas, 28 `registerCommand`)**: mover el registro a `commands/index.ts` con una tabla declarativa. Añadir un test que compruebe que cada comando de `package.json` está registrado y viceversa.
3. **Actualizar `CONTRIBUTING.md`**: la estructura descrita no menciona `agent/`, `constitution/`, `utils/` ni el flujo de tests (vitest + smoke).

## Fase 3 — Cobertura de tests (prioridad media, en paralelo con la fase 2)

1. **Activar el reporte de cobertura** (`@vitest/coverage-v8`), publicarlo en CI y fijar un umbral mínimo inicial (por ejemplo, el valor actual) para evitar regresiones.
2. **Módulos con lógica y sin test unitario dedicado** (prioridad por riesgo):
   - `commands/analyze.ts`, `commands/select-provider.ts`, `commands/create-spec-from-jira.ts`, `commands/run-phase.ts`, `commands/approve-phase.ts`
   - `commands/task-edits/diff-preview.ts`, `task-edits/prompt.ts`
   - `views/codelens/*` (phase-actions, tasks, analysis): parseo de rangos y comandos emitidos
   - `specs/workspace.ts`, `speckit/templates.ts`, `jira/jira-provider.ts`
   - `providers/openai-compatible.ts` (solo cubierto indirectamente por `openai-tools.test.ts`)

## Fase 4 — Rendimiento y empaquetado (prioridad baja, ~3 días)

1. **Minificar el bundle en release** (`minify: production` en `esbuild.js`) y medir el tamaño antes y después en CI (presupuesto de tamaño).
2. **Revisar `activationEvents`**: confirmar que no se activa antes de lo necesario y diferir con `import()` dinámico el trabajo pesado (sincronización de plantillas, Jira, DAG).
3. Usar `retainContextWhenHidden` solo donde sea imprescindible (DAG, constitución), porque aumenta el consumo de memoria.

## Fase 5 — Producto / UX (backlog, a validar con usuarios)

1. **Internacionalización** con `vscode.l10n` (hoy los textos están hardcodeados en inglés). Empezar por español.
2. **Accesibilidad de los webviews**: roles ARIA, navegación por teclado en el DAG y en el checklist, foco visible y contraste en temas de alto contraste.
3. **Estimación de coste y tokens** por generación y proveedor, visible en el Output Channel o en la barra de estado.
4. **Telemetría opcional y anónima**, respetando `telemetry.telemetryLevel`, para priorizar funcionalidades con datos reales.
5. **Más integraciones de issues** (GitHub Issues, Linear), reutilizando la abstracción de `jira/`.

---

## Orden sugerido de PRs

| # | PR | Fase | Tamaño |
|---|---|---|---|
| 1 | CSP + nonce en los 3 webviews restantes + test | 1 | S |
| 2 | Shell multiplataforma en la herramienta `bash` del agente | 1 | S |
| 3 | `withRetry()` compartido para los proveedores | 1 | M |
| 4 | Cobertura en CI + umbral | 3 | S |
| 5 | Handlers delegados en `providers-view` (sin inline JS) | 1–2 | M |
| 6 | Split de `providers-view` / `workflow-view` | 2 | L |
| 7 | Registro declarativo de comandos + test de consistencia | 2 | S |
| 8 | Tests de codelens, `analyze` y `select-provider` | 3 | M |
| 9 | Minificación y presupuesto de bundle | 4 | S |
| 10 | Base de l10n | 5 | M |

**Criterio de "hecho" para cada PR:** `npm run build`, `tsc --noEmit`, `npm run lint` y `npm test` en verde, smoke tests de CI en verde en los tres sistemas operativos y CHANGELOG actualizado.
