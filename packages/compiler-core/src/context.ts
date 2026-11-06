import { parseType, T, isSubclass, type TypeRef } from '@cs/type-system';
import type { Diagnostic, FunctionDecl, GraphNode, JsonValue, ScriptDoc } from '@cs/graph-core';
import type { IRExpr } from '@cs/intermediate-representation';
import type { LanguageAdapter } from '@cs/language-sdk';
import { NodeRegistry, type NodeContext, type NodeDefinition, type PortSpec, type ResolvedVariable } from '@cs/node-registry';

export interface Toolchain {
  adapter: LanguageAdapter;
  registry: NodeRegistry;
}

/** Parse a type string through the adapter's alias normalisation. Returns undefined + error message on failure. */
export function resolveType(adapter: LanguageAdapter, text: string | undefined): { type?: TypeRef; error?: string } {
  if (text === undefined || text.trim() === '') return { error: 'Type is empty' };
  const norm = adapter.types.normalize?.(text.trim()) ?? text.trim();
  try {
    const type = parseType(norm);
    const bad = adapter.types.check?.(type);
    if (bad) return { error: bad };
    return { type };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function makeNodeContext(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl): NodeContext {
  const { adapter } = tc;
  const typeCache = new Map<string, TypeRef>();
  const type = (text: string | undefined): TypeRef => {
    const key = text ?? '';
    let t = typeCache.get(key);
    if (!t) {
      t = resolveType(adapter, text).type ?? T.any;
      typeCache.set(key, t);
    }
    return t;
  };
  const vars = (): ResolvedVariable[] => [
    ...fn.params.map((p) => ({ id: p.id, name: p.name, type: type(p.type), scope: 'param' as const, constant: false, decl: p })),
    ...fn.locals.map((v) => ({ id: v.id, name: v.name, type: type(v.type), scope: 'local' as const, constant: !!v.constant, decl: v })),
    ...script.variables.map((v) => ({ id: v.id, name: v.name, type: type(v.type), scope: 'member' as const, constant: !!v.constant, decl: v })),
  ];
  let cachedVars: ResolvedVariable[] | null = null;
  const selfName = typeof script.settings.extends === 'string' && script.settings.extends ? script.settings.extends : undefined;
  return {
    language: adapter.id,
    capabilities: adapter.capabilities,
    script,
    fn,
    type,
    variables: () => (cachedVars ??= vars()),
    variable: (id) => (typeof id === 'string' ? (cachedVars ??= vars()).find((v) => v.id === id) : undefined),
    func: (id) => (typeof id === 'string' ? script.functions.find((f) => f.id === id) : undefined),
    signal: (id) => (typeof id === 'string' ? script.signals.find((s) => s.id === id) : undefined),
    selfType: () => (adapter.capabilities.classes ? (selfName && !selfName.includes('/') && !selfName.includes('"') ? T.named(selfName) : T.named('Object')) : undefined),
    operatorResult: (op, l, r) => adapter.types.operatorResult(op, l, r),
    isSubclass: (c, a) => isSubclass(adapter.types.universe, c, a),
    formatType: (t) => adapter.types.format(t),
  };
}

export interface NodeInfo {
  node: GraphNode;
  def: NodeDefinition | undefined;
  ports: PortSpec[];
  title: string;
}

/** Resolve a node's definition, ports and display title. Never throws (bad definitions yield no ports). */
export function nodeInfo(tc: Toolchain, ctx: NodeContext, node: GraphNode): NodeInfo {
  const def = tc.registry.get(node.type);
  if (!def) return { node, def, ports: [], title: `Unknown (${node.type})` };
  let ports: PortSpec[] = [];
  let title = def.title;
  try {
    ports = def.ports(node, ctx);
    title = def.displayTitle?.(node, ctx) ?? def.title;
  } catch {
    ports = [];
  }
  return { node, def, ports, title };
}

/** Build a literal expression for a JSON value of the given type. */
export function literalExpr(adapter: LanguageAdapter, value: JsonValue, type: TypeRef | undefined): IRExpr {
  const custom = type ? adapter.literal?.(value, type) : undefined;
  if (custom) return custom;
  if (value === null) return { k: 'null' };
  const t = type ?? T.any;
  switch (t.kind) {
    case 'int':
      return { k: 'lit', value: typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10) || 0, type: T.int };
    case 'float':
      return { k: 'lit', value: typeof value === 'number' ? value : Number.parseFloat(String(value)) || 0, type: T.float };
    case 'bool':
      return { k: 'lit', value: value === true || value === 'true', type: T.bool };
    case 'string':
      return { k: 'lit', value: typeof value === 'string' ? value : JSON.stringify(value), type: T.string };
    case 'array':
      return { k: 'array', items: Array.isArray(value) ? value.map((v) => literalExpr(adapter, v, t.element)) : [], ...(t.element.kind === 'any' ? {} : { element: t.element }) };
    case 'map':
      return {
        k: 'map',
        entries: value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([k, v]) => ({ key: literalExpr(adapter, k, t.key.kind === 'any' ? T.string : t.key), value: literalExpr(adapter, v, t.value) })) : [],
      };
    case 'named': {
      const fields = adapter.types.structFields(t.name);
      if (fields && value && typeof value === 'object' && !Array.isArray(value)) {
        const o = value as Record<string, JsonValue>;
        return { k: 'new', type: t, args: fields.map((f) => literalExpr(adapter, o[f.name] ?? 0, f.type)) };
      }
      if (fields && Array.isArray(value)) return { k: 'new', type: t, args: fields.map((f, i) => literalExpr(adapter, value[i] ?? 0, f.type)) };
      return { k: 'null' };
    }
    default: {
      // any: infer from the JSON value
      if (typeof value === 'boolean') return { k: 'lit', value, type: T.bool };
      if (typeof value === 'number') return { k: 'lit', value, type: Number.isInteger(value) ? T.int : T.float };
      if (typeof value === 'string') return { k: 'lit', value, type: T.string };
      if (Array.isArray(value)) return { k: 'array', items: value.map((v) => literalExpr(adapter, v, undefined)) };
      const o = value as Record<string, JsonValue>;
      if (typeof o.$type === 'string') return literalExpr(adapter, value, T.named(o.$type));
      return literalExpr(adapter, value, T.map(T.string, T.any));
    }
  }
}

/** Check that a literal JSON value fits a type (for variable defaults and inline inputs). */
export function literalFits(adapter: LanguageAdapter, value: JsonValue, t: TypeRef): boolean {
  if (value === null) return t.kind === 'any' || t.kind === 'named' || !!t.nullable;
  switch (t.kind) {
    case 'any':
      return true;
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value) && value.every((v) => literalFits(adapter, v, t.element));
    case 'map':
      return typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => literalFits(adapter, v, t.value));
    case 'named': {
      const fields = adapter.types.structFields(t.name);
      if (!fields) return false;
      if (Array.isArray(value)) return value.length === fields.length && value.every((v) => typeof v === 'number');
      if (typeof value !== 'object') return false;
      const o = value as Record<string, JsonValue>;
      return fields.every((f) => o[f.name] === undefined || typeof o[f.name] === 'number');
    }
    default:
      return false;
  }
}

export type DiagnosticSink = (d: Diagnostic) => void;
