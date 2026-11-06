/**
 * IndexedDB (Dexie). Projects live only in this browser; nothing is uploaded anywhere.
 *
 * Schema history (never edit an old version, add a new one):
 *   v1  projects, backups, settings
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '@cs/project-format';

export interface ProjectRow {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
  /** Raw stored document; always passed through migrateProject when read. */
  doc: unknown;
}

export interface BackupRow {
  id?: number;
  projectId: string;
  at: number;
  label: string;
  /** 'user' | 'auto' | 'mcp' */
  source: string;
  doc: Project;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export class StudioDB extends Dexie {
  projects!: Table<ProjectRow, string>;
  backups!: Table<BackupRow, number>;
  settings!: Table<SettingRow, string>;

  constructor(name = 'coding-studio') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      backups: '++id, projectId, at, [projectId+at]',
      settings: 'key',
    });
  }
}

export const db = new StudioDB();
