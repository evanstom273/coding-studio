/**
 * Compiler pipeline:
 *   graph → structural validation → semantic analysis → IR → adapter.validate → adapter.generate
 *
 * Nothing in here knows about a specific language: names, types, operators and spelling all go
 * through the LanguageAdapter. Source is only produced when there are no error diagnostics.
 */
import { findCycles, GraphIndex, reachable, type Diagnostic, type FunctionDecl, type JsonValue, type ScriptDoc } from '@cs/graph-core';
import { alwaysReturns, type IRMember, type IRModule } from '@cs/intermediate-representation';
import { DEFAULT_COMPILER_SETTINGS, type CompilationContext, type CompilerSettings, type GeneratedFile } from '@cs/language-sdk';
import { NodeRegistry } from '@cs/node-registry';
import { formatType, T, type TypeRef } from '@cs/type-system';
import { literalExpr, literalFits, makeNodeContext, nodeInfo, resolveType, type NodeInfo, type Toolchain } from './context';
import { lowerFunction } from './lower';

export interface ScriptCompileResult {
  scriptId: string;
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Only present when ok. */
  files: GeneratedFile[];
  module?: IRModule;
}

export interface CompileOptions {
  languageVersion?: string;
  settings?: Partial<CompilerSettings>;
}

export function compileScript(tc: Toolchain, script: ScriptDoc, opts: CompileOptions = {}): ScriptCompileResult {
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  const report = (d: Diagnostic) => {
    const key = `${d.code}|${d.graphId}|${d.nodeId}|${d.portId}|${d.edgeId}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diags.push({ ...d, scriptId: script.id });
  };

  validateDeclarations(tc, script, report);

  const members: IRMember[] = [];
  for (const e of script.enums) if (tc.adapter.capabilities.enums) members.push({ k: 'enum', name: e.name, members: e.members.map((m) => ({ ...m })), src: { scriptId: script.id } });
  for (const s of script.signals) {
    members.push({
      k: 'signal',
      name: s.name,
      params: s.params.map((p) => ({ name: p.name, type: resolveType(tc.adapter, p.type).type ?? T.any })),
      ...(s.description ? { doc: s.description } : {}),
      src: { scriptId: script.id },
    });
  }
  for (const v of script.variables) {
    const type = resolveType(tc.adapter, v.type).type ?? T.any;
    members.push({
      k: 'field',
      name: v.name,
      type,
      ...(v.default !== undefined ? { init: literalExpr(tc.adapter, v.default, type) } : {}),
      ...(v.constant ? { constant: true } : {}),
      ...(v.exported ? { exported: true } : {}),
      ...(v.description ? { doc: v.description } : {}),
      ...(v.attributes ? { attributes: v.attributes } : {}),
      src: { scriptId: script.id },
    });
  }
  for (const fn of script.functions) {
    const f = compileFunction(tc, script, fn, report);
    if (f) members.push(f);
  }

  const module: IRModule = {
    scriptId: script.id,
    name: script.name,
    path: script.path,
    settings: script.settings,
    imports: [],
    members,
    ...(script.description ? { doc: script.description } : {}),
  };

  const cctx: CompilationContext = {
    script,
    languageVersion: opts.languageVersion ?? tc.adapter.defaultVersion,
    settings: { ...DEFAULT_COMPILER_SETTINGS, ...opts.settings },
  };

  if (!diags.some((d) => d.severity === 'error')) {
    for (const d of tc.adapter.validate(module, cctx)) report(d);
  }
  const ok = !diags.some((d) => d.severity === 'error');
  let files: GeneratedFile[] = [];
  if (ok) {
    try {
      files = tc.adapter.generate(module, cctx);
    } catch (e) {
      report({ severity: 'error', code: 'E_BACKEND', message: `The ${tc.adapter.name} backend failed: ${e instanceof Error ? e.message : String(e)}` });
      files = [];
    }
  }
  const okFinal = !diags.some((d) => d.severity === 'error');
  return { scriptId: script.id, ok: okFinal, diagnostics: sortDiagnostics(diags), files: okFinal ? files : [], module };
}

export interface ProjectLike {
  scripts: ScriptDoc[];
  languageVersion?: string;
  compilerSettings?: Partial<CompilerSettings>;
}

export interface ProjectCompileResult {
  ok: boolean;
  scripts: ScriptCompileResult[];
  diagnostics: Diagnostic[];
  files: GeneratedFile[];
}

export function compileProject(tc: Toolchain, project: ProjectLike): ProjectCompileResult {
  const scripts = project.scripts.map((s) => compileScript(tc, s, { languageVersion: project.languageVersion, settings: project.compilerSettings }));
  const diagnostics = scripts.flatMap((s) => s.diagnostics);
  // Cross-script checks: unique output paths and unique global class names.
  const paths = new Map<string, string>();
  for (const s of project.scripts) {
    const key = s.path.toLowerCase();
    if (paths.has(key)) diagnostics.push({ severity: 'error', code: 'E_DUPLICATE_PATH', message: `Scripts "${paths.get(key)}" and "${s.name}" would both be written to "${s.path}".`, scriptId: s.id, suggestion: 'Change one of the script paths.' });
    paths.set(key, s.name);
  }
  const files = scripts.flatMap((s) => s.files);
  return { ok: !diagnostics.some((d) => d.severity === 'error'), scripts, diagnostics, files };
}

function sortDiagnostics(d: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 };
  return d.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.severity] - rank[b.x.severity] || a.i - b.i).map((p) => p.x);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function validateDeclarations(tc: Toolchain, script: ScriptDoc, report: (d: Diagnostic) => void) {
  const { adapter } = tc;
  const caps = adapter.capabilities;
  const idRules = adapter.identifiers;
  const enumNames = new Set(script.enums.map((e) => e.name));

  const checkName = (name: string, what: string, extra: Partial<Diagnostic> = {}) => {
    if (!idRules.isValid(name)) report({ severity: 'error', code: 'E_INVALID_IDENTIFIER', message: `${what} name "${name}" is not a valid ${adapter.name} identifier. ${idRules.description}`, ...extra });
    else if (idRules.reserved.has(name)) report({ severity: 'error', code: 'E_RESERVED_IDENTIFIER', message: `${what} name "${name}" is a reserved word in ${adapter.name}.`, suggestion: `Rename it, e.g. "${name}_value".`, ...extra });
  };
  const checkType = (text: string, what: string, extra: Partial<Diagnostic> = {}, allowVoid = false): TypeRef | undefined => {
    const r = resolveType(adapter, text);
    if (!r.type) {
      report({ severity: 'error', code: 'E_INVALID_TYPE', message: `${what}: invalid type "${text}" (${r.error}).`, ...extra });
      return undefined;
    }
    const unknown = unknownNamed(r.type, (n) => adapter.types.universe.isKnown(n) || enumNames.has(n));
    if (unknown) report({ severity: 'error', code: 'E_UNKNOWN_TYPE', message: `${what}: unknown type "${unknown}".`, suggestion: 'Check the spelling, or declare it as an enum in this script.', ...extra });
    if (r.type.kind === 'void' && !allowVoid) report({ severity: 'error', code: 'E_INVALID_TYPE', message: `${what}: void is only valid as a return type.`, ...extra });
    return r.type;
  };

  // Unique member names
  const members = new Map<string, string>();
  const claim = (name: string, what: string, extra: Partial<Diagnostic>) => {
    const prev = members.get(name);
    if (prev) report({ severity: 'error', code: 'E_DUPLICATE_IDENTIFIER', message: `"${name}" is declared more than once (${prev} and ${what}).`, suggestion: 'Rename one of them.', ...extra });
    else members.set(name, what);
  };

  if (script.enums.length && !caps.enums) report({ severity: 'error', code: 'E_UNSUPPORTED_FEATURE', message: `${adapter.name} does not support enums.` });
  for (const e of script.enums) {
    checkName(e.name, 'Enum');
    claim(e.name, 'an enum', {});
    const names = new Set<string>();
    for (const m of e.members) {
      checkName(m.name, `Enum member ${e.name}.`);
      if (names.has(m.name)) report({ severity: 'error', code: 'E_DUPLICATE_IDENTIFIER', message: `Enum ${e.name} has "${m.name}" twice.` });
      names.add(m.name);
    }
  }
  if (script.signals.length && !caps.signals) report({ severity: 'error', code: 'E_UNSUPPORTED_FEATURE', message: `${adapter.name} does not support signals.` });
  for (const s of script.signals) {
    checkName(s.name, 'Signal');
    claim(s.name, 'a signal', {});
    s.params.forEach((p) => {
      checkName(p.name, `Signal ${s.name} parameter`);
      checkType(p.type, `Signal ${s.name} parameter ${p.name}`);
    });
  }
  for (const v of script.variables) {
    checkName(v.name, v.constant ? 'Constant' : 'Variable');
    claim(v.name, v.constant ? 'a constant' : 'a variable', {});
    const t = checkType(v.type, `Variable ${v.name}`);
    if (v.exported && !caps.exportedVariables) report({ severity: 'error', code: 'E_UNSUPPORTED_FEATURE', message: `${adapter.name} cannot export variable "${v.name}" to an editor.` });
    if (v.constant && v.default === undefined) report({ severity: 'error', code: 'E_CONSTANT_WITHOUT_VALUE', message: `Constant "${v.name}" needs a value.` });
    if (t && v.default !== undefined && !literalFits(adapter, v.default, t) && !(t.kind === 'named' && enumNames.has(t.name) && typeof v.default === 'number')) {
      report({ severity: 'error', code: 'E_INVALID_DEFAULT', message: `Default value of "${v.name}" does not match its type ${formatType(t)}.` });
    }
  }
  if (!caps.memberVariables && script.variables.some((v) => !v.constant)) report({ severity: 'error', code: 'E_UNSUPPORTED_FEATURE', message: `${adapter.name} scripts cannot hold member variables.` });

  for (const fn of script.functions) {
    const at = { functionId: fn.id, graphId: fn.graph.id };
    checkName(fn.name, 'Function', at);
    claim(fn.name, fn.kind === 'event' ? 'an event' : 'a function', at);
    checkType(fn.returnType, `Function ${fn.name} return`, at, true);
    const local = new Set<string>();
    for (const p of [...fn.params, ...fn.locals]) {
      checkName(p.name, `Function ${fn.name}: "${p.name}"`, at);
      checkType(p.type, `${fn.name}.${p.name}`, at);
      if (local.has(p.name)) report({ severity: 'error', code: 'E_DUPLICATE_IDENTIFIER', message: `"${p.name}" is declared twice in ${fn.name}.`, ...at });
      local.add(p.name);
    }
    if (fn.kind === 'event') {
      const tpl = adapter.events.find((e) => e.id === fn.event);
      if (!tpl) report({ severity: 'error', code: 'E_UNKNOWN_EVENT', message: `Event "${fn.event ?? fn.name}" is not a ${adapter.name} lifecycle event.`, ...at });
      else {
        const sig = (ps: { type: string }[]) => ps.map((p) => formatType(resolveType(adapter, p.type).type ?? T.any)).join(',');
        if (tpl.name !== fn.name || sig(tpl.params) !== sig(fn.params) || formatType(resolveType(adapter, tpl.returnType).type ?? T.void) !== formatType(resolveType(adapter, fn.returnType).type ?? T.void)) {
          report({ severity: 'error', code: 'E_EVENT_SIGNATURE', message: `Event ${fn.name} must have the signature ${tpl.name}(${tpl.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${tpl.returnType}.`, ...at });
        }
      }
    }
  }
  // Locals/params must not shadow members (readability + avoids language-specific shadowing errors).
  for (const fn of script.functions) {
    for (const p of [...fn.params, ...fn.locals]) {
      if (members.has(p.name)) report({ severity: 'error', code: 'E_SHADOWED_IDENTIFIER', message: `"${p.name}" in ${fn.name} has the same name as ${members.get(p.name)} of the script.`, functionId: fn.id, graphId: fn.graph.id, suggestion: 'Rename the parameter or local variable.' });
    }
  }
  adapter.validateScript?.(script, (d) => report({ ...d, scriptId: script.id } as Diagnostic));
}

function unknownNamed(t: TypeRef, known: (n: string) => boolean): string | undefined {
  switch (t.kind) {
    case 'named':
      return known(t.name) ? t.args?.map((a) => unknownNamed(a, known)).find(Boolean) : t.name;
    case 'array':
      return unknownNamed(t.element, known);
    case 'map':
      return unknownNamed(t.key, known) ?? unknownNamed(t.value, known);
    case 'function':
      return [...t.params, t.returns].map((a) => unknownNamed(a, known)).find(Boolean);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Graph analysis + lowering
// ---------------------------------------------------------------------------

export interface GraphAnalysis {
  infos: Map<string, NodeInfo>;
  index: GraphIndex;
  entryId?: string;
}

/** Structural + semantic checks on one function graph. Exposed for the editor (live validation). */
export function analyzeGraph(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl, report: (d: Diagnostic) => void): GraphAnalysis {
  const ctx = makeNodeContext(tc, script, fn);
  const g = fn.graph;
  const at = { scriptId: script.id, functionId: fn.id, graphId: g.id };
  const index = new GraphIndex(g);
  const infos = new Map<string, NodeInfo>();
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) report({ severity: 'error', code: 'E_DUPLICATE_NODE_ID', message: `Two nodes share the id ${n.id}.`, ...at, nodeId: n.id });
    ids.add(n.id);
    const info = nodeInfo(tc, ctx, n);
    infos.set(n.id, info);
    if (!info.def) {
      report({ severity: 'error', code: 'E_UNKNOWN_NODE', message: `Unknown node type "${n.type}".`, ...at, nodeId: n.id, suggestion: 'Delete the node; it may come from a newer version or another language pack.' });
      continue;
    }
    if (!NodeRegistry.isAvailable(info.def, tc.adapter.id, tc.adapter.capabilities)) {
      report({ severity: 'error', code: 'E_UNSUPPORTED_NODE', message: `"${info.title}" is not available in ${tc.adapter.name}${info.def.requires?.length ? ` (needs: ${info.def.requires.join(', ')})` : ''}.`, ...at, nodeId: n.id });
    }
    for (const p of info.def.props) {
      if (p.kind === 'type' && typeof n.props[p.key] === 'string' && n.props[p.key] !== '') {
        const r = resolveType(tc.adapter, n.props[p.key] as string);
        if (!r.type) report({ severity: 'error', code: 'E_INVALID_TYPE', message: `${info.title}: invalid ${p.label.toLowerCase()} "${n.props[p.key]}" (${r.error}).`, ...at, nodeId: n.id });
        else {
          const unknown = unknownNamed(r.type, (x) => tc.adapter.types.universe.isKnown(x) || script.enums.some((e) => e.name === x));
          if (unknown) report({ severity: 'error', code: 'E_UNKNOWN_TYPE', message: `${info.title}: unknown type "${unknown}".`, ...at, nodeId: n.id });
        }
      }
      if (p.typeOptions && p.kind === 'type' && typeof n.props[p.key] === 'string' && n.props[p.key] !== '' && !p.typeOptions.includes(n.props[p.key] as string)) {
        report({ severity: 'error', code: 'E_INVALID_PROPERTY', message: `${info.title}: ${p.label} must be one of ${p.typeOptions.join(', ')}.`, ...at, nodeId: n.id });
      }
    }
    try {
      info.def.check?.(n, ctx, (code, message, o) => report({ severity: o?.severity ?? 'error', code, message: `${info.title}: ${message}`, ...at, nodeId: n.id, ...(o?.port ? { portId: o.port } : {}), ...(o?.suggestion ? { suggestion: o.suggestion } : {}) }));
    } catch (e) {
      report({ severity: 'error', code: 'E_NODE_CHECK', message: `${info.title}: ${e instanceof Error ? e.message : String(e)}`, ...at, nodeId: n.id });
    }
    // Inline literal values must fit their port types.
    for (const [portId, value] of Object.entries(n.inputs)) {
      const spec = info.ports.find((p) => p.id === portId && p.direction === 'in' && p.kind === 'data');
      if (spec?.type && !spec.connectionOnly && index.to(n.id, portId).length === 0 && !literalFits(tc.adapter, value as JsonValue, spec.type)) {
        report({ severity: 'error', code: 'E_INVALID_LITERAL', message: `${info.title}: the value typed into "${spec.name || portId}" is not a valid ${tc.adapter.types.format(spec.type)}.`, ...at, nodeId: n.id, portId });
      }
    }
  }

  // Edges
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    const where = { ...at, edgeId: e.id, nodeId: e.to.node };
    if (edgeIds.has(e.id)) report({ severity: 'error', code: 'E_DUPLICATE_EDGE_ID', message: `Two connections share the id ${e.id}.`, ...where });
    edgeIds.add(e.id);
    const a = infos.get(e.from.node);
    const b = infos.get(e.to.node);
    if (!a || !b) {
      report({ severity: 'error', code: 'E_DANGLING_EDGE', message: 'A connection points to a node that no longer exists.', ...where });
      continue;
    }
    if (!a.def || !b.def) continue;
    const pa = a.ports.find((p) => p.id === e.from.port && p.direction === 'out');
    const pb = b.ports.find((p) => p.id === e.to.port && p.direction === 'in');
    if (!pa || !pb) {
      report({ severity: 'error', code: 'E_INVALID_PORT', message: `A connection between "${a.title}" and "${b.title}" uses a pin that does not exist (${!pa ? e.from.port : e.to.port}).`, ...where, suggestion: 'Delete the connection and reconnect it.' });
      continue;
    }
    const r = checkConnection(tc, pa, pb);
    if (r.severity) report({ severity: r.severity, code: r.code!, message: `${a.title} → ${b.title}: ${r.message}`, ...where, portId: e.to.port });
  }
  // Fan-in / fan-out rules
  for (const [id, info] of infos) {
    for (const p of info.ports) {
      if (p.kind === 'data' && p.direction === 'in' && index.to(id, p.id).length > 1) report({ severity: 'error', code: 'E_MULTIPLE_INPUTS', message: `"${info.title}" has several wires into "${p.name || p.id}"; a data input takes one value.`, ...at, nodeId: id, portId: p.id });
      if (p.kind === 'exec' && p.direction === 'out' && index.from(id, p.id).length > 1) report({ severity: 'error', code: 'E_MULTIPLE_EXEC_OUTPUTS', message: `"${info.title}" has several execution wires leaving "${p.name || p.id}".`, ...at, nodeId: id, portId: p.id, suggestion: 'Use a Sequence node to run several chains in order.' });
    }
  }

  // Entry
  const entries = g.nodes.filter((n) => n.type === 'core.entry');
  if (entries.length !== 1) report({ severity: 'error', code: 'E_MISSING_ENTRY', message: entries.length ? 'A function graph must have exactly one Entry node.' : 'This function graph has no Entry node.', ...at });
  const entryId = entries[0]?.id;

  // Exec cycles (all exec edges, including loop bodies)
  const execSucc = (n: string) => {
    const info = infos.get(n);
    if (!info) return [];
    return info.ports.filter((p) => p.kind === 'exec' && p.direction === 'out').flatMap((p) => index.from(n, p.id).map((e) => e.to.node));
  };
  const execIds = [...infos.values()].filter((i) => i.def && (i.def.flavor === 'exec' || i.def.flavor === 'entry')).map((i) => i.node.id);
  for (const c of findCycles(execIds, execSucc)) {
    report({ severity: 'error', code: 'E_EXEC_CYCLE', message: `Execution wires form a loop through ${c.map((id) => `"${infos.get(id)?.title}"`).join(' → ')}. Use a loop node instead of wiring back.`, ...at, nodeId: c[0] });
  }
  // Data cycles among pure nodes
  const pureIds = [...infos.values()].filter((i) => i.def?.flavor === 'pure').map((i) => i.node.id);
  const pureSet = new Set(pureIds);
  const dataSucc = (n: string) => g.edges.filter((e) => e.from.node === n && pureSet.has(e.to.node) && infos.get(n)?.ports.find((p) => p.id === e.from.port)?.kind === 'data').map((e) => e.to.node);
  for (const c of findCycles(pureIds, dataSucc)) {
    report({ severity: 'error', code: 'E_DATA_CYCLE', message: `Data wires form a loop through ${c.map((id) => `"${infos.get(id)?.title}"`).join(' → ')}.`, ...at, nodeId: c[0] });
  }

  // Reachability
  if (entryId) {
    const reach = new Set(reachable(entryId, execSucc));
    for (const id of execIds) {
      if (!reach.has(id)) report({ severity: 'warning', code: 'W_UNREACHABLE', message: `"${infos.get(id)?.title}" is never executed: nothing connects to its execution input.`, ...at, nodeId: id, suggestion: 'Connect it into the flow or delete it.' });
    }
  }
  for (const id of pureIds) {
    const info = infos.get(id)!;
    const used = info.ports.some((p) => p.direction === 'out' && index.from(id, p.id).length > 0);
    if (!used) report({ severity: 'info', code: 'I_UNUSED_NODE', message: `"${info.title}" is not connected to anything and has no effect.`, ...at, nodeId: id });
  }
  return { infos, index, entryId };
}

export interface ConnectionCheck {
  severity?: 'error' | 'warning';
  code?: string;
  message: string;
}

/** Whether an output port may connect to an input port. Used by the compiler and the editor. */
export function checkConnection(tc: Toolchain, from: { kind: string; direction: string; type?: TypeRef; name?: string }, to: { kind: string; direction: string; type?: TypeRef; name?: string }): ConnectionCheck {
  if (from.direction !== 'out' || to.direction !== 'in') return { severity: 'error', code: 'E_DIRECTION', message: 'Connections go from an output to an input.' };
  if (from.kind !== to.kind) return { severity: 'error', code: 'E_KIND_MISMATCH', message: from.kind === 'exec' ? 'An execution pin cannot connect to a data pin.' : 'A data pin cannot connect to an execution pin.' };
  if (from.kind === 'exec') return { message: 'ok' };
  const ft = from.type ?? T.any;
  const tt = to.type ?? T.any;
  const c = tc.adapter.types.compatibility(ft, tt);
  if (c === 'incompatible') return { severity: 'error', code: 'E_TYPE_MISMATCH', message: `cannot use ${tc.adapter.types.format(ft)} where ${tc.adapter.types.format(tt)} is expected.` };
  if (c === 'narrowing') return { severity: 'warning', code: 'W_NARROWING', message: `${tc.adapter.types.format(ft)} → ${tc.adapter.types.format(tt)} may lose information.` };
  return { message: c };
}

function compileFunction(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl, report: (d: Diagnostic) => void) {
  const at = { scriptId: script.id, functionId: fn.id, graphId: fn.graph.id };
  let errorsHere = 0;
  const rep = (d: Diagnostic) => {
    if (d.severity === 'error') errorsHere++;
    report(d);
  };
  const analysis = analyzeGraph(tc, script, fn, rep);
  if (!analysis.entryId) return undefined;
  // Structural errors (cycles, bad edges) make lowering meaningless.
  if (errorsHere > 0) return undefined;
  const ctx = makeNodeContext(tc, script, fn);
  const taken = new Set<string>([
    ...script.variables.map((v) => v.name),
    ...script.functions.map((f) => f.name),
    ...script.signals.map((s) => s.name),
    ...script.enums.map((e) => e.name),
    ...fn.params.map((p) => p.name),
    ...fn.locals.map((l) => l.name),
  ]);
  const ir = lowerFunction({ tc, script, fn, ctx, infos: analysis.infos, index: analysis.index, entryId: analysis.entryId, takenNames: taken, report: rep });
  if (ir.returnType.kind !== 'void' && !alwaysReturns(ir.body)) {
    rep({ severity: 'error', code: 'E_MISSING_RETURN', message: `${fn.name} must return a ${tc.adapter.types.format(ir.returnType)} on every path.`, ...at, nodeId: analysis.entryId, suggestion: 'Add a Return node at the end of every branch.' });
  }
  return ir;
}
