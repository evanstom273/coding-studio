# Project file format

A project is a **workspace**: a set of files at paths, the same shape in the browser, in the cloud copy and (later) in a Git repository. Visual graphs are files too. Generated code is derived from the graphs and is never the only saved representation.

## Workspace (schema 2)

| Path | Content |
| --- | --- |
| `codingstudio.json` | Project settings: `{ "version": 1, "name", "description?", "language", "languageVersion", "compiler": { indent, indentSize, header, comments } }`. Can't be deleted or moved. |
| `<script path>.vgraph` | One visual script: `{ "format": "coding-studio-graph", "version": 1, "language", "script": <ScriptDoc> }` (the `script` object is exactly the schema-1 script below). `player/player.vgraph` compiles to `player/player.gd`. |
| anything else | Ordinary text or binary files (kept byte-exact). Empty folders are kept with a `.gitkeep` file. |

- Every file has a git blob SHA-1 `hash`; writes can name the hash they were based on and are refused (nothing changes) if the file moved on. Batches of file operations are atomic.
- The editor, compiler and MCP graph tools work on a *project view* derived from `codingstudio.json` and the `.vgraph` files; a graph edit rewrites only the `.vgraph` files it touched.
- Editor layout (open graph, viewport) is not part of `codingstudio.json`; viewports live in the graph file, the rest in local metadata.

### Storage

- **Browser (IndexedDB, Dexie v2):** `workspaces` (metadata) and `files` (one row per file, keyed `[ws+path]`). Saves write only the files that changed. Schema-1 projects stored by older versions are converted the first time they're listed/opened; the original document is kept as a backup.
- **Cloud copy (Claude connector, Durable Object SQLite):** one row per file plus content-addressed blobs (chunked, any size); Claude's undo steps store only the files they changed; backups are full file lists sharing content. Older whole-project entries are converted automatically on first use.
- **Sync** is per file with a three-way check against the last agreed hash: changed only here → uploaded; changed only in the cloud → downloaded; changed on both sides → the cloud copy wins and you're told.

## Single-file exports (schema 1)

The `.vproj` / `.vproj.json` formats below are still how a project is exported and imported as one file (and what the Godot plugin reads); importing one creates a workspace.

## Files

| Extension | Content | Used by |
| --- | --- | --- |
| `.vproj.json` | The project document as pretty-printed JSON | Web export/import, Godot plugin, MCP `export_project include_project` |
| `.vproj` | ZIP: `manifest.json`, `project.json`, `generated/<files>` (for reference only) | Web export/import |

Importing either format runs the migration path; ids are regenerated if a project with the same id already exists in the browser.

## Document (schema 1)

```jsonc
{
  "format": "coding-studio-project",
  "schemaVersion": 1,
  "id": "p_…", "name": "My Game", "description": "…",
  "language": "gdscript", "languageVersion": "4.4",
  "compilerSettings": { "indent": "tab", "indentSize": 4, "header": true, "comments": true },
  "createdAt": 0, "updatedAt": 0,
  "editor": { "activeScriptId": "s_…", "activeFunctionId": "f_…" },   // layout only
  "scripts": [{
    "id": "s_…", "name": "Player", "path": "player/player",          // → player/player.gd
    "settings": { "extends": "CharacterBody2D", "class_name": "", "tool": false },  // adapter-defined
    "description": "…",
    "variables": [{ "id": "v_…", "name": "speed", "type": "float", "default": 300, "exported": true, "constant": false,
                    "description": "…", "attributes": { "onreadyPath": "Head" } }],
    "signals":   [{ "id": "sig_…", "name": "hit", "params": [{ "id": "p_…", "name": "damage", "type": "int" }] }],
    "enums":     [{ "id": "e_…", "name": "State", "members": [{ "name": "IDLE" }, { "name": "RUN", "value": 5 }] }],
    "functions": [{
      "id": "f_…", "name": "_physics_process", "kind": "event", "event": "_physics_process",
      "params": [{ "id": "p_…", "name": "delta", "type": "float" }], "returnType": "void",
      "locals": [ /* variables */ ],
      "graph": {
        "id": "g_…",
        "viewport": { "x": 0, "y": 0, "zoom": 1 },
        "nodes": [{ "id": "n_…", "type": "core.branch", "position": { "x": 0, "y": 0 },
                    "props": {}, "inputs": { "condition": true }, "collapsed": false }],
        "edges": [{ "id": "e_…", "from": { "node": "n_a", "port": "then" }, "to": { "node": "n_b", "port": "exec" } }]
      }
    }]
  }]
}
```

- **Types** use the canonical syntax: `bool int float string any void`, `array<T>`, `map<K, V>`, named types (`Vector2`, `Node2D`, script enums), `?` for nullable.
- **Node props** are validated against the node definition's `PropSchema`; references to variables/functions/signals/enums are stored as ids.
- **inputs** hold literal values for unconnected data inputs, keyed by port id. Struct values are objects (`{"x": 0, "y": 1}`).
- Function parameters are also port ids on the Entry node and on Call Function nodes, so renaming a parameter never breaks wires.
- `editor` and `graph.viewport` are layout data and excluded from the revision hash.

## Revisions

`projectRevision(project)` hashes the stable-stringified document without `updatedAt` and `editor`. MCP edits may pass `expected_revision`; a mismatch rejects the batch with `E_REVISION_CONFLICT`.

## Migrations

`packages/project-format/src/migrations.ts`:

- Each step in `MIGRATIONS` upgrades schema *N* to *N+1*. To change the format, bump `PROJECT_SCHEMA_VERSION` and **add** a step; never edit an old one.
- Documents from a **newer** schema are rejected with an explanation — never opened and truncated.
- After migrating, `sanitizeProject` fills defaults for missing fields. Anything it cannot read (a malformed node, an edge without endpoints) is skipped **and reported** in `issues`, which the editor shows. Dangling edges are kept so the compiler can point at them.
- The stored row in IndexedDB is only replaced on the next successful save.

## Browser storage (IndexedDB, Dexie)

Database `coding-studio`, schema v1: `projects` (id, name, language, timestamps, raw document), `backups` (per project, newest 30), `settings`.
