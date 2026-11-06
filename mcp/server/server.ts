#!/usr/bin/env node
/**
 * Coding Studio MCP server.
 *
 * Claude Code launches this over stdio. Tool calls are relayed to the Coding Studio editor tab
 * through a WebSocket on 127.0.0.1; the editor executes them with the same validated edit
 * operations as the mouse (atomic batches, undo, autosave, revision checks). This process holds
 * no project state and only touches the filesystem in export_script / export_project.
 *
 * Environment:
 *   CODING_STUDIO_PORT          WebSocket port (default 47831; must match the editor's MCP setting)
 *   CODING_STUDIO_ORIGINS       comma-separated extra allowed origins (e.g. https://studio.example.workers.dev)
 *   CODING_STUDIO_EXPORT_ROOTS  optional ':'-separated directories exports must stay inside
 *
 * stdout carries the MCP protocol — logs go to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { BRIDGE_DEFAULT_PORT, type BridgeMethod } from '@cs/shared-protocol';
import { BridgeRequestError, EditorBridge, errorPayload, log, parseOrigins, SERVER_VERSION, type EditorAssets } from './bridge';
import { ExportError, parseRoots, planExport, writePlan } from './export';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof ExportError ? { code: e.code, message: e.message, details: e.details } : errorPayload(e) }, null, 2) }] });

const project = z.string().optional().describe('Project id or exact name. Omit to use the project open in Coding Studio.');
const revision = z.string().optional().describe('Revision returned by get_graph / get_project / a previous edit. If the project changed since (e.g. the user edited it), the edit is rejected with E_REVISION_CONFLICT and nothing changes.');
const graph = z.string().optional().describe('Function/graph id (or function name). Omit to use the graph open in the editor.');
const script = z.string().optional().describe('Script id or name. Omit for the active script.');
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
] as const;

const BATCH_DOC = `Apply several edit operations atomically: either all succeed or the project is unchanged. The whole batch is ONE undo step for the user.
Reference objects created earlier in the batch with "$ref" (set "ref" on the creating op). add_function also defines "$<ref>.entry" for its Entry node.
Operations (fields in brackets are optional; script/graph default to the active ones):
- add_node {type, [ref], [graph], [position {x,y}], [props], [inputs]}   inputs = inline literal values for unconnected data inputs, keyed by port id
- update_node {node, [props], [inputs (null clears)], [position], [collapsed], [size]}
- delete_nodes {nodes[]} · move_nodes {nodes[], dx, dy | positions{id:{x,y}}} · duplicate_nodes {nodes[], [offset], [ref → "$ref.0"…]}
- connect {from {node, port}, to {node, port}, [ref]}  (output → input; replaces an existing wire into a data input / out of an exec output)
- disconnect {edges[] | from | to}
- add_function {name, [params [{name,type,default?}]], [returnType], [description], [ref]}  or {kind:"event", event:"_ready"|"_process"|"_physics_process"|"_input"|…}
- update_function {function, [name], [params], [returnType], [description]} · delete_function {function}
- add_variable {name, type, [default], [exported], [constant], [description], [attributes {onreadyPath}], [function → local variable]} · update_variable {variable, …} · delete_variable {variable}
- add_signal {name, [params]} · update_signal · delete_signal · add_enum {name, members[]} · update_enum · delete_enum
- add_script {name, [path], [template], [settings {extends, class_name, tool}]} · update_script {script, …} · delete_script {script}
- update_project {[name], [languageVersion], [compilerSettings]}
Node props that reference variables/functions/signals/enums accept their id or name.
Execution flow: connect exec output "then" (or "true"/"false", "body", "completed"…) to exec input "exec". Every function graph starts at its Entry node (output "then", plus one data output per parameter, keyed by parameter id or name).`;

export function buildServer(bridge: EditorBridge, exportRoots: string[] = []): McpServer {
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
      description: `Open Coding Studio in the user's default browser. The editor is served by this MCP server itself (no website or install needed) at http://localhost:<port>, and connects to Claude automatically. Use this when status says Coding Studio isn't open.`,
      inputSchema: {},
    },
    async () => {
      const url = bridge.editorUrl;
      try {
        openInBrowser(url);
        return text({ opened: url, note: 'Give the page a few seconds to load, then call status. If no browser window appeared, ask the user to open the URL themselves.' });
      } catch (e) {
        return fail(new BridgeRequestError('E_OPEN_FAILED', `Could not open a browser (${e instanceof Error ? e.message : String(e)}). Ask the user to open ${url} in any browser.`));
      }
    },
  );
  server.registerTool('list_projects', { title: 'List projects', description: 'Projects saved in the Coding Studio browser storage.', inputSchema: {}, annotations: ro }, () => call('list_projects'));
  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a project with one script and open it in the editor. Templates (GDScript): node, node2d, node3d, character2d, character3d, control, refcounted.',
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
    { title: 'Create function', description: 'Add a function with its own graph (an Entry node is created automatically).', inputSchema: { project, expected_revision: revision, script, name: z.string(), params: z.array(param).optional(), return_type: z.string().optional(), description: z.string().optional() } },
    (a) => batch(a, [{ op: 'add_function', ref: 'function', script: a.script, name: a.name, params: a.params, returnType: a.return_type, description: a.description }]),
  );
  server.registerTool(
    'update_function',
    { title: 'Update function', description: 'Rename a function or change its parameters / return type. Connections to removed parameters are dropped (reported as warnings).', inputSchema: { project, expected_revision: revision, function: z.string(), name: z.string().optional(), params: z.array(param.extend({ id: z.string().optional() })).optional(), return_type: z.string().optional(), description: z.string().optional() } },
    (a) => batch(a, [{ op: 'update_function', function: a.function, name: a.name, params: a.params, returnType: a.return_type, description: a.description }]),
  );
  server.registerTool('delete_function', { title: 'Delete function', description: 'Delete a function and its graph.', inputSchema: { project, expected_revision: revision, function: z.string() }, annotations: { destructiveHint: true } }, (a) => batch(a, [{ op: 'delete_function', function: a.function }]));
  server.registerTool('create_signal', { title: 'Create signal', description: 'Declare a signal on a script.', inputSchema: { project, expected_revision: revision, script, name: z.string(), params: z.array(param).optional(), description: z.string().optional() } }, (a) => batch(a, [{ op: 'add_signal', ref: 'signal', script: a.script, name: a.name, params: a.params, description: a.description }]));

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
      if (!outputDir) return text({ files: r.files, diagnostics: r.diagnostics, note: 'No output_dir given, so nothing was written. Pass an absolute output_dir to write the files.' });
      const plan = planExport(outputDir, r.files, exportRoots);
      const conflicts = plan.targets.filter((t) => t.exists).map((t) => t.path);
      if (conflicts.length) {
        if (!overwrite) throw new ExportError('E_FILE_EXISTS', `These files already exist and overwrite is false, so nothing was written:\n${conflicts.join('\n')}\nRe-run with overwrite: true; the user will be asked to approve it in Coding Studio.`, { conflicts });
        const ok = (await bridge.request('confirm_overwrite', { dir: plan.root, files: conflicts }, 300_000)) as { approved: boolean };
        if (!ok.approved) throw new ExportError('E_DECLINED', 'The user declined overwriting the existing files. Nothing was written.', { conflicts });
      }
      const written = writePlan(plan, r.files);
      return text({ outputDir: plan.root, written, overwritten: conflicts, diagnostics: r.diagnostics });
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

  // --- history ------------------------------------------------------------------------------------
  server.registerTool('undo', { title: 'Undo', description: 'Undo the latest edit in the editor (each batch is one step).', inputSchema: { project } }, (a) => call('undo', a));
  server.registerTool('redo', { title: 'Redo', description: 'Redo the latest undone edit.', inputSchema: { project } }, (a) => call('redo', a));
  server.registerTool('list_backups', { title: 'List backups', description: 'Backups of the project (taken before destructive and large edits).', inputSchema: { project }, annotations: ro }, (a) => call('list_backups', a));
  server.registerTool('restore_backup', { title: 'Restore backup', description: 'Restore a backup (the current state is backed up first; the restore itself can be undone).', inputSchema: { project, backup: z.number().int() } }, (a) => call('restore_backup', a));

  return server;
}

/** Open a URL in the user's default browser (fixed command per OS; the URL is always our own localhost address). */
function openInBrowser(url: string) {
  if (!/^http:\/\/localhost:\d+\/?$/.test(url)) throw new Error('refusing to open a non-local URL');
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log(`could not open browser: ${e.message}`));
  child.unref();
}

export async function main(assets: EditorAssets = {}) {
  const port = Number(process.env.CODING_STUDIO_PORT) || BRIDGE_DEFAULT_PORT;
  const origins = parseOrigins(process.env.CODING_STUDIO_ORIGINS);
  const bridge = new EditorBridge(port, origins, assets);
  await bridge.start();
  const server = buildServer(bridge, parseRoots(process.env.CODING_STUDIO_EXPORT_ROOTS));
  await server.connect(new StdioServerTransport());
  log(`MCP server ready (allowed origins: localhost${origins.length ? ', ' + origins.join(', ') : ''})`);
  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
