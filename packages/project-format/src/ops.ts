/**
 * Edit operations: THE way a project changes. The editor UI and the MCP bridge both call
 * `applyOps`, so human and AI edits are validated identically.
 *
 * - Batches are atomic: the first invalid operation throws OpError and the input project is
 *   untouched (copy-on-write; unchanged scripts/graphs/nodes are shared with the input).
 * - Objects created in a batch can be referenced later in the same batch as "$ref".
 * - Scripts, functions, variables, signals and enums can also be referenced by unique name.
 */
import { newId, type Edge, type EnumDecl, type FunctionDecl, type Graph, type GraphNode, type JsonValue, type ParamDecl, type ScriptDoc, type SignalDecl, type VariableDecl } from '@cs/graph-core';
import { checkConnection, literalFits, makeNodeContext, nodeInfo, resolveType, type Toolchain } from '@cs/compiler-core';
import { defaultProps, NodeRegistry, type PropSchema } from '@cs/node-registry';
import { createEventFunction, createFunction, createScript, type Project } from './project';

export class OpError extends Error {
  constructor(
    message: string,
    readonly opIndex?: number,
    readonly code = 'E_INVALID_OPERATION',
  ) {
    super(message);
  }
}

export interface PortAddress {
  node: string;
  port: string;
}

export interface ParamInput {
  id?: string;
  name: string;
  type: string;
  default?: JsonValue;
}

export type EditOp =
  | { op: 'update_project'; name?: string; description?: string; languageVersion?: string; compilerSettings?: Partial<Project['compilerSettings']> }
  | { op: 'add_script'; ref?: string; name: string; path?: string; template?: string; settings?: Record<string, JsonValue>; description?: string }
  | { op: 'update_script'; script?: string; name?: string; path?: string; settings?: Record<string, JsonValue>; description?: string }
  | { op: 'delete_script'; script: string }
  | { op: 'add_function'; ref?: string; script?: string; name?: string; kind?: 'function' | 'event' | 'lambda'; owner?: string; event?: string; params?: ParamInput[]; returnType?: string; description?: string; async?: boolean; exported?: boolean }
  | { op: 'update_function'; function: string; script?: string; name?: string; params?: ParamInput[]; returnType?: string; description?: string; async?: boolean; exported?: boolean }
  | { op: 'delete_function'; function: string; script?: string }
  | { op: 'add_variable'; ref?: string; script?: string; function?: string; name: string; type: string; default?: JsonValue; exported?: boolean; constant?: boolean; description?: string; attributes?: Record<string, JsonValue> }
  | { op: 'update_variable'; variable: string; script?: string; function?: string; name?: string; type?: string; default?: JsonValue | null; exported?: boolean; constant?: boolean; description?: string; attributes?: Record<string, JsonValue> | null }
  | { op: 'delete_variable'; variable: string; script?: string; function?: string }
  | { op: 'add_signal'; ref?: string; script?: string; name: string; params?: ParamInput[]; description?: string }
  | { op: 'update_signal'; signal: string; script?: string; name?: string; params?: ParamInput[]; description?: string }
  | { op: 'delete_signal'; signal: string; script?: string }
  | { op: 'add_enum'; ref?: string; script?: string; name: string; members: (string | { name: string; value?: number })[] }
  | { op: 'update_enum'; enum: string; script?: string; name?: string; members?: (string | { name: string; value?: number })[] }
  | { op: 'delete_enum'; enum: string; script?: string }
  | { op: 'add_node'; ref?: string; script?: string; graph?: string; type: string; position?: { x: number; y: number }; props?: Record<string, JsonValue>; inputs?: Record<string, JsonValue> }
  | { op: 'update_node'; node: string; script?: string; graph?: string; props?: Record<string, JsonValue>; inputs?: Record<string, JsonValue | null>; position?: { x: number; y: number }; collapsed?: boolean; size?: { width: number; height: number } }
  | { op: 'delete_nodes'; nodes: string[]; script?: string; graph?: string }
  | { op: 'move_nodes'; nodes: string[]; script?: string; graph?: string; dx?: number; dy?: number; positions?: Record<string, { x: number; y: number }> }
  | { op: 'connect'; ref?: string; script?: string; graph?: string; from: PortAddress; to: PortAddress }
  | { op: 'disconnect'; script?: string; graph?: string; edges?: string[]; from?: PortAddress; to?: PortAddress }
  | { op: 'duplicate_nodes'; script?: string; graph?: string; nodes: string[]; offset?: { x: number; y: number }; ref?: string }
  | { op: 'paste_nodes'; script?: string; graph?: string; nodes: GraphNode[]; edges: Edge[]; offset?: { x: number; y: number }; ref?: string }
  | { op: 'set_viewport'; script?: string; graph?: string; viewport: { x: number; y: number; zoom: number } };

export interface OpDefaults {
  scriptId?: string;
  functionId?: string;
}

export interface ApplyResult {
  project: Project;
  /** "$ref" name → created id (and for duplicate/paste: refs "name.N" for each new node). */
  created: Record<string, string>;
  /** Non-fatal notes (e.g. connections removed because ports disappeared). */
  warnings: string[];
  /** ids of all objects created by the batch, in order. */
  createdIds: string[];
}

const MAX_OPS = 2000;

// ---------------------------------------------------------------------------
// Copy-on-write draft
// ---------------------------------------------------------------------------

class Draft {
  project: Project;
  private touchedScripts = new Set<string>();
  private touchedFns = new Set<string>();
  private touchedNodes = new Set<string>();

  constructor(p: Project) {
    this.project = { ...p, scripts: [...p.scripts] };
  }

  script(id: string): ScriptDoc {
    const i = this.project.scripts.findIndex((s) => s.id === id);
    if (i < 0) throw new OpError(`Script ${id} not found`);
    if (!this.touchedScripts.has(id)) {
      const s = this.project.scripts[i];
      this.project.scripts[i] = { ...s, settings: { ...s.settings }, variables: [...s.variables], functions: [...s.functions], signals: [...s.signals], enums: [...s.enums] };
      this.touchedScripts.add(id);
    }
    return this.project.scripts[i];
  }

  fn(scriptId: string, fnId: string): FunctionDecl {
    const s = this.script(scriptId);
    const i = s.functions.findIndex((f) => f.id === fnId);
    if (i < 0) throw new OpError(`Function ${fnId} not found`);
    if (!this.touchedFns.has(fnId)) {
      const f = s.functions[i];
      s.functions[i] = { ...f, params: [...f.params], locals: [...f.locals], graph: { ...f.graph, nodes: [...f.graph.nodes], edges: [...f.graph.edges] } };
      this.touchedFns.add(fnId);
    }
    return s.functions[i];
  }

