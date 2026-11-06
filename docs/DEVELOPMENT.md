# Development

Node.js 20+ (22 recommended). All commands run from the repository root.

```bash
npm install
npm run dev                # IDE at http://localhost:5173
npm run check              # typecheck + lint + unit/integration tests + production build
npm run test:e2e           # builds, serves on :4173 and runs Playwright (Chromium)
```

## Tests

| Suite | Location | Covers |
| --- | --- | --- |
| Compiler golden files | `tests/compiler/examples.test.ts`, `tests/fixtures/golden/*.gd` | All 12 examples compile to the checked-in GDScript; determinism; source maps |
| Diagnostics | `tests/compiler/diagnostics.test.ts` | Missing inputs, unavailable values, missing returns, cycles, type mismatches, dangling edges, unknown nodes, duplicates/reserved/shadowing, event signatures, target pins |
| Multi-language | `tests/compiler/multi-language.test.ts`, `tests/compiler/typescript.test.ts` | The same core-node graphs compile to JavaScript and run; TypeScript output passes `tsc --strict` and matches golden files |
| Performance | `tests/compiler/performance.test.ts` | 600-node graph: build, compile, structured merges, fast single edits |
| Unit | `tests/unit/*` | Type system, graph algorithms, edit operations (atomicity, sharing, validation, pruning, revisions), archives, migrations |
| Integration | `tests/integration/*` | MCP bridge origin/session/takeover rules, export safety, companion service |
| E2E | `tests/e2e/*` | Viewport, create/add/connect/edit/generate/save/reopen/export, inspector, invalid connections, undo/redo, diagnostics navigation, archive re-import, full MCP round trip incl. revision conflicts/atomic rejection/overwrite approval/undo/backups, 400-node graph |

Updating golden files after an intended generator change: `UPDATE_GOLDEN=1 npx vitest run tests/compiler/examples.test.ts`, then review the diff.

### Validating with Godot

The golden files prove *determinism*, not *validity*. To check validity against a real engine:

```bash
GODOT_BIN=/path/to/Godot_v4.x_linux.x86_64 npm run test:godot
```

This writes every example into a temporary Godot project and runs `godot --headless --check-only --script` on each file. Without `GODOT_BIN` the script exits with status 2 and says nothing was validated.

## Useful scripts

- `scripts/dev/csp-check.mjs [url]` — loads a served build (e.g. `wrangler dev`) and checks the app works under the production CSP.
- `EXAMPLES_OUT=apps/godot-addon/examples npx vitest run tests/compiler/examples.test.ts` — regenerate the Godot demo project files.

## Conventions

- Strict TypeScript; no `any` leaks across package boundaries.
- Packages must respect the layering in [ARCHITECTURE.md](ARCHITECTURE.md). Language specifics only in `packages/language-*`.
- Every document change goes through `applyOps`. Do not mutate projects in components.
