/**
 * Read-only views and queries over projects, shared by the editor's MCP handlers (browser) and the
 * cloud service (Durable Object). No browser or runtime-specific code.
 */
import type { Diagnostic, FunctionDecl, ScriptDoc } from '@cs/graph-core';
import { compileProject, compileScript, makeNodeContext, nodeInfo } from '@cs/compiler-core';
import { defaultProps, NodeRegistry, type PortSpec } from '@cs/node-registry';
import { formatType } from '@cs/type-system';
import { projectRevision, projectToJson, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';
import { matchScript } from './workspace';

/** Structured error returned to MCP clients as { code, message, details }. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function locateFunction(p: Project, ref: unknown, scriptRef?: unknown, activeFunctionId?: string): { script: ScriptDoc; fn: FunctionDecl } {
  const scripts = str(scriptRef) ? p.scripts.filter((s) => matchScript(s, scriptRef)) : p.scripts;
  const r = str(ref) ?? activeFunctionId;
  for (const s of scripts) {
    const f = s.functions.find((x) => x.id === r || x.graph.id === r) ?? (str(ref) ? s.functions.find((x) => x.name === r) : undefined);
    if (f) return { script: s, fn: f };
  }
  if (!str(ref) && !activeFunctionId) {
    const first = scripts[0]?.functions[0];
    if (first) return { script: scripts[0], fn: first };
  }
  throw new ServiceError('E_NOT_FOUND', `Graph "${String(ref ?? '(active)')}" not found. Use list_graphs.`);
}

export function fmtPort(p: PortSpec, language: string) {
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

export function describeProject(p: Project, active: { scriptId?: string; functionId?: string } = {}) {
  return {
    id: p.id,
    name: p.name,
    language: p.language,
    languageVersion: p.languageVersion,
    revision: projectRevision(p),
    activeScript: active.scriptId,
    activeGraph: active.functionId,
    scripts: p.scripts.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path,
      settings: s.settings,
      variables: s.variables.map((v) => ({ id: v.id, name: v.name, type: v.type, default: v.default, exported: v.exported, constant: v.constant, attributes: v.attributes })),
      signals: s.signals.map((x) => ({ id: x.id, name: x.name, params: x.params })),
      enums: s.enums,
      ...(s.interfaces?.length ? { types: s.interfaces } : {}),
      functions: s.functions.map((f) => ({ id: f.id, graphId: f.graph.id, name: f.name, kind: f.kind, params: f.params, returnType: f.returnType, locals: f.locals.map((l) => ({ id: l.id, name: l.name, type: l.type })), nodes: f.graph.nodes.length })),
    })),
  };
}

export function diagSummary(d: Diagnostic[]) {
  const errors = d.filter((x) => x.severity === 'error');
  const warnings = d.filter((x) => x.severity === 'warning');
  return { errors: errors.length, warnings: warnings.length, items: [...errors, ...warnings].slice(0, 30) };
}

export function describeGraph(p: Project, script: ScriptDoc, fn: FunctionDecl) {
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

export function listGraphs(p: Project) {
  return p.scripts.map((s) => ({ script: { id: s.id, name: s.name }, graphs: s.functions.map((f) => ({ functionId: f.id, graphId: f.graph.id, name: f.name, kind: f.kind, event: f.event, nodes: f.graph.nodes.length, edges: f.graph.edges.length })) }));
}

/** Batches that get a backup first. */
export function isSubstantial(ops: EditOp[]) {
  return ops.length >= 15 || ops.some((o) => o.op.startsWith('delete_') || o.op === 'update_project' || (o.op === 'update_function' && o.params !== undefined));
}

const summary = (d: { type: string; title: string; category: string; flavor: string; description: string }) => ({ type: d.type, title: d.title, category: d.category, flavor: d.flavor, description: d.description });

export function listNodeTypes(language: string, category?: string) {
  const tc = toolchainFor(language);
  return tc.registry
    .available(tc.adapter.id, tc.adapter.capabilities)
    .filter((d) => !category || d.category.toLowerCase().startsWith(category.toLowerCase()))
    .map(summary);
}

export function searchNodes(language: string, query: string, limit = 25) {
  const tc = toolchainFor(language);
  return tc.registry.search(query, tc.adapter.id, tc.adapter.capabilities).slice(0, limit).map(summary);
}

export function nodeSchema(language: string, type: string, props: Record<string, unknown> | undefined, where?: { project: Project; script: ScriptDoc; fn: FunctionDecl }) {
  const tc = toolchainFor(language);
  const def = tc.registry.get(type);
  if (!def) throw new ServiceError('E_UNKNOWN_NODE', `Unknown node type "${type}". Use search_nodes.`);
  let ports: ReturnType<typeof fmtPort>[] = [];
  if (where) {
    const node = { id: '__schema', type: def.type, position: { x: 0, y: 0 }, props: { ...defaultProps(def), ...((props as Record<string, never>) ?? {}) }, inputs: {} };
    ports = nodeInfo(tc, makeNodeContext(tc, where.script, where.fn), node).ports.map((x) => fmtPort(x, language));
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
    notes: "Ports depend on props and on the graph (e.g. Call Function takes the callee's parameters). Pass props and graph to see them. Data inputs can be given inline values via add_node/update_node \"inputs\" instead of connections, unless connectionOnly.",
  };
}

export function languageCapabilities(id: string) {
  const a = toolchainFor(id).adapter;
  return {
    id: a.id,
    name: a.name,
    extensions: a.extensions,
    versions: a.versions,
    defaultVersion: a.defaultVersion,
    capabilities: a.capabilities,
    events: a.events,
    templates: a.templates.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    scriptSettings: a.scriptSettings,
    commonTypes: a.types.pickerTypes(),
    typeSyntax: 'Canonical: bool, int, float, string, any, void, array<T>, map<K, V>, ClassName. GDScript spellings (String, Array[int], Dictionary, Variant) are accepted and normalised.',
  };
}

export function validate(p: Project, graphRef?: unknown, scriptRef?: unknown, activeFunctionId?: string) {
  const r = compileProject(toolchainFor(p.language), p);
  if (str(graphRef)) {
    const { fn } = locateFunction(p, graphRef, scriptRef, activeFunctionId);
    const d = r.diagnostics.filter((x) => x.functionId === fn.id);
    return { revision: projectRevision(p), ...diagSummary(d), all: d };
  }
  return { revision: projectRevision(p), ok: r.ok, ...diagSummary(r.diagnostics), all: r.diagnostics };
}

export function compileOne(p: Project, scriptRef: unknown, activeScriptId?: string) {
  const s = p.scripts.find((x) => matchScript(x, scriptRef)) ?? p.scripts.find((x) => x.id === activeScriptId) ?? p.scripts[0];
  if (!s) throw new ServiceError('E_NOT_FOUND', 'Script not found');
  const r = compileScript(toolchainFor(p.language), s, { languageVersion: p.languageVersion, settings: p.compilerSettings });
  return { ok: r.ok, files: r.files.map((f) => ({ path: f.path, content: f.content })), diagnostics: r.diagnostics };
}

export function compileAll(p: Project) {
  const r = compileProject(toolchainFor(p.language), p);
  return { ok: r.ok, files: r.files.map((f) => ({ path: f.path, content: f.content })), diagnostics: r.diagnostics };
}

export function exportFiles(p: Project, scriptRef?: unknown, includeProject = false) {
  const r = compileProject(toolchainFor(p.language), p);
  const ref = str(scriptRef);
  const scripts = ref ? r.scripts.filter((s) => { const sc = p.scripts.find((x) => x.id === s.scriptId); return !!sc && matchScript(sc, ref); }) : r.scripts;
  if (ref && !scripts.length) throw new ServiceError('E_NOT_FOUND', `Script "${ref}" not found`);
  const diags = scripts.flatMap((s) => s.diagnostics);
  const ok = scripts.every((s) => s.ok) && (ref ? true : r.ok);
  if (!ok) throw new ServiceError('E_COMPILE_ERRORS', 'The graph has errors, so no source was exported. Fix them first (validate_graph).', { diagnostics: diagSummary(diags) });
  const files: Record<string, string> = {};
  for (const s of scripts) for (const f of s.files) files[f.path] = f.content;
  if (includeProject) files[`${p.name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'project'}.vproj.json`] = projectToJson(p);
  return { ok: true, files, diagnostics: diagSummary(diags) };
}
export * from './workspace';
export * from './git';