  node(scriptId: string, fnId: string, nodeId: string): GraphNode {
    const g = this.fn(scriptId, fnId).graph;
    const i = g.nodes.findIndex((n) => n.id === nodeId);
    if (i < 0) throw new OpError(`Node ${nodeId} not found`);
    if (!this.touchedNodes.has(nodeId)) {
      const n = g.nodes[i];
      g.nodes[i] = { ...n, position: { ...n.position }, props: { ...n.props }, inputs: { ...n.inputs } };
      this.touchedNodes.add(nodeId);
    }
    return g.nodes[i];
  }
}

// ---------------------------------------------------------------------------

export function applyOps(project: Project, ops: EditOp[], tc: Toolchain, defaults: OpDefaults = {}): ApplyResult {
  if (!Array.isArray(ops)) throw new OpError('operations must be an array');
  if (ops.length > MAX_OPS) throw new OpError(`A batch may contain at most ${MAX_OPS} operations`);
  if (tc.adapter.id !== project.language) throw new OpError(`Toolchain ${tc.adapter.id} does not match project language ${project.language}`);
  const d = new Draft(project);
  const refs = new Map<string, string>();
  const created: Record<string, string> = {};
  const createdIds: string[] = [];
  const warnings: string[] = [];
  const ctx = new OpContext(d, tc, refs, defaults);
  ops.forEach((op, i) => {
    try {
      if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') throw new OpError('each operation needs an "op" field');
      const out = applyOne(ctx, op, warnings);
      for (const [ref, id] of out) {
        if (ref) {
          if (refs.has(ref)) throw new OpError(`ref "$${ref}" is used twice in this batch`);
          refs.set(ref, id);
          created[ref] = id;
        }
        createdIds.push(id);
      }
    } catch (e) {
      if (e instanceof OpError) throw new OpError(`Operation ${i + 1} (${(op as { op?: string })?.op ?? '?'}): ${e.message}`, i, e.code);
      throw new OpError(`Operation ${i + 1} (${(op as { op?: string })?.op ?? '?'}): ${e instanceof Error ? e.message : String(e)}`, i);
    }
  });
  return { project: d.project, created, warnings, createdIds };
}

class OpContext {
  constructor(
    readonly d: Draft,
    readonly tc: Toolchain,
    readonly refs: Map<string, string>,
    readonly defaults: OpDefaults,
  ) {}

  /** "$name" → id; other strings returned as-is. */
  deref(v: string): string {
    if (v.startsWith('$')) {
      const id = this.refs.get(v.slice(1));
      if (!id) throw new OpError(`Unknown reference "${v}" (refs must be defined earlier in the same batch)`);
      return id;
    }
    return v;
  }

  script(ref?: string): ScriptDoc {
    const p = this.d.project;
    const r = ref !== undefined ? this.deref(ref) : this.defaults.scriptId ?? (p.scripts.length === 1 ? p.scripts[0].id : undefined);
    if (!r) throw new OpError('Specify "script" (id or name); the project has several scripts');
    const byId = p.scripts.find((s) => s.id === r);
    if (byId) return this.d.script(byId.id);
    const byName = p.scripts.filter((s) => s.name === r || s.path === r);
    if (byName.length === 1) return this.d.script(byName[0].id);
    if (byName.length > 1) throw new OpError(`Several scripts are called "${r}"; use the id`);
    throw new OpError(`Script "${r}" not found`);
  }

  /** Find the script that owns a function/graph id when no script is specified. */
  scriptOfFunction(fnRef: string | undefined, scriptRef?: string): { s: ScriptDoc; f: FunctionDecl } {
    const p = this.d.project;
    const r = fnRef !== undefined ? this.deref(fnRef) : this.defaults.functionId;
    if (!r) throw new OpError('Specify "graph" (function id, graph id or function name)');
    if (scriptRef === undefined) {
      for (const s of p.scripts) {
        const f = s.functions.find((x) => x.id === r || x.graph.id === r);
        if (f) return { s: this.d.script(s.id), f: this.d.fn(s.id, f.id) };
      }
    }
    const s = this.script(scriptRef);
    const f = s.functions.find((x) => x.id === r || x.graph.id === r) ?? uniqueByName(s.functions, r, 'function');
    return { s, f: this.d.fn(s.id, f.id) };
  }

  /** Locate a node anywhere (or in the given graph). */
  nodeLoc(nodeRef: string, graphRef?: string, scriptRef?: string): { s: ScriptDoc; f: FunctionDecl; n: GraphNode } {
    const id = this.deref(nodeRef);
    if (graphRef !== undefined || (this.defaults.functionId && !this.findNode(id))) {
      const { s, f } = this.scriptOfFunction(graphRef, scriptRef);
      if (!f.graph.nodes.some((n) => n.id === id)) throw new OpError(`Node "${nodeRef}" is not in graph ${f.name}`);
      return { s, f, n: this.d.node(s.id, f.id, id) };
    }
    const loc = this.findNode(id);
    if (!loc) throw new OpError(`Node "${nodeRef}" not found`);
    return { s: this.d.script(loc.s), f: this.d.fn(loc.s, loc.f), n: this.d.node(loc.s, loc.f, id) };
  }

  findNode(id: string): { s: string; f: string } | undefined {
    for (const s of this.d.project.scripts) for (const f of s.functions) if (f.graph.nodes.some((n) => n.id === id)) return { s: s.id, f: f.id };
    return undefined;
  }
}

function uniqueByName<T extends { id: string; name: string }>(list: T[], name: string, what: string): T {
  const hits = list.filter((x) => x.name === name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new OpError(`Several ${what}s are called "${name}"; use the id`);
  throw new OpError(`${what[0].toUpperCase()}${what.slice(1)} "${name}" not found`);
}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new OpError(`${what} must be a finite number`);
  return n;
}

function checkIdent(ctx: OpContext, name: unknown, what: string): string {
  if (typeof name !== 'string' || !name) throw new OpError(`${what} name is required`);
  const rules = ctx.tc.adapter.identifiers;
  if (!rules.isValid(name)) throw new OpError(`${what} name "${name}" is invalid. ${rules.description}`, undefined, 'E_INVALID_IDENTIFIER');
  if (rules.reserved.has(name)) throw new OpError(`${what} name "${name}" is a reserved word in ${ctx.tc.adapter.name}`, undefined, 'E_RESERVED_IDENTIFIER');
  return name;
}

function memberNames(s: ScriptDoc, except?: string): Set<string> {
  return new Set([...s.variables, ...s.functions, ...s.signals, ...s.enums].filter((x) => x.id !== except).map((x) => x.name));
}

function checkUniqueMember(s: ScriptDoc, name: string, except?: string) {
  if (memberNames(s, except).has(name)) throw new OpError(`"${name}" is already declared in script ${s.name}`, undefined, 'E_DUPLICATE_IDENTIFIER');
}

