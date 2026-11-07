/**
 * Phase 2: file explorer, tabs, text editing, previews, search, generated files, conflicts, zip.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createProject, freshStart } from './helpers';

const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
const tab = (page: Page, id: string) => page.locator(`[data-testid="tab"][data-tab="${id}"]`);

async function newEntry(page: Page, kind: 'file' | 'folder', name: string, inFolder?: string) {
  if (inFolder) {
    await row(page, inFolder).click({ button: 'right' });
    await page.getByRole('menuitem', { name: kind === 'file' ? 'New file' : 'New folder' }).click();
  } else await page.getByTestId(kind === 'file' ? 'new-file' : 'new-folder').click();
  await page.getByTestId('file-name-input').fill(name);
  await page.getByTestId('file-name-input').press('Enter');
}

async function typeInEditor(page: Page, text: string) {
  await page.locator('[data-testid="text-editor"] .monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

const fileText = (page: Page, path: string) => page.evaluate((p) => (window as never as { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> } } } } }).codingStudio.editor.getState().workspace.files.get(p)?.text ?? null, path);

test.beforeEach(async ({ page }) => {
  await freshStart(page);
  await createProject(page, 'Files Project');
  if ((page.viewportSize()?.width ?? 0) > 800) await page.getByTestId('left-tab-files').click();
});

test('folders, files, editing, rename/move with tabs following, undo across files', async ({ page }) => {
  await expect(row(page, 'codingstudio.json')).toBeVisible();
  await expect(row(page, 'main.vgraph')).toBeVisible();
  await newEntry(page, 'folder', 'src');
  await expect(row(page, 'src')).toBeVisible();
  // visual-only: code files can't be made by typing
  await newEntry(page, 'file', 'code.ts', 'src');
  await expect(row(page, 'src/code.ts')).toHaveCount(0);
  await newEntry(page, 'file', 'app.md', 'src');
  await expect(tab(page, 'src/app.md')).toHaveAttribute('aria-selected', 'true');
  await typeInEditor(page, 'the answer is 42');
  await expect.poll(() => fileText(page, 'src/app.md')).toBe('the answer is 42');

  // a stylesheet is created empty and opens in the visual style editor
  await newEntry(page, 'file', 'styles/site.css');
  await expect(page.getByTestId('css-view')).toBeVisible();
  await newEntry(page, 'file', 'README.md');
  await typeInEditor(page, '# Hello');
  await expect.poll(() => fileText(page, 'README.md')).toBe('# Hello');
  await expect(row(page, 'styles')).toBeVisible();

  // rename a file with its tab open: the tab follows
  await tab(page, 'src/app.md').click();
  await row(page, 'src/app.md').click({ button: 'right' });
  await page.getByTestId('menu-rename').click();
  await page.getByTestId('file-name-input').fill('main.md');
  await page.getByTestId('file-name-input').press('Enter');
  await expect(tab(page, 'src/main.md')).toBeVisible();
  await expect(tab(page, 'src/app.md')).toHaveCount(0);
  await expect.poll(() => fileText(page, 'src/main.md')).toBe('the answer is 42');

  // move a folder by dragging it into another: open tabs follow
  await newEntry(page, 'folder', 'lib');
  await row(page, 'src').dragTo(row(page, 'lib'));
  await expect(row(page, 'lib/src')).toBeVisible();
  await expect(tab(page, 'lib/src/main.md')).toBeVisible();

  // undo across files: the move, then the rename
  await page.locator('.react-flow__pane, [data-testid="tab-bar"]').first().click();
  await page.getByTestId('undo').click();
  await expect(tab(page, 'src/main.md')).toBeVisible();
  await expect.poll(() => fileText(page, 'src/main.md')).toBe('the answer is 42');
  await page.getByTestId('redo').click();
  await expect(tab(page, 'lib/src/main.md')).toBeVisible();

  // delete a folder (confirmed), undo brings it back
  await row(page, 'styles').click({ button: 'right' });
  await page.getByTestId('menu-delete').click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'styles')).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(row(page, 'styles')).toBeVisible();

  // everything persists across a reload (tabs too)
  await page.getByTestId('save').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await page.getByTestId('left-tab-files').click();
  await expect(row(page, 'lib')).toBeVisible();
  await expect(tab(page, 'README.md')).toBeVisible();
  await expect.poll(() => fileText(page, 'styles/site.css')).toBe('');
});

test('graph tabs, generated files, uploads with previews, and search', async ({ page }) => {
  // graph files open the canvas; generated code is read-only with a way back
  await expect(tab(page, 'main.vgraph')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.react-flow__pane')).toBeVisible();
  await page.getByTestId('generated-row').first().click();
  await expect(page.getByTestId('generated-view')).toContainText('main.gd');
  await page.getByTestId('open-graph').click();
  await expect(page.locator('.react-flow__pane')).toBeVisible();

  // upload an image → preview
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('upload-files').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await row(page, 'dot.png').click();
  await expect(page.getByTestId('image-preview')).toBeVisible();

  // search finds text and opens the file at the line
  await newEntry(page, 'file', 'notes.md');
  await typeInEditor(page, 'line one\nfind the needle here\n');
  await expect.poll(() => fileText(page, 'notes.md')).toContain('needle');
  await page.getByTestId('left-tab-search').click();
  await page.getByTestId('search-input').fill('needle');
  await expect(page.getByTestId('search-hit')).toHaveCount(1);
  await tab(page, 'main.vgraph').click();
  await page.getByTestId('search-hit').click();
  await expect(tab(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
});

test('a file changed elsewhere while typing shows keep-mine / use-theirs', async ({ page }) => {
  await newEntry(page, 'file', 'shared.txt');
  await typeInEditor(page, 'v1');
  await expect.poll(() => fileText(page, 'shared.txt')).toBe('v1');
  // type, and before it is written, someone else (e.g. Claude) changes the file
  await typeInEditor(page, ' mine');
  await page.evaluate(() => {
    const ed = (window as never as { codingStudio: { editor: { getState(): { applyFiles(ops: unknown[], label: string): void } } } }).codingStudio.editor;
    ed.getState().applyFiles([{ op: 'write_file', path: 'shared.txt', content: 'theirs' }], 'Claude edit');
  });
  await expect(page.getByTestId('file-conflict')).toBeVisible();
  await page.getByTestId('conflict-keep-mine').click();
  await expect.poll(() => fileText(page, 'shared.txt')).toBe('v1 mine');
  // and the other way
  await typeInEditor(page, '!');
  await page.evaluate(() => {
    const ed = (window as never as { codingStudio: { editor: { getState(): { applyFiles(ops: unknown[], label: string): void } } } }).codingStudio.editor;
    ed.getState().applyFiles([{ op: 'write_file', path: 'shared.txt', content: 'theirs again' }], 'Claude edit');
  });
  await page.getByTestId('conflict-use-theirs').click();
  await expect.poll(() => fileText(page, 'shared.txt')).toBe('theirs again');
  await expect(page.locator('[data-testid="text-editor"] .view-lines')).toContainText('theirs again');
  // an external change with no pending typing just appears
  await page.evaluate(() => {
    const ed = (window as never as { codingStudio: { editor: { getState(): { applyFiles(ops: unknown[], label: string): void } } } }).codingStudio.editor;
    ed.getState().applyFiles([{ op: 'write_file', path: 'shared.txt', content: 'quiet update' }], 'Claude edit');
  });
  await expect(page.locator('[data-testid="text-editor"] .view-lines')).toContainText('quiet update');
  await expect(page.getByTestId('file-conflict')).toHaveCount(0);
});

test('workspace zip export and re-import keeps every file', async ({ page }) => {
  await newEntry(page, 'file', 'docs/guide.md');
  await typeInEditor(page, '# Guide');
  await expect.poll(() => fileText(page, 'docs/guide.md')).toBe('# Guide');
  await page.getByTestId('export').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-workspace').click()]);
  const path = await dl.path();
  await page.keyboard.press('Escape');
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import project' }).click();
  await (await chooser).setFiles({ name: 'Files Project.zip', mimeType: 'application/zip', buffer: readFileSync(path!) });
  await expect(page.getByTestId('project-title')).toHaveText('Files Project');
  await page.getByTestId('left-tab-files').click();
  await expect(row(page, 'docs')).toBeVisible();
  await expect.poll(() => fileText(page, 'docs/guide.md')).toBe('# Guide');
  await expect(row(page, 'main.vgraph')).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
  test('the explorer lives in the drawer and opens files full-screen', async ({ page }) => {
    await page.getByTestId('open-left-drawer').click();
    await page.getByTestId('left-tab-files').click();
    await newEntry(page, 'file', 'notes.txt');
    await expect(page.getByTestId('drawer-left')).toHaveAttribute('aria-hidden', 'false');
    await page.getByTestId('drawer-backdrop').click({ position: { x: 400, y: 400 } });
    await expect(tab(page, 'notes.txt')).toHaveAttribute('aria-selected', 'true');
    await typeInEditor(page, 'from my phone');
    await expect.poll(() => fileText(page, 'notes.txt')).toBe('from my phone');
    await page.getByTestId('open-left-drawer').click();
    await row(page, 'main.vgraph').click();
    await expect(page.getByTestId('drawer-left')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.react-flow__pane')).toBeVisible();
  });
});
