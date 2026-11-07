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

describe('workspace MCP tools (cloud)', () => {
  const svc2 = () => new CloudService(kv(), backend(), () => undefined, 'https://site', () => 0);
  type Batch = { workspace_revision: string; changed: { path: string; hash: string | null }[]; created: Record<string, string>; diagnostics?: { errors: number } };

  it('one atomic batch creates folders, files and a new visual script; reads, search and undo work', async () => {
    const cloud = svc2();
    await cloud.handle('create_project', { name: 'Multi' });
    const r = (await cloud.handle('workspace_batch', {
      operations: [
        { op: 'create_dir', path: 'assets' },
        { op: 'write_file', path: 'src/util.ts', content: 'export const add = (a: number, b: number) => a + b;\n' },
        { op: 'write_file', path: 'README.md', content: '# Multi\nuses add()\n', expected_hash: null },
        { op: 'graph', ops: [{ op: 'add_script', ref: 'p', name: 'Player', path: 'actors/player', template: 'character2d' }] },
        { op: 'graph', script: 'actors/player.vgraph', ops: [{ op: 'add_variable', name: 'speed', type: 'float', default: 300 }] },
        { op: 'config', patch: { description: 'made by Claude' } },
      ],
    })) as Batch;
    expect(r.changed.map((c) => c.path).sort()).toEqual(['README.md', 'actors/player.vgraph', 'assets/.gitkeep', 'codingstudio.json', 'src/util.ts']);
    expect(r.diagnostics?.errors).toBe(0);
    const tree = (await cloud.handle('read_tree', {})) as { files: { path: string }[]; folders: string[]; generated: string[]; workspace_revision: string };
    expect(tree.folders).toEqual(['actors', 'assets', 'src']);
    expect(tree.generated).toContain('actors/player.gd');
    expect(tree.workspace_revision).toBe(r.workspace_revision);
    const read = (await cloud.handle('read_files', { paths: ['src/util.ts', 'actors/player.gd', 'nope.txt'] })) as { files: { path: string; text?: string; hash?: string; generated?: boolean; error?: string }[] };
    expect(read.files[0].text).toContain('export const add');
    expect(read.files[1]).toMatchObject({ generated: true });
    expect(read.files[1].text).toContain('var speed: float = 300');
    expect(read.files[2].error).toBe('E_NOT_FOUND');
    const hits = (await cloud.handle('search_files', { query: 'add' })) as { matches: { path: string; line: number }[] };
    expect(hits.matches).toEqual([{ path: 'README.md', line: 2, text: 'uses add()' }, expect.objectContaining({ path: 'src/util.ts', line: 1 })].sort((a, b) => (a.path < b.path ? -1 : 1)));
    // graph tools accept the file path
    expect(((await cloud.handle('list_graphs', {})) as { script: string }[]).length).toBeGreaterThan(0);
    expect(((await cloud.handle('compile_script', { script: 'actors/player.vgraph' })) as { files: { path: string }[] }).files[0].path).toBe('actors/player.gd');
    // the whole batch is one undo step
    await cloud.handle('undo', {});
    const after = (await cloud.handle('read_tree', {})) as { files: { path: string }[] };
    expect(after.files.map((f) => f.path).sort()).toEqual(['codingstudio.json', 'main.vgraph']);
  });

  it('stale expected_hash / revision and invalid ops change nothing', async () => {
    const cloud = svc2();
    await cloud.handle('create_project', { name: 'Stale' });
    const w1 = (await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'a.txt', content: 'one' }] })) as Batch;
    const h1 = w1.changed[0].hash!;
    await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'a.txt', content: 'two', expected_hash: h1 }] });
    await expect(cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'b.txt', content: 'b' }, { op: 'write_file', path: 'a.txt', content: 'three', expected_hash: h1 }] })).rejects.toMatchObject({ code: 'E_REVISION_CONFLICT' });
    await expect(cloud.handle('workspace_batch', { expected_revision: w1.workspace_revision, operations: [{ op: 'write_file', path: 'c.txt', content: 'c' }] })).rejects.toMatchObject({ code: 'E_REVISION_CONFLICT' });
    await expect(cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'd.txt', content: 'd' }, { op: 'delete', path: 'codingstudio.json' }] })).rejects.toMatchObject({ details: { opIndex: 1 } });
    await expect(cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: '../evil', content: 'x' }] })).rejects.toMatchObject({ code: 'E_INVALID_PATH' });
    const tree = (await cloud.handle('read_tree', {})) as { files: { path: string }[] };
    expect(tree.files.map((f) => f.path).sort()).toEqual(['a.txt', 'codingstudio.json', 'main.vgraph']);
    expect(((await cloud.handle('read_files', { paths: ['a.txt'] })) as { files: { text: string }[] }).files[0].text).toBe('two');
    // deleting a folder takes a backup first
    await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'old/x.txt', content: 'x' }] });
    await cloud.handle('workspace_batch', { operations: [{ op: 'delete', path: 'old', recursive: true }] });
    expect(((await cloud.handle('list_backups', {})) as { label: string }[])[0].label).toMatch(/Before Claude file batch/);
  });
});