function checkType(ctx: OpContext, s: ScriptDoc, text: unknown, what: string, allowVoid = false): string {
  if (typeof text !== 'string') throw new OpError(`${what}: type must be a string`);
  const r = resolveType(ctx.tc.adapter, text);
  if (!r.type) throw new OpError(`${what}: invalid type "${text}" (${r.error})`, undefined, 'E_INVALID_TYPE');
  if (r.type.kind === 'void' && !allowVoid) throw new OpError(`${what}: void is only valid as a return type`, undefined, 'E_INVALID_TYPE');
  const named: string[] = [];
  const walk = (t: typeof r.type) => {
    if (!t) return;
    if (t.kind === 'named') named.push(t.name);
    if (t.kind === 'array') walk(t.element);
    if (t.kind === 'map') {
      walk(t.key);
      walk(t.value);
    }
  };
  walk(r.type);
  for (const n of named) if (!ctx.tc.adapter.types.universe.isKnown(n) && !s.enums.some((e) => e.name === n)) throw new OpError(`${what}: unknown type "${n}"`, undefined, 'E_UNKNOWN_TYPE');
  // Store the canonical spelling so documents stay language-neutral.
  return text.trim() === '' ? text : (ctx.tc.adapter.types.normalize?.(text.trim()) ?? text.trim());
}

function params(ctx: OpContext, s: ScriptDoc, list: unknown, what: string, existing: ParamDecl[] = []): ParamDecl[] {
  if (list === undefined) return existing;
  if (!Array.isArray(list)) throw new OpError(`${what}: params must be an array`);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new OpError(`${what}: parameter ${i + 1} must be an object {name, type}`);
    const p = raw as ParamInput;
    const name = checkIdent(ctx, p.name, `${what} parameter`);
    if (seen.has(name)) throw new OpError(`${what}: parameter "${name}" is declared twice`);
    seen.add(name);
    const type = checkType(ctx, s, p.type, `${what} parameter ${name}`);
    const prev = (p.id && existing.find((e) => e.id === p.id)) || existing.find((e) => e.name === name);
    const tr = resolveType(ctx.tc.adapter, type).type!;
    if (p.default !== undefined && !literalFits(ctx.tc.adapter, p.default, tr)) throw new OpError(`${what}: default of ${name} does not match ${type}`);
    return { id: prev?.id ?? newId('p'), name, type, ...(p.default !== undefined ? { default: p.default } : {}) };
  });
}

/** Validate and coerce node props against the definition's schema. */
function validateProps(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, schema: PropSchema[], patch: Record<string, JsonValue>, nodeType: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [k, raw] of Object.entries(patch)) {
    const p = schema.find((x) => x.key === k);
    if (!p) throw new OpError(`${nodeType} has no property "${k}" (has: ${schema.map((x) => x.key).join(', ') || 'none'})`);
    let v: JsonValue = raw;
    const bad = (exp: string) => new OpError(`${nodeType}.${k} must be ${exp}`);
    switch (p.kind) {
      case 'string':
      case 'text':
        if (typeof v !== 'string') throw bad('a string');
        break;
      case 'int':
        if (typeof v !== 'number' || !Number.isInteger(v)) throw bad('an integer');
        if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) throw bad(`between ${p.min} and ${p.max}`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('a number');
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw bad('true or false');
        break;
      case 'select':
        if (typeof v !== 'string' || !p.options?.some((o) => o.value === v)) throw bad(`one of ${p.options?.map((o) => o.value).join(', ')}`);
        break;
      case 'type':
        if (typeof v !== 'string') throw bad('a type string');
        if (v !== '') {
          v = checkType(ctx, s, v, `${nodeType}.${k}`, p.key === 'returnType');
          if (p.typeOptions && !p.typeOptions.includes(v)) throw bad(`one of ${p.typeOptions.join(', ')}`);
        }
        break;
      case 'string_list':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('an array of strings');
        break;
      case 'variable': {
        if (typeof v !== 'string') throw bad('a variable id or name');
        if (v === '') break;
        const id = ctx.deref(v);
        const scopes = p.variableScopes ?? ['member', 'local', 'param'];
        // Inline functions also see their owners' parameters and locals.
        const chain = [f];
        for (let cur = f; cur.kind === 'lambda' && cur.owner; ) {
          const o = s.functions.find((x) => x.id === cur.owner);
          if (!o || chain.includes(o)) break;
          chain.push(o);
          cur = o;
        }
        const all = [
          ...chain.flatMap((g) => [...(scopes.includes('param') ? g.params : []), ...(scopes.includes('local') ? g.locals : [])]),
          ...(scopes.includes('member') ? s.variables : []),
        ];
        const hit = all.find((x) => x.id === id) ?? all.find((x) => x.name === v);
        if (!hit) throw new OpError(`${nodeType}.${k}: no variable or parameter "${v}" in ${f.name} / ${s.name}`);
        v = hit.id;
        break;
      }
      case 'function': {
        if (typeof v !== 'string') throw bad('a function id or name');
        if (v === '') break;
        const id = ctx.deref(v);
        const hit = s.functions.find((x) => x.id === id) ?? s.functions.find((x) => x.name === v);
        if (!hit) throw new OpError(`${nodeType}.${k}: no function "${v}" in ${s.name}`);
        v = hit.id;
        break;
      }
      case 'signal': {
        if (typeof v !== 'string') throw bad('a signal id or name');
        if (v === '') break;
        const id = ctx.deref(v);
        const hit = s.signals.find((x) => x.id === id) ?? s.signals.find((x) => x.name === v);
        if (!hit) throw new OpError(`${nodeType}.${k}: no signal "${v}" in ${s.name}`);
        v = hit.id;
        break;
      }
      case 'enum': {
        if (typeof v !== 'string') throw bad('an enum id or name');
        if (v === '') break;
        const id = ctx.deref(v);
        const hit = s.enums.find((x) => x.id === id) ?? s.enums.find((x) => x.name === v);
        if (!hit) throw new OpError(`${nodeType}.${k}: no enum "${v}" in ${s.name}`);
        v = hit.id;
        break;
      }
    }
    out[k] = v;
  }
  return out;
}

/** Remove edges whose ports no longer exist on their nodes (after props/params changes). */
function pruneEdges(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, warnings: string[]) {
  const nctx = makeNodeContext(ctx.tc, s, f);
  const ports = new Map(f.graph.nodes.map((n) => [n.id, nodeInfo(ctx.tc, nctx, n).ports]));
  const keep: Edge[] = [];
  for (const e of f.graph.edges) {
    const a = ports.get(e.from.node);
    const b = ports.get(e.to.node);
    if (a && b && a.some((p) => p.id === e.from.port && p.direction === 'out') && b.some((p) => p.id === e.to.port && p.direction === 'in')) keep.push(e);
    else if (a && b) warnings.push(`Removed connection ${e.id} in ${f.name}: its pin no longer exists.`);
    else keep.push(e); // dangling edges are left for the compiler to report
  }
  if (keep.length !== f.graph.edges.length) f.graph.edges = keep;
}

