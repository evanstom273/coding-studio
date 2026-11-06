/**
 * File-level undo history. Each entry records, per changed path, the record before and after
 * (records are immutable and shared with snapshots, so this costs only the changed files).
 * Undo/redo apply the inverse only if the files still match — so undoing never overwrites
 * changes that arrived from elsewhere (sync, Claude in the cloud, another tab).
 */
import type { FileRecord, Workspace } from './model';

export interface FileChange {
  path: string;
  before: FileRecord | null;
  after: FileRecord | null;
}

export interface HistoryEntry {
  label: string;
  source: 'user' | 'mcp' | 'system';
  mergeKey?: string;
  time: number;
  changes: FileChange[];
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const HISTORY_LIMIT = 300;
export const MERGE_WINDOW_MS = 1000;

export const emptyHistory = (): History => ({ past: [], future: [] });

export function diffWorkspaces(before: Workspace, after: Workspace, paths?: Iterable<string>): FileChange[] {
  const keys = paths ? new Set(paths) : new Set([...before.files.keys(), ...after.files.keys()]);
  const out: FileChange[] = [];
  for (const path of [...keys].sort()) {
    const b = before.files.get(path) ?? null;
    const a = after.files.get(path) ?? null;
    if (b === a || (b && a && b.hash === a.hash && b.kind === a.kind)) continue;
    out.push({ path, before: b, after: a });
  }
  return out;
}

export function pushHistory(h: History, e: Omit<HistoryEntry, 'time'>, now = Date.now()): History {
  if (!e.changes.length) return h;
  const last = h.past[h.past.length - 1];
  if (e.mergeKey && last?.mergeKey === e.mergeKey && now - last.time < MERGE_WINDOW_MS) {
    const byPath = new Map(last.changes.map((c) => [c.path, { ...c }]));
    for (const c of e.changes) {
      const prev = byPath.get(c.path);
      if (prev) prev.after = c.after;
      else byPath.set(c.path, c);
    }
    const merged = [...byPath.values()].filter((c) => c.before?.hash !== c.after?.hash);
    const past = merged.length ? [...h.past.slice(0, -1), { ...last, changes: merged, time: now }] : h.past.slice(0, -1);
    return { past, future: [] };
  }
  const past = [...h.past, { ...e, time: now }];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [] };
}

export class HistoryConflict extends Error {}

function apply(ws: Workspace, changes: FileChange[], dir: 'undo' | 'redo', now: number): Workspace {
  const files = new Map(ws.files);
  for (const c of changes) {
    const expect = dir === 'undo' ? c.after : c.before;
    const target = dir === 'undo' ? c.before : c.after;
    if ((files.get(c.path)?.hash ?? null) !== (expect?.hash ?? null)) throw new HistoryConflict(`${c.path} has changed since this step`);
    if (target) files.set(c.path, target);
    else files.delete(c.path);
  }
  return { meta: { ...ws.meta, updatedAt: now }, files };
}

export function undoHistory(h: History, ws: Workspace, now = Date.now()): { history: History; workspace: Workspace; entry: HistoryEntry } | null {
  const entry = h.past[h.past.length - 1];
  if (!entry) return null;
  return { history: { past: h.past.slice(0, -1), future: [entry, ...h.future] }, workspace: apply(ws, entry.changes, 'undo', now), entry };
}

export function redoHistory(h: History, ws: Workspace, now = Date.now()): { history: History; workspace: Workspace; entry: HistoryEntry } | null {
  const entry = h.future[0];
  if (!entry) return null;
  return { history: { past: [...h.past, { ...entry, mergeKey: undefined }], future: h.future.slice(1) }, workspace: apply(ws, entry.changes, 'redo', now), entry };
}
