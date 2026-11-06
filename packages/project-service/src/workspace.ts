/**
 * Workspace (file-level) views for the MCP tools, shared by the editor's handlers and the cloud
 * service: directory listings, file reads, search and batch preparation.
 */
import type { ScriptDoc } from '@cs/graph-core';
import type { EditOp, Project } from '@cs/project-format';
import { GRAPH_EXT, normalizePath, searchFiles, type FileRecord, type WorkspaceOp } from '@cs/workspace';
import { ServiceError, str } from './index';

/** A script by id, name, path ("player/player") or graph file ("player/player.vgraph"). */
export function matchScript(s: ScriptDoc, ref: unknown): boolean {
  if (typeof ref !== 'string' || !ref) return false;
  return s.id === ref || s.name === ref || s.path === ref || `${s.path}${GRAPH_EXT}` === ref;
}

export function findScript(p: Project, ref: unknown): ScriptDoc | undefined {
  return str(ref) ? p.scripts.find((s) => matchScript(s, str(ref))) : undefined;
}

export interface IndexEntry {
  path: string;
  kind: string;
  size: number;
  hash: string;
}

/** Listing of `path` (default: root) down to `depth` levels; deeper folders are summarised. */
export function describeTree(index: IndexEntry[], opts: { path?: unknown; depth?: unknown; revision: string; generated?: string[] }) {
  const root = str(opts.path) ? normalizePath(String(opts.path)) : '';
  const depth = typeof opts.depth === 'number' && opts.depth > 0 ? Math.min(opts.depth, 50) : 20;
  const inside = index.filter((e) => !root || e.path.startsWith(`${root}/`) || e.path === root);
  if (root && !inside.length) throw new ServiceError('E_NOT_FOUND', `"${root}" does not exist. Use read_tree without a path to see the project.`);
  const files: { path: string; kind: string; size: number; hash: string }[] = [];
  const folded = new Map<string, { files: number; bytes: number }>();
  for (const e of inside) {
    if (e.path.endsWith('/.gitkeep')) continue;
    const rel = root ? e.path.slice(root.length + 1) : e.path;
    const parts = rel.split('/');
    if (parts.length - 1 >= depth) {
      const dir = (root ? `${root}/` : '') + parts.slice(0, depth).join('/');
      const f = folded.get(dir) ?? { files: 0, bytes: 0 };
      f.files++;
      f.bytes += e.size;
      folded.set(dir, f);
    } else files.push({ path: e.path, kind: e.kind, size: e.size, hash: e.hash });
  }
  const dirs = new Set<string>();
  for (const e of inside) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!root || d.startsWith(`${root}/`)) dirs.add(d);
    }
  }
  return {
    workspace_revision: opts.revision,
    path: root || '/',
    files,
    folders: [...dirs].filter((d) => ![...folded.keys()].some((f) => d.startsWith(`${f}/`))).sort(),
    ...(folded.size ? { collapsed: Object.fromEntries(folded), note: `Folders deeper than ${depth} level(s) are summarised; call read_tree with their path to see inside.` } : {}),
    ...(opts.generated?.length ? { generated: opts.generated, generated_note: 'Generated from .vgraph files: read-only, not stored. Read them with read_files or compile_script; edit the graph instead.' } : {}),
    total_files: files.length + [...folded.values()].reduce((a, f) => a + f.files, 0),
  };
}

const READ_LIMIT = 2 * 1024 * 1024;

/** File contents for read_files. Binary files come back as base64 (up to the limit). */
export function readFilesView(paths: unknown, lookup: (path: string) => FileRecord | undefined, generated: (path: string) => string | undefined) {
  if (!Array.isArray(paths) || !paths.length) throw new ServiceError('E_INVALID', 'paths must be a non-empty array');
  if (paths.length > 200) throw new ServiceError('E_INVALID', 'At most 200 paths per call');
  let budget = READ_LIMIT * 4;
  return {
    files: paths.map((raw) => {
      let path: string;
      try {
        path = normalizePath(String(raw));
      } catch (e) {
        return { path: String(raw), error: e instanceof Error ? e.message : String(e) };
      }
      const f = lookup(path);
      if (!f) {
        const g = generated(path);
        if (g !== undefined) return { path, generated: true, read_only: true, text: g };
        return { path, error: 'E_NOT_FOUND' };
      }
      if (f.size > READ_LIMIT || f.size > budget) return { path, kind: f.kind, hash: f.hash, size: f.size, error: 'E_TOO_LARGE', message: `File is ${f.size} bytes; too large to return in one call.` };
      budget -= f.size;
      if (f.kind === 'binary') {
        let s = '';
        const d = f.data ?? new Uint8Array();
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
        return { path, kind: f.kind, hash: f.hash, size: f.size, base64: btoa(s) };
      }
      return { path, kind: f.kind, hash: f.hash, size: f.size, text: f.text ?? '' };
    }),
  };
}

export function searchView(files: Iterable<FileRecord>, params: Record<string, unknown>) {
  const query = String(params.query ?? '');
  if (!query) throw new ServiceError('E_INVALID', 'query is required');
  const r = searchFiles(files, query, { regex: params.regex === true, caseSensitive: params.case_sensitive === true, limit: Math.min(Number(params.limit) || 200, 2000), under: str(params.path) });
  if (r.error) throw new ServiceError('E_INVALID', `Invalid regular expression: ${r.error}`);
  return { matches: r.hits.map((h) => ({ path: h.path, line: h.line, text: h.text })), truncated: r.truncated };
}

export const WORKSPACE_OPS = ['write_file', 'create_dir', 'delete', 'move', 'copy', 'graph', 'config'] as const;

/**
 * Validate a workspace batch from Claude and resolve graph-op defaults (a `graph` op may name its
 * script by path, e.g. "player/player.vgraph"). Returns the ops and whether it's destructive.
 */
export function prepareBatch(_p: Project, raw: unknown, active: { scriptId?: string; functionId?: string }): { ops: WorkspaceOp[]; destructive: boolean; touchesGraphs: boolean } {
  if (!Array.isArray(raw) || !raw.length) throw new ServiceError('E_INVALID', 'operations must be a non-empty array');
  let destructive = false;
  let touchesGraphs = false;
  const ops = raw.map((o, i): WorkspaceOp => {
    const op = o as Record<string, unknown>;
    if (!op || typeof op !== 'object' || !WORKSPACE_OPS.includes(op.op as (typeof WORKSPACE_OPS)[number])) throw new ServiceError('E_INVALID', `Operation ${i + 1}: unknown op "${String(op?.op)}" (expected one of ${WORKSPACE_OPS.join(', ')})`);
    if (op.op === 'delete') destructive = true;
    if (op.op === 'graph') {
      touchesGraphs = true;
      if (!Array.isArray(op.ops ?? op.operations)) throw new ServiceError('E_INVALID', `Operation ${i + 1}: "graph" needs ops: [...]`);
      return { op: 'graph', ops: (op.ops ?? op.operations) as EditOp[], defaults: { scriptId: active.scriptId, functionId: active.functionId }, ...(str(op.script) ? { script: str(op.script) } : {}), ...(str(op.graph) ? { graph: str(op.graph) } : {}) };
    }
    if (String(op.path ?? op.from ?? '').endsWith(GRAPH_EXT) || String(op.to ?? '').endsWith(GRAPH_EXT)) touchesGraphs = true;
    // Accept snake_case from MCP clients.
    if (op.expected_hash !== undefined && op.expectedHash === undefined) return { ...op, expectedHash: op.expected_hash } as WorkspaceOp;
    return op as WorkspaceOp;
  });
  return { ops, destructive, touchesGraphs };
}
