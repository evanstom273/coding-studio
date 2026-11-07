/**
 * The Coding Studio MCP tool set, shared by the local server (Node, stdio) and the remote
 * connector (Cloudflare Worker). Every tool relays to the editor tab through `Relay`; the few
 * things that differ per host (opening the editor, writing files) come from `ToolHost`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeMethod } from '../../packages/shared-protocol/src/index';
import { BridgeRequestError, errorPayload, ExportError, SERVER_VERSION } from './errors';

export interface Relay {
  request(method: BridgeMethod, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface ToolHost {
  openEditorDescription: string;
  openEditor(): Promise<unknown>;
  /** Local server only: write exported files to disk (with its safety checks). */
  writeFiles?(outputDir: string, files: Record<string, string>, overwrite: boolean, relay: Relay): Promise<Record<string, unknown>>;
  /** Local server only: link projects to folders on this computer and run their tasks. */
  local?: LocalTasks;
}

export interface LocalTasks {
  open(dir: string, opts?: { name?: string; watch?: boolean; cloneUrl?: string }): Promise<unknown>;
  link(dir: string, opts: { project?: string; overwrite?: boolean; watch?: boolean }): Promise<unknown>;
  sync(project?: string): Promise<unknown>;
  install(project?: string, wait?: boolean): Promise<unknown>;
  run(script: string, opts?: { project?: string; wait?: boolean }): Promise<unknown>;
  dev(action: 'start' | 'stop' | 'status', opts?: { project?: string; script?: string }): Promise<unknown>;
  output(id: string | undefined, project?: string): Promise<unknown>;
  git(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: errorPayload(e) }, null, 2) }] });

const project = z.string().optional().describe('Project id or exact name. Omit to use the project open in Coding Studio.');
const revision = z.string().optional().describe('Revision returned by get_graph / get_project / a previous edit. If the project changed since (e.g. the user edited it), the edit is rejected with E_REVISION_CONFLICT and nothing changes.');
const repository = z.string().optional().describe('GitHub repository "owner/name". Omit to use the project\'s linked repository.');
const graph = z.string().optional().describe('Function/graph id (or function name). Omit to use the graph open in the editor.');
const script = z.string().optional().describe('Script id, name or graph file path (e.g. "player/player.vgraph"). Omit for the active script.');
const nodeRef = z.string().describe('Node id, or "$ref" of a node created earlier in the same batch');
const port = z.object({ node: nodeRef, port: z.string().describe('Port id (or its display name) — see get_graph / get_node_schema') });
const json = z.unknown();
const param = z.object({ name: z.string(), type: z.string().describe('e.g. int, float, string, bool, Vector2, Node2D, array<int>'), default: json.optional() });

const OP_NAMES = [
  'update_project',
  'add_script',
  'update_script',
  'delete_script',
  'add_function',
  'update_function',
  'delete_function',
  'add_variable',
  'update_variable',
  'delete_variable',
  'add_signal',
  'update_signal',
  'delete_signal',
  'add_enum',
  'update_enum',
  'delete_enum',
  'add_node',
  'update_node',
  'delete_nodes',
  'move_nodes',
  'connect',
  'disconnect',
  'duplicate_nodes',
  'paste_nodes',
  'set_viewport',
  'add_interface',
  'update_interface',
  'delete_interface',
] as const;

const BATCH_DOC = `Apply several edit operations atomically: either all succeed or the project is unchanged. The whole batch is ONE undo step for the user.
Reference objects created earlier in the batch with "$ref" (set "ref" on the creating op). add_function also defines "$<ref>.entry" for its Entry node.
Operations (fields in brackets are optional; script/graph default to the active ones):
- add_node {type, [ref], [graph], [position {x,y}], [props], [inputs]}   inputs = inline literal values for unconnected data inputs, keyed by port id
- update_node {node, [props], [inputs (null clears)], [position], [collapsed], [size]}
- delete_nodes {nodes[]} · move_nodes {nodes[], dx, dy | positions{id:{x,y}}} · duplicate_nodes {nodes[], [offset], [ref → "$ref.0"…]}
- connect {from {node, port}, to {node, port}, [ref]}  (output → input; replaces an existing wire into a data input / out of an exec output)
- disconnect {edges[] | from | to}
- add_function {name, [params [{name,type,default?}]], [returnType], [description], [async], [exported], [ref]}  or {kind:"event", event:"_ready"|"_process"|"_physics_process"|"_input"|…} (GDScript)
- update_function {function, [name], [params], [returnType], [description], [async], [exported]}  (async/exported: TypeScript) · delete_function {function}
- add_variable {name, type, [default], [exported], [constant], [description], [attributes {onreadyPath}], [function → local variable]} · update_variable {variable, …} · delete_variable {variable}
- add_signal {name, [params]} · update_signal · delete_signal · add_enum {name, members[]} · update_enum · delete_enum
- add_script {name, [path], [template], [settings {extends, class_name, tool}]} · update_script {script, …} · delete_script {script}
- update_project {[name], [languageVersion], [compilerSettings], [entry: {function, [script], [host]} | null]}  (entry = where the program starts; see set_entry_point)
- add_interface {name, fields [{name, type, optional?}], [exported], [description], [ref]} · update_interface {interface, …} · delete_interface {interface}  (TypeScript type declarations; use the name as a type anywhere)
Node props that reference variables/functions/signals/enums accept their id or name.
TypeScript nodes: ts.call {module (npm package) | scriptPath (another script of the project) | neither (globals like fetch, JSON.parse), name, argNames[], argTypes[], returnType, await} · ts.call_method {name, argTypes[], returnType, await, optional} · ts.await {type} · ts.try (exec outs try/catch/finally/then, data out error) · ts.throw · ts.template {template "Hi {name}"} · ts.object {keys[]} · ts.get_field / ts.set_field {name, optional} · ts.function_ref {function} · ts.default_value (??) · ts.closure {function} (an inline arrow function). Imports are written automatically.
React (TypeScript): add_function {…, component:true} makes a component (params = props, returns elements); a local variable with attributes {state:true} is React state (Set Variable calls its setter); ts.element {tag, attributes[], children} builds JSX (inputs attr_<name>, child_<i>; tag can be a component; module/scriptPath imports it); handlers are ts.closure inline functions; ts.classes {classes, conditional[]} builds a Tailwind className (inputs when_<i>); hooks (use…) must be at the top of a component, not in branches/loops.
Inline functions (closures, TypeScript): add_function {kind:"lambda", owner:<function>, name, params, returnType, [async], ref} creates a function whose graph can read/write the owner's params and locals (get_var/set_var by name); put a ts.closure {function:"$ref"} node in the owner's graph to use it as a value (callbacks, handlers, array.map…). Deleting the owner deletes its inline functions.
Execution flow: connect exec output "then" (or "true"/"false", "body", "completed"…) to exec input "exec". Every function graph starts at its Entry node (output "then", plus one data output per parameter, keyed by parameter id or name).`;