function inputsPatch(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, node: GraphNode, patch: Record<string, JsonValue | null>, nodeType: string) {
  const nctx = makeNodeContext(ctx.tc, s, f);
  const ports = nodeInfo(ctx.tc, nctx, node).ports;
  for (const [k, v] of Object.entries(patch)) {
    const p = ports.find((x) => x.id === k && x.direction === 'in' && x.kind === 'data') ?? ports.find((x) => x.name === k && x.direction === 'in' && x.kind === 'data');
    if (!p) throw new OpError(`${nodeType} has no data input "${k}" (inputs: ${ports.filter((x) => x.direction === 'in' && x.kind === 'data').map((x) => x.id).join(', ') || 'none'})`);
    if (v === null) {
      delete node.inputs[p.id];
      continue;
    }
    if (p.connectionOnly) throw new OpError(`${nodeType}.${p.id} only accepts a connection, not a typed value`);
    if (p.type && !literalFits(ctx.tc.adapter, v, p.type) && !(p.type.kind === 'named' && s.enums.some((e) => e.name === (p.type as { name: string }).name))) {
      throw new OpError(`${nodeType}.${p.id}: ${JSON.stringify(v)} is not a valid ${ctx.tc.adapter.types.format(p.type)}`);
    }
    node.inputs[p.id] = v;
  }
}

function addNode(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, init: { type: string; position?: { x: number; y: number }; props?: Record<string, JsonValue>; inputs?: Record<string, JsonValue> }): GraphNode {
  const def = ctx.tc.registry.get(init.type);
  if (!def) throw new OpError(`Unknown node type "${init.type}". Use list_node_types / search_nodes.`, undefined, 'E_UNKNOWN_NODE');
  if (def.internal) throw new OpError(`"${init.type}" cannot be added manually`);
  if (!NodeRegistry.isAvailable(def, ctx.tc.adapter.id, ctx.tc.adapter.capabilities)) throw new OpError(`"${def.title}" is not available in ${ctx.tc.adapter.name}`, undefined, 'E_UNSUPPORTED_NODE');
  const pos = init.position ?? { x: 0, y: 0 };
  const node: GraphNode = {
    id: newId('n'),
    type: init.type,
    position: { x: finite(pos.x, 'position.x'), y: finite(pos.y, 'position.y') },
    props: { ...defaultProps(def), ...validateProps(ctx, s, f, def.props, init.props ?? {}, init.type) },
    inputs: {},
    ...(def.flavor === 'annotation' ? { size: { width: 360, height: 220 } } : {}),
  };
  if (init.inputs) inputsPatch(ctx, s, f, node, init.inputs, init.type);
  f.graph.nodes.push(node);
  return node;
}

function connect(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, from: PortAddress, to: PortAddress, warnings: string[]): Edge {
  if (!from || !to || typeof from.node !== 'string' || typeof to.node !== 'string' || typeof from.port !== 'string' || typeof to.port !== 'string') throw new OpError('connect needs from {node, port} and to {node, port}');
  const a = f.graph.nodes.find((n) => n.id === ctx.deref(from.node));
  const b = f.graph.nodes.find((n) => n.id === ctx.deref(to.node));
  if (!a) throw new OpError(`Source node "${from.node}" is not in graph ${f.name}`);
  if (!b) throw new OpError(`Target node "${to.node}" is not in graph ${f.name}`);
  if (a.id === b.id) throw new OpError('A node cannot connect to itself');
  const nctx = makeNodeContext(ctx.tc, s, f);
  const ia = nodeInfo(ctx.tc, nctx, a);
  const ib = nodeInfo(ctx.tc, nctx, b);
  const pa = ia.ports.find((p) => p.direction === 'out' && (p.id === from.port || p.name === from.port));
  const pb = ib.ports.find((p) => p.direction === 'in' && (p.id === to.port || p.name === to.port));
  if (!pa) throw new OpError(`"${ia.title}" has no output "${from.port}" (outputs: ${ia.ports.filter((p) => p.direction === 'out').map((p) => p.id).join(', ') || 'none'})`);
  if (!pb) throw new OpError(`"${ib.title}" has no input "${to.port}" (inputs: ${ib.ports.filter((p) => p.direction === 'in').map((p) => p.id).join(', ') || 'none'})`);
  const chk = checkConnection(ctx.tc, pa, pb);
  if (chk.severity === 'error') throw new OpError(`${ia.title}.${pa.id} → ${ib.title}.${pb.id}: ${chk.message}`, undefined, chk.code);
  if (chk.severity === 'warning') warnings.push(`${ia.title}.${pa.id} → ${ib.title}.${pb.id}: ${chk.message}`);
  // Replace existing wires: a data input holds one value, an exec output leads to one place.
  f.graph.edges = f.graph.edges.filter((e) => {
    if (pb.kind === 'data' && e.to.node === b.id && e.to.port === pb.id) return false;
    if (pa.kind === 'exec' && e.from.node === a.id && e.from.port === pa.id) return false;
    return true;
  });
  // Exec cycles are rejected immediately: they could never compile.
  if (pa.kind === 'exec' && reachesExec(ctx, s, f, b.id, a.id)) throw new OpError(`Connecting ${ia.title} → ${ib.title} would create an execution loop. Use a loop node instead.`, undefined, 'E_EXEC_CYCLE');
  const edge: Edge = { id: newId('e'), from: { node: a.id, port: pa.id }, to: { node: b.id, port: pb.id } };
  f.graph.edges.push(edge);
  return edge;
}

function reachesExec(ctx: OpContext, s: ScriptDoc, f: FunctionDecl, start: string, target: string): boolean {
  const nctx = makeNodeContext(ctx.tc, s, f);
  const execOut = new Map<string, Set<string>>();
  for (const n of f.graph.nodes) execOut.set(n.id, new Set(nodeInfo(ctx.tc, nctx, n).ports.filter((p) => p.kind === 'exec' && p.direction === 'out').map((p) => p.id)));
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    for (const e of f.graph.edges) {
      if (e.from.node === cur && execOut.get(cur)?.has(e.from.port) && !seen.has(e.to.node)) {
        seen.add(e.to.node);
        stack.push(e.to.node);
      }
    }
  }
  return false;
}

