/**
 * Forward migrations and structural sanitisation for project documents.
 *
 * - Each migration step takes schema N to N+1. Never edit an old step; add a new one and bump
 *   PROJECT_SCHEMA_VERSION.
 * - Documents from a newer schema are rejected, not truncated.
 * - Sanitisation fills defaults for missing fields but never drops user data silently: anything
 *   it cannot interpret is reported in `issues` (the caller shows them) and kept where possible.
 */
import type { FunctionDecl, Graph, GraphNode, ScriptDoc } from '@cs/graph-core';
import { DEFAULT_COMPILER_SETTINGS } from '@cs/language-sdk';
import { PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, type Project } from './project';

type Doc = Record<string, unknown>;

export const MIGRATIONS: Record<number, (doc: Doc) => Doc> = {
  // 0 → 1: pre-release documents had no "format" marker or compiler settings.
  0: (doc) => ({ ...doc, format: PROJECT_FORMAT, compilerSettings: doc.compilerSettings ?? { ...DEFAULT_COMPILER_SETTINGS }, schemaVersion: 1 }),
};

export class ProjectFormatError extends Error {}

export interface MigrationResult {
  project: Project;
  /** Human-readable notes about repaired or unreadable data. */
  issues: string[];
  migratedFrom?: number;
}

export function migrateProject(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectFormatError('Project data is not a JSON object.');
  let doc: Doc = { ...(raw as Doc) };
  if (doc.format !== undefined && doc.format !== PROJECT_FORMAT) throw new ProjectFormatError(`Not a Coding Studio project (format "${String(doc.format)}").`);
  const start = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (start > PROJECT_SCHEMA_VERSION) throw new ProjectFormatError(`This project was saved by a newer version of Coding Studio (schema ${start}; this build reads up to ${PROJECT_SCHEMA_VERSION}). It was not opened, so nothing was lost.`);
  let v = start;
  while (v < PROJECT_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new ProjectFormatError(`No migration from schema ${v}.`);
    doc = step(doc);
    v = doc.schemaVersion as number;
  }
  const issues: string[] = [];
  const project = sanitizeProject(doc, issues);
  return { project, issues, ...(start !== PROJECT_SCHEMA_VERSION ? { migratedFrom: start } : {}) };
}

const isObj = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function sanitizeGraph(raw: unknown, where: string, issues: string[]): Graph {
  const g = isObj(raw) ? raw : {};
  if (!isObj(raw)) issues.push(`${where}: graph was missing and has been recreated.`);
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of arr(g.nodes)) {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string' || ids.has(n.id)) {
      issues.push(`${where}: an unreadable node was skipped.`);
      continue;
    }
    ids.add(n.id);
    const pos = isObj(n.position) ? n.position : {};
    nodes.push({
      id: n.id,
      type: n.type,
      position: { x: num(pos.x, 0), y: num(pos.y, 0) },
      props: isObj(n.props) ? (n.props as GraphNode['props']) : {},
      inputs: isObj(n.inputs) ? (n.inputs as GraphNode['inputs']) : {},
      ...(n.collapsed === true ? { collapsed: true } : {}),
      ...(isObj(n.size) ? { size: { width: num(n.size.width, 300), height: num(n.size.height, 200) } } : {}),
    });
  }
  const edges: Graph['edges'] = [];
  const edgeIds = new Set<string>();
  for (const e of arr(g.edges)) {
    if (!isObj(e) || typeof e.id !== 'string' || !isObj(e.from) || !isObj(e.to) || edgeIds.has(e.id)) {
      issues.push(`${where}: an unreadable connection was skipped.`);
      continue;
    }
    edgeIds.add(e.id);
    // Dangling edges are kept: the compiler reports them so the user can see what broke.
    edges.push({ id: e.id, from: { node: str(e.from.node, ''), port: str(e.from.port, '') }, to: { node: str(e.to.node, ''), port: str(e.to.port, '') } });
  }
  const vp = isObj(g.viewport) ? g.viewport : undefined;
  return { id: str(g.id, `g_${Math.random().toString(36).slice(2, 12)}`), nodes, edges, ...(vp ? { viewport: { x: num(vp.x, 0), y: num(vp.y, 0), zoom: num(vp.zoom, 1) } } : {}) };
}

