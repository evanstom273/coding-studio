/**
 * Publishing visual projects to GitHub: the generated code goes with the graphs, so the repository
 * builds. Uses the real pipeline (cloud service → GitHub client) against an in-memory GitHub, then
 * checks out what GitHub would hold and (with LIVE_NET) runs `npm install && npm run build` on it.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CloudService } from '../../worker/cloud-service';
import { GitHubVault } from '../../worker/github';
import { FakeGitHub } from '../fixtures/fake-github';
import { memoryBackend, memoryKv } from '../fixtures/cloud-backend';

async function setup(name = 'x') {
  const fake = new FakeGitHub('lyra', name);
  const store = memoryKv();
  const cloud = new CloudService(store, memoryBackend(), () => undefined, 'https://site', () => 0);
  cloud.github = () => new GitHubVault(store, () => fake.fetch);
  await cloud.github().set('github_pat_1234567890abcdefghij');
  return { fake, cloud };
}

/** Put a node of an unknown type into main.vgraph and wire it in (as an old or hand-edited file might). */
async function breakGraph(cloud: CloudService) {
  const f = ((await cloud.handle('read_files', { paths: ['main.vgraph'] })) as { files: { text: string }[] }).files[0];
  const doc = JSON.parse(f.text);
  const g = doc.script.functions[0].graph;
  const entry = g.nodes.find((n: { type: string }) => n.type === 'core.entry');
  g.nodes.push({ id: 'n_broken', type: 'core.no_such_node', position: { x: 300, y: 0 }, props: {}, inputs: {} });
  g.edges.push({ id: 'e_broken', from: { node: entry.id, port: 'then' }, to: { node: 'n_broken', port: 'exec' } });
  await cloud.handle('workspace_batch', { operations: [{ op: 'write_file', path: 'main.vgraph', content: JSON.stringify(doc, null, 2) }] });
}

const checkout = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-checkout-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};

