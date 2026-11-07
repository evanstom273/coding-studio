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

describe('GitHub Actions', () => {
  it('templates follow package.json scripts and lockfiles', async () => {
    const { WORKFLOW_TEMPLATES } = await import('@cs/git');
    const ci = WORKFLOW_TEMPLATES.find((t) => t.id === 'ci')!.build({ packageJson: '{"scripts":{"test":"vitest","build":"vite build"}}', hasLockfile: { npm: true, pnpm: false, yarn: false } });
    expect(ci).toContain('npm ci');
    expect(ci).toContain('run: npm run test');
    expect(ci).toContain('workflow_dispatch');
    expect(ci).not.toContain('typecheck');
    const pn = WORKFLOW_TEMPLATES.find((t) => t.id === 'ci')!.build({ packageJson: '{"scripts":{"lint":"eslint ."}}', hasLockfile: { npm: false, pnpm: true, yarn: false } });
    expect(pn).toContain('pnpm install --frozen-lockfile');
    expect(pn).toContain('run: pnpm lint');
  });

  it('finds problems in logs and links them to workspace files', async () => {
    const { parseLogProblems } = await import('@cs/git');
    const log = [
      '2026-01-01T10:00:00.1234567Z \u001b[36m> tsc --noEmit\u001b[0m',
      '2026-01-01T10:00:01.0000000Z src/app.ts(12,5): error TS2322: Type string is not assignable to type number.',
      '2026-01-01T10:00:02.0000000Z  FAIL  tests/app.test.ts > adds',
      "2026-01-01T10:00:02.0000000Z AssertionError: expected 3 to be 4",
      '2026-01-01T10:00:02.0000000Z  ❯ tests/app.test.ts:7:19',
      '2026-01-01T10:00:03.0000000Z ##[error]Process completed with exit code 1.',
      '2026-01-01T10:00:03.0000000Z node_modules/x/index.js:1:1 Error in dependency',
    ].join('\n');
    const has = (p: string) => ['src/app.ts', 'tests/app.test.ts'].includes(p);
    const ps = parseLogProblems(log, has);
    expect(ps[0]).toMatchObject({ file: 'src/app.ts', line: 12, column: 5, message: 'TS2322: Type string is not assignable to type number.' });
    expect(ps.some((p) => p.file === 'tests/app.test.ts' && p.line === 7)).toBe(true);
    expect(ps.some((p) => p.message === 'Process completed with exit code 1.' && !p.file)).toBe(true);
    expect(ps.some((p) => p.file?.startsWith('node_modules'))).toBe(false);
  });

  it('lists workflows and runs, dispatches, reads jobs and logs, re-runs failed jobs', async () => {
    const fake = new FakeGitHub();
    fake.push('main', { '.github/workflows/ci.yml': 'name: CI' });
    const gh = new GitHub(fake.fetch);
    expect((await gh.workflows('lyra', 'game')).map((w) => w.path)).toEqual(['.github/workflows/ci.yml']);
    await gh.dispatch('lyra', 'game', 100, 'main');
    const [run] = await gh.runs('lyra', 'game', { branch: 'main' });
    expect(run.status).toBe('in_progress');
    fake.finish(run.id, 'failure', 'x\n##[error]boom');
    const jobs = await gh.jobs('lyra', 'game', run.id);
    expect(jobs[0].conclusion).toBe('failure');
    expect(await gh.jobLog('lyra', 'game', jobs[0].id)).toContain('boom');
    await gh.rerun('lyra', 'game', run.id);
    expect((await gh.run('lyra', 'game', run.id)).status).toBe('in_progress');
  });
});

