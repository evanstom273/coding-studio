// Screenshots of the editor at phone / foldable sizes (dev aid). Usage: node scripts/dev/mobile-shots.mjs <outdir>
import { chromium, devices } from '@playwright/test';
const out = process.argv[2] ?? 'test-results';
const b = await chromium.launch();
for (const [name, opts] of [
  ['phone', { ...devices['Pixel 7'] }],
  ['fold-inner', { viewport: { width: 734, height: 760 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true }],
]) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  await p.goto('http://localhost:4173/');
  await p.getByTestId('example-jump-gravity').click();
  await p.waitForSelector('[data-testid="graph-node"]');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/${name}-editor.png` });
  await p.getByTestId('open-left-drawer').tap();
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/${name}-drawer.png` });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, 'horizontal overflow:', overflow);
  await ctx.close();
}
await b.close();
