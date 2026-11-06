/**
 * Local execution host, full path: MCP client → stdio server → editor tab → project written to a
 * folder → package.json scripts run there → edits made in the folder come back into the editor.
 */
import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freshStart } from './helpers';

const PORT = 47996;
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
let client: Client;
const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const data = (r: ToolResult) => JSON.parse(r.content[0].text!);

test.beforeAll(async () => {
  execSync('npm run build:mcp', { stdio: 'ignore' });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/coding-studio-mcp.mjs'], env: { ...process.env, CODING_STUDIO_PORT: String(PORT) } as Record<string, string>, stderr: 'ignore' }));
});
test.afterAll(async () => {
  await client?.close();
});

test('link a project to a folder, run its tests and dev server there, and get folder edits back', async ({ page }) => {
  test.setTimeout(120_000);
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['link_folder', 'sync_folder', 'install', 'run_task', 'run_tests', 'dev_server', 'task_output']) expect(tools).toContain(t);

  data(await tool('create_project', { name: 'Hosted', language: 'typescript', template: 'module' }));
  expect(data(await tool('run_tests')).error.code).toBe('E_NOT_LINKED');
  const pkg = { name: 'hosted', private: true, version: '1.0.0', scripts: { test: 'node check.cjs', dev: 'node server.cjs' } };
  const w = await tool('workspace_batch', {
    operations: [
      { op: 'write_file', path: 'package.json', content: JSON.stringify(pkg) },
      { op: 'write_file', path: 'check.cjs', content: "const s=require('fs').readFileSync('main.ts','utf8');if(!s.includes('export'))process.exit(1);console.log('generated code is here')" },
      { op: 'write_file', path: 'server.cjs', content: "require('http').createServer((q,r)=>r.end('served')).listen(0,'127.0.0.1',function(){console.log('Local: http://localhost:'+this.address().port+'/')})" },
    ],
  });
  expect(w.isError).toBeFalsy();

  const dir = mkdtempSync(join(tmpdir(), 'cs-e2e-host-'));
  const linked = data(await tool('link_folder', { folder: dir }));
  expect(linked.scripts).toEqual(['test', 'dev']);
  expect(existsSync(join(dir, 'main.ts'))).toBe(true); // generated from main.vgraph
  expect(existsSync(join(dir, 'main.vgraph'))).toBe(true);

  const t = data(await tool('run_tests'));
  expect(t.state, t.output).toBe('passed');
  expect(t.output).toContain('generated code is here');
  expect(data(await tool('run_task', { script: 'nope' })).error.code).toBe('E_UNKNOWN_SCRIPT');

  const dev = data(await tool('dev_server', { action: 'start' }));
  expect(dev.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  expect(await (await fetch(dev.url)).text()).toBe('served');
  expect(data(await tool('dev_server', { action: 'stop' })).stopped).toEqual([dev.id]);

  // edited in the folder (e.g. in VS Code) → appears in the editor
  writeFileSync(join(dir, 'check.cjs'), "console.log('edited outside')");
  await expect.poll(async () => data(await tool('read_files', { paths: ['check.cjs'] })).files[0].text, { timeout: 10_000 }).toBe("console.log('edited outside')");
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(JSON.stringify(pkg));
});

test('open an existing folder as a project; editor edits reach the folder by themselves', async ({ page }) => {
  test.setTimeout(120_000);
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  const dir = mkdtempSync(join(tmpdir(), 'cs-e2e-open-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'existing', scripts: { test: 'node -e "console.log(1)"' } }));
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const answer = 42;\n');
  const r = data(await tool('open_folder', { folder: dir, name: 'Existing repo' }));
  expect(r.files).toBe(2);
  await expect(page.getByTestId('project-title')).toHaveText('Existing repo');
  const tree = data(await tool('read_tree'));
  expect(tree.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['package.json', 'src/util.ts']));
  expect(tree.files.some((f: { path: string }) => f.path.startsWith('node_modules'))).toBe(false);
  // an edit in the editor (here via Claude, same path as typing) shows up on disk without any tool call
  await tool('write_file', { path: 'src/util.ts', content: 'export const answer = 43;\n' });
  await expect.poll(() => readFileSync(join(dir, 'src', 'util.ts'), 'utf8'), { timeout: 10_000 }).toBe('export const answer = 43;\n');
  expect(data(await tool('run_tests')).state).toBe('passed');
});

test('live: the web starter installs and runs under Vite on this computer, and graph edits reach it', async ({ page }) => {
  test.skip(!process.env.LIVE_NET, 'needs the npm registry (set LIVE_NET=1)');
  test.setTimeout(600_000);
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  data(await tool('create_project', { name: 'Vite Live', language: 'typescript', template: 'web-app' }));
  const dir = mkdtempSync(join(tmpdir(), 'cs-e2e-vite-'));
  data(await tool('link_folder', { folder: dir }));
  expect(readFileSync(join(dir, 'src', 'App.tsx'), 'utf8')).toContain('My todos');
  const inst = data(await client.callTool({ name: 'install', arguments: {} }, undefined, { timeout: 600_000 }) as ToolResult);
  expect(inst.state, inst.output).toBe('passed');
  const dev = data(await tool('dev_server', { action: 'start' }));
  expect(dev.url, dev.output).toMatch(/^http:\/\/localhost:\d+\/$/);
  expect(await (await fetch(dev.url)).text()).toContain('<div id="root">');
  expect(await (await fetch(`${dev.url}src/App.tsx`)).text()).toContain('My todos');
  // change the heading in the graph → App.tsx on disk (and so Vite) follows
  const g = data(await tool('get_graph', { graph: 'App' }));
  const h1 = g.nodes.find((n: { type: string; props: { tag?: string } }) => n.type === 'ts.element' && n.props.tag === 'h1');
  await tool('update_node', { graph: 'App', node: h1.id, inputs: { child_0: 'Hot reloaded' } });
  await expect.poll(() => readFileSync(join(dir, 'src', 'App.tsx'), 'utf8'), { timeout: 15_000 }).toContain('Hot reloaded');
  await expect.poll(async () => (await fetch(`${dev.url}src/App.tsx`)).text(), { timeout: 15_000 }).toContain('Hot reloaded');
  const build = data(await client.callTool({ name: 'run_task', arguments: { script: 'build' } }, undefined, { timeout: 300_000 }) as ToolResult);
  expect(build.state, build.output).toBe('passed');
  await tool('dev_server', { action: 'stop' });
});
