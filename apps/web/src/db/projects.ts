/**
 * Project storage in the browser. A "project" is a workspace: metadata + one row per file.
 * Function names are the familiar ones; schema-1 projects are migrated on first touch.
 */
import { migrateProject, type Project } from '@cs/project-format';
import { deriveProject, projectToWorkspace, reidWorkspace as reidWs, configOf, type FileRecord, type Workspace, type WorkspaceMeta } from '@cs/workspace';
import { newId } from '@cs/graph-core';
import { db, type BackupRow, type FileRow } from './db';

export const BACKUP_LIMIT = 30;

export interface ProjectSummary {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
}

/** Fired after saves/deletes in this browser (used by cloud sync). Not fired for `silent` writes. */
export const projectEvents = new EventTarget();
export interface SavedDetail {
  workspace: Workspace;
  changedPaths: string[];
}

const toRow = (ws: string, f: FileRecord): FileRow => ({ ws, path: f.path, kind: f.kind, hash: f.hash, size: f.size, mtime: f.mtime, ...(f.text !== undefined ? { text: f.text } : {}), ...(f.data ? { data: f.data } : {}) });
const fromRow = (r: FileRow): FileRecord => ({ path: r.path, kind: r.kind, hash: r.hash, size: r.size, mtime: r.mtime, ...(r.text !== undefined ? { text: r.text } : {}), ...(r.data ? { data: r.data } : {}) });

