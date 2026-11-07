/** In-memory Durable Object storage (node:sqlite + a Map) for cloud-service tests. */
import { DatabaseSync } from 'node:sqlite';
import type { StoreBackend } from '../../worker/cloud-store';
import type { KvLike } from '../../worker/cloud-service';

export function memoryBackend(): StoreBackend {
  const db = new DatabaseSync(':memory:');
  const norm = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  return {
    sql: {
      exec(q, ...b) {
        const st = db.prepare(q);
        const args = b.map(norm) as never[];
        const rows = /^\s*(SELECT|INSERT[\s\S]*RETURNING)/i.test(q) ? st.all(...args) : (st.run(...args), []);
        return { toArray: () => rows as Record<string, never>[] };
      },
    },
    transaction(fn) {
      db.exec('SAVEPOINT t');
      try {
        const r = fn();
        db.exec('RELEASE t');
        return r;
      } catch (e) {
        db.exec('ROLLBACK TO t');
        db.exec('RELEASE t');
        throw e;
      }
    },
  };
}

export function memoryKv(): KvLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(k: string) {
      return structuredClone(map.get(k)) as T | undefined;
    },
    async put(k, v) {
      map.set(k, structuredClone(v));
    },
    async delete(k) {
      return map.delete(k);
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T]));
    },
  };
}

/**
 * Put files into the open cloud project the way the editor's sync does (as an imported project or
 * a GitHub pull would bring them).
 */
export async function seedFiles(cloud: import('../../worker/cloud-service').CloudService, files: Record<string, string | null>) {
  const st = (await cloud.handle('status', {})) as { openProject: { id: string } | null };
  const id = st.openProject!.id;
  const cur = cloud.store.readPaths(id, Object.keys(files));
  const hash = new Map(cur.map((f) => [f.path, f.hash]));
  const r = await cloud.apply(id, { changes: Object.entries(files).map(([path, text]) => (text === null ? { path, delete: true, base: hash.get(path) ?? null } : { path, text, base: hash.get(path) ?? null })) });
  if (!r.ok) throw new Error(`seedFiles failed: ${JSON.stringify(r)}`);
}
