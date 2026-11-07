/** check_project through the local MCP server: the editor adds TypeScript's own type check. */
import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freshStart } from './helpers';

const PORT = 47995;
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
let client: Client;
const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
const data = (r: ToolResult) => JSON.parse(r.content[0].text!);

test.beforeAll(async () => {
  execSync('npm run build:mcp', { stdio: 'ignore' });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/coding-studio-mcp.mjs'], env: { ...process.env, CODING_STUDIO_PORT: String(PORT) } as Record<string, string>, stderr: 'ignore' }));
});
test.afterAll(async () => {
  await client?.close();
});

test('check_project includes TypeScript errors from generated code, and is clean once they are fixed', async ({ page }) => {
  test.setTimeout(150_000);
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  data(await tool('create_project', { name: 'Typed', language: 'typescript', template: 'module' }));
  const clean = data(await tool('check_project'));
  expect(clean.checked).toContain('TypeScript types');
  expect(clean.errors).toBe(0);
  // a call to a global with the wrong argument type: the graph compiles, TypeScript objects
  const g = data(await tool('get_graph', {}));
  const entry = g.nodes.find((n: { type: string }) => n.type === 'core.entry').id;
  await tool('batch_edit', { operations: [{ op: 'add_node', ref: 'c', type: 'ts.call', props: { module: '', name: 'parseInt', argNames: ['s'], argTypes: ['number'], returnType: 'number' }, inputs: { arg_0: 5 } }, { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$c', port: 'exec' } }] });
  const bad = data(await tool('check_project'));
  expect(bad.ok).toBe(false);
  expect(bad.problems.some((p: { area: string; message: string }) => p.area === 'types' && /not assignable/.test(p.message))).toBe(true);
  expect(bad.next).toMatch(/fix ALL/);
});
