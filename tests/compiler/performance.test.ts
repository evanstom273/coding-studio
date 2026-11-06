/** Large graphs: hundreds of nodes must still compile and edit quickly. */
import { describe, expect, it } from 'vitest';
import { toolchainFor } from '@cs/toolchain';
import { compileScript } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp } from '@cs/project-format';

const tc = toolchainFor('gdscript');

function bigProject(chain: number) {
  const p = createProject(tc.adapter, 'Big', { template: 'node' });
  const f = p.scripts[0].functions[0];
  const nodes: EditOp[] = [{ op: 'add_variable', name: 'total', type: 'int', default: 0 }];
  const wires: EditOp[] = [];
  const link = (a: string, ap: string, b: string, bp: string) => wires.push({ op: 'connect', from: { node: a, port: ap }, to: { node: b, port: bp } });
  for (let i = 0; i < chain; i++) {
    // per step: a branch, a get, a compare and a set → 4 nodes
    nodes.push(
      { op: 'add_node', ref: `b${i}`, graph: f.id, type: 'core.branch', position: { x: i * 300, y: 0 } },
      { op: 'add_node', ref: `g${i}`, graph: f.id, type: 'core.get_var', props: { variable: 'total' }, position: { x: i * 300, y: 200 } },
      { op: 'add_node', ref: `c${i}`, graph: f.id, type: 'core.less', props: { type: 'int' }, inputs: { b: 1000 }, position: { x: i * 300, y: 300 } },
      { op: 'add_node', ref: `s${i}`, graph: f.id, type: 'core.set_var', props: { variable: 'total', operation: '+' }, inputs: { value: i }, position: { x: i * 300 + 150, y: 0 } },
    );
    link(i === 0 ? f.graph.nodes[0].id : `$s${i - 1}`, 'then', `$b${i}`, 'exec');
    if (i > 0) link(`$b${i - 1}`, 'false', `$b${i}`, 'exec');
    link(`$g${i}`, 'value', `$c${i}`, 'a');
    link(`$c${i}`, 'result', `$b${i}`, 'condition');
    link(`$b${i}`, 'true', `$s${i}`, 'exec');
  }
  return { p, ops: [...nodes, ...wires] };
}

describe('performance', () => {
  it('builds and compiles a 600-node graph quickly with correct merges', () => {
    const { p, ops } = bigProject(150);
    let t0 = performance.now();
    const project = applyOps(p, ops, tc).project;
    const applyMs = performance.now() - t0;
    expect(project.scripts[0].functions[0].graph.nodes.length).toBe(601);
    t0 = performance.now();
    const r = compileScript(tc, project.scripts[0]);
    const compileMs = performance.now() - t0;
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Each step is one flat "if" (merges are found, not duplicated or nested 150 deep).
    const body = r.files[0].content.split('func _ready() -> void:\n')[1].split('\n\n')[0];
    expect(body.split('\n').filter((l) => l.startsWith('\tif total < 1000:'))).toHaveLength(150);
    expect(body).not.toMatch(/^\t\t\tif/m);
    console.log(`600 nodes: applyOps ${applyMs.toFixed(0)} ms, compile ${compileMs.toFixed(0)} ms`);
    expect(compileMs).toBeLessThan(3000);
  });

  it('single edits on a large graph stay fast (copy-on-write)', () => {
    const { p, ops } = bigProject(150);
    const project = applyOps(p, ops, tc).project;
    const n = project.scripts[0].functions[0].graph.nodes[10].id;
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) applyOps(project, [{ op: 'move_nodes', nodes: [n], dx: 1, dy: 1 }], tc);
    expect((performance.now() - t0) / 50).toBeLessThan(40);
  });
});
