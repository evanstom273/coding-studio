// Smoke test of a served build (e.g. `wrangler dev`): app loads under the production CSP,
// opens an example, compiles in the worker and renders Monaco. Usage: node scripts/dev/csp-check.mjs [baseUrl]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) && errs.push('console ' + m.text()));
await p.goto(base + '/');
await p.click('[data-testid="example-timer"]');
await p.waitForSelector('[data-testid="graph-node"]');
await p.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
await p.waitForTimeout(1500);
const code = await p.textContent('[data-testid="code-text"]');
const monacoText = await p.textContent('.monaco-editor .view-lines');
console.log('code ok:', code.includes('Timer.new()'), '| monaco rendered:', monacoText.includes('extends'));
await p.screenshot({ path: process.env.SHOT ?? 'test-results/served-build.png' });
console.log(errs.join('\n') || 'no console errors');
await b.close();
process.exit(errs.length ? 1 : 0);
