/** Packages panel: search npm, add a dependency, its types load into the editor; remove it. (npm/jsDelivr served from fixtures.) */
import { expect, test, type Page } from '@playwright/test';
import { freshStart, generatedCode } from './helpers';

const DEXIE_DTS = 'export interface Table<T = any> {\n  get(key: number): Promise<T | undefined>;\n  count(): Promise<number>;\n  add(item: T): Promise<number>;\n}\nexport declare class Dexie {\n  constructor(databaseName: string, options?: { autoOpen?: boolean });\n  table<T = any>(tableName: string): Table<T>;\n  close(): void;\n}\n/** Observe a query. */\nexport declare function liveQuery<T>(querier: () => T | Promise<T>): { subscribe(cb: (v: T) => void): void };\nexport default Dexie;\n';

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

test('library nodes: Dexie\'s classes, methods and functions in the palette build a graph that type-checks', async ({ page }) => {
  await freshStart(page);
  await fakeNpm(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Lib Nodes');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await page.getByTestId('left-tab-deps').click();
  await page.getByTestId('package-search').fill('dexie');
  await page.getByTestId('package-result').first().getByTestId('package-add').click();
  await expect(page.locator('[data-testid="dependency"][data-name="dexie"]')).toHaveAttribute('data-state', 'types', { timeout: 15_000 });

  // make main async so awaited library calls are offered awaited
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('function-row').filter({ hasText: 'main' }).click();
  await page.getByTestId('fn-async').check();

  // the catalog fills the palette (Library/dexie)
  await page.getByTestId('left-tab-nodes').click();
  await page.getByTestId('library-search').fill('dexie');
  await expect(page.getByTestId('library-item').filter({ hasText: 'new Dexie' })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('library-item').filter({ hasText: 'Dexie.table()' })).toHaveCount(1);
  await expect(page.getByTestId('library-item').filter({ hasText: 'Table.count()' })).toHaveCount(1);
  await expect(page.getByTestId('library-item').filter({ hasText: 'liveQuery()' })).toHaveCount(1);

  for (const t of ['new Dexie', 'Dexie.table()', 'Table.count()']) await page.getByTestId('library-item').filter({ hasText: t }).dblclick();
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string; props: Record<string, unknown> }[] } }[] }[] }; dispatch(ops: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const n = (pred: (x: { type: string; props: Record<string, unknown> }) => boolean) => fn.graph.nodes.find(pred)!.id;
    const entry = n((x) => x.type === 'core.entry');
    const create = n((x) => x.type === 'ts.new');
    const table = n((x) => x.type === 'ts.call_method' && x.props.name === 'table');
    const count = n((x) => x.type === 'ts.call_method' && x.props.name === 'count');
    st.dispatch(
      [
        { op: 'update_node', node: create, inputs: { arg_0: 'todos' } },
        { op: 'update_node', node: table, inputs: { arg_0: 'items' } },
        { op: 'add_node', ref: 'p', graph: fn.id, type: 'core.print' },
        { op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: create, port: 'exec' } },
        { op: 'connect', graph: fn.id, from: { node: create, port: 'then' }, to: { node: table, port: 'exec' } },
        { op: 'connect', graph: fn.id, from: { node: create, port: 'object' }, to: { node: table, port: 'object' } },
        { op: 'connect', graph: fn.id, from: { node: table, port: 'then' }, to: { node: count, port: 'exec' } },
        { op: 'connect', graph: fn.id, from: { node: table, port: 'result' }, to: { node: count, port: 'object' } },
        { op: 'connect', graph: fn.id, from: { node: count, port: 'then' }, to: { node: '$p', port: 'exec' } },
        { op: 'connect', graph: fn.id, from: { node: count, port: 'result' }, to: { node: '$p', port: 'value' } },
      ],
      'test',
    );
  });
  const code = await generatedCode(page);
  await expect(code).toContainText("import Dexie from 'dexie';");
  await expect(code).toContainText("let dexie = new Dexie('todos');");
  await expect(code).toContainText("let table_result = dexie.table('items');");
  await expect(code).toContainText('let count_result: number = await table_result.count();');
  await page.getByTestId('bottom-tab-errors').click();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('diagnostic').filter({ hasText: 'TypeScript:' })).toHaveCount(0);
  await expect(page.getByTestId('diagnostic')).toHaveCount(0);
});

test('live: real dexie and date-fns from npm produce library nodes', async ({ page }) => {
  test.skip(!process.env.LIVE_NET, 'needs the real npm registry and jsDelivr');
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Live');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await page.evaluate(() =>
    (window as never as { codingStudio: { editor: { getState(): { applyFiles(o: unknown[], l: string): void } } } }).codingStudio.editor
      .getState()
      .applyFiles([{ op: 'write_file', path: 'package.json', content: JSON.stringify({ name: 'live', dependencies: { dexie: '^4', 'date-fns': '^4' } }) }], 'test'),
  );
  const cat = () => page.evaluate(() => (window as never as { codingStudio: { catalog: { getState(): { byPackage: Record<string, { title: string }[]> } } } }).codingStudio.catalog.getState().byPackage);
  await expect.poll(async () => Object.keys(await cat()).sort(), { timeout: 90_000 }).toEqual(['date-fns', 'dexie']);
  const c = await cat();
  console.log('dexie', c.dexie.length, c.dexie.slice(0, 12).map((e) => e.title).join(' | '));
  console.log('date-fns', c['date-fns'].length, c['date-fns'].slice(0, 12).map((e) => e.title).join(' | '));
  expect(c.dexie.some((e) => e.title === 'new Dexie')).toBe(true);
  expect(c['date-fns'].some((e) => e.title === 'format()')).toBe(true);
});
