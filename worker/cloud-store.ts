/**
 * Per-file workspace storage for the Durable Object (SQLite).
 *
 *   workspaces  one row per project (name/language cached from codingstudio.json)
 *   files       one row per file: path, kind, git blob hash, size, mtime
 *   blobs       content by hash (chunked, so files of any size fit SQLite's row limit);
 *               shared between files, history and backups, garbage-collected when unused
 *   snaps       undo/redo steps (deltas: only the paths a step changed) and backups (full index)
 *   snap_files  the file rows of each snap
 *
 * Plain SQL behind a tiny interface, so tests run it on node:sqlite. No Workers types here.
 */
import { CONFIG_PATH, gitBlobHash, makeRecord, parseConfig, type FileKind, type FileRecord, type Workspace } from '@cs/workspace';

type Value = ArrayBuffer | Uint8Array | string | number | null;
export interface SqlLike {
  exec(query: string, ...bindings: Value[]): { toArray(): Record<string, Value>[] };
}
export interface StoreBackend {
  sql: SqlLike;
  /** Runs fn atomically (DO: storage.transactionSync). */
  transaction<T>(fn: () => T): T;
}

export const CHUNK = 1024 * 1024;
const HISTORY_LIMIT = 50;
const BACKUP_LIMIT = 30;

export interface IndexEntry {
  path: string;
  kind: FileKind;
  hash: string;
  size: number;
  mtime: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  language: string;
  createdAt: number;
  updatedAt: number;
  revision: string;
}

export interface SnapInfo {
  id: number;
  kind: 'undo' | 'redo' | 'backup';
  label: string;
  source: string;
  at: number;
}

/** A change to one path: new content, or deletion (content undefined). */
export interface FileChange {
  path: string;
  record?: FileRecord;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (v: Value): Uint8Array => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : enc.encode(String(v ?? '')));
const toBuffer = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Revision of a workspace from its index (same as workspaceRevision on the full snapshot). */
export function indexRevision(index: { path: string; hash: string }[]): string {
  return gitBlobHash(index.map((f) => `${f.path}\0${f.hash}`).sort().join('\n'));
}

