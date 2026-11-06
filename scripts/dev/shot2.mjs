import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
await p.goto('http://localhost:4173/');
await p.click('[data-testid="example-conditional-logic"]');
await p.waitForSelector('[data-testid="graph-node"]');
await p.waitForTimeout(2000);
await p.screenshot({ path: '/tmp/claude-0/shots/cond.png' });
await b.close();