describe('GitHub through the cloud connector', () => {
  it('token is validated and never returned; clone, edit, commit to a branch, PR, pull', async () => {
    const { FakeGitHub } = await import('../fixtures/fake-github');
    const { GitHubVault } = await import('../../worker/github');
    const fake = new FakeGitHub();
    fake.push('main', { 'README.md': '# Game\n', 'src/app.ts': 'export const a = 1;\n' });
    const store = kv();
    const cloud = new CloudService(store, backend(), () => undefined, 'https://site', () => 0);
    cloud.github = () => new GitHubVault(store, () => fake.fetch);
    await expect(cloud.handle('git_repos', {})).rejects.toMatchObject({ code: 'E_GITHUB_NOT_CONNECTED' });
    const vault = cloud.github();
    await expect(vault.set('nope')).rejects.toMatchObject({ code: 'E_INVALID' });
    expect(await vault.set('github_pat_1234567890abcdefghij')).toEqual({ connected: true, login: 'lyra' });
    expect(JSON.stringify(await vault.status())).not.toContain('github_pat');

    const cl = (await cloud.handle('git_clone', { repository: 'lyra/game' })) as { project: string; linked: boolean; changes: { path: string }[] };
    expect(cl.linked).toBe(true);
    expect(cl.changes.map((c) => c.path)).toEqual(['codingstudio.json']);
    await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'src/app.ts', content: 'export const a = 2;\n' }] });
    const st = (await cloud.handle('git_status', {})) as { changes: { path: string; status: string }[] };
    expect(st.changes).toEqual([{ path: 'codingstudio.json', status: 'added' }, { path: 'src/app.ts', status: 'modified' }]);
    const c = (await cloud.handle('git_commit', { message: 'Claude change', new_branch: 'claude/edit' })) as { branch: string };
    expect(c.branch).toBe('claude/edit');
    expect(fake.files('claude/edit')['src/app.ts']).toBe('export const a = 2;\n');
    expect(fake.files('main')['src/app.ts']).toBe('export const a = 1;\n');
    expect(((await cloud.handle('git_status', {})) as { clean: boolean }).clean).toBe(true);
    const pr = (await cloud.handle('git_create_pr', { title: 'Edit' })) as { number: number };
    expect(fake.pullsList[pr.number - 1]).toMatchObject({ head: 'claude/edit', base: 'main' });
    // someone pushes to the branch; pull brings it in
    fake.push('claude/edit', { 'docs/x.md': 'new' });
    const p = (await cloud.handle('git_pull', {})) as { updated: string[] };
    expect(p.updated).toEqual(['docs/x.md']);
    expect(((await cloud.handle('read_files', { paths: ['docs/x.md'] })) as { files: { text: string }[] }).files[0].text).toBe('new');
    // the editor's proxy passes every method the client uses (merge = PUT, delete = DELETE) on to GitHub
    expect((await vault.proxy('/repos/lyra/game/pulls/999/merge', 'PUT', { merge_method: 'squash' })).status).toBe(404);
    expect((await vault.proxy('/repos/lyra/game/git/refs/heads/nope', 'DELETE', undefined)).status).toBe(204);
    expect((await vault.proxy('/repos/lyra/game', 'TRACE', undefined)).status).toBe(405);
    // merge the PR from the phone, then pull main
    const m = (await cloud.handle('git_pr_merge', { number: pr.number, delete_branch: true })) as { merged: boolean; into: string };
    expect(m).toMatchObject({ merged: true, into: 'main' });
    expect(fake.files('main')['src/app.ts']).toBe('export const a = 2;\n');
    expect(((await cloud.handle('git_pr_list', { state: 'closed' })) as { pull_requests: { state: string }[] }).pull_requests[0].state).toBe('merged');
  });

  it('publishes a new project to a new repository, and repo calls work by name without a project', async () => {
    const { FakeGitHub } = await import('../fixtures/fake-github');
    const { GitHubVault } = await import('../../worker/github');
    const fake = new FakeGitHub('lyra', 'x');
    const store = kv();
    const cloud = new CloudService(store, backend(), () => undefined, 'https://site', () => 0);
    cloud.github = () => new GitHubVault(store, () => fake.fetch);
    await cloud.github().set('github_pat_1234567890abcdefghij');
    await cloud.handle('create_project', { name: 'Phone mod', language: 'typescript', template: 'module' });
    const r = (await cloud.handle('git_publish', { name: 'phone-mod' })) as { repository: string; files: number };
    expect(r.repository).toBe('lyra/phone-mod');
    expect(Object.keys(fake.files('main'))).toEqual(expect.arrayContaining(['README.md', 'codingstudio.json', 'main.vgraph']));
    expect(((await cloud.handle('git_status', {})) as { clean: boolean; repository: string })).toMatchObject({ clean: true, repository: 'lyra/phone-mod' });
    await expect(cloud.handle('git_publish', { name: 'again' })).rejects.toMatchObject({ code: 'E_INVALID' });
    expect(await cloud.handle('git_repo_update', { repository: 'lyra/phone-mod', description: 'Made on a phone' })).toMatchObject({ description: 'Made on a phone' });
    await expect(cloud.handle('git_repo_delete', { repository: 'lyra/phone-mod' })).rejects.toMatchObject({ code: 'E_CONFIRM' });
    expect(await cloud.handle('git_repo_delete', { repository: 'lyra/phone-mod', confirm_name: 'lyra/phone-mod' })).toEqual({ deleted: 'lyra/phone-mod' });
  });
});

