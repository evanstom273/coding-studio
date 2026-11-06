/**
 * Executes MCP bridge requests inside the editor. Every mutation goes through
 * useEditor.dispatch → applyOps, exactly like mouse edits: same validation, one undo step per
 * batch, autosaved. Projects are opened through the normal route so the user sees what Claude
 * is editing.
 */
import type { BridgeMethod } from '@cs/shared-protocol';
import type { Diagnostic, FunctionDecl, ScriptDoc } from '@cs/graph-core';
import { compileProject, compileScript, makeNodeContext, nodeInfo } from '@cs/compiler-core';
import { defaultProps, NodeRegistry, type PortSpec } from '@cs/node-registry';
import { formatType } from '@cs/type-system';
import { createProject, OpError, projectRevision, projectToJson, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor, languages } from '@web/lib/toolchain';
import { navigate } from '@web/lib/router';
import { createBackup, deleteProject, duplicateProject, getBackup, insertProject, listBackups, listProjects } from '@web/db/projects';
import { saveNow } from '@web/hooks/useAutosave';
import { useEditor } from '@web/store/editor';
import { compileNow } from '@web/compile/store';
import { confirmDialog } from '@web/components/ui/primitives';
import { APP_VERSION } from './client';

type Params = Record<string, unknown>;

export class BridgeHandlerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new BridgeHandlerError('E_TIMEOUT', `Timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function findProjectId(ref: string): Promise<string> {
  const all = await listProjects();
  if (all.some((p) => p.id === ref)) return ref;
  const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new BridgeHandlerError('E_AMBIGUOUS', `Several projects are called "${ref}": ${byName.map((p) => p.id).join(', ')}. Use the id.`);
  throw new BridgeHandlerError('E_NOT_FOUND', `No project "${ref}". Use list_projects.`);
}

async function openAndWait(id: string) {
  if (useEditor.getState().project?.id === id) return;
  await saveNow();
  navigate({ name: 'project', id });
  await waitFor(() => useEditor.getState().project?.id === id, 10_000, 'the project to open in the editor');
}

async function ensureOpen(ref: unknown): Promise<Project> {
  const r = str(ref);
  if (r) await openAndWait(await findProjectId(r));
  const p = useEditor.getState().project;
  if (!p) throw new BridgeHandlerError('E_NO_PROJECT', 'No project is open in Coding Studio. Pass "project" (id or name), or use create_project / open_project.');
  return p;
}

function locateFunction(p: Project, ref: unknown, scriptRef?: unknown): { script: ScriptDoc; fn: FunctionDecl } {
  const st = useEditor.getState();
  const scripts = str(scriptRef) ? p.scripts.filter((s) => s.id === scriptRef || s.name === scriptRef) : p.scripts;
  const r = str(ref) ?? st.activeFunctionId;
  for (const s of scripts) {
    const f = s.functions.find((x) => x.id === r || x.graph.id === r) ?? (str(ref) ? s.functions.find((x) => x.name === r) : undefined);
    if (f) return { script: s, fn: f };
  }
  throw new BridgeHandlerError('E_NOT_FOUND', `Graph "${String(ref ?? '(active)')}" not found. Use list_graphs.`);
}

function fmtPort(p: PortSpec, language: string) {
  return {
    id: p.id,
    name: p.name,
    direction: p.direction,
    kind: p.kind,
    ...(p.type ? { type: formatType(p.type), sourceType: toolchainFor(language).adapter.types.format(p.type) } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.required ? { required: true } : {}),
    ...(p.connectionOnly ? { connectionOnly: true } : {}),
    ...(p.region ? { region: p.region } : {}),
  };
}

function describeProject(p: Project) {
  const st = useEditor.getState();
  return {
    id: p.id,
    name: p.name,
    language: p.language,
    languageVersion: p.languageVersion,
    revision: projectRevision(p),
    activeScript: st.project?.id === p.id ? st.activeScriptId : undefined,
    activeGraph: st.project?.id === p.id ? st.activeFunctionId : undefined,
    scripts: p.scripts.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path,
      settings: s.settings,
      variables: s.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, default: v.default, exported: v.exported, constant: v.constant, attributes: v.attributes })),
      signals: s.signals.map((x) => ({ id: x.id, name: x.name, params: x.params })),
      enums: s.enums,
      functions: s.functions.map((f) => ({ id: f.id, graphId: f.graph.id, name: f.name, kind: f.kind, params: f.params, returnType: f.returnType, locals: f.locals.map((l) => ({ id: l.id, name: l.name, type: l.type })), nodes: f.graph.nodes.length })),
    })),
  };
}

function diagSummary(d: Diagnostic[]) {
  const errors = d.filter((x) => x.severity === 'error');
  const warnings = d.filter((x) => x.severity === 'warning');
  return { errors: errors.length, warnings: warnings.length, items: [...errors, ...warnings].slice(0, 30) };
}

function describeGraph(p: Project, script: ScriptDoc, fn: FunctionDecl) {
  const tc = toolchainFor(p.language);
  const ctx = makeNodeContext(tc, script, fn);
  const diags = compileScript(tc, script, { languageVersion: p.languageVersion }).diagnostics.filter((d) => d.functionId === fn.id);
  return {
    revision: projectRevision(p),
    script: { id: script.id, name: script.name },
    function: { id: fn.id, name: fn.name, kind: fn.kind, params: fn.params, returnType: fn.returnType, locals: fn.locals },
    graphId: fn.graph.id,
    nodes: fn.graph.nodes.map((n) => {
      const info = nodeInfo(tc, ctx, n);
      return { id: n.id, type: n.type, title: info.title, position: n.position, props: n.props, inputs: n.inputs, ...(n.collapsed ? { collapsed: true } : {}), ports: info.ports.map((x) => fmtPort(x, p.language)) };
    }),
    edges: fn.graph.edges,
    diagnostics: diagSummary(diags),
  };
}

function isSubstantial(ops: EditOp[]) {
  return ops.length >= 15 || ops.some((o) => o.op.startsWith('delete_') || o.op === 'update_project' || (o.op === 'update_function' && o.params !== undefined));
}

function opError(e: unknown): never {
  if (e instanceof OpError) throw new BridgeHandlerError(e.code, e.message, { opIndex: e.opIndex, projectUnchanged: true });
  throw e;
}

export async function handleRequest(method: BridgeMethod, params: Params): Promise<unknown> {
  switch (method) {
    case 'status': {
      const p = useEditor.getState().project;
      return {
        app: 'Coding Studio',
        version: APP_VERSION,
        origin: window.location.origin,
        openProject: p ? { id: p.id, name: p.name, language: p.language, revision: projectRevision(p), activeScript: useEditor.getState().activeScriptId, activeGraph: useEditor.getState().activeFunctionId } : null,
        languages: languages.all().map((l) => ({ id: l.id, name: l.name })),
      };
    }
    case 'list_projects':
      return listProjects();
    case 'create_project': {
      const language = str(params.language) ?? 'gdscript';
      const tc = toolchainFor(language);
      const name = str(params.name);
      if (!name) throw new BridgeHandlerError('E_INVALID', 'name is required');
      const template = str(params.template) ?? tc.adapter.templates[0]?.id;
      if (template && !tc.adapter.templates.some((t) => t.id === template)) throw new BridgeHandlerError('E_INVALID', `Unknown template "${template}". Available: ${tc.adapter.templates.map((t) => t.id).join(', ')}`);
      const scriptName = str(params.script_name) ?? 'Main';
      if (!tc.adapter.identifiers.isValid(scriptName)) throw new BridgeHandlerError('E_INVALID_IDENTIFIER', `script_name "${scriptName}" is not a valid identifier`);
      await saveNow();
      const p = await insertProject(createProject(tc.adapter, name, { template, scriptName }));
      await openAndWait(p.id);
      return describeProject(useEditor.getState().project!);
    }
    case 'open_project':
      return describeProject(await ensureOpen(params.project));
    case 'get_project': {
      const p = await ensureOpen(params.project);
      return params.full === true ? JSON.parse(projectToJson(p)) : describeProject(p);
    }
    case 'save_project': {
      await ensureOpen(params.project);
      await saveNow();
      return { saved: useEditor.getState().saveState === 'saved', state: useEditor.getState().saveState };
    }
    case 'duplicate_project': {
      const id = await findProjectId(str(params.project) ?? useEditor.getState().project?.id ?? '');
      await saveNow();
      const copy = await duplicateProject(id, str(params.name));
      return { id: copy.id, name: copy.name };
    }
    case 'delete_project': {
      const id = await findProjectId(str(params.project) ?? '');
      const name = (await listProjects()).find((p) => p.id === id)?.name;
      const ok = await confirmDialog({ title: 'Claude wants to delete a project', message: `Allow Claude Code to permanently delete "${name}" and its backups from this browser?`, confirm: 'Delete', danger: true });
      if (!ok) throw new BridgeHandlerError('E_DECLINED', 'The user declined the deletion. Nothing was deleted.');
      if (useEditor.getState().project?.id === id) {
        navigate({ name: 'dashboard' });
        await waitFor(() => !useEditor.getState().project, 5000, 'the editor to close').catch(() => undefined);
      }
      await deleteProject(id);
      return { deleted: id };
    }
    case 'list_graphs': {
      const p = await ensureOpen(params.project);
      return p.scripts.map((s) => ({ script: { id: s.id, name: s.name }, graphs: s.functions.map((f) => ({ functionId: f.id, graphId: f.graph.id, name: f.name, kind: f.kind, event: f.event, nodes: f.graph.nodes.length, edges: f.graph.edges.length })) }));
    }
    case 'get_graph': {
      const p = await ensureOpen(params.project);
      const { script, fn } = locateFunction(p, params.graph, params.script);
      if (params.focus !== false) useEditor.getState().setActive(script.id, fn.id);
      return describeGraph(p, script, fn);
    }
    case 'list_node_types': {
      const p = useEditor.getState().project;
      const tc = toolchainFor(str(params.language) ?? p?.language ?? 'gdscript');
      const cat = str(params.category);
      return tc.registry
        .available(tc.adapter.id, tc.adapter.capabilities)
        .filter((d) => !cat || d.category.toLowerCase().startsWith(cat.toLowerCase()))
        .map((d) => ({ type: d.type, title: d.title, category: d.category, flavor: d.flavor, description: d.description }));
    }
    case 'search_nodes': {
      const p = useEditor.getState().project;
      const tc = toolchainFor(str(params.language) ?? p?.language ?? 'gdscript');
      return tc.registry
        .search(String(params.query ?? ''), tc.adapter.id, tc.adapter.capabilities)
        .slice(0, Number(params.limit) || 25)
        .map((d) => ({ type: d.type, title: d.title, category: d.category, flavor: d.flavor, description: d.description }));
    }
    case 'get_node_schema': {
      const p = useEditor.getState().project;
      const tc = toolchainFor(p?.language ?? 'gdscript');
      const def = tc.registry.get(String(params.type ?? ''));
      if (!def) throw new BridgeHandlerError('E_UNKNOWN_NODE', `Unknown node type "${String(params.type)}". Use search_nodes.`);
      let ports: ReturnType<typeof fmtPort>[] = [];
      if (p) {
        const { script, fn } = locateFunction(p, params.graph, params.script);
        const node = { id: '__schema', type: def.type, position: { x: 0, y: 0 }, props: { ...defaultProps(def), ...((params.props as Record<string, never>) ?? {}) }, inputs: {} };
        ports = nodeInfo(tc, makeNodeContext(tc, script, fn), node).ports.map((x) => fmtPort(x, p.language));
      }
      return {
        type: def.type,
        title: def.title,
        category: def.category,
        description: def.description,
        flavor: def.flavor,
        available: NodeRegistry.isAvailable(def, tc.adapter.id, tc.adapter.capabilities),
        props: def.props.map((x) => ({ key: x.key, label: x.label, kind: x.kind, default: x.default, description: x.description, options: x.options?.map((o) => o.value), typeOptions: x.typeOptions, min: x.min, max: x.max })),
        ports,
        notes: 'Ports depend on props and on the graph (e.g. Call Function takes the callee\'s parameters). Pass props and graph to see them. Data inputs can be given inline values via add_node/update_node "inputs" instead of connections, unless connectionOnly.',
      };
    }
    case 'list_language_capabilities': {
      const id = str(params.language) ?? useEditor.getState().project?.language ?? 'gdscript';
      const a = toolchainFor(id).adapter;
      return { id: a.id, name: a.name, extensions: a.extensions, versions: a.versions, defaultVersion: a.defaultVersion, capabilities: a.capabilities, events: a.events, templates: a.templates.map((t) => ({ id: t.id, name: t.name, description: t.description })), scriptSettings: a.scriptSettings, commonTypes: a.types.pickerTypes(), typeSyntax: 'Canonical: bool, int, float, string, any, void, array<T>, map<K, V>, ClassName. GDScript spellings (String, Array[int], Dictionary, Variant) are accepted and normalised.' };
    }
    case 'batch_edit': {
      const p = await ensureOpen(params.project);
      const ops = params.operations;
      if (!Array.isArray(ops) || ops.length === 0) throw new BridgeHandlerError('E_INVALID', 'operations must be a non-empty array');
      const expected = str(params.expected_revision);
      const current = projectRevision(p);
      if (expected && expected !== current) {
        throw new BridgeHandlerError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${current}) — probably the user edited it. Nothing was applied. Re-read the graph (get_graph) and retry with the new revision.`, { expected, current });
      }
      if (isSubstantial(ops as EditOp[])) await createBackup(p, `Before Claude batch (${ops.length} ops)`, 'mcp');
      let res;
      try {
        res = useEditor.getState().dispatch(ops as EditOp[], `Claude: ${(ops as EditOp[]).length === 1 ? (ops as EditOp[])[0].op.replace(/_/g, ' ') : `${ops.length} edits`}`, {
          source: 'mcp',
          defaults: { scriptId: str(params.script) ? p.scripts.find((s) => s.id === params.script || s.name === params.script)?.id : useEditor.getState().activeScriptId, functionId: str(params.graph) ? locateFunction(p, params.graph, params.script).fn.id : useEditor.getState().activeFunctionId },
        });
      } catch (e) {
        opError(e);
      }
      const next = useEditor.getState().project!;
      const diags = compileNow(next).diagnostics;
      return { revision: projectRevision(next), created: res.created, warnings: res.warnings, diagnostics: diagSummary(diags), undo: 'This batch is one undo step (tool "undo").' };
    }
    case 'validate_graph': {
      const p = await ensureOpen(params.project);
      const r = compileNow(p);
      if (str(params.graph)) {
        const { fn } = locateFunction(p, params.graph, params.script);
        return { revision: projectRevision(p), ...diagSummary(r.diagnostics.filter((d) => d.functionId === fn.id)), all: r.diagnostics.filter((d) => d.functionId === fn.id) };
      }
      return { revision: projectRevision(p), ok: r.ok, ...diagSummary(r.diagnostics), all: r.diagnostics };
    }
    case 'compile_script': {
      const p = await ensureOpen(params.project);
      const s = p.scripts.find((x) => x.id === params.script || x.name === params.script) ?? p.scripts.find((x) => x.id === useEditor.getState().activeScriptId);
      if (!s) throw new BridgeHandlerError('E_NOT_FOUND', 'Script not found');
      const r = compileScript(toolchainFor(p.language), s, { languageVersion: p.languageVersion, settings: p.compilerSettings });
      return { ok: r.ok, files: r.files.map((f) => ({ path: f.path, content: f.content })), diagnostics: r.diagnostics };
    }
    case 'compile_project': {
      const p = await ensureOpen(params.project);
      const r = compileNow(p);
      return { ok: r.ok, files: r.files.map((f) => ({ path: f.path, content: f.content })), diagnostics: r.diagnostics };
    }
    case 'export_files': {
      const p = await ensureOpen(params.project);
      const r = compileProject(toolchainFor(p.language), p);
      const scriptRef = str(params.script);
      const scripts = scriptRef ? r.scripts.filter((s) => s.scriptId === scriptRef || p.scripts.find((x) => x.id === s.scriptId)?.name === scriptRef) : r.scripts;
      if (scriptRef && !scripts.length) throw new BridgeHandlerError('E_NOT_FOUND', `Script "${scriptRef}" not found`);
      const diags = scripts.flatMap((s) => s.diagnostics);
      const ok = scripts.every((s) => s.ok) && (scriptRef ? true : r.ok);
      if (!ok) throw new BridgeHandlerError('E_COMPILE_ERRORS', 'The graph has errors, so no source was exported. Fix them first (validate_graph).', { diagnostics: diagSummary(diags) });
      const files: Record<string, string> = {};
      for (const s of scripts) for (const f of s.files) files[f.path] = f.content;
      if (params.include_project === true) files[`${p.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'project'}.vproj.json`] = projectToJson(p);
      return { ok: true, files, diagnostics: diagSummary(diags) };
    }
    case 'undo': {
      await ensureOpen(params.project);
      const label = useEditor.getState().undo();
      if (!label) throw new BridgeHandlerError('E_NOTHING_TO_UNDO', 'Nothing to undo.');
      return { undone: label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'redo': {
      await ensureOpen(params.project);
      const label = useEditor.getState().redo();
      if (!label) throw new BridgeHandlerError('E_NOTHING_TO_REDO', 'Nothing to redo.');
      return { redone: label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'list_backups': {
      const p = await ensureOpen(params.project);
      return listBackups(p.id);
    }
    case 'restore_backup': {
      const p = await ensureOpen(params.project);
      const row = await getBackup(Number(params.backup));
      if (!row || row.projectId !== p.id) throw new BridgeHandlerError('E_NOT_FOUND', `Backup ${String(params.backup)} not found for this project. Use list_backups.`);
      await createBackup(p, 'Before restoring a backup (Claude)', 'mcp');
      useEditor.getState().replaceProject(row.doc, `Claude: restore backup "${row.label}"`, 'mcp');
      return { restored: row.id, label: row.label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'confirm_overwrite': {
      const files = Array.isArray(params.files) ? (params.files as string[]) : [];
      const ok = await confirmDialog({
        title: 'Claude wants to overwrite files',
        message: (
          <>
            Allow Claude Code to overwrite {files.length} existing file(s) in <code className="font-mono text-[11.5px]">{String(params.dir)}</code>?
            <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 font-mono text-[11px]">
              {files.slice(0, 50).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        ),
        confirm: 'Overwrite',
        danger: true,
      });
      return { approved: ok };
    }
  }
}