function cloneNodes(f: FunctionDecl, nodes: GraphNode[], edges: Edge[], offset: { x: number; y: number }): { nodes: GraphNode[]; edges: Edge[] } {
  const map = new Map<string, string>();
  const outNodes = nodes
    .filter((n) => n.type !== 'core.entry')
    .map((n) => {
      const id = newId('n');
      map.set(n.id, id);
      return { ...structuredClone(n), id, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } };
    });
  const outEdges = edges.filter((e) => map.has(e.from.node) && map.has(e.to.node)).map((e) => ({ id: newId('e'), from: { node: map.get(e.from.node)!, port: e.from.port }, to: { node: map.get(e.to.node)!, port: e.to.port } }));
  f.graph.nodes.push(...outNodes);
  f.graph.edges.push(...outEdges);
  return { nodes: outNodes, edges: outEdges };
}

function enumMembers(ctx: OpContext, list: unknown): EnumDecl['members'] {
  if (!Array.isArray(list) || !list.length) throw new OpError('enum members must be a non-empty array');
  const seen = new Set<string>();
  return list.map((m) => {
    const o = typeof m === 'string' ? { name: m } : (m as { name: string; value?: number });
    const name = checkIdent(ctx, o?.name, 'Enum member');
    if (seen.has(name)) throw new OpError(`Enum member "${name}" is listed twice`);
    seen.add(name);
    return { name, ...(typeof o.value === 'number' ? { value: Math.trunc(o.value) } : {}) };
  });
}

function findVar(ctx: OpContext, op: { variable: string; script?: string; function?: string }): { s: ScriptDoc; f?: FunctionDecl; list: VariableDecl[]; index: number } {
  const id = ctx.deref(op.variable);
  if (op.function !== undefined) {
    const { s, f } = ctx.scriptOfFunction(op.function, op.script);
    const index = f.locals.findIndex((v) => v.id === id || v.name === op.variable);
    if (index < 0) throw new OpError(`Local variable "${op.variable}" not found in ${f.name}`);
    return { s, f, list: f.locals, index };
  }
  // member first, then locals anywhere by id
  const p = ctx.d.project;
  for (const s0 of op.script !== undefined ? [ctx.script(op.script)] : p.scripts) {
    const idx = s0.variables.findIndex((v) => v.id === id);
    if (idx >= 0) {
      const s = ctx.d.script(s0.id);
      return { s, list: s.variables, index: idx };
    }
    for (const f0 of s0.functions) {
      const li = f0.locals.findIndex((v) => v.id === id);
      if (li >= 0) {
        const s = ctx.d.script(s0.id);
        const f = ctx.d.fn(s0.id, f0.id);
        return { s, f, list: f.locals, index: li };
      }
    }
  }
  const s = ctx.script(op.script);
  const index = s.variables.findIndex((v) => v.name === op.variable);
  if (index < 0) throw new OpError(`Variable "${op.variable}" not found`);
  return { s, list: s.variables, index };
}