function sanitizeParams(v: unknown) {
  return arr(v)
    .filter(isObj)
    .map((p, i) => ({ id: str(p.id, `p_auto${i}`), name: str(p.name, `arg${i}`), type: str(p.type, 'any'), ...(p.default !== undefined ? { default: p.default as never } : {}) }));
}

function sanitizeVars(v: unknown) {
  return arr(v)
    .filter(isObj)
    .map((x, i) => ({
      id: str(x.id, `v_auto${i}`),
      name: str(x.name, `var_${i}`),
      type: str(x.type, 'any'),
      ...(x.default !== undefined ? { default: x.default as never } : {}),
      ...(typeof x.description === 'string' ? { description: x.description } : {}),
      ...(x.exported === true ? { exported: true } : {}),
      ...(x.constant === true ? { constant: true } : {}),
      ...(isObj(x.attributes) ? { attributes: x.attributes as never } : {}),
    }));
}

function sanitizeScript(raw: Doc, i: number, issues: string[]): ScriptDoc {
  const name = str(raw.name, `Script${i + 1}`);
  const functions: FunctionDecl[] = arr(raw.functions)
    .filter(isObj)
    .map((f, j) => ({
      id: str(f.id, `f_auto${j}`),
      name: str(f.name, `function_${j}`),
      kind: f.kind === 'event' ? 'event' : 'function',
      ...(typeof f.event === 'string' ? { event: f.event } : {}),
      params: sanitizeParams(f.params),
      returnType: str(f.returnType, 'void'),
      locals: sanitizeVars(f.locals),
      ...(typeof f.description === 'string' ? { description: f.description } : {}),
      graph: sanitizeGraph(f.graph, `${name}.${str(f.name, '?')}`, issues),
    }));
  return {
    id: str(raw.id, `s_auto${i}`),
    name,
    path: str(raw.path, name.toLowerCase()),
    settings: isObj(raw.settings) ? (raw.settings as ScriptDoc['settings']) : {},
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    variables: sanitizeVars(raw.variables),
    functions,
    signals: arr(raw.signals)
      .filter(isObj)
      .map((s, j) => ({ id: str(s.id, `sig_auto${j}`), name: str(s.name, `signal_${j}`), params: sanitizeParams(s.params), ...(typeof s.description === 'string' ? { description: s.description } : {}) })),
    enums: arr(raw.enums)
      .filter(isObj)
      .map((e, j) => ({
        id: str(e.id, `e_auto${j}`),
        name: str(e.name, `Enum${j}`),
        members: arr(e.members)
          .filter(isObj)
          .map((m, k) => ({ name: str(m.name, `VALUE_${k}`), ...(typeof m.value === 'number' ? { value: m.value } : {}) })),
      })),
  };
}

export function sanitizeProject(doc: Doc, issues: string[] = []): Project {
  const cs = isObj(doc.compilerSettings) ? doc.compilerSettings : {};
  const scripts = arr(doc.scripts);
  const out: Project = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: str(doc.id, `p_${Math.random().toString(36).slice(2, 12)}`),
    name: str(doc.name, 'Untitled'),
    ...(typeof doc.description === 'string' ? { description: doc.description } : {}),
    language: str(doc.language, 'gdscript'),
    languageVersion: str(doc.languageVersion, '4.4'),
    compilerSettings: {
      indent: cs.indent === 'spaces' ? 'spaces' : 'tab',
      indentSize: num(cs.indentSize, 4),
      header: cs.header !== false,
      comments: cs.comments !== false,
    },
    scripts: scripts.filter(isObj).map((s, i) => sanitizeScript(s, i, issues)),
    createdAt: num(doc.createdAt, Date.now()),
    updatedAt: num(doc.updatedAt, Date.now()),
    ...(isObj(doc.editor) ? { editor: { activeScriptId: typeof doc.editor.activeScriptId === 'string' ? doc.editor.activeScriptId : undefined, activeFunctionId: typeof doc.editor.activeFunctionId === 'string' ? doc.editor.activeFunctionId : undefined } } : {}),
  };
  if (scripts.length !== out.scripts.length) issues.push(`${scripts.length - out.scripts.length} unreadable script entr(ies) were skipped.`);
  return out;
}