describe('publishing a visual React project', () => {
  it('pushes the graphs AND their generated code; later graph edits update the generated files', async () => {
    const { fake, cloud } = await setup();
    await cloud.handle('create_project', { name: 'Todo', language: 'typescript', template: 'web-app' });
    const pub = (await cloud.handle('git_publish', { name: 'todo-app' })) as { files: number };
    const main = fake.files('main');
    expect(Object.keys(main)).toEqual(expect.arrayContaining(['src/App.vgraph', 'src/App.tsx', 'src/main.tsx', 'src/db.ts', 'src/TodoList.tsx', 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'codingstudio.json']));
    expect(main['src/App.tsx']).toContain('export function App()');
    expect(main['src/App.tsx']).toContain('My todos');
    expect(Object.keys(main).some((p) => p.startsWith('.codingstudio/'))).toBe(false);
    expect(pub.files).toBe(Object.keys(main).length); // every file (the project's README replaces GitHub's)
    expect((await cloud.handle('git_status', {})) as { clean: boolean }).toMatchObject({ clean: true });

    // edit the graph: the generated file shows as changed, and the next commit carries it
    const g = (await cloud.handle('get_graph', { graph: 'App' })) as { nodes: { id: string; type: string; props: { tag?: string } }[] };
    const h1 = g.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'h1')!;
    await cloud.handle('batch_edit', { graph: 'App', operations: [{ op: 'update_node', node: h1.id, inputs: { child_0: 'Things to do' } }] });
    expect(((await cloud.handle('git_status', {})) as { changes: unknown[] }).changes).toEqual(expect.arrayContaining([{ path: 'src/App.tsx', status: 'modified', generated: true }, { path: 'src/App.vgraph', status: 'modified' }]));
    await cloud.handle('git_commit', { message: 'New heading' });
    expect(fake.files('main')['src/App.tsx']).toContain('Things to do');

  }, 60_000);

  it('refuses to push when a graph has errors, naming the errors, and pushes nothing', async () => {
    const { fake, cloud } = await setup();
    await cloud.handle('create_project', { name: 'Broken', language: 'typescript', template: 'module' });
    await cloud.handle('git_publish', { name: 'broken' });
    await breakGraph(cloud);
    const errs = ((await cloud.handle('compile_project', {})) as { ok: boolean }).ok;
    expect(errs).toBe(false);
    const head = fake.refs.get('main');
    const err = await cloud.handle('git_commit', { message: 'broken' }).then(() => null, (e) => e as { code: string; message: string });
    expect(err?.code).toBe('E_COMPILE_ERRORS');
    expect(err?.message).toMatch(/Not pushed: \d+ error/);
    expect(err?.message).toMatch(/main/);
    expect(fake.refs.get('main')).toBe(head);
    // publishing a broken project doesn't even create the repository
    const { fake: f2, cloud: c2 } = await setup('never');
    await c2.handle('create_project', { name: 'Broken2', language: 'typescript', template: 'module' });
    await breakGraph(c2);
    await expect(c2.handle('git_publish', { name: 'never' })).rejects.toMatchObject({ code: 'E_COMPILE_ERRORS' });
    expect(f2.repoInfo.created).toEqual([]);
  }, 60_000);

  it('fixes an existing repository that has the graph but not its generated file, and never turns pulled generated code into an editable copy', async () => {
    // Like code-studio-ts-test: published before this fix, so GitHub has App.vgraph but no App.tsx.
    const { fake, cloud } = await setup('old');
    await cloud.handle('create_project', { name: 'Old', language: 'typescript', template: 'web-app' });
    const ws = (await cloud.handle('read_files', { paths: ['src/App.vgraph', 'src/main.tsx', 'src/db.ts', 'src/TodoList.tsx', 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'codingstudio.json', 'src/index.css'] })) as { files: { path: string; text: string }[] };
    fake.push('main', Object.fromEntries(ws.files.map((f) => [f.path, f.text])), 'published before the fix');
    const cl = (await cloud.handle('git_clone', { repository: 'lyra/old' })) as { changes: { path: string; status: string; generated?: boolean }[] };
    expect(cl.changes).toEqual([{ path: 'src/App.tsx', status: 'added', generated: true }]);
    await cloud.handle('git_commit', { message: 'Add generated code' });
    expect(fake.files('main')['src/App.tsx']).toContain('export function App()');
    // someone edits the generated file on GitHub: pulling doesn't make it a project file
    fake.push('main', { 'src/App.tsx': '// hand edit\n', 'README.md': 'hi' });
    await cloud.handle('git_pull', {});
    const tree = (await cloud.handle('read_tree', {})) as { files: { path: string }[]; generated: string[] };
    expect(tree.files.map((f) => f.path)).not.toContain('src/App.tsx');
    expect(tree.files.map((f) => f.path)).toContain('README.md');
    expect(tree.generated).toContain('src/App.tsx');
    // …and the next commit puts the graph's version back
    expect(((await cloud.handle('git_status', {})) as { changes: unknown[] }).changes).toEqual([{ path: 'src/App.tsx', status: 'modified', generated: true }]);
    // cloning a repo that already has generated code keeps the graph as the only source
    const c = (await cloud.handle('git_clone', { repository: 'lyra/old' })) as { project: string };
    const t2 = (await cloud.handle('read_tree', { project: c.project })) as { files: { path: string }[] };
    expect(t2.files.map((f) => f.path)).not.toContain('src/App.tsx');
  }, 60_000);

  it.skipIf(!process.env.LIVE_NET)('LIVE_NET: a checkout of the published repository installs and builds (npm run build)', async () => {
    const { fake, cloud } = await setup('buildable');
    await cloud.handle('create_project', { name: 'Buildable', language: 'typescript', template: 'web-app' });
    await cloud.handle('git_publish', { name: 'buildable' });
    const dir = checkout(fake.files('main'));
    execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    const out = execSync('npm run build 2>&1', { cwd: dir, encoding: 'utf8', timeout: 300_000 });
    expect(out).toMatch(/built in/);
  }, 600_000);
});