function applyOne(ctx: OpContext, op: EditOp, warnings: string[]): [string | undefined, string][] {
  const { d, tc } = ctx;
  switch (op.op) {
    case 'update_project': {
      if (op.name !== undefined) {
        if (typeof op.name !== 'string' || !op.name.trim()) throw new OpError('name must be a non-empty string');
        d.project.name = op.name.trim();
      }
      if (op.description !== undefined) d.project.description = String(op.description);
      if (op.languageVersion !== undefined) {
        if (!tc.adapter.versions.some((v) => v.id === op.languageVersion)) throw new OpError(`languageVersion must be one of ${tc.adapter.versions.map((v) => v.id).join(', ')}`);
        d.project.languageVersion = op.languageVersion;
      }
      if (op.compilerSettings) {
        const c = { ...d.project.compilerSettings, ...op.compilerSettings };
        if (c.indent !== 'tab' && c.indent !== 'spaces') throw new OpError('compilerSettings.indent must be "tab" or "spaces"');
        if (!Number.isInteger(c.indentSize) || c.indentSize < 1 || c.indentSize > 8) throw new OpError('compilerSettings.indentSize must be 1–8');
        d.project.compilerSettings = { indent: c.indent, indentSize: c.indentSize, header: !!c.header, comments: !!c.comments };
      }
      return [];
    }
    case 'add_script': {
      const name = checkIdent(ctx, op.name, 'Script');
      if (d.project.scripts.some((s) => s.name === name)) throw new OpError(`A script called "${name}" already exists`);
      if (op.template && !tc.adapter.templates.some((t) => t.id === op.template)) throw new OpError(`Unknown template "${op.template}" (available: ${tc.adapter.templates.map((t) => t.id).join(', ')})`);
      const s = createScript(tc.adapter, name, { path: op.path, template: op.template });
      if (op.settings) s.settings = { ...s.settings, ...validateSettings(ctx, op.settings) };
      if (op.description) s.description = op.description;
      if (!/^[A-Za-z0-9_\-/.]+$/.test(s.path) || s.path.includes('..') || s.path.startsWith('/')) throw new OpError(`Invalid script path "${s.path}"`);
      if (d.project.scripts.some((x) => x.path.toLowerCase() === s.path.toLowerCase())) throw new OpError(`Another script already uses the path "${s.path}"`);
      d.project.scripts.push(s);
      return [[op.ref, s.id]];
    }
    case 'update_script': {
      const s = ctx.script(op.script);
      if (op.name !== undefined) {
        const name = checkIdent(ctx, op.name, 'Script');
        if (d.project.scripts.some((x) => x.id !== s.id && x.name === name)) throw new OpError(`A script called "${name}" already exists`);
        s.name = name;
      }
      if (op.path !== undefined) {
        if (typeof op.path !== 'string' || !/^[A-Za-z0-9_\-/.]+$/.test(op.path) || op.path.includes('..') || op.path.startsWith('/')) throw new OpError(`Invalid script path "${op.path}" (relative, no "..", letters/digits/_-/. only)`);
        if (d.project.scripts.some((x) => x.id !== s.id && x.path.toLowerCase() === op.path!.toLowerCase())) throw new OpError(`Another script already uses the path "${op.path}"`);
        s.path = op.path;
      }
      if (op.settings) s.settings = { ...s.settings, ...validateSettings(ctx, op.settings) };
      if (op.description !== undefined) s.description = String(op.description);
      return [];
    }
    case 'delete_script': {
      const s = ctx.script(op.script);
      d.project.scripts = d.project.scripts.filter((x) => x.id !== s.id);
      return [];
    }
    case 'add_function': {
      const s = ctx.script(op.script);
      let f: FunctionDecl;
      if (op.kind === 'lambda') {
        if (!tc.adapter.capabilities.closures) throw new OpError(`${tc.adapter.name} has no inline functions`);
        const owner = ctx.scriptOfFunction(op.owner, op.script);
        if (owner.s.id !== s.id) throw new OpError('An inline function must be in the same script as its owner');
        const name = checkIdent(ctx, op.name ?? 'callback', 'Function');
        f = createFunction({ name, kind: 'lambda', owner: owner.f.id, params: params(ctx, s, op.params ?? [], `Function ${name}`), returnType: checkType(ctx, s, op.returnType ?? 'void', `Function ${name} return`, true), description: op.description });
      } else if (op.kind === 'event' || op.event) {
        const ev = op.event ?? op.name;
        if (!ev || !tc.adapter.events.some((e) => e.id === ev)) throw new OpError(`Unknown event "${ev}" (available: ${tc.adapter.events.map((e) => e.id).join(', ')})`);
        if (s.functions.some((x) => x.kind === 'event' && x.event === ev)) throw new OpError(`Script ${s.name} already handles ${ev}`);
        f = createEventFunction(tc.adapter, ev);
      } else {
        const name = checkIdent(ctx, op.name, 'Function');
        f = createFunction({ name, params: params(ctx, s, op.params ?? [], `Function ${name}`), returnType: checkType(ctx, s, op.returnType ?? 'void', `Function ${name} return`, true), description: op.description });
      }
      applyModifiers(tc, f, op);
      checkUniqueMember(s, f.name);
      s.functions.push(f);
      const entry = f.graph.nodes.find((n) => n.type === 'core.entry')!;
      // "$ref.entry" addresses the auto-created Entry node later in the batch.
      return [
        [op.ref, f.id],
        [op.ref ? `${op.ref}.entry` : undefined, entry.id],
      ];
    }
    case 'update_function': {
      const { s, f } = ctx.scriptOfFunction(op.function, op.script);
      if (f.kind === 'event' && (op.name !== undefined || op.params !== undefined || op.returnType !== undefined)) throw new OpError(`${f.name} is an engine event: its name and signature are fixed`);
      if (op.name !== undefined) {
        const name = checkIdent(ctx, op.name, 'Function');
        checkUniqueMember(s, name, f.id);
        f.name = name;
      }
      if (op.params !== undefined) f.params = params(ctx, s, op.params, `Function ${f.name}`, f.params);
      if (op.returnType !== undefined) f.returnType = checkType(ctx, s, op.returnType, `Function ${f.name} return`, true);
      applyModifiers(tc, f, op);
      if (op.description !== undefined) f.description = String(op.description);
      // Signature changes alter Entry/Return/Call ports in every graph of the script.
      for (const g of s.functions) pruneEdges(ctx, s, d.fn(s.id, g.id), warnings);
      return [];
    }
    case 'delete_function': {
      const { s, f } = ctx.scriptOfFunction(op.function, op.script);
      // Inline functions go with their owner (and theirs with them).
      const gone = new Set([f.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of s.functions) {
          if (x.kind === 'lambda' && x.owner && gone.has(x.owner) && !gone.has(x.id)) {
            gone.add(x.id);
            grew = true;
          }
        }
      }
      s.functions = s.functions.filter((x) => !gone.has(x.id));
      const users = s.functions.filter((g) => g.graph.nodes.some((n) => Object.values(n.props).includes(f.id)));
      if (users.length) warnings.push(`Nodes in ${users.map((u) => u.name).join(', ')} still refer to ${f.name}; they will show errors until updated.`);
      return [];
    }
    case 'add_variable': {
      const name = checkIdent(ctx, op.name, 'Variable');
      let s: ScriptDoc;
      let target: VariableDecl[];
      if (op.function !== undefined) {
        const r = ctx.scriptOfFunction(op.function, op.script);
        s = r.s;
        if ([...r.f.params, ...r.f.locals].some((v) => v.name === name)) throw new OpError(`"${name}" already exists in ${r.f.name}`);
        if (memberNames(s).has(name)) throw new OpError(`"${name}" would hide a member of ${s.name}`);
        target = r.f.locals;
      } else {
        s = ctx.script(op.script);
        checkUniqueMember(s, name);
        target = s.variables;
      }
      const type = checkType(ctx, s, op.type, `Variable ${name}`);
      const v: VariableDecl = { id: newId('v'), name, type };
      applyVarFields(ctx, s, v, op, op.function !== undefined);
      target.push(v);
      return [[op.ref, v.id]];
    }
    case 'update_variable': {
      const loc = findVar(ctx, op);
      const v = { ...loc.list[loc.index] };
      if (op.name !== undefined && op.name !== v.name) {
        const name = checkIdent(ctx, op.name, 'Variable');
        if (loc.f) {
          if ([...loc.f.params, ...loc.f.locals].some((x) => x.id !== v.id && x.name === name) || memberNames(loc.s).has(name)) throw new OpError(`"${name}" already exists`);
        } else checkUniqueMember(loc.s, name, v.id);
        v.name = name;
      }
      if (op.type !== undefined) v.type = checkType(ctx, loc.s, op.type, `Variable ${v.name}`);
      applyVarFields(ctx, loc.s, v, op, !!loc.f);
      loc.list[loc.index] = v;
      if (op.type !== undefined) for (const g of loc.s.functions) pruneEdges(ctx, loc.s, d.fn(loc.s.id, g.id), warnings);
      return [];
    }
    case 'delete_variable': {
      const loc = findVar(ctx, op);
      const v = loc.list[loc.index];
      loc.list.splice(loc.index, 1);
      const users = loc.s.functions.filter((g) => g.graph.nodes.some((n) => n.props.variable === v.id));
      if (users.length) warnings.push(`Get/Set nodes for ${v.name} remain in ${users.map((u) => u.name).join(', ')} and will show errors until removed.`);
      return [];
    }
    case 'add_signal': {
      const s = ctx.script(op.script);
      if (!tc.adapter.capabilities.signals) throw new OpError(`${tc.adapter.name} has no signals`, undefined, 'E_UNSUPPORTED_FEATURE');
      const name = checkIdent(ctx, op.name, 'Signal');
      checkUniqueMember(s, name);
      const sg: SignalDecl = { id: newId('sig'), name, params: params(ctx, s, op.params ?? [], `Signal ${name}`), ...(op.description ? { description: op.description } : {}) };
      s.signals.push(sg);
      return [[op.ref, sg.id]];
    }
    case 'update_signal': {
      const s = ctx.script(op.script);
      const id = ctx.deref(op.signal);
      const i = s.signals.findIndex((x) => x.id === id || x.name === op.signal);
      if (i < 0) throw new OpError(`Signal "${op.signal}" not found`);
      const sg = { ...s.signals[i] };
      if (op.name !== undefined) {
        sg.name = checkIdent(ctx, op.name, 'Signal');
        checkUniqueMember(s, sg.name, sg.id);
      }
      if (op.params !== undefined) sg.params = params(ctx, s, op.params, `Signal ${sg.name}`, sg.params);
      if (op.description !== undefined) sg.description = op.description;
      s.signals[i] = sg;
      for (const g of s.functions) pruneEdges(ctx, s, d.fn(s.id, g.id), warnings);
      return [];
    }
    case 'delete_signal': {
      const s = ctx.script(op.script);
      const id = ctx.deref(op.signal);
      const sg = s.signals.find((x) => x.id === id || x.name === op.signal);
      if (!sg) throw new OpError(`Signal "${op.signal}" not found`);
      s.signals = s.signals.filter((x) => x.id !== sg.id);
      return [];
    }
    case 'add_enum': {
      const s = ctx.script(op.script);
      if (!tc.adapter.capabilities.enums) throw new OpError(`${tc.adapter.name} has no enums`, undefined, 'E_UNSUPPORTED_FEATURE');
      const name = checkIdent(ctx, op.name, 'Enum');
      checkUniqueMember(s, name);
      const e: EnumDecl = { id: newId('e'), name, members: enumMembers(ctx, op.members) };
      s.enums.push(e);
      return [[op.ref, e.id]];
    }
    case 'update_enum': {
      const s = ctx.script(op.script);
      const id = ctx.deref(op.enum);
      const i = s.enums.findIndex((x) => x.id === id || x.name === op.enum);
      if (i < 0) throw new OpError(`Enum "${op.enum}" not found`);
      const e = { ...s.enums[i] };
      if (op.name !== undefined) {
        e.name = checkIdent(ctx, op.name, 'Enum');
        checkUniqueMember(s, e.name, e.id);
      }
      if (op.members !== undefined) e.members = enumMembers(ctx, op.members);
      s.enums[i] = e;
      return [];
    }
    case 'delete_enum': {
      const s = ctx.script(op.script);
      const id = ctx.deref(op.enum);
      const e = s.enums.find((x) => x.id === id || x.name === op.enum);
      if (!e) throw new OpError(`Enum "${op.enum}" not found`);
      s.enums = s.enums.filter((x) => x.id !== e.id);
      return [];
    }
    case 'add_node': {
      const { s, f } = ctx.scriptOfFunction(op.graph, op.script);
      if (typeof op.type !== 'string') throw new OpError('type is required');
      const n = addNode(ctx, s, f, op);
      return [[op.ref, n.id]];
    }
    case 'update_node': {
      const { s, f, n } = ctx.nodeLoc(op.node, op.graph, op.script);
      const def = tc.registry.get(n.type);
      if (op.props) {
        if (!def) throw new OpError(`Node type ${n.type} is unknown; only position can change`);
        Object.assign(n.props, validateProps(ctx, s, f, def.props, op.props, n.type));
        pruneEdges(ctx, s, f, warnings);
        // Drop inline values for inputs that no longer exist.
        const ports = nodeInfo(tc, makeNodeContext(tc, s, f), n).ports;
        for (const k of Object.keys(n.inputs)) if (!ports.some((p) => p.id === k && p.direction === 'in')) delete n.inputs[k];
      }
      if (op.inputs) inputsPatch(ctx, s, f, n, op.inputs, n.type);
      if (op.position) n.position = { x: finite(op.position.x, 'position.x'), y: finite(op.position.y, 'position.y') };
      if (op.collapsed !== undefined) {
        if (op.collapsed) n.collapsed = true;
        else delete n.collapsed;
      }
      if (op.size) n.size = { width: Math.max(80, finite(op.size.width, 'size.width')), height: Math.max(60, finite(op.size.height, 'size.height')) };
      return [];
    }
    case 'delete_nodes': {
      if (!Array.isArray(op.nodes) || !op.nodes.length) throw new OpError('nodes must be a non-empty array');
      const first = ctx.nodeLoc(op.nodes[0], op.graph, op.script);
      const ids = new Set(op.nodes.map((r) => ctx.deref(r)));
      const f = first.f;
      for (const id of ids) {
        const n = f.graph.nodes.find((x) => x.id === id);
        if (!n) throw new OpError(`Node "${id}" is not in graph ${f.name}`);
        if (n.type === 'core.entry') throw new OpError('The Entry node cannot be deleted');
      }
      f.graph.nodes = f.graph.nodes.filter((n) => !ids.has(n.id));
      f.graph.edges = f.graph.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
      return [];
    }
    case 'move_nodes': {
      if (!Array.isArray(op.nodes)) throw new OpError('nodes must be an array');
      for (const r of op.nodes) {
        const { n } = ctx.nodeLoc(r, op.graph, op.script);
        const abs = op.positions?.[r] ?? op.positions?.[n.id];
        if (abs) n.position = { x: finite(abs.x, 'x'), y: finite(abs.y, 'y') };
        else n.position = { x: n.position.x + finite(op.dx ?? 0, 'dx'), y: n.position.y + finite(op.dy ?? 0, 'dy') };
      }
      return [];
    }
    case 'connect': {
      const loc = ctx.nodeLoc(op.from?.node ?? '', op.graph, op.script);
      const e = connect(ctx, loc.s, loc.f, op.from, op.to, warnings);
      return [[op.ref, e.id]];
    }
    case 'disconnect': {
      const ref = op.edges?.[0] ? undefined : (op.from?.node ?? op.to?.node);
      let s: ScriptDoc;
      let f: FunctionDecl;
      if (ref) ({ s, f } = ctx.nodeLoc(ref, op.graph, op.script));
      else ({ s, f } = locateEdgeGraph(ctx, op.edges ?? [], op.graph, op.script));
      void s;
      const before = f.graph.edges.length;
      const ids = new Set((op.edges ?? []).map((x) => ctx.deref(x)));
      const fromN = op.from ? ctx.deref(op.from.node) : undefined;
      const toN = op.to ? ctx.deref(op.to.node) : undefined;
      f.graph.edges = f.graph.edges.filter((e) => {
        if (ids.has(e.id)) return false;
        const mf = op.from && e.from.node === fromN && (!op.from.port || e.from.port === op.from.port);
        const mt = op.to && e.to.node === toN && (!op.to.port || e.to.port === op.to.port);
        if (op.from && op.to) return !(mf && mt);
        return !(mf || mt);
      });
      if (f.graph.edges.length === before) throw new OpError('No matching connection to remove');
      return [];
    }
    case 'duplicate_nodes': {
      if (!Array.isArray(op.nodes) || !op.nodes.length) throw new OpError('nodes must be a non-empty array');
      const first = ctx.nodeLoc(op.nodes[0], op.graph, op.script);
      const ids = new Set(op.nodes.map((r) => ctx.deref(r)));
      const src = first.f.graph.nodes.filter((n) => ids.has(n.id));
      if (src.length !== ids.size) throw new OpError('All nodes to duplicate must be in the same graph');
      const r = cloneNodes(first.f, src, first.f.graph.edges, op.offset ?? { x: 40, y: 40 });
      return r.nodes.map((n, i) => [op.ref ? `${op.ref}.${i}` : undefined, n.id] as [string | undefined, string]);
    }
    case 'paste_nodes': {
      const { s, f } = ctx.scriptOfFunction(op.graph, op.script);
      if (!Array.isArray(op.nodes) || !Array.isArray(op.edges)) throw new OpError('paste_nodes needs nodes and edges arrays');
      for (const n of op.nodes) {
        const def = tc.registry.get(n?.type);
        if (!def) throw new OpError(`Cannot paste unknown node type "${n?.type}"`);
        if (!NodeRegistry.isAvailable(def, tc.adapter.id, tc.adapter.capabilities)) throw new OpError(`"${def.title}" is not available in ${tc.adapter.name}`);
        validateProps(ctx, s, f, def.props, Object.fromEntries(Object.entries(n.props ?? {}).filter(([k, v]) => !(['variable', 'function', 'signal', 'enum'].includes(def.props.find((p) => p.key === k)?.kind ?? '') && v === ''))), n.type);
      }
      const r = cloneNodes(f, op.nodes, op.edges, op.offset ?? { x: 0, y: 0 });
      pruneEdges(ctx, s, f, warnings);
      return r.nodes.map((n, i) => [op.ref ? `${op.ref}.${i}` : undefined, n.id] as [string | undefined, string]);
    }
    case 'set_viewport': {
      const { f } = ctx.scriptOfFunction(op.graph, op.script);
      f.graph = { ...f.graph, viewport: { x: finite(op.viewport?.x, 'x'), y: finite(op.viewport?.y, 'y'), zoom: Math.min(4, Math.max(0.05, finite(op.viewport?.zoom, 'zoom'))) } };
      return [];
    }
    default:
      throw new OpError(`Unknown operation "${(op as { op: string }).op}"`);
  }
}

