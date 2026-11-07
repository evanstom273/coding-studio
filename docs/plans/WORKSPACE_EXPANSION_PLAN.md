# Workspace, GitHub & Library Expansion — Technical Plan

Status: **proposal, awaiting approval. Nothing in this document is implemented yet.**
Revision 2: decisions from review applied: phone-first execution via **GitHub Actions**, GitHub moved earlier, the laptop host is optional, and Claude's remote actions (push, PR, merge, install) are **allowed by default** when asked for.
Scope: evolve Coding Studio from "visual scripts compiled to GDScript" into a project-aware, multi-language IDE that works with real repositories, real files and real libraries — with the node graph still at the centre — prioritising TypeScript / React / Vite / Tailwind / Dexie, and keeping Godot/GDScript working.

---

## 0. Summary of the key decisions

1. **The project becomes a real file tree.** A workspace is a set of files at paths. Visual graphs become ordinary files (`*.vgraph`) next to the source they generate, so a repository on GitHub, on disk and in the IDE all look the same. Today's single-document projects migrate into this automatically.
2. **One virtual filesystem interface, several backends**: IndexedDB in the browser (default), the user's disk via the local companion, the cloud (Durable Object + R2) for the Claude connector, and GitHub as a remote. Everything above the VFS is backend-agnostic.
3. **Graphs own the files they generate; existing code is called, not converted.** Visual graphs generate whole files. They can import and call any function, class, component or library symbol in the project, using real type information from the TypeScript language service. Arbitrary source → graph conversion is **not** promised (see §5).
4. **TypeScript's own compiler is the type authority for the web stack.** It runs in a Web Worker in the browser; `.d.ts` files come from the project's `node_modules` (via the companion) or are fetched from the npm CDN (verified: jsDelivr and the npm registry allow browser requests). Library nodes are generated from real declarations; framework patterns (React hooks/JSX, Dexie schemas and query chains, Tailwind classes) get small curated "framework packs".
5. **GitHub via the API first, real git via the companion second.** The REST + Git Data APIs can do browse/edit/commit/branch/compare/PR without any local git, and work on a phone. Merges with conflicts, rebases and offline history need real git — that's the companion's job. OAuth tokens are held server-side in the Worker, never in browser storage or files.
6. **Execution is phone-first, stated honestly**: the browser does editing, type checking, compiling graphs and live in-browser previews; **GitHub Actions** is the default place for install / build / test / deploy (triggered from the IDE or by commits, results shown in the IDE, works from a phone, free within GitHub's personal allowance); the **laptop host** (the single-file MCP server grown into a companion) is an optional power path for live dev servers and real git; a **cloud container** (e.g. Cloudflare Containers, paid) is a later option only if live dev servers on the phone turn out to be needed.
7. **MCP stays the same shape, grows wider.** Same atomic, revision-checked batches — extended from "graph operations" to "workspace operations" (files + graphs + dependencies in one batch). Local MCP, the served editor and the cloud connector all get the same tools.
8. **IR and graph model need real upgrades** before library nodes are worth building: modules/imports/exports, closures (functions as values), async/await, classes, object literals, try/catch. These are additive; GDScript keeps working and keeps its golden tests.

9. **Claude acts when asked.** If you ask Claude to commit, push, open or merge a PR, or install a package, it does it — no second confirmation. Revision checks and backups still apply, so nothing is silently overwritten. A setting can switch categories to "ask first" later.

Phase order (justified in §D): workspace & VFS → explorer, tabs & text editing → workspace MCP tools → **GitHub (API)** → **GitHub Actions** → TypeScript adapter & IR upgrades → TS language service → dependencies → library nodes → React/TSX packs & browser preview → laptop host (optional) → host git → cloud container (optional) → more languages.

---

## A. Existing architecture audit

Inspected at commit `9161191` (main). Sizes are lines of TypeScript/GDScript.

### A.1 What exists

| Area | Where | What it does | State |
| --- | --- | --- | --- |
| Type system | `packages/type-system` (223) | Canonical `TypeRef` (primitives, array, map, named+args, function, nullable), text syntax, default compatibility | Solid, small |
| Graph model | `packages/graph-core` (347) | `Project → ScriptDoc → FunctionDecl → Graph(nodes, edges)`; ids; diagnostics; Tarjan cycles, post-dominators, topo sort | Solid |
| Node registry | `packages/node-registry` (1296) | `NodeDefinition` (ports from props+context, props schema, capability requirements, `lowerExpr`/`lowerExec`), 87 core nodes | Solid; nodes are hand-written TS objects |
| IR | `packages/intermediate-representation` (303) | One module = one script; members: field, function, signal, enum; statements incl. if/while/for/match; expressions incl. call/prop/index/new/ternary/cast/`lang` escape | **Missing**: imports/exports, lambdas, async/await, classes beyond "the script", object literals, try/catch, JSX |
| Compiler | `packages/compiler-core` (844) | Declaration checks, graph analysis, structured lowering (post-dominator merges, scoped value availability), adapter validate/generate, source maps | Solid; **per-script**, no cross-file symbol resolution |
| Language SDK | `packages/language-sdk` (195) | `LanguageAdapter` (types, identifiers, events, templates, node pack, validate, generate), `CodeWriter` | Good shape; assumes one output file per script, no project-level hooks |
| GDScript | `packages/language-gdscript` (1487) | Type rules, 196 Godot nodes (curated API table), generator; 12 golden examples | Working; **not yet validated with a real Godot** |
| Project format | `packages/project-format` (1338) | `Project` document, schema v1 + migrations, `applyOps` (atomic, copy-on-write, `$ref`s), `.vproj` / `.vproj.json` | Central and good; **whole project is one JSON document** |
| Project service | `packages/project-service` (196) | Shared read-only views (describe project/graph, node schemas, compile/export) used by browser + cloud | New, good seam |
| Toolchain | `packages/toolchain` (33) | Language registry wiring | Trivial |
| Web editor | `apps/web/src` (4761, 51 files) | React 19 + React Flow canvas, explorer (scripts/functions/vars), inspector, Monaco **read-only** code view, compile worker, Dexie v1 (`projects`, `backups`, `settings`), autosave, history (whole-project snapshots), mobile drawers | Works; **single graph view, no tabs, no text editing, no files** |
| Local MCP | `mcp/server` (806) | stdio MCP, 43 tools (`tools.ts` shared), loopback WS bridge with origin allow-list, session ownership, relay between duplicate copies, safe disk export, serves the built editor on :47831 | Works, e2e tested |
| Claude connector | `worker` (503) | Worker + Durable Object: remote MCP endpoint; cloud copy of projects edited directly with the same `applyOps`; editor sync (newest-wins) + live updates | Works, deployed; **each project stored as one DO value** (and a 4 MB request cap) — doesn't scale to repositories |
| Godot companion & plugin | `mcp/companion` (183), `apps/godot-addon` (687 GDScript) | Loopback HTTP compile/apply service; GraphEdit plugin | Companion tested; **plugin never run in Godot** |
| Tests | `tests/**` | 62 unit/integration/compiler tests (golden files, diagnostics, executable test-only JS adapter, perf), 16 Playwright e2e (editor, MCP, served editor, duplicate servers, connector/cloud, mobile, large graphs) | Good coverage of what exists |

### A.2 Reusable as-is

- `applyOps` pattern (atomic, COW, `$ref`, structured errors) — becomes the workspace edit engine's graph half.
- Compiler pipeline, post-dominator structuring, scoped availability, source maps.
- `LanguageAdapter` / `NodeRegistry` / capability system — extended, not replaced.
- MCP stack: `tools.ts` + `Relay`/`ToolHost` split, bridge security model, duplicate-copy relay, served editor, cloud connector transport.
- Editor shell, canvas, inspector property editors, compile worker, toasts, dialogs, mobile layout.
- Test harnesses (golden files, executable adapter tests, wrangler-backed e2e).

### A.3 Needs extending

- **Data model**: from "project = list of scripts" to "workspace = file tree", graphs as files.
- **IR**: modules, imports/exports, closures, async, classes, object/record literals, try/catch, optional chaining, JSX (as a structured extension).
- **Graph model**: nested graphs owned by nodes (callbacks, component render bodies), generic type parameters on ports.
- **Compiler**: project-wide symbol table (cross-file calls/imports), multi-file emission with import management.
- **Persistence**: per-file storage, content-addressed blobs, larger-than-memory projects.
- **Editor**: tabs, file explorer, Monaco as an editor (not just a viewer), search, source control panel, output panel.
- **MCP**: file/dependency/language-service/git tools; batches spanning files.
- **Cloud store**: per-file rows + R2 blobs instead of one value per project.

### A.4 Limitations to be aware of (from inspection)

1. Whole-project JSON: every edit re-saves the whole document; history snapshots whole projects. Fine for graphs; wrong for repositories with thousands of files.
2. Cloud connector stores each project in a single Durable Object value and caps uploads at 4 MB.
3. No text source files at all; generated code is read-only and not persisted as files.
4. No cross-script references (documented limitation) — graphs can't call another script's functions in a typed way.
5. `TypeRef` named types have no member/generic knowledge; GDScript's API is a hand-curated table. Fine for Godot, not scalable to npm.
6. IR cannot express callbacks — and almost every JS/React API takes one.
7. Cloud sync is whole-project, newest-wins.
8. Godot output not validated against a real Godot; plugin untested.

---

## B. Proposed architecture

### B.1 Layers

```
┌──────────────────────────────── UI (apps/web) ────────────────────────────────┐
│ Explorer · Tabs · Graph editor · Monaco editor · Palette · Inspector ·        │
│ Diagnostics · Search · Source control · Dependencies · Output/terminal · Preview│
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │ commands / workspace ops                       │ status/events
┌───────────────┴──────────── Workspace core (packages/workspace) ┴──────────────┐
│ Workspace model · WorkspaceOps (atomic, revision-checked) · file kinds ·        │
│ change tracking (base vs working) · history · document registry               │
└──────▲──────────────▲──────────────────▲───────────────────▲───────────────────┘
       │              │                  │                   │
┌──────┴─────┐ ┌──────┴──────┐ ┌─────────┴─────────┐ ┌───────┴────────────────┐
│ VFS        │ │ Language    │ │ Graph compiler    │ │ Source control          │
│ providers  │ │ services    │ │ (existing, +IR,   │ │ GitProvider: GitHub API │
│ idb/opfs/  │ │ TS worker,  │ │ +multi-file,      │ │ | companion git         │
│ companion/ │ │ GDScript,   │ │ +symbol table)    │ │ merge/diff (diff3,      │
│ cloud      │ │ API catalog │ │                   │ │ graph-aware merge)      │
└──────▲─────┘ └──────▲──────┘ └─────────▲─────────┘ └───────▲────────────────┘
       │              │                  │                   │
┌──────┴──────────────┴──────────────────┴───────────────────┴──────────────────┐
│ Language & framework layer: LanguageAdapter (gdscript, typescript, …) ·        │
│ NodeRegistry · Framework packs (react, dexie, tailwind, godot) · API catalog   │
└────────────────────────────────────────────────────────────────────────────────┘
       │ execution requests (install, dev, test, build, git)
┌──────┴──────────────── Execution hosts ─────────────────────────────────────────┐
│ Browser (worker compile, esbuild-wasm preview) │ Local host (companion+MCP)    │
│                                                │ Remote host (optional, later)  │
└────────────────────────────────────────────────────────────────────────────────┘
MCP (local server, served editor, cloud connector) → WorkspaceOps + read APIs, same as the UI.
```

Rule kept from today: **every mutation goes through one op engine** (`WorkspaceOps`), whoever makes it (mouse, keyboard, Monaco, Claude, sync, git pull).

### B.2 Core data model

```ts
// packages/workspace
interface WorkspaceMeta {
  id: string; name: string;
  schemaVersion: 2;
  /** workspace config file contents (codingstudio.json) are a file, this is the parsed cache */
  config: WorkspaceConfig;
  backend: { kind: 'idb' } | { kind: 'companion'; root: string } | { kind: 'cloud'; key: string };
  remote?: { kind: 'github'; owner: string; repo: string; branch: string; baseCommit: string; baseTree: string };
}

type FileKind = 'text' | 'binary' | 'graph';            // decided by extension + config
interface FileEntry { path: string; kind: FileKind; size: number; hash: string /* sha1 of content, git-compatible blob hash */; mtime: number; generated?: { by: string /* graph path */ } }

interface WorkspaceConfig {                              // codingstudio.json at the repo root
  version: 1;
  languages: { [id: string]: { version?: string; sourceRoot?: string } };   // e.g. typescript, gdscript
  graphs: { include: string[]; outputRule: 'sibling' | { dir: string } };  // where generated files go
  frameworks?: string[];                                 // react, dexie, tailwind, godot
  compiler?: Partial<CompilerSettings>;
}
```

**Graph files.** A `*.vgraph` file holds today's `ScriptDoc` plus `language` and `output` path (JSON, stable key order, ids preserved). One graph file → one generated source file (`player.vgraph → player.gd`, `TodoList.vgraph → TodoList.tsx`). Generated files carry the existing header and are marked `generated` in the file index; the editor opens them read-only with an "edit the graph" link. *Why one file per graph:* diffs, PRs and merges stay per-file; Git and GitHub treat graphs as ordinary files; Godot projects keep `*.gd` beside `*.vgraph` exactly as the plugin already expects.

**Migration of existing projects (schema 1 → 2):** each `ScriptDoc` → `<script.path>.vgraph`; `codingstudio.json` from project settings; generated `.gd` files written once. Old `.vproj`/`.vproj.json` remain importable forever (migrations are additive; the Godot plugin keeps reading v1 until it is updated in the GDScript phase).

### B.3 Workspace operations (extending `applyOps`)

```ts
type WorkspaceOp =
  | { op: 'write_file'; path: string; content: string | { base64: string }; expectedHash?: string | null }  // null = must not exist
  | { op: 'create_dir' | 'delete'; path: string; recursive?: boolean }
  | { op: 'move' | 'copy'; from: string; to: string; overwrite?: boolean }
  | { op: 'graph'; path: string; ops: EditOp[] }                 // existing graph ops, scoped to a .vgraph file
  | { op: 'deps'; manifest: string; add?: Dep[]; remove?: string[]; update?: Dep[] }  // edits package.json etc. (not install)
  | { op: 'config'; patch: Partial<WorkspaceConfig> };
```

- Atomic across files: validated against a snapshot, committed as one transaction (Dexie transaction / companion temp-dir+rename / DO SQL transaction).
- Revisions: per-file `hash` (git blob sha1) + workspace revision (hash of the path→hash index). `expectedHash` per file gives fine-grained optimistic concurrency, so Claude editing `a.ts` doesn't conflict with the user editing `b.ts`.
- History: per-batch **file-level deltas** (`{path, beforeHash, afterHash}` with blobs content-addressed), not whole-project snapshots. Undo = apply inverse delta if current hashes match `afterHash` (same safety rule the cloud undo uses today).
- Text edits from Monaco are coalesced into `write_file` ops on a debounce (with merge keys, like today's inspector typing).

### B.4 Virtual filesystem

```ts
interface VfsProvider {
  readonly kind: 'idb' | 'opfs' | 'companion' | 'cloud';
  list(dir: string): Promise<FileEntry[]>;           // and a whole-index call for fast startup
  index(): Promise<Map<string, FileEntry>>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  commit(changes: FileChange[], expected: Record<string, string | null>): Promise<CommitResult>; // atomic
  watch?(cb: (changes: FileChange[]) => void): () => void;  // companion (disk watcher) and cloud (DO broadcasts)
}
```

- **Browser default (IndexedDB, Dexie schema v2)**: `workspaces`, `files` (`[wsId+path]` → entry), `blobs` (`hash` → Blob; content-addressed, shared between history, git base and working copy), `history`, `typesCache` (fetched `.d.ts`), `uiState` (tabs, layout; kept out of files). Existing v1 tables kept; migration copies projects into workspaces lazily on first open.
- **OPFS** (Origin Private File System) for large binaries and big repos: faster, worker-accessible (`createSyncAccessHandle`), same quota. Behind the same `blobs` abstraction.
- **Companion** (user's disk): the real folder; `watch` via filesystem events; ideal for big repos and for anything that runs tools.
- **Cloud** (Claude connector): Durable Object SQLite table `files(path, hash, size, kind)` + R2 (or DO rows ≤ 1 MB chunks) for blobs. Replaces today's one-value-per-project store (fixes A.4-2).
- **Quotas**: call `navigator.storage.persist()`; show usage (`storage.estimate()`); warn early. Chromium allows a large share of disk; Firefox and Safari are stricter and Safari can evict script-written storage after inactivity — recommend the companion or GitHub as the durable home for real repos, with the browser as a cache.

### B.5 Language services

```ts
interface LanguageService {
  languageId: string;
  diagnostics(paths?: string[]): Promise<Diagnostic[]>;
  completions(path: string, offset: number): Promise<Completion[]>;
  hover / definition / references / rename / organizeImports / codeFixes
  /** symbols a graph can use: exports of project files and libraries, with types */
  symbols(query: SymbolQuery): Promise<ApiSymbol[]>;
  /** type relation used for live connection validation */
  isAssignable(from: TypeHandle, to: TypeHandle): Promise<boolean>;
}
```

- **TypeScript/JavaScript**: `typescript` package's `LanguageService` in a dedicated Web Worker, with a `LanguageServiceHost` backed by the VFS. Monaco is wired to it (custom providers) so the text editor and the graph editor share **one** program and one set of diagnostics. Type definitions: from `node_modules` when the companion has installed them; otherwise fetched on demand from jsDelivr by package/version from `package.json`/lockfile (the TypeScript team's `@typescript/ata` does exactly this) and cached in IndexedDB. *Trade-off:* not reusing Monaco's built-in TS worker costs some setup, but the built-in worker can't serve symbol discovery or type relations to the graph editor.
- **GDScript**: keeps today's adapter-based checking; a real Godot language server is out of scope (would need Godot running).
- **Others later**: Python (Pyright in a worker), Rust/C#/Java via LSP servers on the companion.

### B.6 Library APIs as nodes

```ts
interface ApiSymbol {
  id: string;                       // "npm:dexie@4.0.8#Table.where" | "file:src/db.ts#addTodo"
  source: { kind: 'package'; name: string; version: string } | { kind: 'file'; path: string };
  kind: 'function' | 'class' | 'method' | 'property' | 'component' | 'hook' | 'type' | 'interface' | 'enum' | 'constant';
  name: string; container?: string;
  signatures: { typeParams: string[]; params: { name: string; type: TypeHandle; optional: boolean; rest?: boolean }[]; returns: TypeHandle; async: boolean }[];
  docs?: string;
  importSpec: { module: string; named?: string; default?: boolean; typeOnly?: boolean };
}
```

- **Automated (from `.d.ts` via the TS checker)**: functions, overloads, classes (construct, methods, properties), constants, enums, interfaces/types (as data shapes), project-local exports. A **generic node family** turns any `ApiSymbol` into nodes: *Call*, *Await call*, *Construct*, *Get/Set property*, *Method on value*, *Make object of type*. Ports come from the signature; the node stores only the symbol id + chosen overload, so it survives library upgrades and re-resolves types.
- **Type handles**: the TS checker owns real types. Ports carry a `TypeHandle` (stable textual type + symbol reference) and a coarse `TypeRef` projection for colour/quick checks. Connection validation asks the service (`isAssignable`); final authority is compiling the generated file and mapping `tsc` diagnostics back to nodes through source maps (the compiler already produces them).
- **Curated framework packs** (where structure, not just calls, matters):
  - **React**: component graphs (props → render), hooks with the rules of hooks enforced by graph structure, JSX element tree editor, event handlers as nested graphs, conditional/list rendering nodes.
  - **Dexie**: schema designer → typed `Dexie` subclass; query builder nodes for fluent chains (`where().equals().toArray()`), transactions; `useLiveQuery` bridge for React.
  - **Tailwind**: class composer with validation against the project's Tailwind version/config; emits `className` strings.
  - **Godot**: today's curated table, migrated into a pack (could later be generated from Godot's `extension_api.json`, which is machine-readable).
- **User nodes**: (a) any exported function/component in the project automatically appears in the palette; (b) "macro graphs" saved as reusable `.vgraph` functions; (c) packs can be published as JSON metadata + optional lowering code.

### B.7 IR and graph upgrades (additive)

- IR: `IRModule.imports/exports` (named/default/type-only/side-effect), `IRExpr` `lambda` (params, body, async, captures), `await`, `object` literal, `optionalChain`, `spread`, `template` string, `IRStmt` `try`, `throw`, `class` members (constructor, methods, getters, static), `type`/`interface` declarations, structured `jsx` (element, props, children, fragments, expressions).
- Graph: nodes may own **subgraphs** (`node.subgraphs: Record<slot, Graph>`) — callbacks, render bodies, event handlers; ports may carry generics resolved per instance.
- Compiler: project-wide **symbol table** (graph files + language-service symbols) so a graph can reference another graph's function or any project export; **multi-file emission** with an import manager (dedupe, relative paths, type-only imports, alias collisions).
- GDScript keeps working because these are new cases; its adapter simply reports `E_UNSUPPORTED` for constructs it can't express (as it already does for foreign `lang` nodes).

### B.8 Source control

```ts
interface GitProvider {
  kind: 'github-api' | 'companion-git';
  status(): Promise<FileStatus[]>;                         // working vs base
  diff(path: string): Promise<Diff>;                       // text: unified; .vgraph: semantic (nodes/edges added/removed/changed)
  log(ref?: string, path?: string): Promise<Commit[]>;
  branches(): Promise<Branch[]>; createBranch(name: string, from: string): Promise<void>; checkout(ref: string): Promise<void>;
  commit(message: string, paths?: string[]): Promise<Commit>;   // github-api: blobs → tree → commit → update ref
  pull(): Promise<MergeResult>; push(): Promise<void>;
  compare(base: string, head: string): Promise<Comparison>;
  pullRequests: { list; create; get; comments; review };
}
```

- **GitHub API provider (browser + Worker)**: base = a commit/tree sha; working copy = VFS; status = hash comparison (VFS uses git blob hashes so no content download is needed to compare); commit = Git Data API (create blobs, tree with `base_tree`, commit, update ref with `force: false` → a rejection means "remote moved"); pull = fetch new tree, three-way merge per file in the browser (`node-diff3` for text; **graph-aware merge** for `.vgraph` by node/edge id; conflicts surfaced in a merge editor). Branches, compare, PRs, reviews: REST.
- **GitHub Actions as the execution backend** (phone-first): the IDE adds a workflow (`.github/workflows/coding-studio.yml`: install → build → test → optional `wrangler deploy` using a repository secret), triggers it on push or on demand (`workflow_dispatch` API), and shows runs, step logs, test failures (mapped to files/nodes where possible) and artifacts. Needs GitHub App permissions `actions: write`, `checks: read`, `workflows: write`. Limits: queue/start latency (tens of seconds to minutes), monthly minutes for private repos, no interactive dev server — the in-browser preview covers live iteration.
- **Companion git provider**: shells out to real `git` in the companion's workspace folder. Full fidelity: rebase, cherry-pick, stash, blame, LFS, submodules, large repos, offline.
- **Auth**: a **GitHub App** (fine-grained, per-repo permissions, user-to-server tokens, revocable). OAuth web flow; the code→token exchange happens in the Worker (needs the client secret, and GitHub's token endpoint doesn't allow browser calls). Token stored encrypted in a Durable Object, session via `HttpOnly; Secure; SameSite=Lax` cookie; the browser calls GitHub through the Worker (or receives short-lived installation tokens). Never in localStorage, files, generated code or logs. The companion can alternatively use the user's existing `gh`/git credentials.

### B.9 Execution hosts

```ts
interface ExecutionHost {
  kind: 'browser' | 'github-actions' | 'local' | 'remote';
  capabilities: { install: boolean; run: boolean; devServer: boolean; tests: boolean; git: boolean; shell: boolean };
  run(task: Task): TaskHandle;      // streams output to the Output panel; cancellable
}
```

- **Browser**: graph compile, TS type-check, esbuild-wasm bundling for previews with CDN-resolved imports (esm.sh — verified browser-accessible), sandboxed `<iframe>` preview, Tailwind's browser build for previews. Cannot: run npm install, native tools, Vite plugins needing Node, tests with Node APIs.
- **GitHub Actions (default for real tooling)**: see B.8 — install, build, tests, deploy, all from a phone.
- **Local host (optional)**: today's single-file MCP server grows into the "Coding Studio host" (MCP + served editor + companion + execution) — still one `.mjs` file to run. Adds: workspace folders on disk, `npm/pnpm` install, `vite dev` with the preview proxied into the IDE, `vitest`/`playwright`, `tsc`, git, `wrangler deploy`. Permissions: per-workspace folder allow-list, command allow-list (package-manager scripts from the manifest, git, tsc…), explicit confirmation for anything else.
- **Cloud container (optional, later)**: same protocol, hosted (e.g. Cloudflare Containers/Sandbox — paid, cold starts) — only if live dev servers from the phone become necessary. WebContainers were considered: they run Node in the browser but require cross-origin isolation headers and a commercial licence for some uses — noted as an alternative, not the plan.

### B.10 MCP tools (same principles, wider reach)

New tool groups (available through local MCP, the served editor and the cloud connector, subject to host capability):
- **Workspace**: `list_workspaces`, `open_workspace`, `read_tree`, `read_files` (batched, with hashes), `search` (text + symbol), `workspace_batch` (any mix of file/graph/deps/config ops, atomic, `expected_hash`es), `move`, `delete`.
- **Graphs**: existing tools, addressed by `.vgraph` path.
- **Language**: `diagnostics`, `symbols`, `find_references`, `go_to_definition`, `rename_symbol` (as a previewed batch).
- **Dependencies**: `list_dependencies`, `add_dependency` / `remove_dependency` (manifest edits), `install` (local host only), `package_info` (registry metadata), `type_info`.
- **Generation**: `compile_workspace`, `generated_output(path)`.
- **Source control**: `git_status`, `git_diff`, `git_log`, `create_branch`, `prepare_commit` (returns staged summary), `commit` (requires user confirmation by default), `push`, `create_pull_request` (confirmation), `pull`.
- **CI** (GitHub Actions): `setup_workflow`, `run_workflow`, `list_runs`, `get_run` (status, failed steps, test results), `get_run_logs`, `deploy` (runs the deploy workflow).
- **Execution** (local host, optional): `run_task` (manifest scripts), `run_tests`, `dev_server` start/stop/url, output tail.
Safety (decided): when the user asks Claude to commit, push, open/merge a PR, run a workflow or change dependencies, Claude does it directly — **no second confirmation**. What stays: revision/hash checks (nothing overwritten silently), backups before deletions and large batches, undo, and an activity log of everything Claude did. Force-pushes and deleting branches/repositories are never done implicitly — only when explicitly asked for by name. A per-category "ask first" setting exists for anyone who wants it.

### B.11 Proposed directory structure

```
packages/
  type-system/  graph-core/  intermediate-representation/  node-registry/
  compiler-core/            # + project symbol table, multi-file emission, import manager
  language-sdk/             # + LanguageService, ProjectAdapter (manifests, layout), framework pack API
  language-gdscript/        # unchanged behaviour; Godot pack extracted
  language-typescript/      # NEW: TS/JS/TSX adapter (emitter), TS language service host, type bridge
  workspace/                # NEW: model, WorkspaceOps, history deltas, change tracking, config
  vfs/                      # NEW: VfsProvider + idb, opfs, companion, cloud providers
  api-catalog/              # NEW: ApiSymbol model, d.ts extraction, generic API nodes, caching
  frameworks/react/  frameworks/dexie/  frameworks/tailwind/  frameworks/godot/   # NEW: curated packs
  dependencies/             # NEW: manifest/lockfile parsing (npm first), registry & types fetching
  source-control/           # NEW: GitProvider, diff, diff3 merge, graph-aware merge
  project-format/           # v1 project docs + migration to workspaces (kept for compatibility)
  project-service/  shared-protocol/  toolchain/  examples/
apps/
  web/src/{workspace,explorer,tabs,editors/{graph,text,image},search,scm,deps,output,preview}/
  godot-addon/
host/                       # renamed/extended mcp/: one local process
  mcp/  bridge/  companion/  exec/  git/  fs/
worker/                     # Worker: assets, connector, cloud workspaces (DO + R2), GitHub OAuth & proxy
tests/ (unit, compiler, integration, e2e, fixtures/workspaces/*)
docs/
```

---

## C. Technical feasibility

Legend: **B** = browser only · **L** = local host (companion) · **R** = remote backend · **W** = Cloudflare Worker (already deployed).

| Feature | Feasible | Runs where | Tools / APIs | Limits | Security notes |
| --- | --- | --- | --- | --- | --- |
| Folder/file tree, CRUD, move/copy | Yes | B (+L/W providers) | Dexie v2, OPFS | Browser quota; Safari eviction | Path normalisation; no `..` |
| Tabs, unsaved state, conflicts | Yes | B | Monaco models, workspace hashes | — | — |
| Text editing | Yes | B | Monaco | Very large files (>5 MB) need read-only mode | — |
| Binary assets | Yes | B | Blobs/OPFS, image/audio previews | Repo-size limits | Size caps on uploads |
| Project-wide search | Yes | B (worker) / L (ripgrep) | In-worker index; ripgrep on host | Large repos slow in browser | — |
| Backups / export / import | Yes | B | Content-addressed blobs, zip (fflate, already used) | — | — |
| Big repositories | Partly | L best; B as cache | Companion fs + git | Browser storage & memory | — |
| GitHub sign-in | Yes | W + B | GitHub App, OAuth web flow | Needs Worker secret | Token never in browser storage |
| Browse/open/create repos | Yes | W/B | REST `repos`, `git/trees?recursive=1` | Tree API truncates very large trees (falls back to per-dir) | Least-privilege App permissions |
| Edit, commit, branch, compare, PRs | Yes | W/B | Git Data API, refs, compare, pulls | Rate limits (5k/h user) | Confirmation for push/PR |
| Pull with conflicts | Yes (text/graph) | B | node-diff3, graph-aware merge | No rebase via API | — |
| Rebase, cherry-pick, stash, blame, LFS, offline | Yes | L | real git | Needs companion | — |
| Visual ↔ source sync (graph-owned files) | Yes | B | existing compiler + source maps | Generated files read-only | — |
| Arbitrary source → graph | **No (lossless)** | — | — | See §5 | — |
| Calling existing code from graphs | Yes | B | TS language service symbols | Types from the project | — |
| package.json understanding, versions, constraints | Yes | B | npm registry (CORS ok), semver | — | — |
| Type definitions for deps | Yes | B (CDN) / L (node_modules) | jsDelivr/unpkg, `@typescript/ata` | Packages without types → `any` | Fetch only from known CDNs |
| Installing deps / correct lockfile | Yes | **L/R only** | npm/pnpm | Not possible in plain browser | Scripts run on host: confirmation |
| Library nodes (automatic) | Yes | B | TS checker over `.d.ts` | Overload/generic UX needs care | — |
| Framework patterns (hooks, JSX, fluent chains) | Yes, curated | B | framework packs | Each pack is real work | — |
| Autocomplete, go-to-def, references, rename | Yes (TS/JS) | B | TS LanguageService + Monaco | Memory on big projects | — |
| Type-checking / diagnostics project-wide | Yes | B / L for big | TS in worker; `tsc` on host | — | — |
| Previews | Partly | B (simple), L (real) | esbuild-wasm + esm.sh; Vite dev on host | Browser previews can't run Node-only plugins | Sandboxed iframe, separate origin |
| Builds, tests, deploy from a phone | Yes | **GitHub Actions** | Actions REST API, workflow files | Start latency; private-repo minutes | Deploy token as a repo secret, never in files |
| Live dev server | Yes | **L/R** | vite | Not on a phone without a container | Command allow-list |
| Deploy (Cloudflare) | Yes | L (wrangler) / W API | wrangler, Cloudflare API | Needs user's CF token | Token on host only |
| MCP for whole workspace | Yes | B/L/W | existing stack | Connector can't run tools without a host | Confirmations, revision checks |

---

## D. Phased roadmap

Order rationale (revision 2, phone-first): **workspace MCP tools move early** (phase 3) because MCP drives much of this and later phases only add tools; **GitHub (phase 4) and GitHub Actions (phase 5) come next** because on a phone the repository *is* the durable home of a project and Actions is where real builds/tests/deploys run — and both work for existing hand-written repos before any visual TypeScript exists; **the TypeScript adapter + IR upgrades come before the language service** because graphs must be able to emit TS before typed library nodes have anything to emit into; **the laptop host and cloud container become optional late phases**; **cloud workspace storage** is folded into phase 1 so the connector doesn't regress.

Phase numbering below follows the original write-up; the order to build them in is: **1 → 2 → 3 → 10 (GitHub) → 10a (Actions) → 4 → 5 → 6 → 7 → 8 → 9 (host, optional) → 11 → 9a (cloud container, optional) → 12.**

Each phase ends with: typecheck, lint, all existing tests green (including the 12 GDScript golden files), new tests green, docs updated, deployable.

### Phase 1 — Workspace & VFS foundation
- Prereqs: none.
- Deliverables: `packages/workspace`, `packages/vfs` (idb + OPFS blob store), Dexie schema v2, `.vgraph` file format, `codingstudio.json`, WorkspaceOps with per-file hashes and delta history, migration v1 projects → workspaces, cloud provider (DO SQL rows + R2/chunks) replacing one-value-per-project, sync protocol updated to per-file.
- Acceptance: existing projects open unchanged (as workspaces) and compile to identical GDScript; 5 000-file synthetic workspace loads its index in < 1 s; atomic multi-file batch rollback proven; cloud connector works with a > 10 MB workspace.
- Tests: unit (ops, hashes, migration round-trip, delta undo), integration (Dexie + fake-indexeddb, DO under wrangler), golden files unchanged.

### Phase 2 — Explorer, tabs, text editing
- Prereqs: 1.
- Deliverables: file explorer (tree, drag-move, context menus, new/rename/delete, reveal), tab bar with dirty markers and split view, Monaco editor for text files (writes via WorkspaceOps), image/audio/font previews, generated files read-only with "open graph", project-wide text search, workspace backups/import/export (zip), conflict UI when a file changed underneath an open editor, responsive behaviour (drawers on mobile, as today).
- Acceptance: create a folder structure, edit `.ts`/`.css`/`.md` files, rename/move with open tabs following, undo across files; mobile layout still passes.
- Tests: e2e explorer/tabs/editing, unit for path ops.

### Phase 3 — Workspace MCP tools
- Prereqs: 1–2.
- Deliverables: `read_tree`, `read_files`, `workspace_batch`, `search`, `move`, `delete`, graph tools addressed by path; same tools in local MCP, served editor and cloud connector; confirmation for deletes outside generated files.
- Acceptance: Claude creates a multi-file project with folders and graphs in one atomic batch; stale `expected_hash` rejected; UI updates live.
- Tests: MCP e2e (local + connector under wrangler).

### Phase 4 — TypeScript language adapter & IR upgrades
- Prereqs: 1.
- Deliverables: IR additions (imports/exports, lambdas, async/await, object literals, classes, try/catch, optional chaining, template strings), nested subgraphs, project symbol table, multi-file emission + import manager, `language-typescript` emitter (TS/JS), core nodes rendered for TS, `async`/callback node patterns.
- Acceptance: golden-file graphs for TS covering every new IR construct; generated TS passes `tsc --noEmit --strict`; the test-only JS adapter is retired in favour of the real one (executed outputs still tested); GDScript goldens unchanged.
- Tests: golden files + type-check of outputs in CI + execution of JS outputs in node.

### Phase 5 — TypeScript language service
- Prereqs: 2, 4.
- Deliverables: TS worker with VFS host; Monaco wired to it (completions, hover, diagnostics, go-to-def, references, rename, organise imports, quick fixes); diagnostics panel merges TS + graph diagnostics; generated-file diagnostics mapped to graph nodes via source maps; project symbols in the node palette ("Call `formatDate` from src/utils.ts").
- Acceptance: graph calls a hand-written TS function with type-checked ports; renaming the function updates the graph reference; type error in generated code highlights the node.
- Tests: worker unit tests, e2e for editor features, perf check on a 500-file project.

### Phase 6 — Dependencies
- Prereqs: 5.
- Deliverables: `packages/dependencies` (package.json + lockfile parsing, semver, registry metadata via npm registry API), dependency browser panel (search, versions, add/remove → manifest edits), type acquisition from jsDelivr into cache, clear states: *declared* / *types available* / *installed (host)*.
- Acceptance: adding `dexie` and `react` makes their types available to the editor and graphs without a backend; lockfile changes are explicitly marked as "requires install on a host".
- Tests: unit with recorded registry fixtures; integration against real CDN behind a flag.

### Phase 7 — Library-aware visual nodes
- Prereqs: 5–6.
- Deliverables: `packages/api-catalog` (d.ts → ApiSymbol), generic API node family, overload/generic pickers, import generation, live connection validation via `isAssignable` + post-compile verification, palette grouped by package/module, user macro-graphs.
- Acceptance: build a graph using `date-fns` / `zod` / `dexie` purely from palette nodes; generated code compiles and runs; upgrading a package re-resolves nodes or reports exactly which became invalid.
- Tests: catalog extraction snapshots for pinned package versions; end-to-end graph→code→run.

### Phase 8 — React/TSX & web framework packs
- Prereqs: 7.
- Deliverables: React pack (component graph, props/state/effects/memo/refs/context, event-handler subgraphs, JSX tree editor, conditional/list rendering), Dexie pack (schema designer, query builder, transactions, `useLiveQuery`), Tailwind pack (class composer, config-aware), Vite + React + Tailwind + Dexie project template, browser preview (esbuild-wasm + esm.sh, sandboxed iframe).
- Acceptance: a working todo app (React + Dexie + Tailwind) built visually, type-checks, previews in the browser, and builds with Vite on the host in phase 9.
- Tests: golden TSX, rules-of-hooks enforcement tests, preview smoke test.

### Phase 9 — Local execution host (optional, laptop) — done: MCP tools `open_folder`, `link_folder`, `sync_folder`, `install`, `run_task`, `run_tests`, `dev_server`, `task_output` (see docs/MCP.md) and the editor's Computer panel
- Prereqs: 1, 3 (and 8 for the showcase).
- Deliverables: single-file "Coding Studio host" (existing MCP server + companion merged): disk workspaces (open folder), file watching, install, run scripts, Vite dev server proxied into a preview tab, test runner integration with results linked to files/nodes, output console, wrangler deploy; command allow-list + confirmations; MCP tools `run_task`, `run_tests`, `dev_server`, `install`.
- Acceptance: open an existing Vite repo from disk, install, run dev server, edit visually and see hot reload, run tests from the IDE.
- Tests: integration tests spawning the host against fixture workspaces.

### Phase 10 — GitHub (API provider)
- Prereqs: 1–2 (independent of 4–9; can start in parallel).
- Deliverables: GitHub App + Worker OAuth + token vault (DO) + API proxy; repo browser, clone-into-workspace (tree + lazy blobs), status/diff (text + semantic graph diff), commit, branches, compare, pull (three-way merge, merge editor, graph-aware merge), push, PR create/list/review, private repos.
- Acceptance: on a phone, open a private repo, edit a graph and a TS file, commit to a new branch, open a PR; concurrent remote change produces a correct merge or a clear conflict UI.
- Tests: provider against recorded GitHub fixtures + a sandbox repo e2e behind a flag; merge unit tests (text + graph).

### Phase 10a — GitHub Actions (builds, tests, deploys from a phone)
- Prereqs: 10.
- Deliverables: workflow templates (Vite/TS: install, typecheck, build, test; optional Cloudflare deploy via `wrangler` with `CLOUDFLARE_API_TOKEN` as a repo secret); "Run" panel to trigger workflows and follow runs; logs viewer; failed tests/type errors linked to files and nodes; status on commits/PRs; artifacts download; MCP CI tools.
- Acceptance: from a phone, commit a change, see the workflow run, open a failing test's log line in the editor, fix, re-run green, deploy.
- Tests: provider against recorded Actions API fixtures; sandbox repo e2e behind a flag.

### Phase 9a — Cloud container (optional)
- Prereqs: 9.
- Deliverables: same host protocol running in a hosted container (live dev server + preview from a phone).
- Only if needed; has a monthly cost.

### Phase 11 — Git via the host + source-control MCP tools — done: `local_git` (rebase, stash, cherry-pick, merge, blame, LFS, any remote) and git in the Computer panel
- Prereqs: 9–10.
- Deliverables: companion git provider (rebase, stash, cherry-pick, blame, LFS), same SCM panel, MCP `git_*` / `prepare_commit` / `create_pull_request` with confirmations.
- Acceptance: identical UI flows over both providers; large repo (≥ 50k files) usable via host.

### Phase 12 — More languages & frameworks
- Prereqs: 4–5 patterns proven.
- Deliverables (each its own sub-phase): Godot pack generated from `extension_api.json`; Python (Pyright worker), C# / Java / Rust via host LSPs; framework packs as needed.
- Acceptance per language: golden files + real toolchain validation (as the GDScript plan intended with `GODOT_BIN`).

---

## E. Risks and trade-offs

| Risk | Why it's hard | Mitigation |
| --- | --- | --- |
| Large repos in the browser | Memory, IndexedDB write speed, quota, Safari eviction | Index-first loading, lazy blobs, OPFS, content addressing; steer big repos to the host; browser as cache |
| Browser storage limits | Varies by browser; can be cleared | `storage.persist()`, usage meter, GitHub/host/cloud as durable copies, backups |
| Dependency resolution | Real resolution needs npm (peer deps, scripts, platform builds) | Browser only *reads* manifests/lockfiles and fetches types; installs only on a host; never fake a lockfile |
| Library API discovery | `.d.ts` quality varies; huge APIs (e.g. DOM); overloads/generics | Pinned-version catalog cache, search-first palette, curated packs for patterns, `any`-typed fallback nodes |
| Bidirectional sync | Arbitrary code has no canonical graph | Graph-owned files + calling code + opaque code nodes; read-only visualisation later; no lossless promise |
| Type-safe connections | TS types are structural, generic, conditional | TS checker as authority; coarse colours for UX; post-compile diagnostics as the final check |
| GitHub auth | Secrets can't live in the browser; token endpoint has no CORS | Worker-side OAuth and token vault; GitHub App fine-grained permissions |
| Conflicts | API has no merge for working copies; graphs aren't line-based | Browser three-way merge; id-based graph merge; host git for hard cases |
| Browser vs backend | Users will expect "Run" to work everywhere | Capabilities shown explicitly per host; browser preview for simple apps; host for real tooling |
| Compatibility | Existing projects, Godot plugin, MCP clients | Additive schema migrations, golden files as tripwires, v1 import kept, tool names stable (new tools added, old kept) |
| Scope | This is several products' worth of work | Strict phase gates; each phase shippable and useful alone |

---

## F. Implementation checklist

Each item should be a single session-sized change with tests. Tick only when merged with tests green.

**Phase 1**
- [ ] 1.1 `packages/workspace`: types (`WorkspaceMeta`, `FileEntry`, `WorkspaceConfig`), path utils (normalise, join, validate), git blob hashing.
- [ ] 1.2 `packages/vfs`: `VfsProvider` interface + in-memory provider for tests.
- [ ] 1.3 `WorkspaceOps.apply` for file ops (write/create_dir/delete/move/copy) with `expectedHash`, atomic, structured errors.
- [ ] 1.4 `.vgraph` codec (ScriptDoc ↔ file), `graph` op delegating to existing `applyOps` per file.
- [ ] 1.5 Delta history + undo/redo with hash guards.
- [ ] 1.6 Dexie v2 schema + idb provider + blob store (+ OPFS backend behind a flag).
- [ ] 1.7 Migration v1 project → workspace; golden-file equality test.
- [ ] 1.8 Editor store backed by a workspace (current single-graph UI working on top of it).
- [ ] 1.9 Cloud provider: DO SQL `files` table + blob chunks/R2; per-file sync protocol; connector tests updated.
- [ ] 1.10 Docs: PROJECT_FORMAT v2, migration notes.

**Phase 2**
- [ ] 2.1 File explorer tree (virtualised) with create/rename/delete/move, context menu, keyboard.
- [ ] 2.2 Tabs + split view; persisted UI state outside files.
- [ ] 2.3 Monaco text editor writing via WorkspaceOps (debounced, merge keys); dirty/close prompts.
- [ ] 2.4 Graph editor as a tab type (current canvas) per `.vgraph` file.
- [ ] 2.5 Generated-file handling (read-only, "open graph").
- [ ] 2.6 Binary previews (image/audio/font) and uploads.
- [ ] 2.7 Workspace search (worker index).
- [ ] 2.8 External-change conflict UI.
- [ ] 2.9 Zip import/export + backups; mobile layout tests.

**Phase 3**
- [ ] 3.1 Tool schemas + `project-service` read APIs for trees/files/search.
- [ ] 3.2 `workspace_batch` (files + graphs + config) in browser handlers and cloud service.
- [ ] 3.3 Activity log + backups for Claude's batches; MCP e2e (local + connector).

**Phase 4**
- [ ] 4.1 IR: imports/exports + import manager; GDScript reports unsupported.
- [ ] 4.2 IR: lambdas + nested subgraphs in graph-core and lowering.
- [ ] 4.3 IR: async/await, try/catch/throw, object literals, optional chaining, template strings.
- [ ] 4.4 IR: classes, interfaces/type aliases.
- [ ] 4.5 Project symbol table; cross-file graph calls.
- [ ] 4.6 `language-typescript` emitter (TS + JS output modes) with golden files and `tsc` validation in tests.

**Phase 5**
- [ ] 5.1 TS worker + VFS-backed host; incremental updates from WorkspaceOps.
- [ ] 5.2 Monaco providers (completion, hover, diagnostics, definition, references, rename, organise imports).
- [ ] 5.3 Diagnostics panel merge; generated-code diagnostics → nodes.
- [ ] 5.4 Project exports as palette nodes; rename-safe references.

**Phase 6**
- [ ] 6.1 Manifest/lockfile parsing (npm/pnpm/yarn read-only), semver.
- [ ] 6.2 Registry metadata client + cache.
- [ ] 6.3 Type acquisition (jsDelivr) + cache + status per dependency.
- [ ] 6.4 Dependency browser UI + MCP dependency tools.

**Phase 7**
- [ ] 7.1 d.ts → ApiSymbol extraction (functions, classes, members, overloads, generics).
- [ ] 7.2 Generic API node family + overload/generic UI.
- [ ] 7.3 Live `isAssignable` connection checks; post-compile verification.
- [ ] 7.4 Macro graphs / user nodes.

**Phase 8**
- [ ] 8.1 React: component graph, props, hooks (rules enforced), JSX tree editor.
- [ ] 8.2 React: event handlers, conditional/list rendering, context.
- [ ] 8.3 Dexie pack: schema designer, query builder, transactions, `useLiveQuery`.
- [ ] 8.4 Tailwind pack.
- [ ] 8.5 Vite/React/Tailwind/Dexie template; browser preview (esbuild-wasm + esm.sh, sandboxed).

**Phase 9**
- [ ] 9.1 Merge companion into the MCP host; disk workspace provider + watcher.
- [ ] 9.2 Task runner (install, scripts) with allow-list, confirmations, output streaming.
- [ ] 9.3 Vite dev server proxy + preview tab; test runner integration; wrangler deploy.

**Phase 10**
- [ ] 10.1 GitHub App registration doc; Worker OAuth flow, token vault, session cookie, API proxy.
- [ ] 10.2 Repo browser + clone into workspace (tree + lazy blobs).
- [ ] 10.3 Status/diff (text + semantic graph diff); commit via Git Data API; branches.
- [ ] 10.4 Pull + three-way merge (text, graph) + merge editor.
- [ ] 10.5 Compare, PR create/list/review.

**Phase 10a**
- [ ] 10a.1 GitHub App permissions for Actions; workflow templates.
- [ ] 10a.2 Trigger/list/follow runs; logs viewer.
- [ ] 10a.3 Map failures to files/nodes; deploy workflow; MCP CI tools.

**Phase 11**
- [ ] 11.1 Host git provider; parity tests with API provider.
- [ ] 11.2 SCM MCP tools (allowed by default when asked; force/delete only when named).

**Phase 12**
- [ ] 12.x Per language/framework, as separate plans.

---

## Decisions (from review)

1. **Graph granularity**: one `.vgraph` per generated source file — *assumed; not objected to.*
2. **Execution**: phone-first. GitHub Actions is the default for install/build/test/deploy; in-browser preview for live iteration; laptop host optional; cloud container only if needed later.
3. **GitHub**: API provider first (works on a phone, GitHub App + Worker), host git later.
4. **Claude's actions**: allowed by default when asked — no second confirmation; revision checks, backups, undo and the activity log remain.
5. **Phase order**: as revised in §D.

Waiting for approval to start Phase 1.
