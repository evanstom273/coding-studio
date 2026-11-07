/**
 * The StoryEngine wipe: a repository cloned into a project that only partly loaded (an upload to
 * the cloud stopped after 162 of 1,054 files) showed every missing file as deleted, the cloud
 * sync then deleted them from the full copy too, and a commit deleted them from GitHub.
 */
import { describe, expect, it } from 'vitest';
import { cloneFiles, commitAndPush, GitHub, readState, status } from '@cs/git';
import { CONFIG_PATH, detectedConfig, makeRecord, serializeConfig, type Workspace } from '@cs/workspace';
import { planSync } from '../../apps/web/src/sync/plan';
import { FakeGitHub } from '../fixtures/fake-github';

const repoFiles = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/file${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));

describe('a project that did not load completely', () => {
  it('cannot be committed: mass deletions need the exact number confirmed', async () => {
    const fake = new FakeGitHub();
    fake.push('main', repoFiles(60));
    const gh = new GitHub(fake.fetch);
    const c = await cloneFiles(gh, 'lyra', 'game', undefined);
    // Only the git state and the first 12 files arrived.
    const partial = new Map(c.files.filter((f) => f.path.startsWith('.codingstudio/') || f.path < 'src/file012').map((f) => [f.path, f]));
    const ws: Workspace = { meta: { id: 'w', schemaVersion: 2, createdAt: 0, updatedAt: 0 }, files: partial };
    expect(status(ws, readState(ws)!).filter((x) => x.status === 'deleted')).toHaveLength(48);
    await expect(commitAndPush(gh, ws, 'main')).rejects.toMatchObject({ code: 'E_MASS_DELETE', deletions: 48 });
    await expect(commitAndPush(gh, ws, 'main', { confirmDeletions: 47 })).rejects.toMatchObject({ code: 'E_MASS_DELETE' });
    expect(Object.keys(fake.files('main'))).toHaveLength(60); // GitHub untouched
    // Deleting a few files on purpose still just works.
    const few = new Map(c.files.map((f) => [f.path, f]));
    for (const p of ['src/file000.ts', 'src/file001.ts', 'src/file002.ts']) few.delete(p);
    await commitAndPush(gh, { meta: ws.meta, files: few }, 'Remove three files');
    expect(Object.keys(fake.files('main'))).toHaveLength(57);
  });

  it('is filled in by the cloud sync, never used to delete the full copy', () => {
    const full = new Map(Object.keys(repoFiles(50)).map((p, i) => [p, `h${i}`]));
    const partial = new Map([...full].slice(0, 10));
    // No agreed base (first sync / interrupted), and the cloud copy looks newer: nothing is pulled as a deletion.
    const r = planSync(full, partial, null, false);
    expect(r.pull).toEqual([]);
    expect(r.push).toHaveLength(40);
    // The other way round: a device with the partial copy gets the rest.
    const r2 = planSync(partial, full, null, true);
    expect(r2.push).toEqual([]);
    expect(r2.pull).toHaveLength(40);
    // With an agreed base, a real deletion still syncs.
    const base = Object.fromEntries(full);
    const deleted = new Map(full);
    deleted.delete('src/file003.ts');
    expect(planSync(full, deleted, base, false).pull).toEqual(['src/file003.ts']);
  });
});

describe('importing a repository', () => {
  it('opens it in the language of its files', () => {
    expect(detectedConfig('story', ['package.json', 'tsconfig.json', 'src/index.ts', 'assets/x.png']).language).toBe('typescript');
    expect(detectedConfig('game', ['project.godot', 'player.gd', 'tools/build.js']).language).toBe('gdscript');
    expect(detectedConfig('notes', ['README.md']).language).toBe('typescript');
    expect(serializeConfig(detectedConfig('x', ['a.gd'])).includes('gdscript')).toBe(true);
    void CONFIG_PATH;
    void makeRecord;
  });
});

describe('branches', () => {
  it('lists every branch, not just the first page (main sorts after lots of feat/ and fix/ branches)', async () => {
    const fake = new FakeGitHub();
    fake.push('main', { 'a.txt': 'a' });
    const sha = (await new GitHub(fake.fetch).head('lyra', 'game', 'main'));
    for (let i = 0; i < 220; i++) (fake as unknown as { refs: Map<string, string> }).refs.set(`feat/branch-${String(i).padStart(3, '0')}`, sha);
    const names = (await new GitHub(fake.fetch).branches('lyra', 'game')).map((b) => b.name);
    expect(names).toHaveLength(221);
    expect(names).toContain('main');
  });
});