export function buildServer(bridge: Relay, host: ToolHost): McpServer {
  const server = new McpServer({ name: 'coding-studio', version: SERVER_VERSION });
  const call = async (method: BridgeMethod, params: Record<string, unknown> = {}, timeout?: number) => {
    try {
      return text(await bridge.request(method, params, timeout));
    } catch (e) {
      return fail(e);
    }
  };
  const batch = (args: { project?: string; expected_revision?: string; script?: string; graph?: string }, operations: Record<string, unknown>[]) => call('batch_edit', { ...args, operations });
  const ro = { readOnlyHint: true };

  // --- connection & projects ------------------------------------------------------------
  server.registerTool('status', { title: 'Status', description: 'Check the connection to Coding Studio and see the open project, its revision and the active script/graph. Call this first.', inputSchema: {}, annotations: ro }, async () => {
    return call('status');
  });
  server.registerTool(
    'open_editor',
    {
      title: 'Open the editor',
      description: host.openEditorDescription,
      inputSchema: {},
    },
    async () => {
      try {
        return text(await host.openEditor());
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool('list_projects', { title: 'List projects', description: 'Projects saved in the Coding Studio browser storage.', inputSchema: {}, annotations: ro }, () => call('list_projects'));
  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a project with one script and open it in the editor. language: gdscript (Godot, default) or typescript (web; script setting output "js" writes plain JavaScript). Templates — GDScript: node, node2d, node3d, character2d, character3d, control, refcounted; TypeScript: web-app (Vite + React + Tailwind + Dexie starter: App component as a graph, runs in Preview), module (exported main), async-module, empty.',
      inputSchema: { name: z.string(), language: z.string().optional().describe('Default gdscript'), template: z.string().optional(), script_name: z.string().optional().describe('Name of the first script (default Main)') },
    },
    (a) => call('create_project', a, 20_000),
  );
  server.registerTool('open_project', { title: 'Open project', description: 'Open a project in the editor (the user sees it).', inputSchema: { project: z.string() } }, (a) => call('open_project', a, 20_000));
  server.registerTool('get_project', { title: 'Get project', description: 'Project structure: scripts, variables, functions/graphs, signals, enums and the current revision. full=true returns the raw document.', inputSchema: { project, full: z.boolean().optional() }, annotations: ro }, (a) => call('get_project', a));
  server.registerTool('save_project', { title: 'Save project', description: 'Save immediately (edits are also autosaved).', inputSchema: { project } }, (a) => call('save_project', a));
  server.registerTool('duplicate_project', { title: 'Duplicate project', description: 'Copy a project (new ids).', inputSchema: { project, name: z.string().optional() } }, (a) => call('duplicate_project', a));
  server.registerTool('delete_project', { title: 'Delete project', description: 'Permanently delete a project. The user must confirm in the editor.', inputSchema: { project: z.string() }, annotations: { destructiveHint: true } }, (a) => call('delete_project', a, 120_000));

  // --- graphs -----------------------------------------------------------------------------
  server.registerTool('list_graphs', { title: 'List graphs', description: 'All function/event graphs per script.', inputSchema: { project }, annotations: ro }, (a) => call('list_graphs', a));
  server.registerTool(
    'get_graph',
    { title: 'Get graph', description: 'Nodes (with resolved ports, props and inline inputs), connections, diagnostics and the revision of one graph. Opens it in the editor unless focus=false.', inputSchema: { project, graph, script, focus: z.boolean().optional() }, annotations: ro },
    (a) => call('get_graph', a),
  );
  server.registerTool(
    'create_graph',
    { title: 'Create graph', description: 'Create a function graph, or an engine event graph (kind "event", e.g. event "_physics_process").', inputSchema: { project, expected_revision: revision, script, name: z.string().optional(), kind: z.enum(['function', 'event']).optional(), event: z.string().optional(), params: z.array(param).optional(), return_type: z.string().optional(), description: z.string().optional() } },
    (a) => batch(a, [{ op: 'add_function', ref: 'graph', script: a.script, name: a.name, kind: a.kind, event: a.event, params: a.params, returnType: a.return_type, description: a.description }]),
  );
  server.registerTool('rename_graph', { title: 'Rename graph', description: 'Rename a function graph (events have fixed names).', inputSchema: { project, expected_revision: revision, graph: z.string(), name: z.string() } }, (a) => batch(a, [{ op: 'update_function', function: a.graph, name: a.name }]));
  server.registerTool('delete_graph', { title: 'Delete graph', description: 'Delete a function or event graph (a backup is taken first).', inputSchema: { project, expected_revision: revision, graph: z.string() }, annotations: { destructiveHint: true } }, (a) => batch(a, [{ op: 'delete_function', function: a.graph }]));

  // --- node discovery -----------------------------------------------------------------------
  server.registerTool('list_node_types', { title: 'List node types', description: 'Node types available for the project language, optionally filtered by category prefix (Flow, Variables, Math, Godot/CharacterBody2D…).', inputSchema: { category: z.string().optional(), language: z.string().optional() }, annotations: ro }, (a) => call('list_node_types', a));
  server.registerTool('search_nodes', { title: 'Search nodes', description: 'Find node types by keywords, e.g. "move and slide", "is action pressed", "branch".', inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional(), language: z.string().optional() }, annotations: ro }, (a) => call('search_nodes', a));
  server.registerTool(
    'get_node_schema',
    { title: 'Get node schema', description: 'Props and resolved ports of a node type. Ports can depend on props (e.g. operand type) and on the graph (Call Function takes the callee signature) — pass them to see the exact ports.', inputSchema: { type: z.string(), props: z.record(z.string(), json).optional(), graph, script }, annotations: ro },
    (a) => call('get_node_schema', a),
  );
  server.registerTool('list_language_capabilities', { title: 'Language capabilities', description: 'Capabilities, engine events, script templates, settings and type syntax of a language.', inputSchema: { language: z.string().optional() }, annotations: ro }, (a) => call('list_language_capabilities', a));

  // --- editing ------------------------------------------------------------------------------
  const edit = { project, expected_revision: revision, script, graph };
  server.registerTool(
    'add_node',
    { title: 'Add node', description: 'Add one node. For several connected nodes use batch_edit.', inputSchema: { ...edit, type: z.string(), position: z.object({ x: z.number(), y: z.number() }).optional(), props: z.record(z.string(), json).optional(), inputs: z.record(z.string(), json).optional().describe('Inline values for unconnected data inputs, keyed by port id') } },
    (a) => batch(a, [{ op: 'add_node', ref: 'node', type: a.type, position: a.position, props: a.props, inputs: a.inputs }]),
  );
  server.registerTool(
    'update_node',
    { title: 'Update node', description: 'Change props, inline input values (null clears one), position or collapsed state.', inputSchema: { ...edit, node: z.string(), props: z.record(z.string(), json).optional(), inputs: z.record(z.string(), json).optional(), position: z.object({ x: z.number(), y: z.number() }).optional(), collapsed: z.boolean().optional() } },
    (a) => batch(a, [{ op: 'update_node', node: a.node, props: a.props, inputs: a.inputs, position: a.position, collapsed: a.collapsed }]),
  );
  server.registerTool('delete_nodes', { title: 'Delete nodes', description: 'Delete nodes and their connections (the Entry node cannot be deleted).', inputSchema: { ...edit, nodes: z.array(z.string()).min(1) }, annotations: { destructiveHint: true } }, (a) => batch(a, [{ op: 'delete_nodes', nodes: a.nodes }]));
  server.registerTool(
    'connect_nodes',
    { title: 'Connect nodes', description: 'Connect an output port to an input port. Types are checked; incompatible connections are rejected with the reason.', inputSchema: { ...edit, from: port, to: port } },
    (a) => batch(a, [{ op: 'connect', from: a.from, to: a.to }]),
  );
  server.registerTool(
    'disconnect_nodes',
    { title: 'Disconnect nodes', description: 'Remove connections by edge id, or everything between/at the given ports.', inputSchema: { ...edit, edges: z.array(z.string()).optional(), from: port.partial({ port: true }).optional(), to: port.partial({ port: true }).optional() } },
    (a) => batch(a, [{ op: 'disconnect', edges: a.edges, from: a.from, to: a.to }]),
  );
  server.registerTool(
    'move_nodes',
    { title: 'Move nodes', description: 'Move nodes by an offset or to absolute positions.', inputSchema: { ...edit, nodes: z.array(z.string()).min(1), dx: z.number().optional(), dy: z.number().optional(), positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional() } },
    (a) => batch(a, [{ op: 'move_nodes', nodes: a.nodes, dx: a.dx, dy: a.dy, positions: a.positions }]),
  );
  server.registerTool('duplicate_nodes', { title: 'Duplicate nodes', description: 'Duplicate nodes with the connections between them.', inputSchema: { ...edit, nodes: z.array(z.string()).min(1), offset: z.object({ x: z.number(), y: z.number() }).optional() } }, (a) => batch(a, [{ op: 'duplicate_nodes', ref: 'copy', nodes: a.nodes, offset: a.offset }]));
  server.registerTool(
    'batch_edit',
    { title: 'Batch edit', description: BATCH_DOC, inputSchema: { ...edit, operations: z.array(z.looseObject({ op: z.enum(OP_NAMES) })).min(1).max(2000) } },
    (a) => call('batch_edit', a, 60_000),
  );

  // --- program structure ----------------------------------------------------------------------
  const varFields = { default: json.optional(), exported: z.boolean().optional(), constant: z.boolean().optional(), description: z.string().optional(), attributes: z.record(z.string(), json).optional().describe('GDScript: {"onreadyPath": "Head/Camera3D"}'), function: z.string().optional().describe('Make it a local variable of this function') };
  server.registerTool('create_variable', { title: 'Create variable', description: 'Add a script member variable (or a local variable when "function" is given).', inputSchema: { project, expected_revision: revision, script, name: z.string(), type: z.string(), ...varFields } }, ({ project: p, expected_revision, script: s, ...v }) => batch({ project: p, expected_revision, script: s }, [{ op: 'add_variable', ref: 'variable', script: s, ...v }]));
  server.registerTool(
    'update_variable',
    { title: 'Update variable', description: 'Rename, retype or change the default/flags of a variable (default: null clears it).', inputSchema: { project, expected_revision: revision, script, variable: z.string(), name: z.string().optional(), type: z.string().optional(), ...varFields } },
    ({ project: p, expected_revision, script: s, ...v }) => batch({ project: p, expected_revision, script: s }, [{ op: 'update_variable', script: s, ...v }]),
  );
  server.registerTool('delete_variable', { title: 'Delete variable', description: 'Delete a variable.', inputSchema: { project, expected_revision: revision, script, variable: z.string(), function: z.string().optional() }, annotations: { destructiveHint: true } }, ({ project: p, expected_revision, ...v }) => batch({ project: p, expected_revision }, [{ op: 'delete_variable', ...v }]));
  server.registerTool(
    'create_function',
    { title: 'Create function', description: 'Add a function with its own graph (an Entry node is created automatically). TypeScript: async=true allows Await nodes; exported=true lets other scripts call it.', inputSchema: { project, expected_revision: revision, script, name: z.string(), params: z.array(param).optional(), return_type: z.string().optional(), description: z.string().optional(), async: z.boolean().optional(), exported: z.boolean().optional() } },
    (a) => batch(a, [{ op: 'add_function', ref: 'function', script: a.script, name: a.name, params: a.params, returnType: a.return_type, description: a.description, async: a.async, exported: a.exported }]),
  );
  server.registerTool(
    'update_function',
    { title: 'Update function', description: 'Rename a function or change its parameters / return type. Connections to removed parameters are dropped (reported as warnings).', inputSchema: { project, expected_revision: revision, function: z.string(), name: z.string().optional(), params: z.array(param.extend({ id: z.string().optional() })).optional(), return_type: z.string().optional(), description: z.string().optional() } },
    (a) => batch(a, [{ op: 'update_function', function: a.function, name: a.name, params: a.params, returnType: a.return_type, description: a.description }]),
  );
  server.registerTool('delete_function', { title: 'Delete function', description: 'Delete a function and its graph.', inputSchema: { project, expected_revision: revision, function: z.string() }, annotations: { destructiveHint: true } }, (a) => batch(a, [{ op: 'delete_function', function: a.function }]));
  server.registerTool('create_signal', { title: 'Create signal', description: 'Declare a signal on a script.', inputSchema: { project, expected_revision: revision, script, name: z.string(), params: z.array(param).optional(), description: z.string().optional() } }, (a) => batch(a, [{ op: 'add_signal', ref: 'signal', script: a.script, name: a.name, params: a.params, description: a.description }]));

  server.registerTool(
    'set_entry_point',
    {
      title: 'Set the program entry point',
      description: 'Make a function the place the program starts (or clear it with function: null). Each language generates the startup it needs: TypeScript/JavaScript a launcher module (<script>.entry.ts) that calls it — awaited if async — or renders it if it is a React component; GDScript a call from _ready() plus a main scene (<script>.tscn), or an Autoload setup. host: typescript "browser" | "node"; gdscript "scene" | "autoload". compile_project then includes how to run it.',
      inputSchema: { project, function: z.string().nullable().describe('Function id or name; null clears the entry point'), script, host: z.string().optional() },
    },
    (a) => batch({ project: a.project }, [{ op: 'update_project', entry: a.function === null ? null : { function: a.function, ...(a.script ? { script: a.script } : {}), ...(a.host ? { host: a.host } : {}) } }]),
  );

  // --- compilation ------------------------------------------------------------------------------
  server.registerTool('validate_graph', { title: 'Validate', description: 'Compile and return diagnostics (with node and port ids) for one graph, or the whole project when graph is omitted.', inputSchema: { project, graph: z.string().optional(), script }, annotations: ro }, (a) => call('validate_graph', a));
  server.registerTool('compile_script', { title: 'Compile script', description: 'Generated source + diagnostics for one script. Source is only produced when there are no errors.', inputSchema: { project, script }, annotations: ro }, (a) => call('compile_script', a));
  server.registerTool('compile_project', { title: 'Compile project', description: 'Generated source + diagnostics for every script.', inputSchema: { project }, annotations: ro }, (a) => call('compile_project', a));
  server.registerTool('get_generated_code', { title: 'Get generated code', description: 'The generated source text of one script (plain text).', inputSchema: { project, script }, annotations: ro }, async (a) => {
    try {
      const r = (await bridge.request('compile_script', a)) as { ok: boolean; files: { path: string; content: string }[]; diagnostics: { severity: string; message: string }[] };
      if (!r.ok) return fail(new BridgeRequestError('E_COMPILE_ERRORS', 'The script has errors, so no code is generated.', r.diagnostics.filter((d) => d.severity === 'error')));
      return text(r.files.map((f) => `# ===== ${f.path} =====\n${f.content}`).join('\n'));
    } catch (e) {
      return fail(e);
    }
  });

  const doExport = async (params: Record<string, unknown>, outputDir: string | undefined, overwrite: boolean) => {
    try {
      const r = (await bridge.request('export_files', params, 60_000)) as { files: Record<string, string>; diagnostics: unknown };
      if (!outputDir) return text({ files: r.files, diagnostics: r.diagnostics, note: host.writeFiles ? 'No output_dir given, so nothing was written. Pass an absolute output_dir to write the files.' : 'These are the generated files. This connector runs in the cloud and cannot write to your computer; save them yourself or use Export in the editor.' });
      if (!host.writeFiles) throw new ExportError('E_NO_FILESYSTEM', 'This connector runs in the cloud and cannot write files to your computer. Call again without output_dir to get the file contents, or use Export in the editor.');
      return text({ ...(await host.writeFiles(outputDir, r.files, overwrite, bridge)), diagnostics: r.diagnostics });
    } catch (e) {
      return fail(e);
    }
  };
  server.registerTool(
    'export_script',
    { title: 'Export script', description: 'Write one script\'s generated source (e.g. player.gd) into output_dir (absolute path, e.g. a Godot project folder). Refuses if the graph has errors. Existing files are only replaced with overwrite=true and the user\'s approval in the editor.', inputSchema: { project, script, output_dir: z.string().optional(), overwrite: z.boolean().optional() }, annotations: { destructiveHint: false } },
    (a) => doExport({ project: a.project, script: a.script }, a.output_dir, a.overwrite === true),
  );
  server.registerTool(
    'export_project',
    { title: 'Export project', description: 'Write every generated script (folder structure preserved) into output_dir; include_project also writes the editable <name>.vproj.json. Same overwrite rules as export_script.', inputSchema: { project, output_dir: z.string().optional(), overwrite: z.boolean().optional(), include_project: z.boolean().optional() } },
    (a) => doExport({ project: a.project, include_project: a.include_project === true }, a.output_dir, a.overwrite === true),
  );

  // --- files (the whole project workspace) -------------------------------------------------------
  const wsRevision = z.string().optional().describe('workspace_revision from read_tree / a previous file batch. If ANY file changed since, nothing is applied (E_REVISION_CONFLICT). For finer control use expected_hash per write.');
  server.registerTool(
    'read_tree',
    { title: 'Read file tree', description: 'List the project\'s files and folders (path, kind text|binary|graph, size, git blob hash) and the workspace_revision. Visual scripts are "<path>.vgraph" files; their generated source (e.g. main.gd) is listed under "generated" (read-only).', inputSchema: { project, path: z.string().optional().describe('Folder to list (default: whole project)'), depth: z.number().int().min(1).max(50).optional() }, annotations: ro },
    (a) => call('read_tree', a),
  );
  server.registerTool(
    'read_files',
    { title: 'Read files', description: 'Read up to 200 files at once: text (and .vgraph JSON) as text, binaries as base64. Each file comes with its hash — pass it as expected_hash when writing it back so you never overwrite someone else\'s change. Generated files (e.g. main.gd) can be read too.', inputSchema: { project, paths: z.array(z.string()).min(1).max(200) }, annotations: ro },
    (a) => call('read_files', a),
  );
  server.registerTool(
    'search_files',
    { title: 'Search files', description: 'Search text files in the project (literal by default; regex=true for a regular expression). Returns path, line and the matching line.', inputSchema: { project, query: z.string(), regex: z.boolean().optional(), case_sensitive: z.boolean().optional(), path: z.string().optional().describe('Only search inside this folder'), limit: z.number().int().min(1).max(2000).optional() }, annotations: ro },
    (a) => call('search_files', a),
  );
  const WS_DOC = `Change the project's files atomically: all operations succeed or nothing changes, and the batch is ONE undo step. Operations:
- {op:"write_file", path, content | base64, [expected_hash]}  create or replace a file. expected_hash = the hash you read (refused if the file changed since); null = must not exist yet. Parent folders are created.
- {op:"create_dir", path} · {op:"delete", path, [recursive], [expected_hash]} (folders need recursive:true) · {op:"move"|"copy", from, to, [overwrite]} (files or folders)
- {op:"graph", ops:[…batch_edit operations…], [script: "path/to.vgraph" | name | id], [graph]}  edit visual scripts in the same atomic batch (see batch_edit for the operation list). Create a new visual script with {op:"graph", ops:[{op:"add_script", name, path}]}.
- {op:"config", patch:{name?, description?, language?, languageVersion?, compiler?}}  edit codingstudio.json.
.vgraph files are visual scripts: prefer "graph" ops over writing their JSON. codingstudio.json can't be deleted or moved. A backup is taken before deletes and large batches.`;
  server.registerTool('read_config', { title: 'Read a config file', description: 'A JSON / YAML / TOML / XML / .properties file as data, plus what is wrong with it for known kinds (package.json, tsconfig, fabric.mod.json, neoforge.mods.toml, pom.xml, .csproj, pyproject.toml, GitHub workflows, wrangler, gradle.properties). XML elements appear as keys ("@name" = attribute; repeated elements are lists).', inputSchema: { project, path: z.string() }, annotations: ro }, (a) => call('read_config', a));
  server.registerTool(
    'edit_config',
    {
      title: 'Edit a config file',
      description: 'Change fields in a JSON / YAML / TOML / XML / .properties file without rewriting it: comments, key order and other fields stay as they are (the same edits the visual editor makes). One undo step. Creates the file if missing. Returns any problems the file\'s schema finds afterwards.',
      inputSchema: {
        project,
        path: z.string(),
        edits: z.array(z.looseObject({ op: z.enum(['set', 'delete', 'rename', 'move', 'insert']), path: z.array(z.union([z.string(), z.number()])).describe('Keys and list indexes, e.g. ["scripts","dev"] or ["mods",0,"modId"]'), value: z.unknown().optional(), to: z.union([z.string(), z.number()]).optional().describe('rename: new key; move: new index'), index: z.number().optional().describe('insert: position (default: end)') })).min(1),
      },
    },
    (a) => call('edit_config', a),
  );
  server.registerTool(
    'workspace_batch',
    { title: 'Edit files (batch)', description: WS_DOC, inputSchema: { project, expected_revision: wsRevision, operations: z.array(z.looseObject({ op: z.enum(['write_file', 'create_dir', 'delete', 'move', 'copy', 'graph', 'config']) })).min(1).max(2000) } },
    (a) => call('workspace_batch', a, 60_000),
  );
  server.registerTool(
    'write_file',
    { title: 'Write file', description: 'Create or replace one text file (folders are created). Pass expected_hash from read_files to avoid overwriting a newer version; null means the file must not exist yet.', inputSchema: { project, path: z.string(), content: z.string(), expected_hash: z.string().nullable().optional() } },
    (a) => call('workspace_batch', { project: a.project, operations: [{ op: 'write_file', path: a.path, content: a.content, ...(a.expected_hash !== undefined ? { expectedHash: a.expected_hash } : {}) }] }),
  );
  server.registerTool(
    'move_path',
    { title: 'Move / rename', description: 'Move or rename a file or folder. Visual scripts keep their .vgraph extension.', inputSchema: { project, from: z.string(), to: z.string(), overwrite: z.boolean().optional() } },
    (a) => call('workspace_batch', { project: a.project, operations: [{ op: 'move', from: a.from, to: a.to, overwrite: a.overwrite }] }),
  );
  server.registerTool(
    'delete_path',
    { title: 'Delete file or folder', description: 'Delete a file, or a folder with recursive=true. A backup is taken first and it can be undone.', inputSchema: { project, path: z.string(), recursive: z.boolean().optional(), expected_hash: z.string().optional() }, annotations: { destructiveHint: true } },
    (a) => call('workspace_batch', { project: a.project, operations: [{ op: 'delete', path: a.path, recursive: a.recursive, ...(a.expected_hash ? { expectedHash: a.expected_hash } : {}) }] }),
  );

  // --- GitHub ------------------------------------------------------------------------------------
  const gitNote = 'Needs GitHub connected in Coding Studio (Git tab → token; the token stays in the user\'s own cloud storage).';
  server.registerTool('git_repos', { title: 'List GitHub repositories', description: `Repositories the user's GitHub token can access. ${gitNote}`, inputSchema: {}, annotations: ro }, () => call('git_repos', {}, 60_000));
  server.registerTool(
    'git_clone',
    { title: 'Open a GitHub repository', description: `Download a branch of a repository as a new Coding Studio project (linked to GitHub for commit/pull). ${gitNote}`, inputSchema: { repository: z.string().describe('"owner/name"'), branch: z.string().optional().describe('Default: the repository\'s default branch') } },
    (a) => call('git_clone', a, 300_000),
  );
  server.registerTool('git_status', { title: 'Git status', description: 'Repository, branch and the files changed (added/modified/deleted) since the last commit or pull.', inputSchema: { project }, annotations: ro }, (a) => call('git_status', a));
  server.registerTool(
    'git_commit',
    { title: 'Commit & push', description: `Commit all changes (or only "paths") and push to GitHub. new_branch commits to a new branch made from the current one (then open a PR with git_create_pr). Refused with E_NOT_FAST_FORWARD if GitHub has newer commits — git_pull first. ${gitNote}`, inputSchema: { project, message: z.string(), paths: z.array(z.string()).optional(), new_branch: z.string().optional() } },
    (a) => call('git_commit', a, 300_000),
  );
  server.registerTool(
    'git_pull',
    { title: 'Pull', description: 'Bring in new commits from GitHub. Files changed only on GitHub are updated; text changed on both sides is merged line by line (overlaps get conflict markers); graph/binary files changed on both sides keep the local version and are reported. One undo step.', inputSchema: { project } },
    (a) => call('git_pull', a, 300_000),
  );
  server.registerTool(
    'git_create_pr',
    { title: 'Open a pull request', description: 'Open a pull request from the current branch (or "head") into the default branch (or "base"). repository "owner/name" targets any repository instead of the project\'s.', inputSchema: { project, repository, title: z.string(), body: z.string().optional(), head: z.string().optional(), base: z.string().optional(), draft: z.boolean().optional() } },
    (a) => call('git_create_pr', a, 60_000),
  );
  server.registerTool('git_pr_list', { title: 'List pull requests', description: `Pull requests of the project's repository (or "repository"). ${gitNote}`, inputSchema: { project, repository, state: z.enum(['open', 'closed', 'all']).optional() }, annotations: ro }, (a) => call('git_pr_list', a, 60_000));
  server.registerTool('git_pr_get', { title: 'Pull request details', description: 'One pull request: description, whether it can be merged, and the files it changes.', inputSchema: { project, repository, number: z.number() }, annotations: ro }, (a) => call('git_pr_get', a, 60_000));
  server.registerTool('git_pr_update', { title: 'Edit / close a pull request', description: 'Change a pull request\'s title, description or base branch, or close / reopen it (state).', inputSchema: { project, repository, number: z.number(), title: z.string().optional(), body: z.string().optional(), base: z.string().optional(), state: z.enum(['open', 'closed']).optional() } }, (a) => call('git_pr_update', a, 60_000));
  server.registerTool(
    'git_pr_merge',
    { title: 'Merge a pull request', description: 'Merge a pull request on GitHub (method merge, squash or rebase; delete_branch removes its branch afterwards). Refused with E_MERGE_CONFLICT if it conflicts with its base. After merging, git_pull brings the result into the project.', inputSchema: { project, repository, number: z.number(), method: z.enum(['merge', 'squash', 'rebase']).optional(), commit_title: z.string().optional(), delete_branch: z.boolean().optional() } },
    (a) => call('git_pr_merge', a, 120_000),
  );
  server.registerTool('git_repo_create', { title: 'Create a repository', description: `Create a new GitHub repository (private unless private=false; org to create it in an organisation). To put the open project into a new repository instead, use git_publish. ${gitNote}`, inputSchema: { name: z.string(), description: z.string().optional(), private: z.boolean().optional(), org: z.string().optional(), auto_init: z.boolean().optional().describe('Start with a README commit (default true)') } }, (a) => call('git_repo_create', a, 60_000));
  server.registerTool('git_publish', { title: 'Publish project to a new repository', description: 'Create a GitHub repository for the open project (which must not be linked yet), link it, and push every file as the first commit.', inputSchema: { project, name: z.string(), description: z.string().optional(), private: z.boolean().optional(), org: z.string().optional(), message: z.string().optional() } }, (a) => call('git_publish', a, 300_000));
  server.registerTool('git_repo_update', { title: 'Edit a repository', description: 'Rename a repository, change its description, homepage, visibility (private), default branch, or archive it. Defaults to the project\'s repository.', inputSchema: { project, repository, name: z.string().optional(), description: z.string().optional(), homepage: z.string().optional(), private: z.boolean().optional(), default_branch: z.string().optional(), archived: z.boolean().optional() } }, (a) => call('git_repo_update', a, 60_000));
  server.registerTool('git_repo_delete', { title: 'Delete a repository', description: 'Permanently delete a GitHub repository. confirm_name must be exactly "owner/name"; when the editor is open the user is asked too. Needs the token\'s Administration permission.', inputSchema: { project, repository, confirm_name: z.string() }, annotations: { destructiveHint: true } }, (a) => call('git_repo_delete', a, 300_000));

  // --- CI (GitHub Actions) -------------------------------------------------------------------------
  server.registerTool('ci_status', { title: 'CI status', description: 'Workflows of the linked repository and the latest runs on the current branch (state: running / passed / failed …).', inputSchema: { project, branch: z.string().optional() }, annotations: ro }, (a) => call('ci_status', a, 60_000));
  server.registerTool('ci_run', { title: 'Run a workflow', description: 'Start a workflow (needs "on: workflow_dispatch") on the current branch or "ref".', inputSchema: { project, workflow: z.string().optional().describe('Workflow id, name or file (e.g. ci.yml); optional if there is only one'), ref: z.string().optional() } }, (a) => call('ci_run', a, 60_000));
  server.registerTool('ci_run_details', { title: 'CI run details', description: 'Jobs of a run with their state and failed steps.', inputSchema: { project, run_id: z.number().int() }, annotations: ro }, (a) => call('ci_run_details', a, 60_000));
  server.registerTool(
    'ci_logs',
    { title: 'CI logs', description: 'Logs of a run\'s failed jobs (or one job): the problems found (errors with project file and line, when they point at one) and the last lines of the log.', inputSchema: { project, run_id: z.number().int().optional(), job_id: z.number().int().optional(), tail: z.number().int().min(10).max(1000).optional() }, annotations: ro },
    (a) => call('ci_logs', a, 120_000),
  );
  server.registerTool('ci_rerun', { title: 'Re-run CI', description: 'Re-run the failed jobs of a run (all=true re-runs everything).', inputSchema: { project, run_id: z.number().int(), all: z.boolean().optional() } }, (a) => call('ci_rerun', a, 60_000));
  server.registerTool('ci_add_workflow', { title: 'Add a CI workflow', description: 'Add a workflow file from a template: "ci" (install + typecheck/lint/test/build scripts from package.json) or "cloudflare" (deploy with wrangler; needs repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID). Commit it with git_commit to turn it on.', inputSchema: { project, template: z.enum(['ci', 'cloudflare']) } }, (a) => call('ci_add_workflow', a));

  // --- npm dependencies ----------------------------------------------------------------------------
  server.registerTool('deps_list', { title: 'List dependencies', description: 'Dependencies, devDependencies and scripts from package.json, and whether the lockfile is in sync.', inputSchema: { project }, annotations: ro }, (a) => call('deps_list', a));
  server.registerTool('deps_search', { title: 'Search npm', description: 'Search the npm registry.', inputSchema: { query: z.string(), limit: z.number().int().min(1).max(30).optional(), project }, annotations: ro }, (a) => call('deps_search', a, 30_000));
  server.registerTool(
    'deps_add',
    { title: 'Add a dependency', description: 'Add (or change) a package in package.json (created if missing). version: a version or range (default: ^latest). The editor then loads its TypeScript types; installing happens on a computer or in CI.', inputSchema: { project, name: z.string(), version: z.string().optional(), dev: z.boolean().optional() } },
    (a) => call('deps_add', a, 30_000),
  );
  server.registerTool('deps_remove', { title: 'Remove a dependency', description: 'Remove a package from package.json.', inputSchema: { project, name: z.string() } }, (a) => call('deps_remove', a));

  // --- this computer (local server only) -----------------------------------------------------------
  const local = host.local;
  if (local) {
    const run = async (f: () => Promise<unknown>) => {
      try {
        return text(await f());
      } catch (e) {
        return fail(e);
      }
    };
    server.registerTool(
      'link_folder',
      { title: 'Link to a folder', description: 'Write the project (every file plus the generated code) into a folder on this computer, so it can be installed, run, tested and built there. Afterwards edits made in the folder (another editor, a formatter) come back into the project, and run_task / dev_server re-sync the folder first. Existing files with different content are only replaced with overwrite=true and the user\'s approval in the editor.', inputSchema: { project, folder: z.string().describe('Absolute path; created if missing'), overwrite: z.boolean().optional(), watch: z.boolean().optional().describe('Bring edits made in the folder back (default true)') } },
      (a) => run(() => local.link(a.folder, { project: a.project, overwrite: a.overwrite, watch: a.watch })),
    );
    server.registerTool(
      'open_folder',
      { title: 'Open a folder', description: 'Open an existing folder on this computer (e.g. a Vite or Godot project) as a new Coding Studio project, linked to it: node_modules, .git and build output are left out, edits in either place reach the other, and install / run_task / dev_server run there.', inputSchema: { folder: z.string().describe('Absolute path'), name: z.string().optional(), watch: z.boolean().optional(), clone_url: z.string().optional().describe('git clone this repository into the (empty) folder first, with the computer\'s own git credentials') } },
      (a) => run(() => local.open(a.folder, { name: a.name, watch: a.watch, cloneUrl: a.clone_url })),
    );
    server.registerTool('sync_folder', { title: 'Sync folder', description: 'Write the project\'s current files into its linked folder (only what changed).', inputSchema: { project } }, (a) => run(() => local.sync(a.project)));
    server.registerTool('install', { title: 'Install packages', description: 'Run the project\'s package manager install (npm, pnpm or yarn, chosen from the lockfile) in the linked folder. Waits for it unless wait=false.', inputSchema: { project, wait: z.boolean().optional() } }, (a) => run(() => local.install(a.project, a.wait !== false)));
    server.registerTool(
      'run_task',
      { title: 'Run a script', description: 'Run a script from package.json (build, lint, typecheck…) in the linked folder and return its exit code and output. Only scripts package.json defines can run; there is no shell. dev/start/serve/preview start the dev server instead (see dev_server).', inputSchema: { project, script: z.string(), wait: z.boolean().optional().describe('false = return at once with the task id (read it with task_output)') } },
      (a) => run(() => local.run(a.script, { project: a.project, wait: a.wait })),
    );
    server.registerTool('run_tests', { title: 'Run tests', description: 'Run the "test" script from package.json in the linked folder; returns pass/fail and the output.', inputSchema: { project } }, (a) => run(() => local.run('test', { project: a.project })));
    server.registerTool(
      'dev_server',
      { title: 'Dev server', description: 'start: run the dev script (default "dev", e.g. Vite) in the linked folder and return its local URL once it prints one; it keeps running and reloads on changes. stop: stop it. status: is it running, and where.', inputSchema: { project, action: z.enum(['start', 'stop', 'status']), script: z.string().optional() } },
      (a) => run(() => local.dev(a.action, { project: a.project, script: a.script })),
    );
    server.registerTool(
      'local_git',
      {
        title: 'Git (this computer)',
        description: `Real git in the project's linked folder (link_folder / open_folder first), using the computer's own git and credentials. Use it for what the GitHub tools can't do: rebase, stash, cherry-pick, merge, blame, LFS, other remotes. The editor's files are written to the folder first, and after actions that change files (switch, pull, stash, stash_pop, rebase, cherry_pick, merge, lfs_pull) the project is updated from the folder (one undo step). push and rebase need the user's approval in the editor. On a conflict the result lists the files; fix the markers, then rebase_continue or commit, or *_abort.
Actions: status · log {ref?, path?, limit?} · diff {ref?, paths?} · blame {path, ref?} · branches · switch {branch, create?} · commit {message, paths? (default all)} · fetch {remote?} · pull {remote?, branch?} · push {remote?, branch?} · stash {message?} · stash_pop · stash_list · rebase {onto} · rebase_continue · rebase_abort · cherry_pick {commit} · merge {branch} · merge_abort · lfs_status · lfs_pull · lfs_track {pattern} · init {branch?}. To clone a repository onto this computer, use open_folder with clone_url.`,
        inputSchema: { project, action: z.string(), path: z.string().optional(), paths: z.array(z.string()).optional(), message: z.string().optional(), branch: z.string().optional(), create: z.boolean().optional(), onto: z.string().optional(), commit: z.string().optional(), ref: z.string().optional(), limit: z.number().optional(), remote: z.string().optional(), pattern: z.string().optional(), url: z.string().optional() },
      },
      ({ action, ...rest }) => run(() => local.git(action, rest)),
    );
    server.registerTool('task_output', { title: 'Task output', description: 'Output and state of a task (by id from install / run_task / dev_server), or a list of this project\'s tasks when id is omitted.', inputSchema: { project, id: z.string().optional() }, annotations: ro }, (a) => run(() => local.output(a.id, a.project)));
  }

  // --- history ------------------------------------------------------------------------------------
  server.registerTool('undo', { title: 'Undo', description: 'Undo the latest edit in the editor (each batch is one step).', inputSchema: { project } }, (a) => call('undo', a));
  server.registerTool('redo', { title: 'Redo', description: 'Redo the latest undone edit.', inputSchema: { project } }, (a) => call('redo', a));
  server.registerTool('list_backups', { title: 'List backups', description: 'Backups of the project (taken before destructive and large edits).', inputSchema: { project }, annotations: ro }, (a) => call('list_backups', a));
  server.registerTool('restore_backup', { title: 'Restore backup', description: 'Restore a backup (the current state is backed up first; the restore itself can be undone).', inputSchema: { project, backup: z.number().int() } }, (a) => call('restore_backup', a));

  return server;
}

