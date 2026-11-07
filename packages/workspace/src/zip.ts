/**
 * Whole-workspace zip import/export. A zip of any folder becomes a workspace (a single top-level
 * folder is unwrapped); `codingstudio.json` is created if missing. `.git`, `node_modules` and OS
 * junk are skipped on import (and reported).
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { CONFIG_PATH, detectedConfig, makeRecord, serializeConfig, WORKSPACE_SCHEMA_VERSION, type FileRecord, type Workspace } from './model';
import { normalizePath } from './paths';
import { applyWorkspaceOps } from './ops';

export function workspaceToZip(ws: Workspace, extra: { path: string; content: string }[] = []): Uint8Array {
  const enc = new TextEncoder();
  const z: Zippable = {};
  for (const f of ws.files.values()) z[f.path] = [f.data ?? enc.encode(f.text ?? ''), { mtime: new Date(f.mtime || Date.now()) }];
  for (const e of extra) if (!z[e.path]) z[e.path] = enc.encode(e.content);
  return zipSync(z, { level: 6 });
}

const SKIP = /(^|\/)(\.git|node_modules|__MACOSX)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;

export interface ZipImport {
  workspace: Workspace;
  skipped: number;
  issues: string[];
}

/** Returns null if the zip is a `.vproj` archive (handled by the project-format importer). */
export function zipToWorkspace(bytes: Uint8Array, id: string, fallbackName: string, now = Date.now()): ZipImport | null {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries).filter((n) => !n.endsWith('/'));
  if (names.includes('manifest.json') && names.includes('project.json')) return null;
  let skipped = 0;
  const kept = names.filter((n) => {
    if (SKIP.test(n)) {
      skipped++;
      return false;
    }
    return true;
  });
  // Unwrap a single top-level folder ("my-app/src/…" → "src/…").
  const tops = new Set(kept.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && kept.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
  const files = new Map<string, FileRecord>();
  const issues: string[] = [];
  const ws0: Workspace = { meta: { id, schemaVersion: WORKSPACE_SCHEMA_VERSION, createdAt: now, updatedAt: now }, files };
  const ops = [];
  for (const n of kept) {
    let path: string;
    try {
      path = normalizePath(n.slice(strip.length));
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!path) continue;
    let b64 = '';
    const data = entries[n];
    for (let i = 0; i < data.length; i += 0x8000) b64 += String.fromCharCode(...data.subarray(i, i + 0x8000));
    ops.push({ op: 'write_file' as const, path, base64: btoa(b64) });
  }
  // Each file individually, so one bad file (e.g. an unreadable graph) doesn't sink the import.
  let ws = ws0;
  for (const op of ops) {
    try {
      ws = applyWorkspaceOps(ws, [op], undefined, now).workspace;
    } catch (e) {
      issues.push(e instanceof Error ? e.message.replace(/^Operation \d+ \([a-z_]+\): /, '') : String(e));
    }
  }
  if (!ws.files.has(CONFIG_PATH)) {
    const f = new Map(ws.files);
    f.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(detectedConfig(fallbackName, f.keys())), now));
    ws = { meta: ws.meta, files: f };
  }
  return { workspace: ws, skipped, issues };
}
