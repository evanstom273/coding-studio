# Project file format

The project document is the **source of truth**. Generated code is derived from it and is never the only saved representation.

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
