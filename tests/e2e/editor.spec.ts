import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addNodeViaMenu, createProject, dragPin, freshStart, generatedCode, node } from './helpers';

test.beforeEach(async ({ page }) => {
  await freshStart(page);
});

test('the editor fills the viewport', async ({ page }) => {
  await createProject(page);
  const box = (await page.getByTestId('editor').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.width).toBe(vp.width);
  expect(box.height).toBe(vp.height);
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!;
  expect(canvas.width * canvas.height).toBeGreaterThan(vp.width * vp.height * 0.35);
});

test('create, add, connect, edit, generate, save, reopen and export', async ({ page }) => {
  await createProject(page, 'Hello Project');
  const print = await addNodeViaMenu(page, 'print', 'core.print');
  const entry = node(page, 'core.entry').first();
  await dragPin(page, entry.getByTestId('pin-out-then'), print.getByTestId('pin-in-exec'), { expectEdge: true });
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // edit the inline value of the Print node
  const input = print.getByLabel('Value value');
  await input.fill('Hello from the graph');
  const code = await generatedCode(page);
  await expect(code).toContainText('print("Hello from the graph")');
  await expect(code).toContainText('func _ready() -> void:');

  // save + reload = persisted
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.getByTestId('project-title')).toHaveText('Hello Project');
  await expect(await generatedCode(page)).toContainText('print("Hello from the graph")');

  // export the .gd file
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-script').click()]);
  expect(download.suggestedFilename()).toBe('main.gd');
  const content = readFileSync((await download.path())!, 'utf8');
  expect(content).toContain('extends Node');
  expect(content).toContain('\tprint("Hello from the graph")');
});

test('editing node properties in the inspector updates the code', async ({ page }) => {
  await createProject(page);
  const add = await addNodeViaMenu(page, 'add', 'core.add');
  await add.click();
  await expect(page.getByTestId('node-inspector')).toBeVisible();
  await page.getByTestId('prop-type').fill('int');
  await page.getByTestId('prop-type').press('Enter');
  await expect(add.getByTestId('pin-out-result')).toHaveAttribute('title', /int/);
});

test('invalid connections are rejected', async ({ page }) => {
  await createProject(page);
  const branch = await addNodeViaMenu(page, 'branch', 'core.branch');
  await branch.dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 700, y: 200 } });
  const str = await addNodeViaMenu(page, 'string', 'core.literal_string');
  await dragPin(page, str.getByTestId('pin-out-value'), branch.getByTestId('pin-in-condition'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  // exec → data is rejected too
  await dragPin(page, node(page, 'core.entry').getByTestId('pin-out-then'), branch.getByTestId('pin-in-condition'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
});

test('undo and redo', async ({ page }) => {
  await createProject(page);
  await addNodeViaMenu(page, 'print', 'core.print');
  await expect(node(page, 'core.print')).toHaveCount(1);
  await page.getByTestId('undo').click();
  await expect(node(page, 'core.print')).toHaveCount(0);
  await page.getByTestId('redo').click();
  await expect(node(page, 'core.print')).toHaveCount(1);
  await page.locator('.react-flow__pane').click({ position: { x: 50, y: 50 } });
  await page.keyboard.press('Control+z');
  await expect(node(page, 'core.print')).toHaveCount(0);
});

test('diagnostics are listed and focus their node', async ({ page }) => {
  await createProject(page);
  const w = await addNodeViaMenu(page, 'while', 'core.while');
  await dragPin(page, node(page, 'core.entry').getByTestId('pin-out-then'), w.getByTestId('pin-in-exec'), { expectEdge: true });
  await page.getByTestId('validate').click();
  await expect(page.getByTestId('diagnostic').first()).toContainText('needs a value for "Condition"');
  await page.getByTestId('diagnostic').first().click();
  await expect(page.getByTestId('node-inspector')).toContainText('While Loop');
});

test('examples open as editable graphs and reimport from an archive', async ({ page }) => {
  await page.getByTestId('example-movement-2d').click();
  await expect(await generatedCode(page)).toContainText('move_and_slide()');
  await page.getByTestId('export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-archive').click()]);
  await page.keyboard.press('Escape');
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import project' }).click();
  await (await chooser).setFiles((await download.path())!);
  await expect(page.getByTestId('project-title')).toHaveText('2D Character Movement');
  await expect(await generatedCode(page)).toContainText('velocity = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down") * speed');
});
