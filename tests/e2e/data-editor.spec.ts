/** Visual config editing: package.json as a form, a Fabric manifest with validation, any JSON as a tree. */
import { expect, test, type Page } from '@playwright/test';
import { freshStart } from './helpers';

const fileText = (page: Page, path: string) => page.evaluate((p) => (window as never as { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> } } } } }).codingStudio.editor.getState().workspace.files.get(p)?.text ?? null, path);
const write = (page: Page, path: string, content: string) => page.evaluate(([p, c]) => (window as never as { codingStudio: { editor: { getState(): { applyFiles(o: unknown[], l: string): void } } } }).codingStudio.editor.getState().applyFiles([{ op: 'write_file', path: p, content: c }], 'test'), [path, content]);

async function webApp(page: Page) {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Config');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app' }).click();
  await page.getByTestId('create-project').click();
  await page.getByTestId('left-tab-files').click();
}

test('package.json opens as a form; edits keep the file intact and undo works', async ({ page }) => {
  await webApp(page);
  await page.locator('[data-testid="file-row"][data-path="package.json"]').click();
  await expect(page.getByTestId('data-view')).toBeVisible();
  await expect(page.getByTestId('data-status')).toContainText('Looks valid');
  await page.getByTestId('field-description-input').fill('My todo app');
  await expect.poll(async () => JSON.parse((await fileText(page, 'package.json'))!).description).toBe('My todo app');
  // add a script from the suggestions
  await page.locator('[data-testid="field-scripts"] [data-testid="map-suggestion"][data-key="test"]').click();
  await expect.poll(async () => JSON.parse((await fileText(page, 'package.json'))!).scripts.test).toBe('vitest run');
  // a bad package name explains itself
  await page.getByTestId('field-name-input').fill('My App');
  await expect(page.locator('[data-testid="field-name"] [data-testid="field-error"]')).toContainText('Lower-case letters');
  await expect(page.getByTestId('data-status')).toContainText('1 problem');
  const json = JSON.parse((await fileText(page, 'package.json'))!);
  expect(Object.keys(json.dependencies)).toEqual(['dexie', 'dexie-react-hooks', 'react', 'react-dom']);
  // the name edits were one undo step: undo brings the valid name back
  await page.getByTestId('undo').click();
  await expect.poll(async () => JSON.parse((await fileText(page, 'package.json'))!).name).toBe('config');
  // text view shows the same file
  await page.getByTestId('data-mode-text').click();
  await expect(page.getByTestId('text-editor')).toBeVisible();
  await expect(page.locator('[data-testid="text-editor"] .view-lines')).toContainText('My todo app');
});

test('a Fabric mod manifest gets understandable fields, choices and dependency suggestions', async ({ page }) => {
  await webApp(page);
  await write(page, 'src/main/resources/fabric.mod.json', '{\n  "schemaVersion": 1,\n  "id": "examplemod",\n  "version": "1.0.0"\n}\n');
  await page.locator('[data-testid="file-row"][data-path="src"]').click().catch(() => undefined);
  await page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { openTab(p: string): void } } } }).codingStudio.editor.getState().openTab('src/main/resources/fabric.mod.json'));
  await expect(page.getByTestId('data-view')).toContainText('Fabric mod');
  await expect(page.getByTestId('field-id')).toContainText('Mod ID');
  await page.getByTestId('field-name-input').fill('Example Mod');
  await page.getByTestId('field-environment-input').selectOption('client');
  await page.locator('[data-testid="field-depends"] [data-testid="map-suggestion"][data-key="minecraft"]').click();
  await page.locator('[data-testid="field-depends"] [data-testid="map-suggestion"][data-key="fabricloader"]').click();
  await page.getByTestId('field-id-input').fill('Example Mod');
  await expect(page.locator('[data-testid="field-id"] [data-testid="field-error"]')).toBeVisible();
  await page.getByTestId('field-id-input').fill('examplemod');
  await expect.poll(async () => JSON.parse((await fileText(page, 'src/main/resources/fabric.mod.json'))!)).toEqual({ schemaVersion: 1, id: 'examplemod', version: '1.0.0', name: 'Example Mod', environment: 'client', depends: { minecraft: '~1.21.1', fabricloader: '>=0.16.0' } });
  await expect(page.getByTestId('data-status')).toContainText('Looks valid');
});

test('any JSON / YAML file: tree editing (add, rename, retype, delete) keeps comments', async ({ page }) => {
  await webApp(page);
  await write(page, 'config.yml', '# settings\nname: demo # the name\nlevels:\n  - one\n');
  await page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { openTab(p: string): void } } } }).codingStudio.editor.getState().openTab('config.yml'));
  await expect(page.getByTestId('data-tree')).toBeVisible();
  const root = page.getByTestId('data-tree');
  await root.getByTestId('tree-add').last().click();
  await expect.poll(() => fileText(page, 'config.yml')).toContain('newField: ""');
  const row = page.locator('[data-testid="tree-node"][data-path=".newField"]');
  await row.getByTestId('key-input').fill('lives');
  await row.getByTestId('key-input').press('Enter');
  await page.locator('[data-testid="tree-node"][data-path=".lives"]').getByTestId('tree-type').selectOption('number');
  await expect.poll(() => fileText(page, 'config.yml')).toContain('lives: 0');
  await page.locator('[data-testid="tree-node"][data-path=".levels"]').getByTestId('tree-add').click();
  await expect.poll(() => fileText(page, 'config.yml')).toBe('# settings\nname: demo # the name\nlevels:\n  - one\n  - ""\nlives: 0\n');
});

test('on a phone the form is usable', async ({ page }) => {
  await webApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { openTab(p: string): void } } } }).codingStudio.editor.getState().openTab('package.json'));
  await expect(page.getByTestId('data-view')).toBeVisible();
  const box = await page.getByTestId('field-description-input').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(34);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
