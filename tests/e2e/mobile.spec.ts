/** Phones and foldables: drawer layout, touch adding of nodes, no horizontal overflow. */
import { devices, expect, test } from '@playwright/test';
import { freshStart, node } from './helpers';

for (const [name, opts] of [
  ['phone (Pixel 7, portrait)', { viewport: devices['Pixel 7'].viewport, userAgent: devices['Pixel 7'].userAgent, deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor, isMobile: true, hasTouch: true }],
  ['foldable inner screen', { viewport: { width: 734, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 }],
] as const) {
  test.describe(name, () => {
    test.use(opts);

    test('canvas gets the screen; panels are drawers; nodes can be added by touch', async ({ page }) => {
      await freshStart(page);
      await page.getByTestId('new-project').tap();
      await page.getByTestId('create-project').tap();
      await expect(page.getByTestId('editor')).toHaveAttribute('data-layout', 'compact');

      const vp = page.viewportSize()!;
      const canvas = (await page.getByTestId('graph-canvas').boundingBox())!;
      expect(canvas.width).toBeGreaterThan(vp.width * 0.95);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // Navigation, MCP status and inspector stay reachable without scrolling the toolbar.
      for (const id of ['open-left-drawer', 'open-right-drawer', 'mcp-indicator']) {
        const b = (await page.getByTestId(id).boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
      }

      // Floating + button → search → add
      await page.getByTestId('fab-add-node').tap();
      await page.getByTestId('add-node-search').fill('print');
      await page.getByTestId('add-node-item').first().tap();
      await expect(node(page, 'core.print')).toHaveCount(1);

      // Node library in the left drawer: a tap adds the node and closes the drawer
      await page.getByTestId('open-left-drawer').tap();
      await page.getByTestId('left-tab-nodes').tap();
      await page.getByTestId('library-search').fill('branch');
      await page.getByTestId('library-item').first().tap();
      await expect(node(page, 'core.branch')).toHaveCount(1);
      await expect(page.getByTestId('drawer-backdrop')).toHaveCount(0);

      // Inspector drawer
      await page.getByTestId('open-right-drawer').tap();
      await expect(page.getByTestId('drawer-right')).toContainText('Inspector', { ignoreCase: true });
      await page.getByTestId('drawer-backdrop').tap({ position: { x: 10, y: 200 } });
      await expect(page.getByTestId('drawer-backdrop')).toHaveCount(0);

      // Code view still works
      await page.getByTestId('bottom-tab-code').tap();
      await expect(page.getByTestId('code-text')).toContainText('func _ready() -> void:');
    });
  });
}
