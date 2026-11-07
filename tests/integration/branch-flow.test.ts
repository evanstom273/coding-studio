/** Branches: switch, merge → delete branch → back to main, recovery from a deleted branch. */
import { describe, expect, it } from 'vitest';
import { GitHub, readState, switchBranch, stateRecord, branchExists } from '@cs/git';
import { makeRecord, type Workspace } from '@cs/workspace';
import { CloudService } from '../../worker/cloud-service';
import { GitHubVault } from '../../worker/github';
import { FakeGitHub } from '../fixtures/fake-github';
import { memoryBackend, memoryKv, seedFiles } from '../fixtures/cloud-backend';

async function setup() {
  const fake = new FakeGitHub('lyra', 'x');
  const store = memoryKv();
  const cloud = new CloudService(store, memoryBackend(), () => undefined, 'https://site', () => 0);
  cloud.github = () => new GitHubVault(store, () => fake.fetch);
  await cloud.github().set('github_pat_1234567890abcdefghij');
  return { fake, cloud };
}

describe('switchBranch', () => {
  it("takes the other branch's version of files you haven't changed and keeps the ones you have", async () => {
    const fake = new FakeGitHub();
    const base = fake.push('main', { 'a.txt': 'a1', 'b.txt': 'b1', 'gone.txt': 'g' });
    fake.push('other', { 'a.txt': 'a2', 'b.txt': 'b2', 'gone.txt': null, 'new.txt': 'n' });
    const st = { provider: 'github' as const, owner: 'lyra', repo: 'game', branch: 'main', commit: base, tree: Object.fromEntries(['a.txt', 'b.txt', 'gone.txt'].map((p) => [p, makeRecord(p, { 'a.txt': 'a1', 'b.txt': 'b1', 'gone.txt': 'g' }[p]!).hash])) };
    const ws: Workspace = { meta: { id: 'p', schemaVersion: 2, createdAt: 0, updatedAt: 0 }, files: new Map([['a.txt', makeRecord('a.txt', 'a1')], ['b.txt', makeRecord('b.txt', 'mine')], ['gone.txt', makeRecord('gone.txt', 'g')], ['local.txt', makeRecord('local.txt', 'only here')], ['.codingstudio/git.json', stateRecord(st)]]) };
    const r = await switchBranch(new GitHub(fake.fetch), ws, 'other');
    expect(r.from).toBe('main');
    expect(r.state).toMatchObject({ branch: 'other', commit: fake.refs.get('other') });
    expect(r.updates.get('a.txt')?.text).toBe('a2');
    expect(r.updates.get('new.txt')?.text).toBe('n');
    expect(r.updates.get('gone.txt')).toBeNull();
    expect(r.updates.has('b.txt')).toBe(false); // your change wins
    expect(r.updates.has('local.txt')).toBe(false); // untracked file stays
    expect(r.kept).toEqual(['b.txt']);
    await expect(switchBranch(new GitHub(fake.fetch), ws, 'nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(await branchExists(new GitHub(fake.fetch), { ...st, branch: 'other' })).toBe(true);
    expect(await branchExists(new GitHub(fake.fetch), { ...st, branch: 'deleted' })).toBe(false);
    void readState;
  });
});

describe('merge → delete branch → back to main → deploy', () => {
  it('through the connector: the project follows the merge to main, and commit / pull / workflow runs use main', async () => {
    const { fake, cloud } = await setup();
    await cloud.handle('create_project', { name: 'Neon', language: 'typescript', template: 'web-app' });
    await cloud.handle('git_publish', { name: 'neon' });
    await cloud.handle('ci_add_workflow', { template: 'cloudflare' });
    await cloud.handle('git_commit', { message: 'Deploy workflow' });
    // work on a feature branch
    await seedFiles(cloud, { 'src/survivor.ts': 'export const hp = 3;\n' });
    await cloud.handle('git_commit', { message: 'Neon survivor', new_branch: 'feature/neon-survivor' });
    expect(((await cloud.handle('git_branches', {})) as { current: string }).current).toBe('feature/neon-survivor');
    const pr = (await cloud.handle('git_create_pr', { title: 'Neon survivor' })) as { number: number };
    // an uncommitted change made meanwhile must survive the switch
    await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'notes.md', content: 'todo\n' }] });
    const m = (await cloud.handle('git_pr_merge', { number: pr.number, delete_branch: true })) as { merged: boolean; deleted_branch: string; switched_project_to: { branch: string; commit: string } };
    expect(m).toMatchObject({ merged: true, deleted_branch: 'feature/neon-survivor', switched_project_to: { branch: 'main', commit: fake.refs.get('main') } });
    expect(fake.refs.has('feature/neon-survivor')).toBe(false);
    const status = (await cloud.handle('git_status', {})) as { branch: string; commit: string; changes: { path: string }[] };
    expect(status).toMatchObject({ branch: 'main', commit: fake.refs.get('main') });
    expect(status.changes.map((c) => c.path)).toEqual(['notes.md']); // kept, and nothing else differs
    expect(((await cloud.handle('read_files', { paths: ['src/survivor.ts'] })) as { files: { text: string }[] }).files[0].text).toBe('export const hp = 3;\n');
    // commit goes to main (fast-forward from the merge commit)
    await cloud.handle('git_commit', { message: 'Notes' });
    expect(fake.files('main')['notes.md']).toBe('todo\n');
    // pull uses main
    fake.push('main', { 'README.md': 'from GitHub\n' });
    expect(((await cloud.handle('git_pull', {})) as { branch: string; updated: string[] })).toMatchObject({ branch: 'main', updated: ['README.md'] });
    // running the deploy workflow by hand runs it on main
    await cloud.handle('ci_run', { workflow: 'deploy.yml' });
    expect(fake.dispatches.at(-1)).toEqual({ workflow: '.github/workflows/deploy.yml', ref: 'main' });
    // explicit switching works too
    fake.refs.set('release', fake.refs.get('main')!);
    fake.push('release', { 'x.txt': 'x' });
    expect(await cloud.handle('git_switch_branch', { branch: 'release' })).toMatchObject({ from: 'main', branch: 'release', updated: ['x.txt'] });
  });
});
