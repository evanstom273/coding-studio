/**
 * IndexedDB (Dexie). Projects live in this browser (and, with the Claude connector on, are synced
 * to the user's own Cloudflare Durable Object).
 *
 * Schema history (never edit an old version, add a new one):
 *   v1  projects (one JSON document per project), backups, settings
 *   v2  + workspaces (metadata) and files (one row per file, keyed [ws+path]).
 *       v1 projects are migrated lazily, on first open/list, and kept as a backup.
 */
import Dexie, { type Table } from 'dexie';
import type { FileKind, WorkspaceMeta } from '@cs/workspace';

export interface ProjectRow {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
  /** Raw stored schema-1 document; read through migrateProject. */
  doc: unknown;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
  meta: WorkspaceMeta;
}

export interface FileRow {
  ws: string;
  path: string;
  kind: FileKind;
  hash: string;
  size: number;
  mtime: number;
  text?: string;
  data?: Uint8Array;
}

export interface BackupRow {
  id?: number;
  projectId: string;
  at: number;
  label: string;
  /** 'user' | 'auto' | 'mcp' */
  source: string;
  /** WorkspaceBackup (v2) or a schema-1 Project (v1 backups). */
  doc: unknown;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export class StudioDB extends Dexie {
  projects!: Table<ProjectRow, string>;
  backups!: Table<BackupRow, number>;
  settings!: Table<SettingRow, string>;
  workspaces!: Table<WorkspaceRow, string>;
  files!: Table<FileRow, [string, string]>;

  constructor(name = 'coding-studio') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      backups: '++id, projectId, at, [projectId+at]',
      settings: 'key',
    });
    this.version(2).stores({
      workspaces: 'id, updatedAt, name',
      files: '[ws+path], ws',
    });
  }
}

export const db = new StudioDB();
