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
