# Claude integration (MCP)

There are two ways to connect Claude, and you can use either or both:

| | Claude connector (remote) | Local MCP server |
| --- | --- | --- |
| Works with | Claude on your phone, claude.ai, Claude desktop — anywhere connectors work | Claude Code and Claude desktop on the computer where it runs |
| Setup | Switch on *Claude connector* in the editor, paste its link into Claude once | Register `coding-studio-mcp.mjs` with Claude |
| Runs | In your Cloudflare Worker | On your PC |
| Can write exported files to disk | No (returns the file contents) | Yes, with your approval for overwrites |

## Claude connector (phone, claude.ai, anywhere)

```
Claude (any device) ──HTTPS──► <your site>/mcp/<key> ──┐
                                                         ├─ Durable Object (one per key): your projects + Claude's edits
Coding Studio (any browser) ──► /sync + /bridge/<key> ──┘     (the editor syncs; live updates when open)
```

With the connector on, your projects are kept in your Cloudflare account as well as the browser, and **Claude edits that cloud copy directly — no browser needs to be open**. When you open the editor it pulls in Claude's changes; if it's already open they appear live, as an undoable step.

1. Open your deployed site, tap the robot **MCP** button, switch on **Claude connector**, copy the link.
2. In Claude: **claude.ai → Settings → Connectors → Add custom connector**, paste the link, leave the rest empty. It also works in the Claude phone and desktop apps.