describe('CI through the cloud connector', () => {
  it('add a workflow, commit, see a failing run, read the problems, re-run', async () => {
    const { FakeGitHub } = await import('../fixtures/fake-github');
    const { GitHubVault } = await import('../../worker/github');
    const fake = new FakeGitHub();
    fake.push('main', { 'package.json': '{"scripts":{"test":"vitest"}}', 'package-lock.json': '{}', 'src/app.ts': 'export const a = 1;\n' });
    const store = kv();
    const cloud = new CloudService(store, backend(), () => undefined, 'https://site', () => 0);
    cloud.github = () => new GitHubVault(store, () => fake.fetch);
    await cloud.github().set('github_pat_1234567890abcdefghij');
    await cloud.handle('git_clone', { repository: 'lyra/game' });
    const add = (await cloud.handle('ci_add_workflow', { template: 'ci' })) as { added: string[]; files: { content: string }[] };
    expect(add.added).toEqual(['.github/workflows/ci.yml']);
    expect(add.files[0].content).toContain('npm ci');
    await cloud.handle('git_commit', { message: 'Add CI' });
    expect(fake.files('main')['.github/workflows/ci.yml']).toContain('run: npm run test');
    fake.addRun('main', { conclusion: 'failure', log: '2026-01-01T00:00:00.0000000Z src/app.ts(1,14): error TS2322: nope\n##[error]Process completed with exit code 2.' });
    const s = (await cloud.handle('ci_status', {})) as { workflows: { path: string }[]; runs: { id: number; state: string }[] };
    expect(s.workflows.map((w) => w.path)).toEqual(['.github/workflows/ci.yml']);
    expect(s.runs[0].state).toBe('failed');
    const logs = (await cloud.handle('ci_logs', { run_id: s.runs[0].id })) as { jobs: { problems: { file?: string; line?: number }[]; tail: string }[] };
    expect(logs.jobs[0].problems[0]).toMatchObject({ file: 'src/app.ts', line: 1 });
    expect(logs.jobs[0].tail).not.toMatch(/^2026-/);
    await cloud.handle('ci_rerun', { run_id: s.runs[0].id });
    expect(((await cloud.handle('ci_status', {})) as { runs: { state: string }[] }).runs[0].state).toBe('running');
    await cloud.handle('ci_run', {});
    expect(fake.dispatches).toEqual([{ workflow: '.github/workflows/ci.yml', ref: 'main' }]);
  });
});

describe('TypeScript projects through the connector', () => {
  it('Claude creates a TS project, adds an exported async function using fetch, and gets TypeScript', async () => {
    const cloud = new CloudService(kv(), backend(), () => undefined, 'https://site', () => 0);
    await cloud.handle('create_project', { name: 'Web', language: 'typescript', template: 'empty' });
    await cloud.handle('batch_edit', {
      operations: [
        { op: 'add_function', ref: 'f', name: 'load', params: [{ name: 'url', type: 'string' }], returnType: 'any', async: true, exported: true },
        { op: 'add_node', ref: 'fetch', graph: '$f', type: 'ts.call', props: { name: 'fetch', argNames: ['url'], argTypes: ['string'], returnType: 'Response', await: true } },
        { op: 'add_node', ref: 'json', graph: '$f', type: 'ts.call_method', props: { name: 'json', returnType: 'any', await: true } },
        { op: 'add_node', ref: 'ret', graph: '$f', type: 'core.return' },
        { op: 'connect', graph: '$f', from: { node: '$f.entry', port: 'then' }, to: { node: '$fetch', port: 'exec' } },
        { op: 'connect', graph: '$f', from: { node: '$f.entry', port: 'url' }, to: { node: '$fetch', port: 'arg_0' } },
        { op: 'connect', graph: '$f', from: { node: '$fetch', port: 'then' }, to: { node: '$json', port: 'exec' } },
        { op: 'connect', graph: '$f', from: { node: '$fetch', port: 'result' }, to: { node: '$json', port: 'object' } },
        { op: 'connect', graph: '$f', from: { node: '$json', port: 'then' }, to: { node: '$ret', port: 'exec' } },
        { op: 'connect', graph: '$f', from: { node: '$json', port: 'result' }, to: { node: '$ret', port: 'value' } },
      ],
    });
    const r = (await cloud.handle('compile_project', {})) as { ok: boolean; files: { path: string; content: string }[] };
    expect(r.ok).toBe(true);
    expect(r.files[0].path).toBe('main.ts');
    expect(r.files[0].content).toContain('export async function load(url: string): Promise<any> {');
    expect(r.files[0].content).toContain('let fetch_result: Response = await fetch(url);');
    expect(r.files[0].content).toContain('let json_result = await fetch_result.json();');
  });
});