describe('pull requests and repositories', () => {
  it('opens, lists, edits, merges (deleting the branch) and refuses conflicting PRs', async () => {
    const { githubCall } = await import('@cs/project-service');
    const fake = new FakeGitHub();
    fake.push('main', { 'main.gd': 'extends Node\n' });
    fake.push('feature', { 'main.gd': 'extends Node2D\n' });
    const gh = new GitHub(fake.fetch);
    const st = { provider: 'github' as const, owner: 'lyra', repo: 'game', branch: 'feature', commit: fake.refs.get('feature')!, tree: {} };
    await expect(githubCall('git_create_pr', gh, { head: 'main' }, { ...st, branch: 'main' })).rejects.toMatchObject({ code: 'E_INVALID' });
    const pr = (await githubCall('git_create_pr', gh, { title: 'Use Node2D', body: 'why' }, st)) as { number: number; base: string };
    expect(pr).toMatchObject({ number: 1, base: 'main' });
    expect(((await githubCall('git_pr_list', gh, {}, st)) as { pull_requests: unknown[] }).pull_requests).toMatchObject([{ number: 1, title: 'Use Node2D', head: 'feature', base: 'main', state: 'open', mergeable: true }]);
    expect(await githubCall('git_pr_update', gh, { number: 1, title: 'Switch to Node2D' }, st)).toMatchObject({ title: 'Switch to Node2D' });
    expect(await githubCall('git_pr_get', gh, { number: 1 }, st)).toMatchObject({ number: 1, files: [{ path: 'main.gd' }] });
    const merged = (await githubCall('git_pr_merge', gh, { number: 1, method: 'squash', delete_branch: true }, st)) as Record<string, unknown>;
    expect(merged).toMatchObject({ merged: true, into: 'main', deleted_branch: 'feature', method: 'squash' });
    expect(fake.files('main')['main.gd']).toBe('extends Node2D\n');
    expect(fake.refs.has('feature')).toBe(false);
    expect(await githubCall('git_pr_merge', gh, { number: 1 }, st)).toMatchObject({ merged: true, already: true });
    expect(((await githubCall('git_pr_list', gh, { state: 'closed' }, st)) as { pull_requests: { state: string }[] }).pull_requests[0].state).toBe('merged');

    fake.push('other', { 'x.gd': 'x' });
    await githubCall('git_create_pr', gh, { head: 'other' }, st);
    fake.pullsList[1].conflict = true;
    await expect(githubCall('git_pr_merge', gh, { number: 2 }, st)).rejects.toMatchObject({ code: 'E_MERGE_CONFLICT' });
    await githubCall('git_pr_update', gh, { number: 2, state: 'closed' }, st);
    expect(((await githubCall('git_pr_list', gh, {}, st)) as { pull_requests: unknown[] }).pull_requests).toEqual([]);
  });

  it('creates, publishes a project to, renames and deletes repositories', async () => {
    const { githubCall } = await import('@cs/project-service');
    const { createRepoFor, commitAndPush, stateRecord } = await import('@cs/git');
    const { makeRecord } = await import('@cs/workspace');
    const fake = new FakeGitHub('lyra', 'old');
    const gh = new GitHub(fake.fetch);
    expect(await githubCall('git_repo_create', gh, { name: 'bad name!' }, null).catch((e) => e.code)).toBe('E_INVALID');
    // publish: a new repo, linked, every file pushed on top of GitHub's README commit
    const { state } = await createRepoFor(gh, { name: 'my-mod', description: 'A mod' });
    expect(state).toMatchObject({ owner: 'lyra', repo: 'my-mod', branch: 'main', tree: {} });
    const files = new Map([['main.gd', makeRecord('main.gd', 'extends Node\n')], ['.codingstudio/git.json', stateRecord(state)]]);
    const r = await commitAndPush(gh, { meta: { id: 'p', schemaVersion: 2, createdAt: 0, updatedAt: 0 }, files }, 'First commit');
    expect(r.files).toBe(1);
    expect(fake.files('main')).toEqual({ 'README.md': '# my-mod\n', 'main.gd': 'extends Node\n' });
    expect(fake.repoInfo).toMatchObject({ private: true, description: 'A mod' });
    // edit
    const st = r.state;
    expect(await githubCall('git_repo_update', gh, { name: 'better-mod', private: false, description: 'Renamed' }, st)).toMatchObject({ repository: 'lyra/better-mod', private: false, description: 'Renamed' });
    // delete: needs the exact name, and the user's yes when someone can be asked
    const renamed = { ...st, repo: 'better-mod' };
    await expect(githubCall('git_repo_delete', gh, {}, renamed)).rejects.toMatchObject({ code: 'E_CONFIRM' });
    await expect(githubCall('git_repo_delete', gh, { confirm_name: 'lyra/better-mod' }, renamed, async () => false)).rejects.toMatchObject({ code: 'E_DECLINED' });
    expect(fake.repoInfo.deleted).toBe(false);
    expect(await githubCall('git_repo_delete', gh, { confirm_name: 'lyra/better-mod' }, renamed, async () => true)).toEqual({ deleted: 'lyra/better-mod' });
    expect(fake.repoInfo.deleted).toBe(true);
    // any repository by name, without a linked project
    await expect(githubCall('git_pr_list', gh, {}, null)).rejects.toMatchObject({ code: 'E_NOT_LINKED' });
  });
});
