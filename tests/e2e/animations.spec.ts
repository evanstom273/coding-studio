/** Visual animations: a counter's number bounces when it changes, built with no code, running in Preview. */
import { expect, test } from '@playwright/test';
import { freshStart } from './helpers';

type St = { project: { scripts: { functions: { id: string; name: string; graph: { nodes: { id: string; type: string; props: Record<string, unknown> }[] } }[] }[] }; dispatch(o: unknown[], l: string): void; setSelection(s: { nodes: string[]; edges: string[] }): void };

test('make the heading bounce whenever the counter changes, then see it in Preview', async ({ page }) => {
  test.setTimeout(120_000);
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Bouncy');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  // the starter's heading shows the count instead of "My todos" (wired by the test), then gets an animation from the panel
  await page.evaluate(() => {
    const s = (window as never as { codingStudio: { editor: { getState(): St } } }).codingStudio.editor.getState();
    const fn = s.project.scripts[0].functions.find((f) => f.name === 'App')!;
    const h1 = fn.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'h1')!;
    s.dispatch([{ op: 'add_node', ref: 'c', graph: fn.id, type: 'core.get_var', props: { variable: 'count' }, position: { x: -200, y: 200 } }, { op: 'connect', graph: fn.id, from: { node: '$c', port: 'value' }, to: { node: h1.id, port: 'child_0' } }], 'test');
  });
  await page.locator('[data-testid="graph-node"]', { hasText: '<h1>' }).first().click();
  await expect(page.getByTestId('element-animations')).toBeVisible();
  await page.locator('[data-testid="animation-preset"][data-preset="Bounce"]').click();
  await expect(page.getByTestId('animation-chip')).toContainText('Bounce');
  await page.getByTestId('animation-trigger').locator('[data-value="change"]').click();
  // the timeline shows the preset's keyframes; drag one and the preview keeps playing
  await expect(page.getByTestId('keyframe')).toHaveCount(5);
  await page.getByTestId('kf-y').first().fill('-30');
  await page.getByTestId('kf-y').first().press('Enter');
  // wire the count into the new "Replay Bounce when this changes" pin
  await page.evaluate(() => {
    const s = (window as never as { codingStudio: { editor: { getState(): St } } }).codingStudio.editor.getState();
    const fn = s.project.scripts[0].functions.find((f) => f.name === 'App')!;
    const h1 = fn.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'h1')!;
    s.dispatch([{ op: 'add_node', ref: 'c2', graph: fn.id, type: 'core.get_var', props: { variable: 'count' }, position: { x: -200, y: 260 } }, { op: 'connect', graph: fn.id, from: { node: '$c2', port: 'value' }, to: { node: h1.id, port: 'anim_0' } }], 'test');
  });
  await expect(page.getByTestId('status-errors')).toHaveText('0 errors');
  // Preview: tapping the button changes the count, and the heading re-runs its bounce
  await page.getByTestId('open-preview').click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  const h1 = frame.locator('h1');
  await expect(h1).toHaveText('0', { timeout: 60_000 });
  expect(await h1.evaluate((e) => getComputedStyle(e).animationName)).toMatch(/^cs-bounce-/);
  await frame.locator('button', { hasText: 'Add a todo' }).click();
  await expect(h1).toHaveText('1');
  expect(await h1.evaluate((e) => getComputedStyle(e).animationName)).toMatch(/^cs-bounce-/);
});

test('the animation editor fits a phone', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Phone');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app' }).click();
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  // phones: select a node, then open its properties from the toolbar
  await page.locator('[data-testid="graph-node"]', { hasText: '<button>' }).first().click();
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(page.getByTestId('drawer-right')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('[data-testid="animation-preset"][data-preset="Pop"]').click();
  const track = await page.getByTestId('timeline-track').boundingBox();
  expect(track!.height).toBeGreaterThanOrEqual(36);
  expect(track!.x + track!.width).toBeLessThanOrEqual(392);
  // the canvas survives (it used to loop on phone layouts)
  await expect(page.getByText('Graph canvas crashed')).toHaveCount(0);
});