describe('npm dependencies through the connector', () => {
  it('deps_add creates package.json with ^latest, deps_list reports the lockfile, deps_remove removes', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      const url = String(u);
      const body = url.includes('/resolve/npm/dexie@') ? { version: '4.0.11' } : url.includes('/resolve/npm/') ? { version: null } : url.includes('/-/v1/search') ? { objects: [{ package: { name: 'dexie', version: '4.0.11' } }] } : {};
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const cloud = new CloudService(kv(), backend(), () => undefined, 'https://site', () => 0);
      await cloud.handle('create_project', { name: 'Todo App', language: 'typescript', template: 'module' });
      const r = (await cloud.handle('deps_add', { name: 'dexie' })) as { range: string };
      expect(r.range).toBe('^4.0.11');
      const pkg = JSON.parse(((await cloud.handle('read_files', { paths: ['package.json'] })) as { files: { text: string }[] }).files[0].text);
      expect(pkg).toMatchObject({ name: 'todo-app', dependencies: { dexie: '^4.0.11' } });
      await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'package-lock.json', content: JSON.stringify({ packages: { '': { dependencies: { dexie: '^4.0.11' } } } }) }] });
      expect(((await cloud.handle('deps_list', {})) as { lockfile: { status: string } }).lockfile.status).toBe('in-sync');
      await expect(cloud.handle('deps_add', { name: 'nope-not-real' })).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
      await cloud.handle('deps_remove', { name: 'dexie' });
      const l = (await cloud.handle('deps_list', {})) as { dependencies: Record<string, string>; lockfile: { status: string } };
      expect(l.dependencies).toEqual({});
      expect(l.lockfile.status).toBe('out-of-date');
      expect(((await cloud.handle('deps_search', { query: 'dex' })) as { name: string }[])[0].name).toBe('dexie');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('config files through the connector', () => {
  it('read_config / edit_config change only the fields asked for and report schema problems', async () => {
    const cloud = new CloudService(kv(), backend(), () => undefined, 'https://site', () => 0);
    await cloud.handle('create_project', { name: 'Cfg', language: 'typescript', template: 'module' });
    await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'mods.toml', content: '# NeoForge\nmodLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n\n[[mods]]\nmodId="examplemod"\n' }] });
    const r = (await cloud.handle('edit_config', { path: 'mods.toml', edits: [{ op: 'set', path: ['mods', 0, 'displayName'], value: 'Example' }] })) as { problems: unknown[] };
    expect(r.problems).toEqual([]);
    const text = ((await cloud.handle('read_files', { paths: ['mods.toml'] })) as { files: { text: string }[] }).files[0].text;
    expect(text).toBe('# NeoForge\nmodLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n\n[[mods]]\nmodId="examplemod"\ndisplayName = "Example"\n');
    const bad = (await cloud.handle('edit_config', { path: 'mods.toml', edits: [{ op: 'set', path: ['mods', 0, 'modId'], value: 'Bad Id' }] })) as { problems: { field: string }[] };
    expect(bad.problems[0].field).toBe('mods.0.modId');
    expect(await cloud.handle('read_config', { path: 'mods.toml' })).toMatchObject({ kind: 'NeoForge mod', value: { mods: [{ modId: 'Bad Id' }] } });
    await expect(cloud.handle('edit_config', { path: 'x.ts', edits: [{ op: 'set', path: ['a'], value: 1 }] })).rejects.toMatchObject({ code: 'E_INVALID' });
    await cloud.handle('undo', {});
    expect(((await cloud.handle('read_config', { path: 'mods.toml' })) as { value: { mods: { modId: string }[] } }).value.mods[0].modId).toBe('examplemod');
  });
});
