/**
 * Claude connector with cloud projects: Claude edits projects stored in the Worker's Durable
 * Object with NO browser open; the editor syncs and shows Claude's edits (live when open).
 * Runs the real Worker locally with `wrangler dev`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { addNodeViaMenu, generatedCode, node } from './helpers';

const PORT = 8789;
const SITE = `http://127.0.0.1:${PORT}`;
const KEY = `TestKey_${Date.now()}_0123456789abcdefghijklmnop`;
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

async function openWithConnector(page: Page) {
  await page.goto(SITE);
  await page.evaluate((key) => {
    localStorage.setItem('coding-studio:connector-test', '1');
    localStorage.setItem('coding-studio:connector', JSON.stringify({ enabled: true, key }));
  }, KEY);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
}

test('Claude edits projects with no browser open; the editor syncs and shows changes live', async ({ page }) => {
  const { c, call } = await claude();
  try {
    // --- no browser anywhere ---
    const created = data(await call('create_project', { name: 'Built Offline', template: 'node' }));
    const ready = created.scripts[0].functions.find((f: { name: string }) => f.name === '_ready');
    const add = data(await call('add_node', { graph: ready.id, type: 'core.print', inputs: { value: 'Made while the editor was closed' } }));
    const g = data(await call('get_graph', { graph: ready.id }));
    const entry = g.nodes.find((n: { type: string }) => n.type === 'core.entry').id;
    expect((await call('connect_nodes', { expected_revision: g.revision, from: { node: entry, port: 'then' }, to: { node: add.created.node, port: 'exec' } })).isError).toBeFalsy();
    expect((await call('get_generated_code', {})).content[0].text).toContain('print("Made while the editor was closed")');
    expect(data(await call('status')).editorsOpen).toBe(0);
    // undo / redo work in the cloud
    expect(data(await call('undo', {})).undone).toMatch(/^Claude:/);
    expect((await call('get_generated_code', {})).content[0].text).not.toContain('\tprint(');
    await call('redo', {});
    expect((await call('get_generated_code', {})).content[0].text).toContain('\tprint("Made while the editor was closed")');

    // --- the user opens the site: the project is there with Claude's work ---
    await openWithConnector(page);
    await page.getByTestId('project-card').filter({ hasText: 'Built Offline' }).click();
    await expect(page.getByTestId('project-title')).toHaveText('Built Offline');
    await expect(await generatedCode(page)).toContainText('print("Made while the editor was closed")');

    // --- Claude edits while it's open: appears live ---
    await call('add_node', { graph: ready.id, type: 'core.branch' });
    await expect(node(page, 'core.branch')).toHaveCount(1);
    await page.getByTestId('undo').click(); // Claude's live edit is an undoable step here too
    await expect(node(page, 'core.branch')).toHaveCount(0);

    // --- the user's edits reach Claude ---
    await addNodeViaMenu(page, 'while', 'core.while');
    await expect.poll(async () => data(await call('get_graph', { graph: ready.id })).nodes.some((n: { type: string }) => n.type === 'core.while'), { timeout: 10_000 }).toBe(true);
    // ...and Claude can't undo its old edit over the user's newer work
    expect(data(await call('undo', {})).error.code).toBe('E_REVISION_CONFLICT');

    // --- a project made in the browser is visible to Claude ---
    await page.goto(SITE);
    await page.getByTestId('new-project').click();
    await page.getByTestId('project-name').fill('Made In Browser');
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('project-title')).toHaveText('Made In Browser');
    await expect.poll(async () => data(await call('list_projects')).map((p: { name: string }) => p.name), { timeout: 10_000 }).toContain('Made In Browser');

    // --- deleting in Claude removes it here ---
    await page.goto(SITE);
    await expect(page.getByTestId('project-card').filter({ hasText: 'Built Offline' })).toHaveCount(1);
    await call('delete_project', { project: 'Built Offline' });
    await expect(page.getByTestId('project-card').filter({ hasText: 'Built Offline' })).toHaveCount(0);
  } finally {
    await c.close();
  }
});

test('the editor endpoints only accept this site and valid keys', async () => {
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
  expect((await fetch(`${SITE}/sync/${KEY}/workspaces`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
});

test('files sync one by one, including non-graph files, both ways', async ({ page }) => {
  const { c, call } = await claude();
  try {
    const created = data(await call('create_project', { name: 'Per File' }));
    await openWithConnector(page);
    await page.getByTestId('project-card').filter({ hasText: 'Per File' }).click();
    await expect(page.getByTestId('project-title')).toHaveText('Per File');

    // A file written in the cloud (e.g. by another device) arrives in this browser's storage.
    const sync = (path: string, init?: RequestInit) => fetch(`${SITE}/sync/${KEY}/workspaces${path}`, { ...init, headers: { 'Content-Type': 'application/json', Origin: SITE } });
    const r = await sync(`/${created.id}/apply`, { method: 'POST', body: JSON.stringify({ changes: [{ path: 'notes/todo.md', base: null, text: '- ship it' }] }) });
    expect(r.status).toBe(200);
    const localFile = (path: string) =>
      page.evaluate(
        ([ws, p]) =>
          new Promise<string | null>((resolve) => {
            const req = indexedDB.open('coding-studio');
            req.onsuccess = () => {
              const g = req.result.transaction('files').objectStore('files').get([ws, p]);
              g.onsuccess = () => resolve(g.result?.text ?? null);
              g.onerror = () => resolve(null);
            };
          }),
        [created.id, path],
      );
    await expect.poll(() => localFile('notes/todo.md'), { timeout: 10_000 }).toBe('- ship it');

    // A graph edit here uploads only the graph file; the cloud keeps the note untouched.
    await addNodeViaMenu(page, 'while', 'core.while');
    await expect.poll(async () => (await (await sync(`/${created.id}`)).json()).files.map((f: { path: string }) => f.path), { timeout: 10_000 }).toContain('notes/todo.md');
    const ready = created.scripts[0].functions[0].id;
    await expect.poll(async () => data(await call('get_graph', { project: created.id, graph: ready })).nodes.some((n: { type: string }) => n.type === 'core.while'), { timeout: 10_000 }).toBe(true);

    // A stale write is refused with the conflicting path.
    const stale = await sync(`/${created.id}/apply`, { method: 'POST', body: JSON.stringify({ changes: [{ path: 'notes/todo.md', base: null, text: 'stale' }] }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).conflicts[0].path).toBe('notes/todo.md');
  } finally {
    await c.close();
  }
});

test('the connector has the file tools and the editor follows them live', async ({ page }) => {
  const { c, call } = await claude();
  try {
    const created = data(await call('create_project', { name: 'Cloud Files' }));
    await openWithConnector(page);
    await page.getByTestId('project-card').filter({ hasText: 'Cloud Files' }).click();
    await expect(page.getByTestId('project-title')).toHaveText('Cloud Files');
    await page.getByTestId('left-tab-files').click();
    expect(data(await call('write_file', { project: created.id, path: 'web/index.html', content: '<h1>hi</h1>' })).error.code).toBe('E_VISUAL_ONLY');
    const r = data(await call('workspace_batch', { project: created.id, operations: [{ op: 'write_file', path: 'web/notes.md', content: '# hi' }, { op: 'graph', ops: [{ op: 'add_script', name: 'Hud', path: 'ui/hud' }] }] }));
    expect(r.changed.length).toBe(2);
    await expect(page.locator('[data-testid="file-row"][data-path="web"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="file-row"][data-path="ui"]')).toBeVisible();
    const f = data(await call('read_files', { project: created.id, paths: ['web/notes.md'] })).files[0];
    expect(f.text).toBe('# hi');
    const stale = await call('write_file', { project: created.id, path: 'web/notes.md', content: 'x', expected_hash: 'deadbeef' });
    expect(data(stale).error.code).toBe('E_REVISION_CONFLICT');
    await call('undo', { project: created.id });
    await expect(page.locator('[data-testid="file-row"][data-path="web"]')).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await c.close();
  }
});

test('the GitHub endpoints keep the token server-side and only proxy GitHub API paths', async () => {
  const gh = (path: string, init?: RequestInit) => fetch(`${SITE}/github/${KEY}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Origin: SITE } });
  expect(await (await gh('/token')).json()).toEqual({ connected: false });
  expect((await gh('/token', { method: 'PUT', body: JSON.stringify({ token: 'x' }) })).status).toBe(400);
  const r = await gh('/api/user');
  expect(r.status).toBe(401);
  expect((await r.json()).code).toBe('E_GITHUB_NOT_CONNECTED');
  expect((await gh('/api/orgs/x')).status).toBe(400);
  expect((await fetch(`${SITE}/github/${KEY}/token`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
});
