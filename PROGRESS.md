# Progress

Status of the implementation against the specification. "Verified" means covered by an automated test or checked by running the real thing; anything else says so.

## Stages

- [x] **1 Foundations** — monorepo (path-aliased packages), Vite/React 19/Tailwind 4 app, Dexie storage, graph model, editor shell
- [x] **2 Visual editor** — node editing, connections with validation, project management, persistence, history, diagnostics
- [x] **3 Compiler** — type system, IR, language adapter SDK, structured lowering, GDScript backend
- [x] **4 Language features** — core node pack (87 nodes), Godot pack (196 nodes incl. curated API), 12 editable examples
- [x] **5 MCP** — stdio server, loopback WebSocket bridge, 42 tools, revision checks, backups, safe export, e2e test
- [x] **6 Godot** — companion service (tested) + editor plugin (**not executed in Godot**)
- [x] **7 Polish & testing** — 60 unit/integration/compiler tests, 10 Playwright tests, large-graph checks
- [~] **8 Deployment** — Worker config tested with `wrangler dev`; **not deployed** (no Cloudflare authorisation)

## Acceptance criteria

| # | Criterion | Status |
| --- | --- | --- |
| 1 | React app builds and runs | ✅ `npm run build`, e2e against the production build |
| 2 | Editor fills the viewport | ✅ e2e `the editor fills the viewport` |
| 3 | Create and save projects | ✅ e2e create/save/reopen |
| 4 | Nodes created, connected, edited, deleted | ✅ e2e + unit tests of edit operations |
| 5 | Compiler generates genuine GDScript from graphs | ✅ 12 golden files; ⚠ not yet run through Godot's checker (`npm run test:godot`) |
| 6 | Generated GDScript usable without the editor | ✅ by construction (no runtime, plain `.gd`); ⚠ not executed in Godot here |
| 7 | Complete scripts, not just expressions | ✅ extends/class_name/signals/enums/consts/exports/@onready/functions/events |
| 8 | Invalid graphs give useful diagnostics | ✅ `tests/compiler/diagnostics.test.ts`, e2e diagnostics navigation |
| 9 | Projects persist across browser restarts | ✅ e2e reload; IndexedDB |
| 10 | Undo/redo reliable | ✅ e2e (UI and MCP batches), unit history via store |
| 11 | Claude Code controls the editor via MCP | ✅ e2e with a real MCP client over stdio |
| 12 | AI edits atomic and revision-protected | ✅ e2e (conflict + rejected batch leave project unchanged) |
| 13 | Export and re-import graphs | ✅ unit round-trips + e2e archive re-import |
| 14 | Godot plugin loads graphs and generates scripts | ⚠ implemented; companion tested; plugin not run in Godot |
| 15 | Architecture supports more languages | ✅ adapter SDK + executed test-only JS adapter |
| 16 | Deployable through Cloudflare Workers | ✅ `wrangler dev` serves the build with SPA fallback + headers; ⚠ not deployed |
| 17 | Automated tests cover core workflows | ✅ |
| 18 | Documentation matches the implementation | ✅ `docs/` |

## Continuation plan

1. Run `GODOT_BIN=… npm run test:godot`; fix any generator issue it reports and update golden files.
2. Open `apps/godot-addon` in Godot 4.2+, exercise the plugin (open an example, edit, generate, attach) and fix API mismatches.
3. `npx wrangler login && npm run cf:deploy`; verify the deployed site and the hosted→local MCP path in Chrome.
4. Next language: follow `docs/LANGUAGE_ADAPTERS.md` (e.g. promote the test JS adapter to a real JavaScript/TypeScript backend with its own node pack).