function locateEdgeGraph(ctx: OpContext, edgeIds: string[], graphRef?: string, scriptRef?: string): { s: ScriptDoc; f: FunctionDecl } {
  if (graphRef !== undefined || !edgeIds.length) return ctx.scriptOfFunction(graphRef, scriptRef);
  const id = ctx.deref(edgeIds[0]);
  for (const s of ctx.d.project.scripts) for (const f of s.functions) if (f.graph.edges.some((e) => e.id === id)) return { s: ctx.d.script(s.id), f: ctx.d.fn(s.id, f.id) };
  throw new OpError(`Connection "${edgeIds[0]}" not found`);
}

function validateSettings(ctx: OpContext, settings: Record<string, JsonValue>): Record<string, JsonValue> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new OpError('settings must be an object');
  const schema = ctx.tc.adapter.scriptSettings;
  for (const [k, v] of Object.entries(settings)) {
    const p = schema.find((x) => x.key === k);
    if (!p) throw new OpError(`Unknown script setting "${k}" (available: ${schema.map((x) => x.key).join(', ')})`);
    if (p.kind === 'boolean' && typeof v !== 'boolean') throw new OpError(`Setting ${k} must be true or false`);
    if ((p.kind === 'string' || p.kind === 'text') && typeof v !== 'string') throw new OpError(`Setting ${k} must be a string`);
  }
  return settings;
}

