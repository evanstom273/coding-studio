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
Claude (any device) ──HTTPS──► <your site>/mcp/<secret key>  ─┐
                                                               ├─ Durable Object (one per key) ─► your editor tab
Coding Studio tab ──WebSocket─► <your site>/bridge/<same key> ─┘
```

1. Open your deployed site (e.g. `https://coding-studio.<you>.workers.dev`), tap the robot **MCP** button in the toolbar.
2. Switch on **Claude connector**. Copy the link shown under it.
3. In Claude: **claude.ai → Settings → Connectors → Add custom connector**. Paste the link as the URL, leave everything else empty. It is then available in the Claude apps on your phone and computer too.
4. Keep the Coding Studio tab open while Claude works. On a phone use split screen (or keep it on your computer); phones pause background tabs, and the tab reconnects by itself when it's visible again.

Security: the link contains a random 256-bit key generated in your browser. Anyone with the link can edit projects in a tab where the connector is switched on, so treat it like a password; *Make a new link* in the same dialog invalidates the old one. The editor's WebSocket is only accepted from the site's own origin, and Durable Objects are named by a hash of the key. The connector has the same tools as the local server; `export_script` / `export_project` return the files' contents instead of writing them, and `open_editor` returns the site address.


```
Claude Code ──stdio (MCP)──► dist/mcp/coding-studio-mcp.mjs ──ws://127.0.0.1:47831──► Coding Studio tab
```

The MCP server is a local Node process launched by Claude Code. It relays tool calls to the editor tab, which executes them with the **same edit operations as the mouse**: validated, atomic per batch, one undo step per batch, autosaved, and checked against `expected_revision`. The server keeps no project state and does not need any Cloudflare service.

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
| History | `undo`, `redo`, `list_backups`, `restore_backup` |

`batch_edit` is the workhorse: create nodes with `ref`, connect them with `"$ref"` in the same atomic batch (`add_function` also defines `"$<ref>.entry"`). Results contain created ids, the new revision, warnings and a diagnostics summary. Errors are structured: `{ "error": { "code", "message", "details" } }`, e.g. `E_REVISION_CONFLICT`, `E_TYPE_MISMATCH`, `E_UNKNOWN_NODE`, `E_NOT_CONNECTED`, `E_FILE_EXISTS`, `E_DECLINED`.

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