function summaryOf(ws: Workspace) {
  const c = configOf(ws);
  return { id: ws.meta.id, name: c.name, language: c.language, createdAt: ws.meta.createdAt, updatedAt: ws.meta.updatedAt, meta: ws.meta };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const ws = await db.workspaces.toArray();
  const ids = new Set(ws.map((w) => w.id));
  const legacy = (await db.projects.toArray()).filter((p) => !ids.has(p.id));
  return [...ws.map(({ id, name, language, createdAt, updatedAt }) => ({ id, name, language, createdAt, updatedAt })), ...legacy.map(({ id, name, language, createdAt, updatedAt }) => ({ id, name, language, createdAt, updatedAt }))].sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface LoadedWorkspace {
  workspace: Workspace;
  issues: string[];
  migratedFrom?: number;
}

/** Write a whole workspace (or only `changedPaths`) in one transaction. */
export async function saveWorkspace(ws: Workspace, changedPaths?: Iterable<string>, opts: { silent?: boolean } = {}): Promise<void> {
  const paths = changedPaths ? [...new Set(changedPaths)] : undefined;
  await db.transaction('rw', db.workspaces, db.files, async () => {
    await db.workspaces.put(summaryOf(ws));
    if (!paths) {
      await db.files.where('ws').equals(ws.meta.id).delete();
      await db.files.bulkPut([...ws.files.values()].map((f) => toRow(ws.meta.id, f)));
      return;
    }
    const put = paths.flatMap((p) => (ws.files.has(p) ? [toRow(ws.meta.id, ws.files.get(p)!)] : []));
    const del = paths.filter((p) => !ws.files.has(p)).map((p) => [ws.meta.id, p] as [string, string]);
    if (put.length) await db.files.bulkPut(put);
    if (del.length) await db.files.bulkDelete(del);
  });
  if (!opts.silent) projectEvents.dispatchEvent(new CustomEvent<SavedDetail>('saved', { detail: { workspace: ws, changedPaths: paths ?? [...ws.files.keys()] } }));
}

/** Load a workspace, migrating a schema-1 project row on first touch (the original is kept as a backup). */
export async function loadWorkspace(id: string): Promise<LoadedWorkspace | undefined> {
  const row = await db.workspaces.get(id);
  if (row) {
    const files = await db.files.where('ws').equals(id).toArray();
    const ws: Workspace = { meta: row.meta, files: new Map(files.map((f) => [f.path, fromRow(f)])) };
    return { workspace: ws, issues: deriveProject(ws).issues.map((i) => `${i.path}: ${i.message}`) };
  }
  const legacy = await db.projects.get(id);
  if (!legacy) return undefined;
  const m = migrateProject(legacy.doc);
  const ws = projectToWorkspace({ ...m.project, id: legacy.id });
  await saveWorkspace(ws, undefined, { silent: true });
  await db.backups.add({ projectId: id, at: Date.now(), label: 'Original project before upgrading to the file-based format', source: 'auto', doc: legacy.doc });
  await db.projects.delete(id);
  return { workspace: ws, issues: m.issues, migratedFrom: 1 };
}

/** Store a workspace as a new project (fresh ids if the id is taken). */
export async function insertWorkspace(ws: Workspace): Promise<Workspace> {
  const taken = (await db.workspaces.get(ws.meta.id)) || (await db.projects.get(ws.meta.id));
  const now = Date.now();
  const stored = taken ? reidWorkspace(ws) : { meta: { ...ws.meta, updatedAt: now }, files: ws.files };
  await saveWorkspace(stored);
  return stored;
}

/** Store a schema-1 Project (new project, example, .vproj import) as a workspace. */
export async function insertProject(p: Project): Promise<Workspace> {
  return insertWorkspace(projectToWorkspace(p));
}

/** Same files, new workspace id and new script/node ids (a copy must never share ids). */
export function reidWorkspace(ws: Workspace, name?: string): Workspace {
  return reidWs(ws, newId('p'), name);
}

export async function duplicateProject(id: string, name?: string): Promise<Workspace> {
  const l = await loadWorkspace(id);
  if (!l) throw new Error(`Project ${id} not found`);
  const copy = reidWorkspace(l.workspace, name ?? `${configOf(l.workspace).name} (copy)`);
  await saveWorkspace(copy);
  return copy;
}

export async function deleteProject(id: string, opts: { silent?: boolean } = {}): Promise<void> {
  await db.transaction('rw', [db.projects, db.workspaces, db.files, db.backups], async () => {
    await db.projects.delete(id);
    await db.workspaces.delete(id);
    await db.files.where('ws').equals(id).delete();
    await db.backups.where('projectId').equals(id).delete();
  });
  if (!opts.silent) projectEvents.dispatchEvent(new CustomEvent('deleted', { detail: id }));
}

// --- backups -------------------------------------------------------------------------------

export interface WorkspaceBackup {
  format: 'coding-studio-workspace-backup';
  meta: WorkspaceMeta;
  files: FileRecord[];
}

export async function createBackup(ws: Workspace, label: string, source: 'user' | 'auto' | 'mcp' = 'auto'): Promise<number> {
  const doc: WorkspaceBackup = { format: 'coding-studio-workspace-backup', meta: ws.meta, files: [...ws.files.values()] };
  const id = await db.backups.add({ projectId: ws.meta.id, at: Date.now(), label, source, doc });
  const all = await db.backups.where('projectId').equals(ws.meta.id).sortBy('at');
  const extra = all.length - BACKUP_LIMIT;
  if (extra > 0) await db.backups.bulkDelete(all.slice(0, extra).map((b) => b.id!));
  return id;
}

/** A backup as a workspace (v1 project backups are converted). */
export function backupToWorkspace(doc: unknown, id: string): Workspace {
  const d = doc as Partial<WorkspaceBackup>;
  if (d?.format === 'coding-studio-workspace-backup' && Array.isArray(d.files) && d.meta) return { meta: { ...d.meta, id }, files: new Map(d.files.map((f) => [f.path, f])) };
  const p = migrateProject(doc).project;
  return projectToWorkspace({ ...p, id });
}

export async function listBackups(projectId: string): Promise<Omit<BackupRow, 'doc'>[]> {
  const all = await db.backups.where('projectId').equals(projectId).reverse().sortBy('at');
  return all.map(({ doc: _doc, ...rest }) => {
    void _doc;
    return rest;
  });
}

export async function getBackup(id: number): Promise<BackupRow | undefined> {
  return db.backups.get(id);
}

// --- settings ----------------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return ((await db.settings.get(key))?.value as T | undefined) ?? fallback;
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}
