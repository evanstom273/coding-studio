/** Preview: the project bundled in the browser (esbuild-wasm) and run in a sandboxed iframe. */
import { expect, test, type Page } from '@playwright/test';
import { addNodeViaMenu, freshStart } from './helpers';

const files = (page: Page, ops: unknown[]) => page.evaluate((o) => (window as never as { codingStudio: { editor: { getState(): { applyFiles(o: unknown[], l: string): void } } } }).codingStudio.editor.getState().applyFiles(o, 'test'), ops);

async function tsProject(page: Page, name: string) {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-language').selectOption('typescript');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
}

test('runs hand-written code and graph code together, shows console output, links build errors', async ({ page }) => {
  await tsProject(page, 'Previewed');
  // the graph's main() prints; the page calls it
  await addNodeViaMenu(page, 'print', 'core.print');
  await page.evaluate(() => {
    const st = (window as never as { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; graph: { nodes: { id: string; type: string }[] } }[] }[] }; dispatch(o: unknown[], l: string): void } } } }).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions[0];
    const entry = fn.graph.nodes.find((n) => n.type === 'core.entry')!.id;
    const pr = fn.graph.nodes.find((n) => n.type === 'core.print')!.id;
    st.dispatch([{ op: 'connect', graph: fn.id, from: { node: entry, port: 'then' }, to: { node: pr, port: 'exec' } }, { op: 'update_node', node: pr, inputs: { value: 'hello from the graph' } }], 'test');
  });
  await files(page, [
    { op: 'write_file', path: 'index.html', content: '<!doctype html><html><head><title>App</title></head><body><h1 id="title">…</h1><script type="module" src="/src/app.ts"></script></body></html>' },
    { op: 'write_file', path: 'src/app.ts', content: "import { main } from '../main';\nimport './app.css';\ndocument.getElementById('title')!.textContent = 'Built in the browser';\nmain();\n" },
    { op: 'write_file', path: 'src/app.css', content: 'h1 { color: rgb(255, 0, 0); }\n' },
  ]);
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('#title')).toHaveText('Built in the browser', { timeout: 30_000 });
  await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(page.getByTestId('preview-console')).toContainText('hello from the graph');

  // edits rebuild automatically; a broken file shows its error with file:line
  await files(page, [{ op: 'write_file', path: 'src/app.ts', content: "import { main } from '../main';\nconst x = ;\n" }]);
  await expect(page.getByTestId('preview-errors')).toContainText('src/app.ts:2', { timeout: 15_000 });
  await page.getByTestId('preview-errors').getByRole('button').first().click();
  await expect(page.locator('[data-testid="tab"][data-tab="src/app.ts"]')).toHaveAttribute('aria-selected', 'true');
});

test('live: a React + esm.sh app renders in the preview', async ({ page }) => {
  test.skip(!process.env.LIVE_NET, 'needs esm.sh');
  await tsProject(page, 'React Live');
  await files(page, [
    { op: 'write_file', path: 'package.json', content: JSON.stringify({ name: 'r', dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' } }) },
    { op: 'write_file', path: 'index.html', content: '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
    { op: 'write_file', path: 'src/main.tsx', content: "import { useState } from 'react';\nimport { createRoot } from 'react-dom/client';\nfunction App() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>clicked {n}</button>;\n}\ncreateRoot(document.getElementById('root')!).render(<App />);\n" },
  ]);
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('button')).toHaveText('clicked 0', { timeout: 60_000 });
  await frame.locator('button').click();
  await expect(frame.locator('button')).toHaveText('clicked 1');
});

test('the Web app starter: graph component, files, packages', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Todo Demo');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app (React' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText('Todo Demo');
  await page.getByTestId('left-tab-files').click();
  for (const p of ['src', 'index.html', 'package.json', 'vite.config.ts']) await expect(page.locator(`[data-testid="file-row"][data-path="${p}"]`)).toBeVisible();
  await expect(page.getByTestId('code-file')).toHaveText('src/App.tsx');
  const code = await (await import('./helpers')).generatedCode(page);
  await expect(code).toContainText('const [count, setCount] = useState(0);');
  await expect(code).toContainText('<TodoList />');
  await page.getByTestId('left-tab-project').click();
  await page.getByTestId('function-row').filter({ hasText: 'App' }).first().click();
  await expect(page.getByTestId('fn-component')).toBeChecked();
});

test('live: the Web app starter runs in the preview (React, Tailwind, Dexie from esm.sh)', async ({ page }) => {
  test.skip(!process.env.LIVE_NET, 'needs esm.sh');
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Live Todos');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app (React' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-title')).toHaveText('Live Todos');
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('h1')).toHaveText('My todos', { timeout: 60_000 });
  await frame.getByRole('button', { name: 'Add a todo' }).click();
  await expect(frame.locator('li')).toHaveText('Todo 1', { timeout: 15_000 });
  await expect(frame.locator('button')).toHaveCSS('background-color', /rgb|oklch/);
});