function applyVarFields(ctx: OpContext, s: ScriptDoc, v: VariableDecl, op: { default?: JsonValue | null; exported?: boolean; constant?: boolean; description?: string; attributes?: Record<string, JsonValue> | null }, local: boolean) {
  if (op.default !== undefined) {
    if (op.default === null) delete v.default;
    else {
      const t = resolveType(ctx.tc.adapter, v.type).type!;
      const isEnum = t.kind === 'named' && s.enums.some((e) => e.name === t.name);
      if (!isEnum && !literalFits(ctx.tc.adapter, op.default, t)) throw new OpError(`Default ${JSON.stringify(op.default)} does not fit type ${v.type}`);
      if (isEnum) {
        const e = s.enums.find((x) => x.name === (t as { name: string }).name)!;
        if (!(typeof op.default === 'number' || (typeof op.default === 'string' && e.members.some((m) => m.name === op.default)))) throw new OpError(`Default must be a member of ${e.name}`);
      }
      v.default = op.default;
    }
  }
  if (op.exported !== undefined) {
    if (local && op.exported) throw new OpError('Local variables cannot be exported');
    if (op.exported && !ctx.tc.adapter.capabilities.exportedVariables) throw new OpError(`${ctx.tc.adapter.name} cannot export variables`);
    if (op.exported) v.exported = true;
    else delete v.exported;
  }
  if (op.constant !== undefined) {
    if (op.constant) v.constant = true;
    else delete v.constant;
  }
  if (v.constant && v.default === undefined) throw new OpError(`Constant ${v.name} needs a default value`);
  if (op.description !== undefined) {
    if (op.description) v.description = op.description;
    else delete v.description;
  }
  if (op.attributes !== undefined) {
    if (op.attributes === null) delete v.attributes;
    else if (typeof op.attributes !== 'object' || Array.isArray(op.attributes)) throw new OpError('attributes must be an object');
    else v.attributes = op.attributes;
  }
}

/** Convenience: graph lookup for read-only callers. */
/** async / exported flags, where the language has them. */
function applyModifiers(tc: Toolchain, f: FunctionDecl, op: { async?: unknown; exported?: unknown }) {
  if (op.async !== undefined) {
    if (typeof op.async !== 'boolean') throw new OpError('"async" must be true or false');
    if (op.async && tc.adapter.id === 'gdscript') throw new OpError('GDScript functions can\'t be marked async (use await on signals instead)');
    if (op.async) f.async = true;
    else delete f.async;
  }
  if (op.exported !== undefined) {
    if (typeof op.exported !== 'boolean') throw new OpError('"exported" must be true or false');
    if (op.exported && !tc.adapter.capabilities.modules) throw new OpError(`${tc.adapter.name} has no exports`);
    if (op.exported) f.exported = true;
    else delete f.exported;
  }
}

export function findFunction(p: Project, ref: string): { script: ScriptDoc; fn: FunctionDecl } | undefined {
  for (const s of p.scripts) {
    const f = s.functions.find((x) => x.id === ref || x.graph.id === ref);
    if (f) return { script: s, fn: f };
  }
  return undefined;
}

export function graphOf(p: Project, ref: string): Graph | undefined {
  return findFunction(p, ref)?.fn.graph;
}
