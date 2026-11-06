import { describe, expect, it } from 'vitest';
import { commitAndPush, GitHub, merge3, pull, readState, status, cloneFiles, GIT_STATE_PATH, stateRecord } from '@cs/git';
import { applyWorkspaceOps, CONFIG_PATH, defaultConfig, makeRecord, serializeConfig, type FileRecord, type Workspace } from '@cs/workspace';
import { FakeGitHub } from '../fixtures/fake-github';

describe('three-way merge', () => {
  it('combines non-overlapping edits and marks overlapping ones', () => {
    const base = 'a\nb\nc\nd\ne';
    expect(merge3(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')).toEqual({ text: 'A\nb\nc\nd\nE', conflicts: 0 });
    expect(merge3(base, 'a\nb\nX\nd\ne', 'a\nb\nY\nd\ne')).toEqual({ text: 'a\nb\n<<<<<<< yours\nX\n=======\nY\n>>>>>>> GitHub\nd\ne', conflicts: 1 });
    expect(merge3(base, 'a\nb\nX\nd\ne', 'a\nb\nX\nd\ne').conflicts).toBe(0);
    expect(merge3(base, 'a\nnew1\nb\nc\nd\ne', 'a\nb\nc\nd\ne\nnew2')).toEqual({ text: 'a\nnew1\nb\nc\nd\ne\nnew2', conflicts: 0 });
    expect(merge3(base, 'b\nc\nd\ne', 'a\nb\nc\nd')).toEqual({ text: 'b\nc\nd', conflicts: 0 });
  });
});

function wsFrom(files: FileRecord[]): Workspace {
  const m = new Map(files.map((f) => [f.path, f]));
  if (!m.has(CONFIG_PATH)) m.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(defaultConfig('game'))));
  return { meta: { id: 'w', schemaVersion: 2, createdAt: 0, updatedAt: 0 }, files: m };
}
const edit = (ws: Workspace, ops: Parameters<typeof applyWorkspaceOps>[1]) => applyWorkspaceOps(ws, ops).workspace;
function applyPull(ws: Workspace, r: Awaited<ReturnType<typeof pull>>): Workspace {
  const files = new Map(ws.files);
  for (const [p, f] of r.updates) {
    if (f) files.set(p, f);
    else files.delete(p);
  }
  files.set(GIT_STATE_PATH, stateRecord(r.state));
  return { meta: ws.meta, files };
}

describe('GitHub sync', () => {
  it('clone → edit → status → commit/push → remote change → pull with merge → PR on a new branch', async () => {
    const fake = new FakeGitHub();
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
    fake.push('main', { 'README.md': '# Game\nline2\nline3\n', 'src/app.ts': 'export const a = 1;\n', 'img/logo.png': png });
    const gh = new GitHub(fake.fetch);
    const c = await cloneFiles(gh, 'lyra', 'game', undefined);
    expect(c.state.branch).toBe('main');
    let ws = wsFrom(c.files);
    expect(ws.files.get('img/logo.png')!.kind).toBe('binary');
    const st0 = readState(ws)!;
    // codingstudio.json was added locally (not in the repo)
    expect(status(ws, st0)).toEqual([{ path: CONFIG_PATH, status: 'added' }]);

    ws = edit(ws, [{ op: 'write_file', path: 'src/app.ts', content: 'export const a = 2;\n' }, { op: 'write_file', path: 'src/new.ts', content: 'x' }, { op: 'delete', path: 'img/logo.png' }]);
    expect(status(ws, readState(ws)!).map((x) => `${x.status}:${x.path}`)).toEqual([`added:${CONFIG_PATH}`, 'deleted:img/logo.png', 'modified:src/app.ts', 'added:src/new.ts']);
    const r1 = await commitAndPush(gh, ws, 'Edit app');
    ws = edit(ws, [{ op: 'write_file', path: GIT_STATE_PATH, content: stateRecord(r1.state).text! }]);
    expect(status(ws, readState(ws)!)).toEqual([]);
    expect(fake.files('main')['src/app.ts']).toBe('export const a = 2;\n');
    expect(fake.files('main')['img/logo.png']).toBeUndefined();

    // someone else pushes; we edit the same file in a different place, and another file on both sides
    fake.push('main', { 'README.md': '# Game\nline2\nline3 (remote)\n', 'src/app.ts': 'export const a = 2;\n// remote\n', 'docs/new.md': 'hi' });
    ws = edit(ws, [{ op: 'write_file', path: 'README.md', content: '# Game (local)\nline2\nline3\n' }, { op: 'write_file', path: 'src/app.ts', content: 'export const a = 3;\n' }]);
    await expect(commitAndPush(gh, ws, 'too early')).rejects.toMatchObject({ code: 'E_NOT_FAST_FORWARD' });
    const p = await pull(gh, ws);
    expect(p.merged).toEqual(['README.md']);
    ws = applyPull(ws, p);
    expect(ws.files.get('README.md')!.text).toBe('# Game (local)\nline2\nline3 (remote)\n');
    expect(ws.files.get('docs/new.md')!.text).toBe('hi');
    // app.ts: adjacent edits on both sides conflict (as in git) → markers to resolve
    expect(p.conflicts).toEqual([{ path: 'src/app.ts', kind: 'text' }]);
    expect(ws.files.get('src/app.ts')!.text).toBe('<<<<<<< yours\nexport const a = 3;\n=======\nexport const a = 2;\n// remote\n>>>>>>> GitHub\n');
    ws = edit(ws, [{ op: 'write_file', path: 'src/app.ts', content: 'export const a = 3;\n// remote\n' }]);

    // commit to a new branch and open a PR
    const r2 = await commitAndPush(gh, ws, 'Merge + local edits', { newBranch: 'feature/x' });
    expect(r2.branch).toBe('feature/x');
    expect(fake.refs.get('main')).not.toBe(r2.commit);
    expect(fake.files('feature/x')['README.md']).toBe('# Game (local)\nline2\nline3 (remote)\n');
    const pr = await gh.createPull('lyra', 'game', { title: 'X', head: 'feature/x', base: 'main' });
    expect(pr.number).toBe(1);
  });

  it('graph files changed on both sides are reported as conflicts and keep the local version', async () => {
    const fake = new FakeGitHub();
    fake.push('main', { 'main.vgraph': '{"v":1}\n' });
    const gh = new GitHub(fake.fetch);
    let ws = wsFrom((await cloneFiles(gh, 'lyra', 'game', 'main')).files);
    fake.push('main', { 'main.vgraph': '{"v":"remote"}\n' });
    const files = new Map(ws.files);
    files.set('main.vgraph', makeRecord('main.vgraph', '{"v":"local"}\n', 1, 'graph'));
    ws = { meta: ws.meta, files };
    const p = await pull(gh, ws);
    expect(p.conflicts).toEqual([{ path: 'main.vgraph', kind: 'graph' }]);
    expect(p.updates.has('main.vgraph')).toBe(false);
  });
});