Details:
- Same tools and validation as everywhere else (the editing code runs inside the Durable Object). `undo` / `redo` cover Claude's own edits, and refuse if the project changed since (e.g. you edited it) rather than throw your work away; backups are taken before deletions and large batches.
- Sync rules: on connect, the newer copy of each project wins and new projects go both ways; every save in the editor is pushed up; if Claude changed the project at the same moment, the cloud version is kept and loaded (you get a notice). Deleting a project on either side deletes it everywhere.
- "The project I have open": the editor tells the cloud which project/graph is open, so Claude's tools default to it.
- Exports return file contents (the cloud can't write to your disk).
- The link contains a random key; it is the only access control. *Make a new link* replaces it (projects stay with the old key's storage, so re-sync from a browser that has them).

## The simplest setup: the server serves the editor

The MCP server file contains the whole editor. Whenever Claude starts the server, the editor is available at **http://localhost:47831** in any browser (Firefox, Edge, Chrome…). Opened from there it connects to Claude automatically: no hosted site, no `npm install`, no toggle. Claude can also open it for you with the `open_editor` tool ("open Coding Studio").

Projects are stored per address, so projects made on a hosted copy (e.g. Cloudflare) don't appear at localhost automatically: export them there (*Export → .vproj*) and import them here.

## Setup

1. Build the server (once, and after updating the repository):
   ```bash
   npm install && npm run build:mcp
   ```
2. Register it with Claude Code:
   ```bash
   claude mcp add coding-studio -- node /absolute/path/to/coding-studio/dist/mcp/coding-studio-mcp.mjs
   ```
   If the editor runs on a hosted URL (e.g. your Cloudflare Worker), allow that origin:
   ```bash
   claude mcp add coding-studio -e CODING_STUDIO_ORIGINS=https://coding-studio.<you>.workers.dev -- node /abs/path/dist/mcp/coding-studio-mcp.mjs
   ```
   The **MCP** dialog in the editor shows the exact command for the page you are on.
3. In Coding Studio click the **MCP** indicator in the toolbar and tick **Allow Claude Code to control this editor** (off by default).
4. In Claude Code: "check the coding-studio status". The indicator turns green (*Claude connected*).

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODING_STUDIO_PORT` | 47831 | WebSocket port; must match the port in the editor's MCP dialog |
| `CODING_STUDIO_ORIGINS` | – | Extra allowed page origins, comma-separated (localhost/127.0.0.1 always allowed) |
| `CODING_STUDIO_EXPORT_ROOTS` | – | Optional `:`-separated directories that `export_*` must write inside |

## Tools

| Area | Tools |
| --- | --- |
| Connection & projects | `status`, `open_editor`, `list_projects`, `create_project`, `open_project`, `get_project`, `save_project`, `duplicate_project`, `delete_project` |
| Graphs | `list_graphs`, `create_graph`, `get_graph`, `rename_graph`, `delete_graph` |
| Node discovery | `list_node_types`, `get_node_schema`, `search_nodes`, `list_language_capabilities` |
| Editing | `add_node`, `update_node`, `delete_nodes`, `connect_nodes`, `disconnect_nodes`, `move_nodes`, `duplicate_nodes`, `batch_edit` |
| Program structure | `create_variable`, `update_variable`, `delete_variable`, `create_function`, `update_function`, `delete_function`, `create_signal` |
| Compilation | `validate_graph`, `compile_script`, `compile_project`, `get_generated_code`, `export_script`, `export_project` |
| Files | `read_tree`, `read_files`, `search_files`, `workspace_batch`, `write_file`, `move_path`, `delete_path` |
| History | `undo`, `redo`, `list_backups`, `restore_backup` |

`batch_edit` is the workhorse: create nodes with `ref`, connect them with `"$ref"` in the same atomic batch (`add_function` also defines `"$<ref>.entry"`). Results contain created ids, the new revision, warnings and a diagnostics summary. Errors are structured: `{ "error": { "code", "message", "details" } }`, e.g. `E_REVISION_CONFLICT`, `E_TYPE_MISMATCH`, `E_UNKNOWN_NODE`, `E_NOT_CONNECTED`, `E_FILE_EXISTS`, `E_DECLINED`.

**Files.** A project is a set of files (see [PROJECT_FORMAT.md](PROJECT_FORMAT.md)); visual scripts are `*.vgraph` files and graph tools accept their path as `script` (e.g. `"player/player.vgraph"`). `workspace_batch` changes many files *and* graphs in one atomic, undoable step: `write_file`, `create_dir`, `delete`, `move`, `copy`, `graph` (batch_edit operations, addressed by `script` path) and `config`. Every file read returns its git blob `hash`; pass it back as `expected_hash` and the write is refused (`E_REVISION_CONFLICT`, nothing applied) if the file changed meanwhile — e.g. because you were typing in it. `expected_revision` does the same for the whole workspace. Generated source (e.g. `main.gd`) shows up in `read_tree` under `generated` and can be read, but not written. Deletes and large batches take a backup first. All of this works the same through the local server, the served editor and the cloud connector.

## Safety model

- **Opt-in**: the editor never connects unless the user enables it; the setting is per browser.
- **Loopback only**: the server listens on 127.0.0.1; the editor only connects to 127.0.0.1.
- **Origin allow-list**: WebSocket handshakes from other web pages are refused (403).
- **Session ownership**: one tab owns the connection. Another tab is told it's busy and must click **Take over**; the previous tab is notified. No silent hijacking.
- **Same validation as the UI**; batches are atomic; invalid batches leave the project untouched.
- **Revision checks**: pass `expected_revision` to avoid overwriting the user's newer manual edits.
- **Backups** before deletes, signature changes, project updates and batches of 15+ operations; restores back up first.
- **Undo**: every Claude batch is one entry ("Claude: …") in the editor's history. The MCP Activity tab logs every call.
- **Filesystem**: only `export_script` / `export_project` write files: absolute non-system destination, no `..`, symlinks may not escape, only `.gd` / `.vproj.json`, optional `CODING_STUDIO_EXPORT_ROOTS`. Existing files are never overwritten unless `overwrite: true` **and** the user clicks *Overwrite* in the editor. No shell access, no arbitrary reads.
- **Destructive project deletion** requires confirmation in the editor.
- Payloads are capped at 8 MB; dead connections are dropped by heartbeat.

## Hosted editor and browser restrictions

`ws://127.0.0.1` from an `https://` page is allowed by Chromium and Firefox (loopback is treated as potentially trustworthy), but:

- **Chrome's Local Network Access** (Chrome 142+) asks the user for permission the first time a public site connects to a local address. Accept it; the site's `Permissions-Policy` already allows `local-network-access=(self)`.
- **Safari** blocks mixed-content `ws://` from `https://` pages. Use `npm run dev` / `npm run preview` (http://localhost) with Safari, or use Chrome/Firefox.
- The hosted origin must be listed in `CODING_STUDIO_ORIGINS`.

The localhost alternative always works: `npm run dev` and use http://localhost:5173.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `E_NOT_CONNECTED` | Enable the toggle in the editor's MCP dialog; check the port matches. |
| Indicator stays amber "MCP waiting" | The server isn't running: restart Claude Code / check `claude mcp list`. |
| "Port 47831 is already in use" | Another server instance is running; stop it or set `CODING_STUDIO_PORT` (and the same port in the editor). |
| Server log: "rejected connection from origin …" | Add that origin to `CODING_STUDIO_ORIGINS`. |
| "Other tab" | Another Coding Studio tab owns the connection; click **Take over** in the tab you want. |
| `E_REVISION_CONFLICT` | The project changed (often a manual edit). Re-read with `get_graph` and retry with the new revision. |
| `E_TIMEOUT` on export/delete | A confirmation dialog is waiting for the user in the editor. |

Tested end to end in `tests/e2e/mcp.spec.ts` (real MCP client → stdio server → browser → GDScript file on disk).
