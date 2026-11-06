/**
 * The editor under its real security headers (wrangler dev, or the deployed site with
 * SITE_URL=https://…): the Preview's esbuild-wasm runs, the app runs in its own frame page, types
 * load from jsDelivr, and nothing is blocked by the Content Security Policy.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 8791;
const SITE = process.env.SITE_URL ?? `http://127.0.0.1:${PORT}`;
let wrangler: ChildProcess | undefined;

test.beforeAll(async () => {
  if (process.env.SITE_URL) return;
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { stdio: 'ignore', detached: true });
  await expect.poll(async () => (await fetch(SITE).catch(() => null))?.status ?? 0, { timeout: 60_000 }).toBe(200);
});
test.afterAll(() => {
  if (wrangler?.pid) process.kill(-wrangler.pid);
});

function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|violates the following/i.test(m.text())) violations.push(m.text());
  });
  return violations;
}

async function fresh(page: Page) {
  await page.goto(SITE);
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((r) => {
      const q = indexedDB.deleteDatabase('coding-studio');
      q.onsuccess = q.onerror = q.onblocked = () => r();
    });
  });
  await page.reload();
}

async function newTs(page: Page, name: string, template: string) {
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: template }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText(name);
}

test('Preview works under the production CSP (esbuild-wasm + frame page)', async ({ page }) => {
  const csp = watchCsp(page);
  await fresh(page);
  await newTs(page, 'Csp Check', 'Async module');
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string }[] } }[] }[] }; dispatch(o: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const entry = fn.graph.nodes.find((n) => n.type === 'core.entry')!.id;
    st.dispatch([{ op: 'add_node', ref: 'p', graph: fn.id, type: 'core.print', inputs: { value: 'csp ok' } }, { op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: '$p', port: 'exec' } }, { op: 'update_project', entry: { function: fn.id } }], 'test');
  });
  await page.getByTestId('open-preview').click();
  await expect(page.getByTestId('preview-console')).toContainText('csp ok', { timeout: 60_000 });
  await expect(page.getByTestId('preview-errors')).toHaveCount(0);
  expect(csp).toEqual([]);
});

test('live: the Web app starter renders, types load, no CSP violations', async ({ page }) => {
  test.skip(!process.env.LIVE_NET && !process.env.SITE_URL, 'needs npm / jsDelivr / esm.sh');
  const csp = watchCsp(page);
  await fresh(page);
  await newTs(page, 'Starter Check', 'Web app (React');
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('h1')).toHaveText('My todos', { timeout: 90_000 });
  await frame.getByRole('button', { name: 'Add a todo' }).click();
  await expect(frame.locator('li').first()).toHaveText('Todo 1', { timeout: 20_000 });
  // React's types arrive from jsDelivr, so the JSX type error is gone
  await page.getByTestId('left-tab-deps').click();
  await expect(page.locator('[data-testid="dependency"][data-name="react"]')).toHaveAttribute('data-state', 'types', { timeout: 60_000 });
  await page.getByTestId('bottom-tab-errors').click();
  await expect.poll(async () => page.getByTestId('diagnostic').filter({ hasText: 'TypeScript' }).count(), { timeout: 60_000 }).toBe(0);
  expect(csp).toEqual([]);
});
