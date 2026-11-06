import { migrateProject, reidProject, type Project } from '@cs/project-format';
import { db, type BackupRow } from './db';

export const BACKUP_LIMIT = 30;

export interface ProjectSummary {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = await db.projects.orderBy('updatedAt').reverse().toArray();
  return rows.map(({ id, name, language, createdAt, updatedAt }) => ({ id, name, language, createdAt, updatedAt }));
}

export interface LoadedProject {
  project: Project;
  issues: string[];
  migratedFrom?: number;
}

/** Load and migrate. The stored row is only replaced on the next successful save. */
export async function loadProject(id: string): Promise<LoadedProject | undefined> {
  const row = await db.projects.get(id);
  if (!row) return undefined;
  const m = migrateProject(row.doc);
  return { project: { ...m.project, id: row.id }, issues: m.issues, migratedFrom: m.migratedFrom };
}

/** Fired after a project is saved or deleted in this browser (used by cloud sync). Not fired for `silent` writes. */
export const projectEvents = new EventTarget();

export async function saveProject(p: Project, opts: { silent?: boolean } = {}): Promise<void> {
  await db.projects.put({ id: p.id, name: p.name, language: p.language, createdAt: p.createdAt, updatedAt: p.updatedAt, doc: p });
  if (!opts.silent) projectEvents.dispatchEvent(new CustomEvent('saved', { detail: p }));
}

export async function insertProject(p: Project): Promise<Project> {
  const project = (await db.projects.get(p.id)) ? reidProject(p) : p;
  const now = Date.now();
  const stored = { ...project, createdAt: project.createdAt || now, updatedAt: now };
  await saveProject(stored);
  return stored;
}

export async function duplicateProject(id: string, name?: string): Promise<Project> {
  const l = await loadProject(id);
  if (!l) throw new Error(`Project ${id} not found`);
  const copy = reidProject(l.project);
  copy.name = name ?? `${l.project.name} (copy)`;
  copy.createdAt = Date.now();
  return insertProject(copy);
}

export async function deleteProject(id: string, opts: { silent?: boolean } = {}): Promise<void> {
  await db.transaction('rw', db.projects, db.backups, async () => {
    await db.projects.delete(id);
    await db.backups.where('projectId').equals(id).delete();
  });
  if (!opts.silent) projectEvents.dispatchEvent(new CustomEvent('deleted', { detail: id }));
}

export async function renameProject(id: string, name: string): Promise<void> {
  const l = await loadProject(id);
  if (!l) return;
  await saveProject({ ...l.project, name, updatedAt: Date.now() });
}

// --- backups -------------------------------------------------------------------

export async function createBackup(p: Project, label: string, source: 'user' | 'auto' | 'mcp' = 'auto'): Promise<number> {
  const id = await db.backups.add({ projectId: p.id, at: Date.now(), label, source, doc: structuredClone(p) });
  const all = await db.backups.where('projectId').equals(p.id).sortBy('at');
  const extra = all.length - BACKUP_LIMIT;
  if (extra > 0) await db.backups.bulkDelete(all.slice(0, extra).map((b) => b.id!));
  return id;
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

// --- settings -----------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  return ((await db.settings.get(key))?.value as T | undefined) ?? fallback;
}

export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}
