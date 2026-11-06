/** Packages panel: search npm, add a dependency, its types load into the editor; remove it. (npm/jsDelivr served from fixtures.) */
import { expect, test, type Page } from '@playwright/test';
import { freshStart } from './helpers';

const DEXIE_DTS = 'export interface Table<T> { get(key: number): Promise<T | undefined>; }\nexport declare class Dexie { constructor(name: string); table<T>(name: string): Table<T>; }\nexport default Dexie;\n';

async function fakeNpm(page: Page) {
  await page.route('https://registry.npmjs.org/**', (r) => r.fulfill({ json: { objects: [{ package: { name: 'dexie', version: '4.0.11', description: 'A Minimalistic Wrapper for IndexedDB' }, downloads: { weekly: 1 } }] } }));
  await page.route('https://data.jsdelivr.com/**', (r) => {
    const u = r.request().url();
    if (u.includes('/resolve/npm/dexie@')) return r.fulfill({ json: { version: '4.0.11' } });
    if (u.includes('/resolve/npm/')) return r.fulfill({ json: { version: null } });
    if (u.endsWith('/dexie@4.0.11/flat')) return r.fulfill({ json: { files: [{ name: '/dist/dexie.d.ts', size: DEXIE_DTS.length }, { name: '/dist/dexie.js', size: 10 }] } });
    return r.fulfill({ status: 404, json: {} });
  });
  await page.route('https://cdn.jsdelivr.net/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('/dexie@4.0.11/package.json')) return r.fulfill({ body: JSON.stringify({ name: 'dexie', version: '4.0.11', types: 'dist/dexie.d.ts' }), contentType: 'application/json' });
    if (u.endsWith('/dexie@4.0.11/dist/dexie.d.ts')) return r.fulfill({ body: DEXIE_DTS, contentType: 'text/plain' });
    return r.fulfill({ status: 404, body: '' });
  });
}

test('search npm, add dexie, its types work in a .ts file, remove it', async ({ page }) => {
  await freshStart(page);
  await fakeNpm(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Todo App');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();

  await page.getByTestId('left-tab-deps').click();
  await page.getByTestId('package-search').fill('dexie');
  await page.getByTestId('package-result').first().getByTestId('package-add').click();
  await expect(page.locator('[data-testid="dependency"][data-name="dexie"]')).toHaveAttribute('data-state', 'types', { timeout: 15_000 });
  const pkg = await page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> } } } } }).codingStudio.editor.getState().workspace.files.get('package.json')?.text);
  expect(JSON.parse(pkg!)).toMatchObject({ name: 'todo-app', dependencies: { dexie: '^4.0.11' } });

  // the types are known to the TypeScript service: a misuse is an error, correct use is not
  await page.evaluate(() =>
    (window as never as { codingStudio: { editor: { getState(): { applyFiles(o: unknown[], l: string): void } } } }).codingStudio.editor
      .getState()
      .applyFiles([{ op: 'write_file', path: 'db.ts', content: "import Dexie from 'dexie';\n\nexport const db = new Dexie('todos');\nexport const wrong: number = db.table<string>('t');\n" }], 'test'),
  );
  await page.getByTestId('bottom-tab-errors').click();
  await expect(page.getByTestId('file-diagnostic')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('file-diagnostic')).toContainText("'Table<string>' is not assignable to type 'number'");

  await page.locator('[data-testid="dependency"][data-name="dexie"]').hover();
  await page.getByTestId('dependency-remove').click();
  await expect(page.locator('[data-testid="dependency"]')).toHaveCount(0);
  await expect(page.getByTestId('file-diagnostic').first()).toContainText("Cannot find module 'dexie'", { timeout: 30_000 });
});
