/** Entry points in the editor: mark a function as where the program starts; Preview runs it. */
import { expect, test } from '@playwright/test';
import { addNodeViaMenu, createProject, freshStart } from './helpers';

test('TypeScript: "Program starts here" generates a launcher and the Preview runs main()', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Starts');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Async module' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await addNodeViaMenu(page, 'print', 'core.print');
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string }[] } }[] }[] }; dispatch(o: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const entry = fn.graph.nodes.find((n) => n.type === 'core.entry')!.id;
    const pr = fn.graph.nodes.find((n) => n.type === 'core.print')!.id;
    st.dispatch([{ op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: pr, port: 'exec' } }, { op: 'update_node', node: pr, inputs: { value: 'the program started' } }], 'test');
  });
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('function-row').filter({ hasText: 'main' }).click();
  await page.getByTestId('entry-toggle').check();
  await expect(page.getByTestId('function-row').filter({ hasText: '▶ main' })).toHaveCount(1);
  await expect(page.getByTestId('entry-instructions')).toContainText('main.entry.ts starts main() and waits for it');
  await page.getByTestId('left-tab-files').click();
  await expect(page.getByTestId('generated-row').filter({ hasText: 'main.entry.ts' })).toHaveCount(1);
  await page.getByTestId('open-preview').click();
  await expect(page.getByTestId('preview-console')).toContainText('the program started', { timeout: 30_000 });
});

test('GDScript: the entry point runs from _ready and gets a main scene', async ({ page }) => {
  await freshStart(page);
  await createProject(page, 'Godot Start');
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('add-functions').click();
  await page.getByTestId('entry-toggle').check();
  await expect(page.getByTestId('entry-instructions')).toContainText('Main Scene');
  await page.getByTestId('left-tab-files').click();
  await expect(page.getByTestId('generated-row').filter({ hasText: 'main.tscn' })).toHaveCount(1);
  await page.getByTestId('entry-host').selectOption('autoload').catch(async () => {
    await page.getByTestId('left-tab-project').click();
    await page.getByTestId('entry-host').selectOption('autoload');
  });
  await expect(page.getByTestId('generated-row').filter({ hasText: 'main.tscn' })).toHaveCount(0);
});
