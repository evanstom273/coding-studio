import { expect, type Page } from '@playwright/test';

export async function freshStart(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((res) => {
      const r = indexedDB.deleteDatabase('coding-studio');
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
  });
  await page.reload();
}

export async function createProject(page: Page, name = 'E2E Project') {
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText(name);
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
}

export function node(page: Page, type: string) {
  return page.locator(`[data-testid="graph-node"][data-node-type="${type}"]`);
}

/** Add a node through the search menu (Tab) and return its locator. */
export async function addNodeViaMenu(page: Page, query: string, type: string) {
  const before = await node(page, type).count();
  await page.locator('.react-flow__pane').click({ position: { x: 200, y: 400 } });
  await page.keyboard.press('Tab');
  await page.getByTestId('add-node-search').fill(query);
  await page.keyboard.press('Enter');
  await expect(node(page, type)).toHaveCount(before + 1);
  return node(page, type).nth(before);
}

export async function dragPin(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
}

export async function generatedCode(page: Page) {
  await page.getByTestId('bottom-tab-code').click();
  return page.getByTestId('code-text');
}
