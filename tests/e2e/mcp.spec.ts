/**
 * Full path: MCP client (as Claude Code would) → stdio MCP server → 127.0.0.1 WebSocket → editor
 * tab → validated graph edits → GDScript compilation → file written to disk.
 */
import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freshStart, generatedCode, node } from './helpers';

const PORT = 47999;
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
let client: Client;

async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const data = (r: ToolResult) => JSON.parse(r.content[0].text!);

test.beforeAll(async () => {
  execSync('npm run build:mcp', { stdio: 'ignore' });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/coding-studio-mcp.mjs'], env: { ...process.env, CODING_STUDIO_PORT: String(PORT) } as Record<string, string>, stderr: 'ignore' }));
});
test.afterAll(async () => {
  await client?.close();
});

test('Claude Code builds, compiles and exports a graph through MCP', async ({ page }) => {
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['status', 'create_project', 'batch_edit', 'get_graph', 'connect_nodes', 'compile_script', 'export_script', 'undo', 'restore_backup', 'get_node_schema', 'create_signal']) expect(tools).toContain(t);
  expect(data(await tool('status')).openProject).toBeNull();

  // create → opens in the editor the user is looking at
  const created = data(await tool('create_project', { name: 'Claude Platformer', template: 'character2d', script_name: 'Player' }));
  await expect(page.getByTestId('project-title')).toHaveText('Claude Platformer');
  const graph = created.scripts[0].functions[0];
  expect(graph.name).toBe('_physics_process');

  // one atomic batch builds a connected graph, referencing new nodes with $refs
  const g0 = data(await tool('get_graph', {}));
  const entry = g0.nodes.find((n: { type: string }) => n.type === 'core.entry').id;
  const r = data(
    await tool('batch_edit', {
      expected_revision: g0.revision,
      operations: [
        { op: 'add_variable', name: 'speed', type: 'float', default: 200, exported: true },
        { op: 'add_node', ref: 'dir', type: 'godot.input.get_vector', position: { x: 0, y: 200 } },
        { op: 'add_node', ref: 'speed', type: 'core.get_var', props: { variable: 'speed' }, position: { x: 0, y: 300 } },
        { op: 'add_node', ref: 'mul', type: 'core.multiply', props: { type: 'Vector2', rhsType: 'float' }, position: { x: 300, y: 250 } },
        { op: 'add_node', ref: 'set', type: 'godot.characterbody2d.set_velocity', position: { x: 300, y: 0 } },
        { op: 'add_node', ref: 'move', type: 'godot.characterbody2d.move_and_slide', position: { x: 600, y: 0 } },
        { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$set', port: 'exec' } },
        { op: 'connect', from: { node: '$set', port: 'then' }, to: { node: '$move', port: 'exec' } },
        { op: 'connect', from: { node: '$dir', port: 'result' }, to: { node: '$mul', port: 'a' } },
        { op: 'connect', from: { node: '$speed', port: 'value' }, to: { node: '$mul', port: 'b' } },
        { op: 'connect', from: { node: '$mul', port: 'result' }, to: { node: '$set', port: 'value' } },
      ],
    }),
  );
  expect(r.diagnostics.errors).toBe(0);
  await expect(node(page, 'godot.characterbody2d.move_and_slide')).toHaveCount(1);
  await expect(await generatedCode(page)).toContainText('velocity = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down") * speed');

  // stale revision → rejected, nothing applied
  const conflict = await tool('add_node', { expected_revision: g0.revision, type: 'core.print' });
  expect(conflict.isError).toBe(true);
  expect(data(conflict).error.code).toBe('E_REVISION_CONFLICT');
  await expect(node(page, 'core.print')).toHaveCount(0);

  // invalid operation in a batch → whole batch rejected, project unchanged
  const bad = await tool('batch_edit', { expected_revision: r.revision, operations: [{ op: 'add_node', ref: 'p', type: 'core.print' }, { op: 'connect', from: { node: '$p', port: 'then' }, to: { node: '$p', port: 'exec' } }] });
  expect(bad.isError).toBe(true);
  await expect(node(page, 'core.print')).toHaveCount(0);
  expect(data(await tool('get_project', {})).revision).toBe(r.revision);

  // compile + export to disk
  const code = (await tool('get_generated_code', {})).content[0].text!;
  expect(code).toContain('extends CharacterBody2D');
  expect(code).toContain('@export var speed: float = 200.0');
  const dir = mkdtempSync(join(tmpdir(), 'cs-godot-project-'));
  const exp = data(await tool('export_script', { output_dir: dir }));
  expect(exp.written).toEqual(['player.gd']);
  expect(readFileSync(join(dir, 'player.gd'), 'utf8')).toBe(code.replace(/^# ===== player\.gd =====\n/, ''));

  // overwriting requires overwrite=true AND the user's approval in the editor
  writeFileSync(join(dir, 'player.gd'), 'user edits');
  const refused = await tool('export_script', { output_dir: dir });
  expect(data(refused).error.code).toBe('E_FILE_EXISTS');
  const pending = tool('export_script', { output_dir: dir, overwrite: true });
  await expect(page.getByRole('dialog', { name: 'Claude wants to overwrite files' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(data(await pending).error.code).toBe('E_DECLINED');
  expect(readFileSync(join(dir, 'player.gd'), 'utf8')).toBe('user edits');
  const pending2 = tool('export_script', { output_dir: dir, overwrite: true });
  await page.getByTestId('confirm-ok').click();
  expect(data(await pending2).overwritten).toEqual(['player.gd']);

  // the whole Claude batch is a single undo step, visible to the user
  const undone = data(await tool('undo', {}));
  expect(undone.undone).toMatch(/^Claude:/);
  await expect(node(page, 'godot.characterbody2d.move_and_slide')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(node(page, 'godot.characterbody2d.move_and_slide')).toHaveCount(1);
  await expect(page.getByTestId('bottom-tab-mcp')).toBeVisible();
  await page.getByTestId('bottom-tab-mcp').click();
  await expect(page.getByTestId('mcp-log')).toContainText('batch_edit');
  expect(existsSync(join(dir, 'player.gd'))).toBe(true);
});

test('backups are created for large Claude batches and can be restored', async ({ page }) => {
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  await tool('create_project', { name: 'Backup Test', template: 'node' });
  const before = data(await tool('get_project', {}));
  const ready = before.scripts[0].functions.find((f: { name: string }) => f.name === '_ready');
  const res = await tool('batch_edit', { graph: ready.id, operations: Array.from({ length: 16 }, (_, i) => ({ op: 'add_node', type: 'core.print', position: { x: i * 10, y: 0 } })) });
  expect(res.isError).toBeFalsy();
  await expect(node(page, 'core.print')).toHaveCount(16);
  const backups = data(await tool('list_backups', {}));
  expect(backups[0].label).toContain('Before Claude batch');
  const restored = data(await tool('restore_backup', { backup: backups[0].id }));
  expect(restored.revision).toBe(before.revision);
  await expect(node(page, 'core.print')).toHaveCount(0);
});

test('Claude works with files: atomic multi-file batch, stale hashes rejected, editor updates live', async ({ page }) => {
  await freshStart(page);
  await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
  await page.reload();
  await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['read_tree', 'read_files', 'search_files', 'workspace_batch', 'write_file', 'move_path', 'delete_path']) expect(tools).toContain(t);

  await tool('create_project', { name: 'Files By Claude' });
  await expect(page.getByTestId('project-title')).toHaveText('Files By Claude');
  await page.getByTestId('left-tab-files').click();

  // Claude can write code files directly
  const code = await tool('write_file', { path: 'src/hack.ts', content: 'export const ok = true;\n' });
  expect(code.isError).toBeFalsy();
  const b = data(
    await tool('workspace_batch', {
      operations: [
        { op: 'write_file', path: 'src/util.md', content: 'twice the speed\n' },
        { op: 'write_file', path: 'docs/notes.md', content: '# Notes\n' },
        { op: 'graph', ops: [{ op: 'add_script', name: 'Enemy', path: 'actors/enemy', template: 'node2d' }] },
        { op: 'graph', script: 'actors/enemy.vgraph', ops: [{ op: 'add_variable', name: 'hp', type: 'int', default: 3 }] },
      ],
    }),
  );
  expect(b.diagnostics.errors).toBe(0);
  // the editor shows it at once
  await expect(page.locator('[data-testid="file-row"][data-path="src"]')).toBeVisible();
  await expect(page.locator('[data-testid="file-row"][data-path="actors"]')).toBeVisible();

  const tree = data(await tool('read_tree', {}));
  expect(tree.generated).toContain('actors/enemy.gd');
  const util = data(await tool('read_files', { paths: ['src/util.md'] })).files[0];

  // the user edits the file in the editor…
  await page.locator('[data-testid="file-row"][data-path="src"]').click();
  await page.locator('[data-testid="file-row"][data-path="src/util.md"]').click();
  await page.locator('[data-testid="text-editor"] .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' (user was here)');
  await expect.poll(async () => data(await tool('read_files', { paths: ['src/util.md'] })).files[0].text).toContain('user was here');
  // …so Claude's write based on the old hash is refused and nothing in the batch applies
  const stale = await tool('workspace_batch', { operations: [{ op: 'write_file', path: 'other.txt', content: 'x' }, { op: 'write_file', path: 'src/util.md', content: 'overwritten', expected_hash: util.hash }] });
  expect(stale.isError).toBe(true);
  expect(data(stale).error.code).toBe('E_REVISION_CONFLICT');
  expect(data(await tool('read_tree', {})).files.map((f: { path: string }) => f.path)).not.toContain('other.txt');

  // search, move with an open tab following, delete + undo
  expect(data(await tool('search_files', { query: 'twice' })).matches[0].path).toBe('src/util.md');
  await tool('move_path', { from: 'src', to: 'lib' });
  await expect(page.locator('[data-testid="tab"][data-tab="lib/util.md"]')).toBeVisible();
  await tool('delete_path', { path: 'docs', recursive: true });
  await expect(page.locator('[data-testid="file-row"][data-path="docs"]')).toHaveCount(0);
  await tool('undo', {});
  await expect(page.locator('[data-testid="file-row"][data-path="docs"]')).toBeVisible();
  // graph tools take paths too
  expect((await tool('get_generated_code', { script: 'actors/enemy.vgraph' })).content[0].text).toContain('var hp: int = 3');
});
