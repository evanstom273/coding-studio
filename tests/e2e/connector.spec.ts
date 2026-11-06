/**
 * Remote "Claude connector": MCP over HTTPS to the Worker (/mcp/<key>) → Durable Object →
 * WebSocket to the editor tab (/bridge/<key>). Runs the real Worker locally with `wrangler dev`.
 */
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { node } from './helpers';

const PORT = 8789;
const SITE = `http://127.0.0.1:${PORT}`;
const KEY = 'TestConnectorKey_0123456789abcdefghijklmnop';
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

let wrangler: ChildProcess;
test.beforeAll(async () => {
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { stdio: 'ignore', detached: true });
  await expect.poll(async () => (await fetch(SITE).catch(() => null))?.status ?? 0, { timeout: 60_000 }).toBe(200);
});
test.afterAll(() => {
  if (wrangler.pid) process.kill(-wrangler.pid);
});

async function claude() {
  const c = new Client({ name: 'claude-connector-e2e', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${SITE}/mcp/${KEY}`)));
  return { c, call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult };
}
const data = (r: ToolResult) => JSON.parse(r.content[0].text!);

test('Claude drives the editor through the hosted connector', async ({ page, browser }) => {
  const { c, call } = await claude();
  try {
    // No tab yet: a clear instruction, not a crash.
    const before = await call('status');
    expect(before.isError).toBe(true);
    expect(data(before).error.code).toBe('E_NOT_CONNECTED');

    // The user switches the connector on (stored per browser), with this key.
    await page.goto(SITE);
    await page.evaluate((key) => {
      localStorage.setItem('coding-studio:connector-test', '1');
      localStorage.setItem('coding-studio:connector', JSON.stringify({ enabled: false, key }));
    }, KEY);
    await page.reload();
    await page.getByTestId('mcp-indicator').click();
    await expect(page.getByTestId('connector-url')).toHaveText(`${SITE}/mcp/${KEY}`);
    await page.getByTestId('connector-enable').check();
    await expect(page.getByTestId('connector-status')).toContainText('Connected');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');

    // Claude builds a script.
    const created = data(await call('create_project', { name: 'From My Phone', template: 'node' }));
    await expect(page.getByTestId('project-title')).toHaveText('From My Phone');
    const ready = created.scripts[0].functions.find((f: { name: string }) => f.name === '_ready');
    const r = data(await call('add_node', { graph: ready.id, type: 'core.print', inputs: { value: 'Hello from the connector' } }));
    expect(r.diagnostics.errors).toBe(0);
    const g = data(await call('get_graph', { graph: ready.id }));
    const entry = g.nodes.find((n: { type: string }) => n.type === 'core.entry').id;
    const printId = g.nodes.find((n: { type: string }) => n.type === 'core.print').id;
    expect((await call('connect_nodes', { expected_revision: g.revision, from: { node: entry, port: 'then' }, to: { node: printId, port: 'exec' } })).isError).toBeFalsy();
    await expect(node(page, 'core.print')).toHaveCount(1);
    const code = (await call('get_generated_code', {})).content[0].text!;
    expect(code).toContain('print("Hello from the connector")');

    // Exports come back as text: the cloud can't write to the user's disk.
    const exp = data(await call('export_script', {}));
    expect(Object.values(exp.files)[0]).toContain('extends Node');
    expect(data(await call('export_script', { output_dir: '/tmp/x' })).error.code).toBe('E_NO_FILESYSTEM');

    // A second tab can't silently take over; an explicit takeover works.
    const other = await browser.newPage();
    await other.goto(SITE);
    await other.evaluate((key) => {
      localStorage.setItem('coding-studio:connector-test', '1');
      localStorage.setItem('coding-studio:connector', JSON.stringify({ enabled: true, key }));
    }, KEY);
    await other.reload();
    await other.getByTestId('mcp-indicator').click();
    await expect(other.getByTestId('connector-status')).toContainText('Another Coding Studio tab');
    expect(data(await call('status')).openProject.name).toBe('From My Phone');
    await other.getByTestId('connector-takeover').click();
    await expect(other.getByTestId('connector-status')).toContainText('Connected');
    await expect.poll(async () => data(await call('status')).openProject, { timeout: 10_000 }).toBeNull();
    await other.close();
  } finally {
    await c.close();
  }
});

test('the editor socket only accepts this site and valid keys', async () => {
  const tryWs = (url: string, origin: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(url, { origin });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
      ws.on('error', () => resolve('error'));
    });
  expect(await tryWs(`ws://127.0.0.1:${PORT}/bridge/${KEY}`, 'https://evil.example')).toBe('403');
  expect(await tryWs(`ws://127.0.0.1:${PORT}/bridge/short`, SITE)).toBe('404');
  expect(await tryWs(`ws://127.0.0.1:${PORT}/bridge/${KEY}`, SITE)).toBe('open');
});
