import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolchainFor } from '@cs/toolchain';
import { applyOps, createProject, projectToJson, type EditOp } from '@cs/project-format';
import { freshStart, generatedCode } from './helpers';

test('a 400-node graph opens, stays interactive and compiles', async ({ page }) => {
  const tc = toolchainFor('gdscript');
  const p = createProject(tc.adapter, 'Large Graph', { template: 'node' });
  const f = p.scripts[0].functions[0];
  const ops: EditOp[] = [];
  const wires: EditOp[] = [];
  for (let i = 0; i < 200; i++) {
    ops.push({ op: 'add_node', ref: `p${i}`, graph: f.id, type: 'core.print', position: { x: (i % 20) * 260, y: Math.floor(i / 20) * 160 } }, { op: 'add_node', ref: `s${i}`, graph: f.id, type: 'core.literal_string', props: { value: `line ${i}` }, position: { x: (i % 20) * 260, y: Math.floor(i / 20) * 160 + 80 } });
    wires.push({ op: 'connect', from: { node: i === 0 ? f.graph.nodes[0].id : `$p${i - 1}`, port: 'then' }, to: { node: `$p${i}`, port: 'exec' } }, { op: 'connect', from: { node: `$s${i}`, port: 'value' }, to: { node: `$p${i}`, port: 'value' } });
  }
  const big = applyOps(p, [...ops, ...wires], tc).project;
  const file = join(mkdtempSync(join(tmpdir(), 'cs-big-')), 'large.vproj.json');
  writeFileSync(file, projectToJson(big));

  await freshStart(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import project' }).click();
  const t0 = Date.now();
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('project-title')).toHaveText('Large Graph');
  await expect(await generatedCode(page)).toContainText('print("line 199")', { timeout: 15_000 });
  const openMs = Date.now() - t0;

  // Interactive: drag a node and see it recorded as an undoable move.
  // Pick a node that is actually inside the visible canvas (the view is centred on the graph).
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!;
  const titles = page.locator('[data-testid="graph-node"][data-node-type="core.print"] [data-testid="node-title"]');
  let box = (await titles.first().boundingBox())!;
  for (let i = 0; i < (await titles.count()); i++) {
    const b = (await titles.nth(i).boundingBox())!;
    if (b.x > canvas.x + 50 && b.y > canvas.y + 50 && b.x + 200 < canvas.x + canvas.width && b.y + 100 < canvas.y + canvas.height) {
      box = b;
      break;
    }
  }
  const t1 = Date.now();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /Move node/);
  const dragMs = Date.now() - t1;
  console.log(`400 nodes: open+compile ${openMs} ms, drag ${dragMs} ms`);
  expect(dragMs).toBeLessThan(5000);
});
