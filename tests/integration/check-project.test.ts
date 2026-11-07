/** check_project finds every kind of problem at once, and says to keep going until it's clean. */
import { describe, expect, it } from 'vitest';
import { CloudService } from '../../worker/cloud-service';
import { memoryBackend, memoryKv, seedFiles } from '../fixtures/cloud-backend';

type Check = { ok: boolean; errors: number; problems: { area: string; where: string; message: string; fix?: string }[]; types_not_checked?: string; next: string; checked: string[] };

describe('check_project', () => {
  it('a fresh web app is clean (apart from the TypeScript check needing an open editor)', async () => {
    const cloud = new CloudService(memoryKv(), memoryBackend(), () => undefined, 'https://site', () => 0);
    await cloud.handle('create_project', { name: 'Clean', language: 'typescript', template: 'web-app' });
    const r = (await cloud.handle('check_project', {})) as Check;
    expect(r).toMatchObject({ ok: true, errors: 0 });
    expect(r.types_not_checked).toMatch(/no Coding Studio tab is open/);
  });

  it('lists graph, package, config and deploy problems together, with fixes, and says not to stop', async () => {
    const cloud = new CloudService(memoryKv(), memoryBackend(), () => undefined, 'https://site', () => 0);
    await cloud.handle('create_project', { name: 'Broken', language: 'typescript', template: 'web-app' });
    // a graph that calls a package nobody installed
    const g = (await cloud.handle('get_graph', { graph: 'App' })) as { nodes: { id: string; type: string }[] };
    const entry = g.nodes.find((n) => n.type === 'core.entry')!.id;
    const ret = g.nodes.find((n) => n.type === 'core.return')!.id;
    await cloud.handle('batch_edit', { graph: 'App', operations: [{ op: 'add_node', ref: 'c', type: 'ts.call', props: { module: 'phaser', name: 'setup', argNames: [], argTypes: [], returnType: 'void' } }, { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$c', port: 'exec' } }, { op: 'connect', from: { node: '$c', port: 'then' }, to: { node: ret, port: 'exec' } }] });
    await cloud.handle('ci_add_workflow', { template: 'cloudflare' });
    await cloud.handle('edit_config', { path: 'package.json', edits: [{ op: 'set', path: ['name'], value: 'Not Valid' }, { op: 'delete', path: ['scripts', 'build'] }] });
    await seedFiles(cloud, { 'wrangler.jsonc': null, 'src/broken.vgraph': null });
    const r = (await cloud.handle('check_project', {})) as Check;
    expect(r.ok).toBe(false);
    const areas = new Set(r.problems.map((p) => p.area));
    expect([...areas].sort()).toEqual(expect.arrayContaining(['build', 'config', 'deploy', 'packages']));
    const pkg = r.problems.find((p) => p.area === 'packages')!;
    expect(pkg.message).toContain('"phaser"');
    expect(pkg.fix).toContain('deps_add');
    expect(r.problems.find((p) => p.area === 'deploy')!.message).toMatch(/Missing entry-point/);
    expect(r.problems.find((p) => p.area === 'build')!.message).toMatch(/no build script/);
    expect(r.problems.find((p) => p.area === 'config')!.where).toBe('package.json › name');
    expect(r.next).toMatch(/fix ALL \d+ error/);
    // fixing them clears the check
    await cloud.handle('deps_add', { name: 'phaser', range: '^3.80.0' });
    await cloud.handle('edit_config', { path: 'package.json', edits: [{ op: 'set', path: ['name'], value: 'not-valid' }, { op: 'set', path: ['scripts', 'build'], value: 'tsc --noEmit && vite build' }] });
    await cloud.handle('ci_add_workflow', { template: 'cloudflare' }).catch(() => undefined);
    await seedFiles(cloud, { 'wrangler.jsonc': '{ "name": "x", "compatibility_date": "2026-09-01", "assets": { "directory": "./dist" } }\n' });
    expect(((await cloud.handle('check_project', {})) as Check).errors).toBe(0);
  });

  it('asks an open editor for the TypeScript check and includes its answer', async () => {
    const cloud = new CloudService(memoryKv(), memoryBackend(), () => undefined, 'https://site', () => 1);
    await cloud.handle('create_project', { name: 'Typed', language: 'typescript', template: 'module' });
    const asked: unknown[] = [];
    cloud.askEditor = async (msg) => {
      asked.push(msg);
      return { problems: [{ path: 'main.ts', line: 3, message: "TS2322: Type 'string' is not assignable to type 'number'.", severity: 'error' }] };
    };
    const r = (await cloud.handle('check_project', {})) as Check;
    expect(asked).toEqual([{ question: 'type-check', projectId: expect.any(String) }]);
    expect(r.checked).toContain('TypeScript types');
    expect(r.problems).toEqual([expect.objectContaining({ area: 'types', where: 'main.ts:3', message: expect.stringContaining('TS2322') })]);
    expect(r.ok).toBe(false);
  });
});