export class CloudStore {
  constructor(private readonly db: StoreBackend) {
    const q = (s: string) => db.sql.exec(s);
    q(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, revision TEXT NOT NULL)`);
    q(`CREATE TABLE IF NOT EXISTS files (ws TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, PRIMARY KEY (ws, path))`);
    q(`CREATE INDEX IF NOT EXISTS files_hash ON files (hash)`);
    q(`CREATE TABLE IF NOT EXISTS blobs (hash TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (hash, n))`);
    q(`CREATE TABLE IF NOT EXISTS snaps (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)`);
    q(`CREATE INDEX IF NOT EXISTS snaps_ws ON snaps (ws, kind, id)`);
    // before_*: state before the step (NULL hash = file absent). after_hash: state after it.
    q(`CREATE TABLE IF NOT EXISTS snap_files (snap INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT, hash TEXT, size INTEGER, mtime INTEGER, after_hash TEXT, PRIMARY KEY (snap, path))`);
    q(`CREATE INDEX IF NOT EXISTS snap_files_hash ON snap_files (hash)`);
  }

  private rows(query: string, ...b: Value[]) {
    return this.db.sql.exec(query, ...b).toArray();
  }

  // --- workspaces ------------------------------------------------------------------------------

  list(): WorkspaceRow[] {
    return this.rows(`SELECT id, name, language, created, updated, revision FROM workspaces ORDER BY updated DESC`).map((r) => ({ id: String(r.id), name: String(r.name), language: String(r.language), createdAt: Number(r.created), updatedAt: Number(r.updated), revision: String(r.revision) }));
  }

  get(id: string): WorkspaceRow | undefined {
    return this.list().find((w) => w.id === id);
  }

  index(id: string): IndexEntry[] {
    return this.rows(`SELECT path, kind, hash, size, mtime FROM files WHERE ws = ? ORDER BY path`, id).map((r) => ({ path: String(r.path), kind: String(r.kind) as FileKind, hash: String(r.hash), size: Number(r.size), mtime: Number(r.mtime) }));
  }

  // --- blobs -----------------------------------------------------------------------------------

  private putBlob(hash: string, content: Uint8Array) {
    if (this.rows(`SELECT 1 FROM blobs WHERE hash = ? AND n = 0`, hash).length) return;
    if (content.length === 0) {
      this.db.sql.exec(`INSERT INTO blobs (hash, n, data) VALUES (?, 0, '')`, hash);
      return;
    }
    for (let i = 0, n = 0; i < content.length; i += CHUNK, n++) this.db.sql.exec(`INSERT INTO blobs (hash, n, data) VALUES (?, ?, ?)`, hash, n, toBuffer(content.subarray(i, i + CHUNK)));
  }

  private getBlob(hash: string): Uint8Array | undefined {
    const parts = this.rows(`SELECT data FROM blobs WHERE hash = ? ORDER BY n`, hash).map((r) => bytes(r.data));
    if (!parts.length) return undefined;
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  private record(e: IndexEntry): FileRecord {
    const data = this.getBlob(e.hash) ?? new Uint8Array(0);
    if (e.kind === 'binary') return { path: e.path, kind: 'binary', data, hash: e.hash, size: e.size, mtime: e.mtime };
    return { path: e.path, kind: e.kind, text: dec.decode(data), hash: e.hash, size: e.size, mtime: e.mtime };
  }

  /** Read files with content. `filter` limits which paths are loaded (e.g. graph files only). */
  read(id: string, filter?: (e: IndexEntry) => boolean): Workspace | undefined {
    const w = this.get(id);
    if (!w) return undefined;
    const files = new Map<string, FileRecord>();
    for (const e of this.index(id)) if (!filter || filter(e)) files.set(e.path, this.record(e));
    return { meta: { id, schemaVersion: 2, createdAt: w.createdAt, updatedAt: w.updatedAt }, files };
  }

  readPaths(id: string, paths: string[]): FileRecord[] {
    const want = new Set(paths);
    return this.index(id)
      .filter((e) => want.has(e.path))
      .map((e) => this.record(e));
  }

  // --- writes ----------------------------------------------------------------------------------

  /**
   * Apply changes atomically. With `expected` (path → hash, null = must not exist) the write is
   * refused, changing nothing, if any listed path differs; the conflicting paths are returned.
   */
  write(id: string, changes: FileChange[], opts: { createdAt?: number; expected?: Record<string, string | null>; history?: { label: string; source: string } } = {}): { ok: true; revision: string; changed: string[] } | { ok: false; conflicts: { path: string; current: string | null }[] } {
    return this.db.transaction(() => {
      const now = Date.now();
      const current = new Map(this.index(id).map((e) => [e.path, e]));
      if (opts.expected) {
        const conflicts = Object.entries(opts.expected)
          .filter(([p, h]) => (current.get(p)?.hash ?? null) !== h)
          .map(([path]) => ({ path, current: current.get(path)?.hash ?? null }));
        if (conflicts.length) return { ok: false as const, conflicts };
      }
      const changed: { path: string; before?: IndexEntry; after?: IndexEntry }[] = [];
      for (const c of changes) {
        const before = current.get(c.path);
        if (!c.record) {
          if (!before) continue;
          this.db.sql.exec(`DELETE FROM files WHERE ws = ? AND path = ?`, id, c.path);
          current.delete(c.path);
          changed.push({ path: c.path, before });
          continue;
        }
        const r = c.record;
        if (before?.hash === r.hash && before.kind === r.kind) continue;
        this.putBlob(r.hash, r.data ?? enc.encode(r.text ?? ''));
        const after: IndexEntry = { path: r.path, kind: r.kind, hash: r.hash, size: r.size, mtime: r.mtime || now };
        this.db.sql.exec(`INSERT OR REPLACE INTO files (ws, path, kind, hash, size, mtime) VALUES (?, ?, ?, ?, ?, ?)`, id, after.path, after.kind, after.hash, after.size, after.mtime);
        current.set(r.path, after);
        changed.push({ path: r.path, before, after });
      }
      const index = [...current.values()];
      const revision = indexRevision(index);
      const existing = this.get(id);
      if (!changed.length && existing) return { ok: true as const, revision, changed: [] };
      const cfg = this.configOf(id, changes);
      if (existing) this.db.sql.exec(`UPDATE workspaces SET name = ?, language = ?, updated = ?, revision = ? WHERE id = ?`, cfg.name, cfg.language, now, revision, id);
      else this.db.sql.exec(`INSERT INTO workspaces (id, name, language, created, updated, revision) VALUES (?, ?, ?, ?, ?, ?)`, id, cfg.name, cfg.language, opts.createdAt ?? now, now, revision);
      if (opts.history && changed.length) {
        this.pushStep(id, 'undo', opts.history.label, opts.history.source, changed);
        this.clearRedo(id);
      }
      return { ok: true as const, revision, changed: changed.map((c) => c.path) };
    });
  }

  private configOf(id: string, changes: FileChange[]) {
    const fromChange = changes.find((c) => c.path === CONFIG_PATH)?.record?.text;
    const text = fromChange ?? this.readPaths(id, [CONFIG_PATH])[0]?.text;
    return parseConfig(text, 'Untitled');
  }

  removeWorkspace(id: string) {
    this.db.transaction(() => {
      this.db.sql.exec(`DELETE FROM files WHERE ws = ?`, id);
      this.db.sql.exec(`DELETE FROM workspaces WHERE id = ?`, id);
      this.db.sql.exec(`DELETE FROM snap_files WHERE snap IN (SELECT id FROM snaps WHERE ws = ? AND kind != 'backup')`, id);
      this.db.sql.exec(`DELETE FROM snaps WHERE ws = ? AND kind != 'backup'`, id);
      this.gc();
    });
  }

  /** Delete blobs nothing refers to any more. */
  gc() {
    this.db.sql.exec(`DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM files) AND hash NOT IN (SELECT hash FROM snap_files WHERE hash IS NOT NULL) AND hash NOT IN (SELECT after_hash FROM snap_files WHERE after_hash IS NOT NULL)`);
  }

  // --- undo / redo (deltas) ------------------------------------------------------------------------

  private pushStep(id: string, kind: 'undo' | 'redo', label: string, source: string, changed: { path: string; before?: IndexEntry; after?: IndexEntry }[]) {
    const snap = Number(this.rows(`INSERT INTO snaps (ws, kind, label, source, at) VALUES (?, ?, ?, ?, ?) RETURNING id`, id, kind, label, source, Date.now())[0].id);
    for (const c of changed) this.db.sql.exec(`INSERT INTO snap_files (snap, path, kind, hash, size, mtime, after_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`, snap, c.path, c.before?.kind ?? null, c.before?.hash ?? null, c.before?.size ?? null, c.before?.mtime ?? null, c.after?.hash ?? null);
    const old = this.rows(`SELECT id FROM snaps WHERE ws = ? AND kind = ? ORDER BY id DESC LIMIT -1 OFFSET ?`, id, kind, HISTORY_LIMIT).map((r) => Number(r.id));
    this.dropSnaps(old);
  }

  private clearRedo(id: string) {
    this.dropSnaps(this.rows(`SELECT id FROM snaps WHERE ws = ? AND kind = 'redo'`, id).map((r) => Number(r.id)));
  }

  private dropSnaps(ids: number[]) {
    if (!ids.length) return;
    for (const s of ids) {
      this.db.sql.exec(`DELETE FROM snap_files WHERE snap = ?`, s);
      this.db.sql.exec(`DELETE FROM snaps WHERE id = ?`, s);
    }
    this.gc();
  }

  steps(id: string, kind: 'undo' | 'redo' | 'backup'): SnapInfo[] {
    return this.rows(`SELECT id, kind, label, source, at FROM snaps WHERE ws = ? AND kind = ? ORDER BY id DESC`, id, kind).map((r) => ({ id: Number(r.id), kind: String(r.kind) as SnapInfo['kind'], label: String(r.label), source: String(r.source), at: Number(r.at) }));
  }

  /**
   * Undo (or redo) the newest step. Refused with `conflict` if any path it touched has changed
   * since (someone else edited it), so it never throws away other work.
   */
  step(id: string, kind: 'undo' | 'redo'): { ok: true; label: string; revision: string; changed: string[] } | { ok: false; reason: 'empty' | 'conflict'; paths?: string[] } {
    return this.db.transaction(() => {
      const s = this.steps(id, kind)[0];
      if (!s) return { ok: false as const, reason: 'empty' as const };
      const rows = this.rows(`SELECT path, kind, hash, size, mtime, after_hash FROM snap_files WHERE snap = ?`, s.id);
      const current = new Map(this.index(id).map((e) => [e.path, e]));
      const moved = rows.filter((r) => (current.get(String(r.path))?.hash ?? null) !== (r.after_hash === null ? null : String(r.after_hash))).map((r) => String(r.path));
      if (moved.length) return { ok: false as const, reason: 'conflict' as const, paths: moved };
      const changed: { path: string; before?: IndexEntry; after?: IndexEntry }[] = [];
      const now = Date.now();
      for (const r of rows) {
        const path = String(r.path);
        const before = current.get(path);
        if (r.hash === null) {
          this.db.sql.exec(`DELETE FROM files WHERE ws = ? AND path = ?`, id, path);
          current.delete(path);
          changed.push({ path, before });
        } else {
          const after: IndexEntry = { path, kind: String(r.kind) as FileKind, hash: String(r.hash), size: Number(r.size), mtime: now };
          this.db.sql.exec(`INSERT OR REPLACE INTO files (ws, path, kind, hash, size, mtime) VALUES (?, ?, ?, ?, ?, ?)`, id, path, after.kind, after.hash, after.size, after.mtime);
          current.set(path, after);
          changed.push({ path, before, after });
        }
      }
      // Push the inverse step before dropping this one, so the blobs it refers to survive gc.
      this.pushStep(id, kind === 'undo' ? 'redo' : 'undo', s.label, s.source, changed);
      this.dropSnaps([s.id]);
      const revision = indexRevision([...current.values()]);
      const cfg = this.configOf(id, []);
      this.db.sql.exec(`UPDATE workspaces SET name = ?, language = ?, updated = ?, revision = ? WHERE id = ?`, cfg.name, cfg.language, now, revision, id);
      return { ok: true as const, label: s.label, revision, changed: changed.map((c) => c.path) };
    });
  }

  // --- backups (full index; content is shared, so they're cheap) --------------------------------------

  backup(id: string, label: string, source = 'mcp'): number {
    return this.db.transaction(() => {
      const snap = Number(this.rows(`INSERT INTO snaps (ws, kind, label, source, at) VALUES (?, 'backup', ?, ?, ?) RETURNING id`, id, label, source, Date.now())[0].id);
      this.db.sql.exec(`INSERT INTO snap_files (snap, path, kind, hash, size, mtime, after_hash) SELECT ?, path, kind, hash, size, mtime, NULL FROM files WHERE ws = ?`, snap, id);
      const old = this.rows(`SELECT id FROM snaps WHERE ws = ? AND kind = 'backup' ORDER BY id DESC LIMIT -1 OFFSET ?`, id, BACKUP_LIMIT).map((r) => Number(r.id));
      this.dropSnaps(old);
      return snap;
    });
  }

  /** A backup's files (with content). */
  backupFiles(id: string, snap: number): FileRecord[] | undefined {
    if (!this.rows(`SELECT 1 FROM snaps WHERE id = ? AND ws = ? AND kind = 'backup'`, snap, id).length) return undefined;
    return this.rows(`SELECT path, kind, hash, size, mtime FROM snap_files WHERE snap = ?`, snap).map((r) => this.record({ path: String(r.path), kind: String(r.kind) as FileKind, hash: String(r.hash), size: Number(r.size), mtime: Number(r.mtime) }));
  }

  /** Store a backup made of explicit records (used when migrating old backups). */
  importBackup(id: string, label: string, source: string, at: number, files: FileRecord[]) {
    this.db.transaction(() => {
      const snap = Number(this.rows(`INSERT INTO snaps (ws, kind, label, source, at) VALUES (?, 'backup', ?, ?, ?) RETURNING id`, id, label, source, at)[0].id);
      for (const f of files) {
        this.putBlob(f.hash, f.data ?? enc.encode(f.text ?? ''));
        this.db.sql.exec(`INSERT OR REPLACE INTO snap_files (snap, path, kind, hash, size, mtime, after_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)`, snap, f.path, f.kind, f.hash, f.size, f.mtime);
      }
    });
  }

  /** Total stored size of a workspace's current files. */
  size(id: string): number {
    return Number(this.rows(`SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE ws = ?`, id)[0].s);
  }
}

/** Build the change list that turns `before` into `after` (records are compared by hash). */
export function diffFiles(before: ReadonlyMap<string, FileRecord>, after: ReadonlyMap<string, FileRecord>, only?: Iterable<string>): FileChange[] {
  const paths = only ? new Set(only) : new Set([...before.keys(), ...after.keys()]);
  const out: FileChange[] = [];
  for (const p of paths) {
    const a = before.get(p);
    const b = after.get(p);
    if (a?.hash === b?.hash && a?.kind === b?.kind) continue;
    out.push(b ? { path: p, record: b } : { path: p });
  }
  return out;
}

export { makeRecord };
