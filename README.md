# Coding Studio

A Blueprint-style **visual programming IDE** that compiles node graphs into **readable, conventional source code**. GDScript for Godot 4 is the first fully supported language; the compiler is built around a language-adapter SDK so other languages can be added without touching the editor.

- Build programs from connected nodes: events, functions, variables, signals, enums, branches, loops, maths, collections, Godot API calls.
- Get idiomatic GDScript that runs in Godot **without** Coding Studio or any runtime.
- Errors are reported on the exact node and pin; invalid graphs never produce code.
- Let **Claude Code** inspect and edit the same graphs through MCP: atomic, revision-checked, undoable.
- Edit graphs inside **Godot** with the editor plugin, using the same file format and compiler.
- Everything stays in your browser (IndexedDB). No accounts, no server, no AI API needed.

```
func _physics_process(delta: float) -> void:
	var vel: Vector2
	vel = velocity
	if not is_on_floor():
		vel += Vector2(0.0, gravity * delta)
	if Input.is_action_just_pressed("ui_accept") and is_on_floor():
		vel = Vector2(vel.x, jump_velocity)
	vel = Vector2(Input.get_axis("ui_left", "ui_right") * speed, vel.y)
	velocity = vel
	move_and_slide()
```
*(generated from the "Jumping and Gravity" example graph)*

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev            # http://localhost:5173
```

Open an example from the start page, or create a project and press **Tab** (or right-click the canvas) to add nodes. Drag from a pin to connect; drop a wire on empty canvas to get a list of compatible nodes. The generated code updates live in the bottom panel.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` / `npm run preview` | Production build / serve it on :4173 |
| `npm run typecheck` · `npm run lint` | TypeScript (strict) · ESLint |
| `npm test` | Vitest: compiler golden files, diagnostics, ops, persistence, MCP bridge, companion |
| `npm run test:e2e` | Playwright: editor workflows, full MCP round trip, large graphs |
| `npm run test:godot` | Validate generated GDScript with a real Godot 4 (`GODOT_BIN=/path/to/godot`) |
| `npm run build:mcp` · `npm run mcp` | Build / run the MCP server |
| `npm run build:companion` · `npm run companion` | Build / run the Godot companion service |
| `npm run cf:dev` · `npm run cf:deploy` | Cloudflare Workers local preview / deploy |

## Claude Code (MCP)

```bash
npm run build:mcp
claude mcp add coding-studio -- node /absolute/path/to/coding-studio/dist/mcp/coding-studio-mcp.mjs
```

In Coding Studio click the **MCP** indicator in the toolbar and enable *Allow Claude Code to control this editor*. Then ask Claude to "check the coding-studio status". Details, security model and troubleshooting: [docs/MCP.md](docs/MCP.md).

## Godot plugin

Copy `apps/godot-addon/addons/coding_studio` into your Godot 4.2+ project, enable it under *Project → Project Settings → Plugins*, and start the companion service (`npm run build:companion && npm run companion`). A **Visual Script** tab appears next to 2D/3D/Script. `apps/godot-addon` is itself a demo project with all examples. See [docs/GODOT_PLUGIN.md](docs/GODOT_PLUGIN.md).

## Deploying

The web app is a Cloudflare **Worker with Static Assets** (`wrangler.jsonc`):

```bash
npx wrangler login     # once
npm run cf:deploy
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| | |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Packages, layers and data flow (and what was adapted from GUI Studio) |
| [Development](docs/DEVELOPMENT.md) | Setup, scripts, testing |
| [User guide](docs/USER_GUIDE.md) | Using the visual editor |
| [GDScript export](docs/GDSCRIPT_EXPORT.md) | What gets generated and how to use it in Godot |
| [Compiler design](docs/COMPILER.md) | Pipeline, IR, control-flow structuring, diagnostics |
| [Language adapters](docs/LANGUAGE_ADAPTERS.md) | How to add a new language |
| [Project file format](docs/PROJECT_FORMAT.md) | `.vproj.json` / `.vproj` and migrations |
| [MCP](docs/MCP.md) | Claude Code integration |
| [Godot plugin](docs/GODOT_PLUGIN.md) | Editor plugin + companion service |
| [Deployment](docs/DEPLOYMENT.md) | Cloudflare Workers |
| [Known limitations](docs/KNOWN_LIMITATIONS.md) | What is not done (yet), honestly |
| [Progress](PROGRESS.md) | Implementation checklist and verification status |
