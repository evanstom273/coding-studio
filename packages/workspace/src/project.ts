/**
 * Bridge between the workspace (files) and the existing graph tooling (Project documents).
 *
 * The editor, compiler and MCP tools keep working on a `Project`; here it is *derived* from the
 * workspace's `*.vgraph` files and `codingstudio.json`. Graph edits still go through `applyOps`;
 * because it is copy-on-write, every script object it didn't touch is the same object as before,
 * so only changed scripts are written back to their files.
 */
import type { ScriptDoc } from '@cs/graph-core';
import { applyOps, PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, reidProject, type ApplyResult, type EditOp, type OpDefaults, type Project } from '@cs/project-format';
import type { Toolchain } from '@cs/compiler-core';
import { CONFIG_PATH, configOf, GRAPH_EXT, graphPathFor, makeRecord, parseGraph, scriptPathFor, serializeConfig, serializeGraph, type FileRecord, type Workspace, type WorkspaceConfig, type WorkspaceMeta, WORKSPACE_SCHEMA_VERSION } from './model';

/** Parsed scripts by content hash, so unchanged files map to the very same ScriptDoc object. */
const scriptCache = new Map<string, ScriptDoc>();
const CACHE_LIMIT = 2000;
function remember(hash: string, s: ScriptDoc) {
  if (scriptCache.size >= CACHE_LIMIT) scriptCache.delete(scriptCache.keys().next().value!);
  scriptCache.set(hash, s);
}

export interface DerivedProject {
  project: Project;
  /** Graph files that could not be read (shown to the user, never silently dropped). */
  issues: { path: string; message: string }[];
}

export function graphFiles(ws: Workspace): FileRecord[] {
  return [...ws.files.values()].filter((f) => f.kind === 'graph' && f.path.endsWith(GRAPH_EXT)).sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function scriptFromRecord(r: FileRecord): ScriptDoc {
  const cached = scriptCache.get(r.hash);
  const wantPath = scriptPathFor(r.path);
  if (cached) return cached.path === wantPath ? cached : { ...cached, path: wantPath };
  const g = parseGraph(r.text ?? '');
  const s = g.script.path === wantPath ? g.script : { ...g.script, path: wantPath };
  remember(r.hash, s);
  return s;
}

export function deriveProject(ws: Workspace): DerivedProject {
  const config = configOf(ws);
  const issues: DerivedProject['issues'] = [];
  const scripts: ScriptDoc[] = [];
  for (const r of graphFiles(ws)) {
    try {
      scripts.push(scriptFromRecord(r));
    } catch (e) {
      issues.push({ path: r.path, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const project: Project = {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: ws.meta.id,
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    language: config.language,
    languageVersion: config.languageVersion,
    compilerSettings: config.compiler,
    scripts,
    createdAt: ws.meta.createdAt,
    updatedAt: ws.meta.updatedAt,
    ...(ws.meta.editor ? { editor: { activeScriptId: ws.meta.editor.activeScriptId, activeFunctionId: ws.meta.editor.activeFunctionId } } : {}),
  };
  return { project, issues };
}

function configFromProject(p: Project): WorkspaceConfig {
  return { version: 1, name: p.name, ...(p.description ? { description: p.description } : {}), language: p.language, languageVersion: p.languageVersion, compiler: { ...p.compilerSettings } };
}

export class WorkspaceConflict extends Error {
  readonly code = 'E_PATH_CONFLICT';
}

/**
 * Write the difference between two Project views back into a file map (mutated in place).
 * Returns the paths that changed.
 */
export function reconcileProject(files: Map<string, FileRecord>, before: Project, after: Project, now: number): string[] {
  const changed: string[] = [];
  const cfgBefore = configFromProject(before);
  const cfgAfter = configFromProject(after);
  if (JSON.stringify(cfgBefore) !== JSON.stringify(cfgAfter)) {
    files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(cfgAfter), now));
    changed.push(CONFIG_PATH);
  }
  const prev = new Map(before.scripts.map((s) => [s.id, s]));
  const next = new Set(after.scripts.map((s) => s.id));
  for (const s of before.scripts) {
    if (!next.has(s.id)) {
      const p = graphPathFor(s.path);
      files.delete(p);
      changed.push(p);
    }
  }
  for (const s of after.scripts) {
    const old = prev.get(s.id);
    if (old === s) continue;
    const path = graphPathFor(s.path);
    if (old && old.path !== s.path) {
      files.delete(graphPathFor(old.path));
      changed.push(graphPathFor(old.path));
    }
    const existing = files.get(path);
    if (existing && (!old || graphPathFor(old.path) !== path) && existing.kind !== 'graph') throw new WorkspaceConflict(`A file already exists at ${path}`);
    const rec = makeRecord(path, serializeGraph(s, after.language), now, 'graph');
    remember(rec.hash, s);
    files.set(path, rec);
    changed.push(path);
  }
  return changed;
}

export interface ProjectOpsResult {
  workspace: Workspace;
  result: ApplyResult;
  changedPaths: string[];
}

/** Apply graph-level edit operations (the existing EditOp set) to a workspace. Atomic. */
export function applyProjectOps(ws: Workspace, ops: EditOp[], tc: Toolchain, defaults: OpDefaults = {}, now = Date.now()): ProjectOpsResult {
  const { project } = deriveProject(ws);
  const result = applyOps(project, ops, tc, defaults);
  const files = new Map(ws.files);
  const changedPaths = reconcileProject(files, project, result.project, now);
  if (!changedPaths.length) return { workspace: ws, result, changedPaths };
  return { workspace: { meta: { ...ws.meta, updatedAt: now }, files }, result, changedPaths };
}

/** Convert a schema-1 Project document (old projects, .vproj imports, Godot plugin files) into a workspace. */
export function projectToWorkspace(p: Project): Workspace {
  const now = p.updatedAt || Date.now();
  const files = new Map<string, FileRecord>();
  files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(configFromProject(p)), now));
  for (const s of p.scripts) {
    const path = graphPathFor(s.path);
    const rec = makeRecord(path, serializeGraph(s, p.language), now, 'graph');
    remember(rec.hash, s);
    files.set(path, rec);
  }
  const meta: WorkspaceMeta = { id: p.id, schemaVersion: WORKSPACE_SCHEMA_VERSION, createdAt: p.createdAt || now, updatedAt: now, ...(p.editor ? { editor: { ...p.editor } } : {}) };
  return { meta, files };
}

/** New ids for a script (copying a graph file must not duplicate script/node ids). */
export function reidScript(s: ScriptDoc, language: string): ScriptDoc {
  const p: Project = { format: PROJECT_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, id: 'tmp', name: 'tmp', language, languageVersion: '', compilerSettings: { indent: 'tab', indentSize: 4, header: true, comments: true }, scripts: [s], createdAt: 0, updatedAt: 0 };
  return reidProject(p).scripts[0];
}
