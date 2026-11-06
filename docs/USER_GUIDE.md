# Visual editor guide

## Layout

- **Toolbar** — back to projects, new/open/save, undo/redo, Add Node, Validate, Generate, Export, command palette, backups, shortcuts, settings, MCP status.
- **Left sidebar** — *Project*: scripts, events, functions, variables, signals, enums. *Nodes*: searchable library grouped by category (drag onto the canvas, or double-click).
- **Canvas** — the graph of the selected function or event.
- **Inspector** — properties of the selected node, or of the selected variable/function/signal/enum/script; *Project settings* at the top right.
- **Bottom panel** — Generated Code (read-only, Monaco), Errors, Warnings, MCP Activity, Project info.

## Building a program

1. Every **script** becomes one source file (`path` + extension). Its settings (GDScript: `extends`, `class_name`, `@tool`) are in the inspector when you click the script.
2. Each **event** (`_ready`, `_process`, `_physics_process`, `_input`, …) and **function** has its own graph, starting at the red **Entry** node. Its outputs are the parameters (e.g. `delta`).
3. Add nodes with **Tab** or right-click. Type to search; Enter adds the highlighted node.
4. **Execution wires** (white, ▶ pins) decide the order statements run in. **Data wires** (coloured by type) carry values. Pin colours: bool red, int teal, float green, string pink, vectors yellow, objects blue, arrays/dictionaries orange, untyped grey.
5. Unconnected data inputs show an inline field — type a literal value there.
6. Drop a wire on empty canvas to get only the nodes that can accept it; the new node is connected automatically.
7. Variables: create them in the explorer, then drag one onto the canvas for a **Get** node (hold **Alt** while dropping for **Set**). Set nodes can also do `+=`, `-=`, `*=`, `/=`.
8. Functions: create one, edit its parameters/return type in the inspector, build its graph, end paths with **Return** if it returns a value. Call it with **Call Function** (double-click a Call node to jump into it).

Flow-control nodes: **Branch** (if/else — chains that meet again continue after the if), **Switch** (match), **Sequence**, **For Loop**, **For Each**, **While Loop**, **Break**, **Continue**, **Return**, **Delay** (await a timer).

## Errors and warnings

Problems appear on the node (red/amber outline with the message), in the Errors and Warnings tabs and in the status bar. Click a diagnostic to jump to its node. While there are errors the code view keeps the last good output and marks it *out of date*; exports of source are disabled until the errors are fixed. Typical messages explain the fix ("connect a wire or type a value", "use a Sequence node", "store the value in a variable").

## Editing

| Action | How |
| --- | --- |
| Select / box select | Click / drag on empty canvas (Shift adds) |
| Pan / zoom | Middle-drag or Space+drag / mouse wheel; **F** fits the graph |
| Copy, cut, paste, duplicate | Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D (paste works across graphs) |
| Delete | Delete or Backspace (Entry nodes can't be deleted) |
| Collapse a node | **H** or the chevron in its header |
| Comment frame around selection | **C** (rename/recolour in the inspector, resize when selected) |
| Reroute points | add *Reroute* / *Reroute (Exec)* nodes |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) — every change, including Claude's, is undoable |
| Command palette | Ctrl+K — commands and "Open <function>" |

## Saving, backups, export

- Projects autosave to this browser (IndexedDB) and survive restarts. The indicator next to the title shows the state; Ctrl+S saves immediately.
- **Backups** (toolbar clock icon) are created automatically before deleting scripts/functions/variables, deleting many nodes, large Claude batches and restores; create one manually at any time and restore with one click (itself undoable).
- **Export**: the active script as `.gd`, all sources as a ZIP (folders preserved), the code to the clipboard, or the editable project as `.vproj` (archive) / `.vproj.json` (plain JSON — the format the Godot plugin opens). Import a `.vproj` or `.vproj.json` from the start page.

The generated code is a view: edit the graph, not the code. Coding Studio does not convert hand-written GDScript back into graphs.
