/**
 * Workspace model: a project is a set of files at paths. Visual graphs are files too (`*.vgraph`),
 * so a workspace in the IDE, on disk and in a Git repository has the same shape.
 *
 * Snapshots are immutable: an edit produces a new `Workspace` whose `files` map shares every
 * unchanged `FileRecord` with the previous one.
 */
import type { ScriptDoc } from '@cs/graph-core';
import { DEFAULT_COMPILER_SETTINGS, type CompilerSettings } from '@cs/language-sdk';
import { byteLength, gitBlobHash } from './hash';
import { extname } from './paths';

export const WORKSPACE_SCHEMA_VERSION = 2;
export const CONFIG_PATH = 'codingstudio.json';
export const GRAPH_EXT = '.vgraph';
export const GRAPH_FORMAT = 'coding-studio-graph';

export type FileKind = 'text' | 'binary' | 'graph';

export interface FileRecord {
  path: string;
  kind: FileKind;
  /** text and graph files */
  text?: string;
  /** binary files */
  data?: Uint8Array;
  /** git blob sha1 of the content */
  hash: string;
  size: number;
  mtime: number;
}

export interface WorkspaceConfig {
  version: 1;
  /** Display name of the project. */
  name: string;
  description?: string;
  /** Default language for new graphs. */
  language: string;
  languageVersion: string;
  compiler: CompilerSettings;
}

export interface WorkspaceMeta {
  id: string;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  /** UI state, not part of any file (never synced into the repository). */
  editor?: { activeScriptId?: string; activeFunctionId?: string; openTabs?: string[]; activeTab?: string };
}

export interface Workspace {
  meta: WorkspaceMeta;
  files: ReadonlyMap<string, FileRecord>;
}

/** One `*.vgraph` file. */
export interface GraphFile {
  format: typeof GRAPH_FORMAT;
  version: 1;
  language: string;
  script: ScriptDoc;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz', '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.webm', '.mov', '.ttf', '.otf', '.woff', '.woff2', '.zip', '.gz', '.tar', '.pdf', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.pck', '.glb', '.blend', '.psd']);

export function kindForPath(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (ext === GRAPH_EXT) return 'graph';
  return BINARY_EXT.has(ext) ? 'binary' : 'text';
}

/** Heuristic for uploaded content: NUL bytes in the first 8 KB → binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function makeRecord(path: string, content: string | Uint8Array, mtime = Date.now(), kind: FileKind = kindForPath(path)): FileRecord {
  const hash = gitBlobHash(content);
  const size = byteLength(content);
  if (typeof content === 'string') return { path, kind: kind === 'binary' ? 'text' : kind, text: content, hash, size, mtime };
  return { path, kind: 'binary', data: content, hash, size, mtime };
}

export function recordContent(r: FileRecord): string | Uint8Array {
  return r.text ?? r.data ?? '';
}

// --- config ------------------------------------------------------------------------------------

export function defaultConfig(name: string, language = 'gdscript', languageVersion = '4.4'): WorkspaceConfig {
  return { version: 1, name, language, languageVersion, compiler: { ...DEFAULT_COMPILER_SETTINGS } };
}

export function serializeConfig(c: WorkspaceConfig): string {
  return JSON.stringify(c, null, 2) + '\n';
}

/** Parse codingstudio.json leniently: unknown keys are kept out, missing ones defaulted. */
export function parseConfig(text: string | undefined, fallbackName = 'Untitled'): WorkspaceConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  const cs = (raw.compiler ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    language: typeof raw.language === 'string' ? raw.language : 'gdscript',
    languageVersion: typeof raw.languageVersion === 'string' ? raw.languageVersion : '4.4',
    compiler: {
      indent: cs.indent === 'spaces' ? 'spaces' : 'tab',
      indentSize: typeof cs.indentSize === 'number' ? cs.indentSize : 4,
      header: cs.header !== false,
      comments: cs.comments !== false,
    },
  };
}

// --- graph files ------------------------------------------------------------------------------

export function serializeGraph(script: ScriptDoc, language: string): string {
  const doc: GraphFile = { format: GRAPH_FORMAT, version: 1, language, script };
  return JSON.stringify(doc, null, 2) + '\n';
}

export class GraphFileError extends Error {}

export function parseGraph(text: string): GraphFile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GraphFileError('Not valid JSON');
  }
  if (raw.format !== GRAPH_FORMAT) throw new GraphFileError(`Not a Coding Studio graph (format "${String(raw.format)}")`);
  if (typeof raw.version !== 'number' || raw.version > 1) throw new GraphFileError(`Graph file version ${String(raw.version)} is newer than this build supports`);
  if (!raw.script || typeof raw.script !== 'object') throw new GraphFileError('Graph file has no script');
  return { format: GRAPH_FORMAT, version: 1, language: typeof raw.language === 'string' ? raw.language : 'gdscript', script: raw.script as ScriptDoc };
}

/** "player/player" → "player/player.vgraph" */
export const graphPathFor = (scriptPath: string) => `${scriptPath}${GRAPH_EXT}`;
export const scriptPathFor = (graphPath: string) => graphPath.slice(0, -GRAPH_EXT.length);

// --- snapshot helpers ----------------------------------------------------------------------------

export function emptyWorkspace(id: string, config: WorkspaceConfig, now = Date.now()): Workspace {
  const files = new Map<string, FileRecord>();
  files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(config), now));
  return { meta: { id, schemaVersion: WORKSPACE_SCHEMA_VERSION, createdAt: now, updatedAt: now }, files };
}

export function configOf(ws: Workspace): WorkspaceConfig {
  return parseConfig(ws.files.get(CONFIG_PATH)?.text, 'Untitled');
}

/** Sorted list of directories implied by the files (plus explicit `.keep` markers). */
export function directoriesOf(ws: Workspace): string[] {
  const dirs = new Set<string>();
  for (const p of ws.files.keys()) {
    let i = p.indexOf('/');
    while (i !== -1) {
      dirs.add(p.slice(0, i));
      i = p.indexOf('/', i + 1);
    }
  }
  return [...dirs].sort();
}

/** Content revision of a whole workspace (independent of timestamps and UI state). */
export function workspaceRevision(ws: Workspace): string {
  const lines = [...ws.files.values()].map((f) => `${f.path}\0${f.hash}`).sort();
  return gitBlobHash(lines.join('\n'));
}
