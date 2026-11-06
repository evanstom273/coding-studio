/**
 * Cloud storage (Durable Object SQLite) and the cloud MCP service, run on node:sqlite.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createProject, projectRevision, type Project } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';
import { CONFIG_PATH, deriveProject, makeRecord, projectToWorkspace, workspaceRevision } from '@cs/workspace';
import { CHUNK, CloudStore, diffFiles, type StoreBackend } from '../../worker/cloud-store';
import { CloudService, type KvLike } from '../../worker/cloud-service';

function backend(): StoreBackend {
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

function kv(): KvLike & { map: Map<string, unknown> } {
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

const tc = toolchainFor('gdscript');
const proj = (name = 'Cloud') => createProject(tc.adapter, name, { template: 'node', scriptName: 'Main' });

describe('cloud store', () => {
  it('stores files, reads them back byte-exact (incl. large chunked and binary) and keeps revision = workspaceRevision', () => {
    const s = new CloudStore(backend());
    const ws = projectToWorkspace(proj());
    const big = 'x'.repeat(CHUNK * 2 + 123);
    const bin = new Uint8Array([0, 1, 2, 255, 0, 7]);
    const files = new Map(ws.files);
    files.set('assets/big.txt', makeRecord('assets/big.txt', big, 1));
    files.set('assets/icon.png', makeRecord('assets/icon.png', bin, 1));
    const full = { meta: ws.meta, files };
    const r = s.write(ws.meta.id, diffFiles(new Map(), files));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.revision).toBe(workspaceRevision(full));
    const back = s.read(ws.meta.id)!;
    expect(back.files.get('assets/big.txt')!.text).toBe(big);
    expect([...back.files.get('assets/icon.png')!.data!]).toEqual([...bin]);
    expect(workspaceRevision(back)).toBe(r.revision);
    expect(s.list()[0]).toMatchObject({ id: ws.meta.id, name: 'Cloud', language: 'gdscript' });
    // filtered read loads only what's asked
    expect([...s.read(ws.meta.id, (e) => e.path === CONFIG_PATH)!.files.keys()]).toEqual([CONFIG_PATH]);
  });

  it('refuses writes whose expected hashes are stale, changing nothing', () => {
    const s = new CloudStore(backend());
    const id = 'w1';
    s.write(id, [{ path: 'a.txt', record: makeRecord('a.txt', 'one') }, { path: CONFIG_PATH, record: makeRecord(CONFIG_PATH, '{"name":"W"}') }]);
    const h1 = s.index(id).find((e) => e.path === 'a.txt')!.hash;
    s.write(id, [{ path: 'a.txt', record: makeRecord('a.txt', 'two') }]);
    const r = s.write(id, [{ path: 'a.txt', record: makeRecord('a.txt', 'three') }, { path: 'b.txt', record: makeRecord('b.txt', 'b') }], { expected: { 'a.txt': h1, 'b.txt': null } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.map((c) => c.path)).toEqual(['a.txt']);
    expect(s.readPaths(id, ['a.txt'])[0].text).toBe('two');
    expect(s.index(id).some((e) => e.path === 'b.txt')).toBe(false);
  });

  it('undo/redo are deltas, refuse when the file moved on, and blobs are garbage-collected', () => {
    const b = backend();
    const s = new CloudStore(b);
    const id = 'w2';
    s.write(id, [{ path: CONFIG_PATH, record: makeRecord(CONFIG_PATH, '{"name":"W"}') }, { path: 'a.txt', record: makeRecord('a.txt', 'v1') }]);
    s.write(id, [{ path: 'a.txt', record: makeRecord('a.txt', 'v2') }, { path: 'n.txt', record: makeRecord('n.txt', 'new') }], { history: { label: 'edit', source: 'claude' } });
    const u = s.step(id, 'undo');
    expect(u).toMatchObject({ ok: true, label: 'edit' });
    expect(s.readPaths(id, ['a.txt'])[0].text).toBe('v1');
    expect(s.index(id).some((e) => e.path === 'n.txt')).toBe(false);
    expect(s.step(id, 'redo')).toMatchObject({ ok: true });
    expect(s.readPaths(id, ['a.txt', 'n.txt']).map((f) => f.text)).toEqual(['v2', 'new']);
    // someone else edits a.txt → undo refused
    s.write(id, [{ path: 'a.txt', record: makeRecord('a.txt', 'user') }]);
    expect(s.step(id, 'undo')).toMatchObject({ ok: false, reason: 'conflict', paths: ['a.txt'] });
    // delete → only backup-referenced blobs remain
    s.backup(id, 'keep');
    s.removeWorkspace(id);
    const hashes = b.sql.exec('SELECT DISTINCT hash FROM blobs').toArray().map((r) => String(r.hash));
    const backed = b.sql.exec("SELECT DISTINCT hash FROM snap_files").toArray().map((r) => String(r.hash));
    expect(hashes.sort()).toEqual([...new Set(backed)].sort());
  });

  it('backups hold full content and restore', () => {
    const s = new CloudStore(backend());
    const id = 'w3';
    s.write(id, [{ path: CONFIG_PATH, record: makeRecord(CONFIG_PATH, '{"name":"W"}') }, { path: 'a.txt', record: makeRecord('a.txt', 'v1') }]);
    const snap = s.backup(id, 'b1');
    s.write(id, [{ path: 'a.txt' }]);
    const files = s.backupFiles(id, snap)!;
    expect(files.find((f) => f.path === 'a.txt')!.text).toBe('v1');
    expect(s.steps(id, 'backup')[0]).toMatchObject({ id: snap, label: 'b1' });
  });
});

describe('cloud service (Claude connector)', () => {
  const svc = (k = kv()) => {
    const events: { id: string; paths?: string[] }[] = [];
    return { k, events, cloud: new CloudService(k, backend(), (m) => events.push(m), 'https://site', () => 0) };
  };

  it('migrates schema-1 whole-project entries (and their backups) to per-file storage', async () => {
    const k = kv();
    const p = proj('Old One');
    await k.put(`p:${p.id}`, p);
    await k.put(`bi:${p.id}`, [{ id: 5, at: 1, label: 'old backup', source: 'mcp' }]);
    await k.put(`b:${p.id}:5`, p);
    await k.put(`hi:${p.id}`, { undo: [], redo: [] });
    const { cloud } = svc(k);
    const list = (await cloud.handle('list_projects', {})) as { id: string; name: string }[];
    expect(list).toEqual([expect.objectContaining({ id: p.id, name: 'Old One' })]);
    expect([...k.map.keys()].filter((x) => /^(p|b|bi|hi|h):/.test(x))).toEqual([]);
    const backups = (await cloud.handle('list_backups', { project: p.id })) as { label: string }[];
    expect(backups.map((b) => b.label)).toEqual(['old backup']);
    // compiles identically to the original
    const code = (await cloud.handle('compile_project', { project: p.id })) as { files: Record<string, string> };
    const { compileAll } = await import('@cs/project-service');
    expect(code.files).toEqual(compileAll(p).files);
  });

  it('Claude edits rewrite only the graph file touched, with undo, and non-graph files are untouched', async () => {
    const { cloud, events } = svc();
    const created = (await cloud.handle('create_project', { name: 'Edits', template: 'node' })) as { id: string; scripts: { functions: { id: string; name: string }[] }[] };
    const id = created.id;
    // a non-graph file pushed by the editor
    expect((await cloud.apply(id, { changes: [{ path: 'README.md', base: null, text: '# hi' }] })).ok).toBe(true);
    const ready = created.scripts[0].functions.find((f) => f.name === '_ready')!;
    events.length = 0;
    const r = (await cloud.handle('batch_edit', { operations: [{ op: 'add_node', graph: ready.id, type: 'core.print', ref: 'n' }] })) as { revision: string; created: Record<string, string> };
    expect(r.created.n).toBeTruthy();
    expect(events.at(-1)!.paths).toEqual(['main.vgraph']);
    expect(cloud.store.readPaths(id, ['README.md'])[0].text).toBe('# hi');
    const p1 = (await cloud.handle('get_project', { full: true })) as Project;
    expect(p1.scripts[0].functions.find((f) => f.id === ready.id)!.graph.nodes.some((n) => n.id === r.created.n)).toBe(true);
    expect(projectRevision(p1)).toBe(r.revision);
    await cloud.handle('undo', {});
    const p2 = (await cloud.handle('get_project', { full: true })) as Project;
    expect(p2.scripts[0].functions.find((f) => f.id === ready.id)!.graph.nodes.some((n) => n.id === r.created.n)).toBe(false);
    // duplicate copies every file with fresh graph ids
    const dup = (await cloud.handle('duplicate_project', { project: id, name: 'Copy' })) as { id: string };
    const copy = cloud.store.read(dup.id)!;
    expect(copy.files.get('README.md')!.text).toBe('# hi');
    expect(deriveProject(copy).project.scripts[0].id).not.toBe(p2.scripts[0].id);
  });

  it('editor apply with a stale base is refused with the conflicting paths', async () => {
    const { cloud } = svc();
    const created = (await cloud.handle('create_project', { name: 'C' })) as { id: string };
    const idx = cloud.store.index(created.id);
    const cfg = idx.find((e) => e.path === CONFIG_PATH)!;
    expect((await cloud.apply(created.id, { changes: [{ path: CONFIG_PATH, base: cfg.hash, text: '{"name":"Renamed"}' }] })).ok).toBe(true);
    expect(cloud.list()[0].name).toBe('Renamed');
    const r = await cloud.apply(created.id, { changes: [{ path: CONFIG_PATH, base: cfg.hash, text: '{"name":"Stale"}' }] });
    expect(r).toMatchObject({ ok: false, conflicts: [{ path: CONFIG_PATH }] });
  });

  it('handles a workspace over 10 MB', async () => {
    const { cloud } = svc();
    const created = (await cloud.handle('create_project', { name: 'Huge' })) as { id: string };
    const chunk = 'y'.repeat(512 * 1024);
    const changes = Array.from({ length: 24 }, (_, i) => ({ path: `assets/data${i}.txt`, base: null, text: chunk + i }));
    expect((await cloud.apply(created.id, { changes })).ok).toBe(true);
    expect(cloud.store.size(created.id)).toBeGreaterThan(10 * 1024 * 1024);
    // graph tools load only graph files, so they stay fast
    const t0 = performance.now();
    await cloud.handle('compile_project', {});
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(cloud.store.readPaths(created.id, ['assets/data23.txt'])[0].text).toBe(chunk + 23);
  });
});
