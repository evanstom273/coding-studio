/**
 * Project document: the authoritative, versioned, JSON-compatible representation of a visual
 * program. Generated source is derived from it and never stored as the only copy.
 */
import { hashString, newId, stableStringify, type FunctionDecl, type GraphNode, type ScriptDoc } from '@cs/graph-core';
import { DEFAULT_COMPILER_SETTINGS, type CompilerSettings, type LanguageAdapter } from '@cs/language-sdk';

export const PROJECT_FORMAT = 'coding-studio-project';
export const PROJECT_SCHEMA_VERSION = 1;

export interface Project {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  /** Language adapter id ("gdscript"). */
  language: string;
  languageVersion: string;
  compilerSettings: CompilerSettings;
  scripts: ScriptDoc[];
  createdAt: number;
  updatedAt: number;
  /** Persisted editor layout: which script/graph was open. Not part of the revision hash. */
  editor?: { activeScriptId?: string; activeFunctionId?: string };
}

/** Revision used for optimistic concurrency: covers the editable content only. */
export function projectRevision(p: Project): string {
  const { updatedAt: _u, editor: _e, ...rest } = p;
  void _u;
  void _e;
  return hashString(stableStringify(rest));
}

export function entryNode(position = { x: 0, y: 0 }): GraphNode {
  return { id: newId('n'), type: 'core.entry', position, props: {}, inputs: {} };
}

export function createFunction(init: Partial<FunctionDecl> & { name: string }): FunctionDecl {
  return {
    id: init.id ?? newId('f'),
    name: init.name,
    kind: init.kind ?? 'function',
    ...(init.event ? { event: init.event } : {}),
    ...(init.owner ? { owner: init.owner } : {}),
    params: init.params ?? [],
    returnType: init.returnType ?? 'void',
    locals: init.locals ?? [],
    ...(init.description ? { description: init.description } : {}),
    ...(init.async ? { async: true } : {}),
    ...(init.exported ? { exported: true } : {}),
    graph: init.graph ?? { id: newId('g'), nodes: [entryNode()], edges: [] },
  };
}

export function createEventFunction(adapter: LanguageAdapter, eventId: string): FunctionDecl {
  const tpl = adapter.events.find((e) => e.id === eventId);
  if (!tpl) throw new Error(`Unknown ${adapter.name} event "${eventId}"`);
  return createFunction({
    name: tpl.name,
    kind: 'event',
    event: tpl.id,
    params: tpl.params.map((p) => ({ id: newId('p'), ...p })),
    returnType: tpl.returnType,
  });
}

export function createScript(adapter: LanguageAdapter, name: string, opts: { path?: string; template?: string } = {}): ScriptDoc {
  const tpl = adapter.templates.find((t) => t.id === opts.template) ?? adapter.templates[0];
  return {
    id: newId('s'),
    name,
    path: opts.path ?? toSnakeCase(name),
    settings: structuredClone(tpl?.settings ?? {}),
    variables: [],
    functions: [
      ...(tpl?.events ?? []).map((e) => createEventFunction(adapter, e)),
      ...(tpl?.functions ?? []).map((f) =>
        createFunction({ name: f.name, params: (f.params ?? []).map((p) => ({ id: newId('p'), ...p })), returnType: f.returnType ?? 'void', ...(f.description ? { description: f.description } : {}), ...(f.exported ? { exported: true } : {}), ...(f.async ? { async: true } : {}) }),
      ),
    ],
    signals: [],
    enums: [],
  };
}

export function createProject(adapter: LanguageAdapter, name: string, opts: { template?: string; scriptName?: string; withScript?: boolean } = {}): Project {
  const now = Date.now();
  const scripts = opts.withScript === false ? [] : [createScript(adapter, opts.scriptName ?? 'Main', { template: opts.template })];
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId('p'),
    name,
    language: adapter.id,
    languageVersion: adapter.defaultVersion,
    compilerSettings: { ...DEFAULT_COMPILER_SETTINGS },
    scripts,
    createdAt: now,
    updatedAt: now,
    editor: scripts[0] ? { activeScriptId: scripts[0].id, activeFunctionId: scripts[0].functions[0]?.id } : {},
  };
}

export function toSnakeCase(s: string): string {
  return (
    s
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'script'
  );
}

/** Re-id every object in a project (used when importing a copy so ids never collide). */
export function reidProject(p: Project): Project {
  const map = new Map<string, string>();
  const re = (old: string, prefix: string) => {
    if (!map.has(old)) map.set(old, newId(prefix));
    return map.get(old)!;
  };
  const copy: Project = structuredClone(p);
  copy.id = newId('p');
  for (const s of copy.scripts) {
    s.id = re(s.id, 's');
    for (const v of s.variables) v.id = re(v.id, 'v');
    for (const sg of s.signals) {
      sg.id = re(sg.id, 'sig');
      for (const pp of sg.params) pp.id = re(pp.id, 'p');
    }
    for (const e of s.enums) e.id = re(e.id, 'e');
    for (const f of s.functions) {
      f.id = re(f.id, 'f');
      for (const pp of f.params) pp.id = re(pp.id, 'p');
      for (const l of f.locals) l.id = re(l.id, 'v');
      f.graph.id = re(f.graph.id, 'g');
      for (const n of f.graph.nodes) n.id = re(n.id, 'n');
      for (const e of f.graph.edges) e.id = re(e.id, 'e');
    }
  }
  // Second pass: rewrite references (edge endpoints, node props/inputs that hold ids, param port ids).
  const swap = (v: unknown): unknown => (typeof v === 'string' && map.has(v) ? map.get(v) : v);
  for (const s of copy.scripts) {
    for (const f of s.functions) {
      for (const n of f.graph.nodes) {
        for (const k of Object.keys(n.props)) n.props[k] = swap(n.props[k]) as never;
        n.inputs = Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [swap(k) as string, v]));
      }
      for (const e of f.graph.edges) {
        e.from = { node: swap(e.from.node) as string, port: swap(e.from.port) as string };
        e.to = { node: swap(e.to.node) as string, port: swap(e.to.port) as string };
      }
    }
  }
  if (copy.editor) copy.editor = { activeScriptId: swap(copy.editor.activeScriptId) as string | undefined, activeFunctionId: swap(copy.editor.activeFunctionId) as string | undefined };
  return copy;
}
