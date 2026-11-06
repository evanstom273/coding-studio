/**
 * Portable project files.
 *
 *  - `.vproj.json`  plain JSON project document (also used by the Godot plugin)
 *  - `.vproj`       ZIP archive: manifest.json + project.json + generated/<sources> (informational)
 *
 * Importing always goes through migrateProject, so old files are upgraded and newer ones rejected.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { GeneratedFile } from '@cs/language-sdk';
import { migrateProject, ProjectFormatError, type MigrationResult } from './migrations';
import { PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, type Project } from './project';

export const ARCHIVE_FORMAT = 'coding-studio-archive';
export const ARCHIVE_VERSION = 1;
/** Hard cap on archive input to avoid zip bombs in the browser. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  archiveVersion: number;
  projectSchemaVersion: number;
  name: string;
  language: string;
  exportedAt: string;
  generated: string[];
}

export function projectToJson(p: Project): string {
  return JSON.stringify(p, null, 2) + '\n';
}

export function buildArchive(p: Project, generated: GeneratedFile[] = []): Uint8Array {
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    archiveVersion: ARCHIVE_VERSION,
    projectSchemaVersion: PROJECT_SCHEMA_VERSION,
    name: p.name,
    language: p.language,
    exportedAt: new Date(p.updatedAt).toISOString(),
    generated: generated.map((f) => f.path),
  };
  const files: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': strToU8(projectToJson(p)),
  };
  for (const f of generated) files[`generated/${f.path}`] = strToU8(f.content);
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2020, 0, 1)) });
}

/** Parse a .vproj archive or a .vproj.json document. */
export function parseProjectFile(bytes: Uint8Array): MigrationResult {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ProjectFormatError('File is too large to be a project (over 50 MB).');
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    let raw: unknown;
    try {
      raw = JSON.parse(strFromU8(bytes));
    } catch {
      throw new ProjectFormatError('File is neither a project archive nor valid project JSON.');
    }
    return migrateProject(raw);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => f.name === 'manifest.json' || f.name === 'project.json' });
  } catch (e) {
    throw new ProjectFormatError(`Could not read the archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!entries['project.json']) throw new ProjectFormatError('Archive has no project.json.');
  if (entries['manifest.json']) {
    const m = JSON.parse(strFromU8(entries['manifest.json'])) as Partial<ArchiveManifest>;
    if (m.format !== ARCHIVE_FORMAT) throw new ProjectFormatError('Archive manifest is not a Coding Studio archive.');
    if (typeof m.archiveVersion === 'number' && m.archiveVersion > ARCHIVE_VERSION) throw new ProjectFormatError(`Archive version ${m.archiveVersion} is newer than this build supports.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(entries['project.json']));
  } catch {
    throw new ProjectFormatError('project.json in the archive is not valid JSON.');
  }
  return migrateProject(raw);
}

/** ZIP of generated sources only (folder structure preserved). */
export function buildSourceZip(files: GeneratedFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of files) z[f.path] = strToU8(f.content);
  return zipSync(z, { level: 6, mtime: new Date(Date.UTC(2020, 0, 1)) });
}

export { PROJECT_FORMAT };
