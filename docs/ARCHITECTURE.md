# Architecture

```
apps/
  web/                React 19 + Vite IDE (React Flow canvas, Monaco code view, Zustand, Dexie)
  godot-addon/        Godot 4 editor plugin (addons/coding_studio) + demo project with the examples
packages/
  type-system/        Language-neutral TypeRef, canonical type syntax, default compatibility rules
  graph-core/         Document model (scripts, functions, graphs, nodes, edges, diagnostics) + graph algorithms
  intermediate-representation/   Structured IR (modules, members, statements, expressions)
  node-registry/      NodeDefinition contract, registry, capability keys, core (language-neutral) node pack
  language-sdk/       LanguageAdapter interface, CodeWriter, capability helpers
  compiler-core/      Pipeline: analysis → lowering to IR → adapter validate/generate
  language-gdscript/  GDScript adapter: type rules, Godot API node pack, generator
  toolchain/          The one place that knows which languages exist (registry + adapters)
  project-format/     Project document, factories, migrations, atomic edit operations, archives
  shared-protocol/    MCP bridge wire protocol (shared by the server and the browser)
  examples/           12 example projects built with edit operations
mcp/
  server/             Stdio MCP server + loopback WebSocket bridge + safe export
  companion/          Loopback HTTP service exposing the compiler/ops to the Godot plugin
tests/                compiler (golden files, diagnostics, multi-language, performance), unit, integration, e2e
```

Packages are plain TypeScript source folders resolved through path aliases (`@cs/*`, see `tsconfig.json` and `aliases.ts`), so there is one toolchain (tsc, Vitest, Vite, esbuild) and no per-package build step.

## Layering

```
type-system ─► graph-core ─► intermediate-representation ─► node-registry ─► language-sdk ─► compiler-core
                                                                   │                              │
                                                       language-gdscript (adapter + node pack) ◄──┘
                                                                   │
                                     toolchain ─► project-format (ops) ─► apps/web · mcp/server · mcp/companion
```

- `graph-core`, `type-system`, `intermediate-representation`, `node-registry`, `language-sdk` and `compiler-core` know nothing about React, React Flow, Godot or any language.
- Everything GDScript- or Godot-specific lives in `language-gdscript`.
- The editor never generates code itself: it calls `compileProject` (in a Web Worker) and displays the result.

## Data flow

```
                ┌───────────────────────────── apps/web ─────────────────────────────┐
mouse/keyboard ─► useEditor.dispatch(ops) ─► applyOps (project-format) ─► new Project ─► history + autosave (Dexie)
Claude (MCP) ──► bridge handlers ──────────┘                                         └► compile worker ─► code view / diagnostics
```

- **One edit path.** UI gestures and MCP requests both become `EditOp[]` and go through `applyOps`, which validates against the node registry and the language adapter and is atomic (copy-on-write; unchanged scripts/graphs/nodes are shared with the previous state).
- **History** stores immutable project snapshots (cheap thanks to structural sharing). One batch = one undo step; typing in a field merges into one step.
- **Compilation** runs 250 ms after the last change in a Web Worker; the last successful output per script stays visible (marked stale) while errors exist.
- **Persistence**: autosave 800 ms after a change, on Ctrl+S, and when the page is hidden. Backups are taken before destructive or large edits.

## What was reused from GUI Studio

The repository [evanstom273/GUI-studio](https://github.com/evanstom273/GUI-studio) was inspected (`mcp/server.ts`, `mcp/protocol.ts`, `mcp/cli.ts`, `src/bridge/*`, `src/editor/history.ts`, `src/database/*`, `docs/ARCHITECTURE.md`, e2e tests). Adapted here:

| GUI Studio | Coding Studio |
| --- | --- |
| Claude Code → stdio MCP → Node server → 127.0.0.1 WebSocket → editor tab | Same topology (`mcp/server`, `apps/web/src/bridge`) |
| Origin allow-list (`GUI_STUDIO_ORIGINS`), stateless relay, tools validated with zod | Same (`CODING_STUDIO_ORIGINS`), plus payload limits and heartbeat |
| Edits executed in the editor through `commit()` → one undo step per batch | `dispatch()` → `applyOps`, same principle |
| `projectRevision()` + `expected_revision` | Same, hashing the editable document only |
| Backups in a settings table before substantial batches | Dedicated Dexie `backups` table, also for UI-destructive edits |
| `writeExport` with absolute dir, no path escape, no overwrite without flag | Extended: system-dir and symlink checks, extension allow-list, optional export roots, **and** user approval in the editor for overwrites |
| Snapshot history with merge keys | `apps/web/src/store/history.ts` (same algorithm, plus source tagging) |
| Forward-only migrations, newer schema rejected | `project-format/migrations.ts` (same rules, plus reported repair issues) |

Changed deliberately: GUI Studio lets the newest editor tab replace the connected one. Coding Studio requires an explicit **Take over** click, and tells the previous tab it lost control.

## Editor (apps/web)

- `store/editor.ts` — open project, active script/graph, selection, history, `dispatch`.
- `components/canvas/*` — React Flow canvas. Node visuals are derived from the document; node data objects are cached per `GraphNode` identity so unchanged nodes don't re-render.
- `components/panels/*` — toolbar, project explorer + node library, inspector (typed property editors generated from `PropSchema`), bottom panel (Monaco code view, errors, warnings, MCP activity, project info).
- `compile/*` — Web Worker compiler and debounced compile loop.
- `db/*` — Dexie schema v1 (`projects`, `backups`, `settings`).
- `bridge/*` — MCP bridge client (off by default) and request handlers.
