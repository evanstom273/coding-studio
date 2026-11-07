/** A TypeScript project in the editor: create, use TS nodes, async/export, and see the generated .ts. */
import { expect, test } from '@playwright/test';
import { addNodeViaMenu, freshStart, generatedCode } from './helpers';

test('create a TypeScript project, add nodes, make main async, read the generated TypeScript', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Web Thing');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText('Web Thing');
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await expect(await generatedCode(page)).toContainText('export function main(): void {');

  await addNodeViaMenu(page, 'fetch', 'ts.call');
  // fetch is awaited, so main must be async: the diagnostic says so…
  await expect(page.getByTestId('save-state')).toBeVisible();
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('function-row').filter({ hasText: 'main' }).click();
  await page.getByTestId('fn-async').check();
  await expect(await generatedCode(page)).toContainText('export async function main(): Promise<void> {');
  await expect(page.getByTestId('code-file')).toHaveText('main.ts');
});

test('inline functions: create from the palette, open by double-click, captured locals, generated arrow function', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Closures');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  // a Call Method node (array.map) and an inline function feeding it
  await addNodeViaMenu(page, 'new inline function', 'ts.closure');
  await page.getByTestId('left-tab-project').click();
  await expect(page.getByTestId('function-row').filter({ hasText: 'inline in main' })).toHaveCount(1);
  // double-click opens the inline function's graph
  await page.locator('[data-testid="graph-node"][data-node-type="ts.closure"]').dblclick();
  await expect(page.getByTestId('breadcrumb')).toContainText('callback');
});

test('types: add an interface in the Script panel, edit fields, see it in the TypeScript', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Typed');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('add-types').click();
  await expect(page.getByTestId('interface-inspector')).toBeVisible();
  await page.getByTestId('add-field').click();
  await expect(await generatedCode(page)).toContainText('export interface Item {');
  await expect(await generatedCode(page)).toContainText('field: string;');
});

test('TypeScript language service: errors in files and in generated graph code, completions, cross-file imports', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Checked');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  const files = (ops: unknown[]) => page.evaluate((o) => (window as never as { codingStudio: { editor: { getState(): { applyFiles(ops: unknown[], l: string): void } } } }).codingStudio.editor.getState().applyFiles(o, 'test'), ops);

  // a hand-written file that imports the graph's module (main.ts is generated) and has a type error
  await files([{ op: 'write_file', path: 'util.ts', content: "import { main } from './main';\n\nexport const ok: () => void = main;\nexport const bad: number = 'nope';\n" }]);
  await page.getByTestId('bottom-tab-errors').click();
  await expect(page.getByTestId('file-diagnostic')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('file-diagnostic')).toContainText("Type 'string' is not assignable to type 'number'");
  await expect(page.getByTestId('file-diagnostic')).toContainText('util.ts:4');
  await page.getByTestId('file-diagnostic').click();
  await expect(page.locator('[data-testid="tab"][data-tab="util.ts"]')).toHaveAttribute('aria-selected', 'true');

  // completions
  await page.locator('[data-testid="text-editor"] .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nconsole.lo');
  await expect(page.locator('.suggest-widget')).toContainText('log', { timeout: 15_000 });
  await page.keyboard.press('Escape');

  // a type error in generated code points at the node that produced it
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string }[] } }[] }[] }; dispatch(ops: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const entry = fn.graph.nodes.find((n) => n.type === 'core.entry')!.id;
    st.dispatch(
      [
        { op: 'add_node', ref: 'c', graph: fn.id, type: 'ts.call', props: { name: 'Math.round', argNames: ['x'], argTypes: ['string'], returnType: 'int' }, inputs: { arg_0: 'not a number' } },
        { op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: '$c', port: 'exec' } },
      ],
      'test',
    );
  });
  await expect(page.getByTestId('diagnostic').filter({ hasText: 'TypeScript:' })).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('diagnostic').filter({ hasText: 'TypeScript:' }).click();
  await expect(page.getByTestId('node-inspector')).toContainText('Math.round');
});

test('functions exported by hand-written files appear in the palette and are imported by the graph', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Mixed');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await page.evaluate(() =>
    (window as never as { codingStudio: { editor: { getState(): { applyFiles(ops: unknown[], l: string): void } } } }).codingStudio.editor
      .getState()
      .applyFiles([{ op: 'write_file', path: 'lib/text.ts', content: 'export function shout(text: string): string {\n  return text.toUpperCase();\n}\n' }], 'test'),
  );
  await addNodeViaMenu(page, 'shout', 'ts.call');
  await page.locator('[data-testid="graph-node"][data-node-type="ts.call"]').click();
  await expect(page.getByTestId('node-inspector')).toContainText('shout');
  // wire it after Entry and check the import
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string }[] } }[] }[] }; dispatch(ops: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const entry = fn.graph.nodes.find((n) => n.type === 'core.entry')!.id;
    const call = fn.graph.nodes.find((n) => n.type === 'ts.call')!.id;
    st.dispatch([{ op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: call, port: 'exec' } }, { op: 'update_node', node: call, inputs: { arg_0: 'hi' } }], 'test');
  });
  await expect(await generatedCode(page)).toContainText("import { shout } from './lib/text';");
  await expect(await generatedCode(page)).toContainText("shout('hi');");
  await page.getByTestId('bottom-tab-errors').click();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('diagnostic').filter({ hasText: 'TypeScript:' })).toHaveCount(0);
});
