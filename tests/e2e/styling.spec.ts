/** Visual styling: a React element's Tailwind classes and a CSS file, without typing CSS. */
import { expect, test, type Page } from '@playwright/test';
import { freshStart } from './helpers';

type W = { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> }; project: { scripts: { functions: { name: string; graph: { nodes: { id: string; type: string; props: Record<string, unknown>; inputs?: Record<string, unknown> }[] } }[] }[] }; setSelection(s: { nodes: string[]; edges: string[] }): void; applyFiles(o: unknown[], l: string): void; openTab(p: string): void } } } };
const buttonClasses = (page: Page) => page.evaluate(() => (window as never as W).codingStudio.editor.getState().project.scripts[0].functions.find((f) => f.name === 'App')!.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'button')!.inputs!.attr_className as string);

/** Open a style section (only if it's closed). */
async function section(page: Page, title: string) {
  const sec = page.locator(`[data-testid="style-section"][data-title="${title}"]`);
  if ((await sec.locator('> div').count()) === 0) await sec.locator('> button').click();
}

async function webApp(page: Page) {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Styled');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
}

test('style a React button visually: classes are written, unknown classes kept, undo works', async ({ page }) => {
  await webApp(page);
  expect(await buttonClasses(page)).toBe('mt-3 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500');
  await page.locator('[data-testid="graph-node"]', { hasText: '<button>' }).first().click();
  await expect(page.getByTestId('element-style')).toBeVisible();
  // existing classes are understood
  await expect(page.locator('[data-testid="style-padding"]')).toBeVisible();
  // round corners, bigger bold text
  await section(page, 'Border');
  await page.getByTestId('style-rounded-full').click();
  await expect.poll(() => buttonClasses(page)).toContain('rounded-full');
  await section(page, 'Text');
  await page.getByTestId('style-fontSize').fill('18');
  await page.getByTestId('style-fontSize').press('Enter');
  await page.getByTestId('style-fontWeight').selectOption('700');
  await expect.poll(() => buttonClasses(page)).toMatch(/text-lg/);
  expect(await buttonClasses(page)).toMatch(/font-bold/);
  // hover state: a different background from the palette
  await page.locator('[data-testid="style-states"] [data-state="hover"]').click();
  await section(page, 'Background');
  await page.locator('[data-testid="style-backgroundColor"] [aria-label="Swatches"]').click();
  await page.locator('[data-testid="palette"] [data-color="emerald-500"]').click();
  await expect.poll(() => buttonClasses(page)).toContain('hover:bg-emerald-500');
  const cls = await buttonClasses(page);
  expect(cls).toContain('bg-indigo-600');
  expect(cls).toContain('mt-3');
  expect(cls).not.toContain('hover:bg-indigo-500');
  // a class the editor doesn't model survives edits
  await page.evaluate(() => {
    const st = (window as never as W).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions.find((f) => f.name === 'App')!;
    const b = fn.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'button')!;
    (st as unknown as { dispatch(o: unknown[], l: string): void }).dispatch([{ op: 'update_node', node: b.id, inputs: { attr_className: `${b.inputs!.attr_className} animate-pulse group` } }], 'x');
  });
  await page.locator('[data-testid="style-states"] [data-state="normal"]').click();
  await section(page, 'Effects');
  await page.getByTestId('style-shadow').locator('[data-value="lg"]').click();
  await expect.poll(() => buttonClasses(page)).toContain('shadow-lg');
  expect(await buttonClasses(page)).toMatch(/animate-pulse group$/);
  await expect(page.getByTestId('style-other-classes')).toContainText('animate-pulse group');
  // undo removes the last change
  await page.getByTestId('undo').click();
  await expect.poll(() => buttonClasses(page)).not.toContain('shadow-lg');
});

test('a CSS file opens as styles; visual edits keep comments and unknown declarations', async ({ page }) => {
  await webApp(page);
  await page.evaluate(() => {
    const st = (window as never as W).codingStudio.editor.getState();
    st.applyFiles([{ op: 'write_file', path: 'src/styles.css', content: '/* Buttons */\n.btn {\n  padding: 4px;\n  -webkit-tap-highlight-color: transparent;\n}\n' }], 'test');
    st.openTab('src/styles.css');
  });
  await expect(page.getByTestId('css-view')).toBeVisible();
  await expect(page.locator('[data-testid="css-style"][data-selector=".btn"]')).toBeVisible();
  await expect(page.getByTestId('css-other')).toContainText('-webkit-tap-highlight-color: transparent');
  await page.getByTestId('style-padding-all').fill('12');
  await page.getByTestId('style-padding-all').press('Enter');
  await section(page, 'Border');
  await page.getByTestId('style-rounded-full').click();
  const text = () => page.evaluate(() => (window as never as W).codingStudio.editor.getState().workspace.files.get('src/styles.css')!.text);
  await expect.poll(text).toBe('/* Buttons */\n.btn {\n  padding: 12px;\n  -webkit-tap-highlight-color: transparent;\n  border-radius: 9999px;\n}\n');
  // a hover style and a tablet size, as separate rules
  await page.locator('[data-testid="style-states"] [data-state="hover"]').click();
  await section(page, 'Effects');
  await page.getByTestId('style-shadow').locator('[data-value="md"]').click();
  await expect.poll(text).toContain('.btn:hover {\n  box-shadow:');
  // add another style
  await page.getByTestId('css-new-selector').fill('.card');
  await page.getByTestId('css-add').click();
  await expect(page.locator('[data-testid="css-style"][data-selector=".card"]')).toBeVisible();
  await page.getByTestId('style-display').locator('[data-value="flex"]').click();
  await page.getByTestId('style-gap').fill('16');
  await page.getByTestId('style-gap').press('Enter');
  await expect.poll(text).toContain('.card {\n  display: flex;\n  gap: 16px;\n}');
  expect(await text()).toContain('/* Buttons */');
  await page.getByTestId('css-mode-text').click();
  await expect(page.getByTestId('text-editor')).toHaveAttribute('data-readonly', 'true');
});

test('the style editor fits a phone screen', async ({ page }) => {
  await webApp(page);
  await page.evaluate(() => {
    const st = (window as never as W).codingStudio.editor.getState();
    st.applyFiles([{ op: 'write_file', path: 'src/styles.css', content: '.btn { color: red; }\n' }], 'test');
    st.openTab('src/styles.css');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('style-editor')).toBeVisible();
  const box = await page.getByTestId('style-editor').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(392);
  const pad = await page.getByTestId('style-padding-all').boundingBox();
  expect(pad!.height).toBeGreaterThanOrEqual(34);
});

test('visual styles apply in the running app (Preview)', async ({ page }) => {
  test.setTimeout(120_000);
  await webApp(page);
  await page.locator('[data-testid="graph-node"]', { hasText: '<button>' }).first().click();
  await section(page, 'Border');
  await page.getByTestId('style-rounded-full').click();
  await section(page, 'Text');
  await page.getByTestId('style-fontSize').fill('24');
  await page.getByTestId('style-fontSize').press('Enter');
  await expect.poll(() => buttonClasses(page)).toContain('text-2xl');
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  const btn = frame.locator('button', { hasText: 'Add a todo' });
  await expect(btn).toBeVisible({ timeout: 60_000 });
  // rounded-full is an "infinite" radius; browsers report it as a very large number of pixels
  await expect.poll(() => btn.evaluate((b) => parseFloat(getComputedStyle(b).borderTopLeftRadius)), { timeout: 30_000 }).toBeGreaterThan(1000);
  expect(await btn.evaluate((b) => getComputedStyle(b).fontSize)).toBe('24px');
});
