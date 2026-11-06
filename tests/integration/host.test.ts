/** Local execution host: linked folder (write, conflicts, watch) and allow-listed tasks. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostError, inside, ProjectFolder } from '../../mcp/server/host';

const pkg = (scripts: Record<string, string>) => ({ path: 'package.json', text: JSON.stringify({ name: 'h', version: '1.0.0', private: true, scripts }) });

describe('local host', () => {
  it('writes only inside the folder, reports conflicts, and picks up edits made in the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-host-'));
    const f = new ProjectFolder(dir);
    expect(() => inside(dir, '../evil.txt')).toThrow(HostError);
    writeFileSync(join(dir, 'a.txt'), 'theirs');
    expect(f.conflicts([{ path: 'a.txt', text: 'mine' }, { path: 'b.txt', text: 'x' }])).toEqual(['a.txt']);
    expect(f.write([{ path: 'a.txt', text: 'mine' }, { path: 'src/b.ts', text: 'export {}' }, { path: 'img.bin', base64: Buffer.from([0, 1, 2]).toString('base64') }])).toEqual(['a.txt', 'src/b.ts', 'img.bin']);
    expect(f.write([{ path: 'a.txt', text: 'mine' }])).toEqual([]);
    expect(readFileSync(join(dir, 'img.bin'))).toEqual(Buffer.from([0, 1, 2]));
    const got: { path: string; text?: string }[] = [];
    f.watch(() => new Set(['a.txt', 'src/b.ts']), (files) => got.push(...files), 50);
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const changed = 1;\n');
    writeFileSync(join(dir, 'ignored.txt'), 'not part of the project');
    await expect.poll(() => got.map((x) => x.path), { timeout: 5000 }).toEqual(['src/b.ts']);
    expect(got[0].text).toBe('export const changed = 1;\n');
    f.dispose();
  });

  it('runs package.json scripts (only those), installs, and runs a dev server until stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-host-'));
    writeFileSync(join(dir, 'server.cjs'), "const http=require('http');const s=http.createServer((q,r)=>r.end('hi'));s.listen(0,'127.0.0.1',()=>console.log('  ➜  Local:   http://localhost:'+s.address().port+'/'));");
    const f = new ProjectFolder(dir);
    f.write([pkg({ test: 'node -e "console.log(\'tests ok\')"', fail: 'node -e "process.exit(3)"', dev: 'node server.cjs' })]);
    expect(() => f.run('nope')).toThrow(/no "nope" script/);
    const t = await f.wait(f.run('test').id);
    expect(t).toMatchObject({ state: 'passed', exitCode: 0, command: 'npm run test' });
    expect(t.output).toContain('tests ok');
    expect((await f.wait(f.run('fail').id)).state).toBe('failed');
    const install = await f.wait(f.install().id);
    expect(install.state).toBe('passed');
    const dev = await f.wait(f.devServer().id, 15_000);
    expect(dev.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(await (await fetch(dev.url!)).text()).toBe('hi');
    expect(f.devServer().id).toBe(dev.id); // already running
    f.stop();
    await expect.poll(async () => (await fetch(dev.url!).then(() => 'up').catch(() => 'down')), { timeout: 5000 }).toBe('down');
    f.dispose();
  }, 120_000);
});

describe('LocalHost (tools side)', () => {
  it('links a project to a folder, asks before overwriting, runs scripts, and sends folder edits back', async () => {
    const { LocalHost } = await import('../../mcp/server/host');
    const dir = mkdtempSync(join(tmpdir(), 'cs-link-'));
    const files = [pkg({ test: 'node -e "console.log(require(\'fs\').readFileSync(\'src/app.ts\',\'utf8\'))"' }), { path: 'src/app.ts', text: 'export const v = 1;\n' }, { path: 'src/app.gd', text: '# generated', generated: true }];
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let approve = false;
    const host = new LocalHost(async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'host_snapshot') return { project: 'p1', name: 'P', files };
      if (method === 'confirm_overwrite') return { approved: approve };
      return { ok: true };
    });
    await expect(host.run('test')).rejects.toMatchObject({ code: 'E_NOT_LINKED' });
    writeFileSync(join(dir, 'package.json'), '{}');
    await expect(host.link(dir, {})).rejects.toMatchObject({ code: 'E_FILE_EXISTS' });
    await expect(host.link(dir, { overwrite: true })).rejects.toMatchObject({ code: 'E_DECLINED' });
    approve = true;
    const linked = (await host.link(dir, { overwrite: true })) as { written: number; scripts: string[] };
    expect(linked).toMatchObject({ written: 3, scripts: ['test'], package_manager: 'npm' });
    expect(readFileSync(join(dir, 'src/app.gd'), 'utf8')).toBe('# generated');
    // the project changes in the editor → run_task syncs first
    files[1] = { path: 'src/app.ts', text: 'export const v = 2;\n' };
    const r = (await host.run('test')) as { state: string; output: string };
    expect(r.state).toBe('passed');
    expect(r.output).toContain('v = 2');
    // an edit made in the folder comes back as a workspace_batch (generated files don't)
    writeFileSync(join(dir, 'src/app.ts'), 'export const v = 3;\n');
    writeFileSync(join(dir, 'src/app.gd'), '# hand edit');
    await expect.poll(() => calls.filter((c) => c.method === 'workspace_batch').length, { timeout: 5000 }).toBe(1);
    expect(calls.find((c) => c.method === 'workspace_batch')!.params).toEqual({ project: 'p1', operations: [{ op: 'write_file', path: 'src/app.ts', content: 'export const v = 3;\n' }] });
    host.dispose();
  }, 60_000);
});

describe('LocalHost: open a folder, live sync from the editor', () => {
  it('imports a folder (skipping node_modules), then writes editor changes into it without clobbering local edits', async () => {
    const { LocalHost } = await import('../../mcp/server/host');
    const { mkdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'cs-open-'));
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'a1');
    writeFileSync(join(dir, 'src', 'b.ts'), 'b1');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1]));
    let files: { path: string; text?: string; base64?: string; generated?: boolean }[] = [];
    let revision = 'r1';
    const batches: unknown[] = [];
    const host = new LocalHost(async (method, params = {}) => {
      if (method === 'host_import') {
        files = (params.files as typeof files).slice();
        return { project: 'p9', files: files.length };
      }
      if (method === 'host_snapshot') return { project: 'p9', name: 'x', files: [...files, { path: 'src/gen.ts', text: 'generated', generated: true }] };
      if (method === 'host_revision') return { open: true, revision };
      if (method === 'workspace_batch') batches.push(params);
      return {};
    }, 50);
    const r = (await host.open(dir)) as { files: number; project: string };
    expect(r).toMatchObject({ project: 'p9', files: 3 });
    expect(files.map((f) => f.path).sort()).toEqual(['logo.png', 'src/a.ts', 'src/b.ts']);
    expect(files.find((f) => f.path === 'logo.png')!.base64).toBe(Buffer.from([0x89, 0x50, 0, 1]).toString('base64'));
    expect(readFileSync(join(dir, 'src', 'gen.ts'), 'utf8')).toBe('generated');
    // a local edit that hasn't been brought back yet survives an editor change to another file
    writeFileSync(join(dir, 'src', 'b.ts'), 'b-local');
    files = files.map((f) => (f.path === 'src/a.ts' ? { path: f.path, text: 'a2' } : f));
    revision = 'r2';
    await expect.poll(() => readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), { timeout: 5000 }).toBe('a2');
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe('b-local');
    await expect.poll(() => batches.length, { timeout: 5000 }).toBeGreaterThan(0);
    host.dispose();
  }, 30_000);
});
