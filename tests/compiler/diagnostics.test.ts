/**
 * Error handling: invalid graphs produce precise diagnostics and never emit source.
 * Some documents are built by hand because the edit operations would refuse to create them.
 */
import { describe, expect, it } from 'vitest';
import { toolchainFor } from '@cs/toolchain';
import { compileScript } from '@cs/compiler-core';
import { applyOps, createFunction, createProject, type Project } from '@cs/project-format';
import type { GraphNode } from '@cs/graph-core';

const tc = toolchainFor('gdscript');

function setup(): { p: Project; fnId: string; entry: string } {
  const p = createProject(tc.adapter, 'D', { template: 'node' });
  const f = p.scripts[0].functions.find((x) => x.name === '_ready')!;
  return { p, fnId: f.id, entry: f.graph.nodes[0].id };
}

const codes = (p: Project) => {
  const r = compileScript(tc, p.scripts[0]);
  if (!r.ok) expect(r.files).toEqual([]);
  return r.diagnostics.map((d) => d.code);
};

describe('diagnostics', () => {
  it('missing required input', () => {
    const { p, fnId, entry } = setup();
    const q = applyOps(p, [
      { op: 'add_node', ref: 'w', graph: fnId, type: 'core.while' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$w', port: 'exec' } },
    ], tc).project;
    expect(codes(q)).toContain('E_MISSING_INPUT');
  });

  it('value used outside the branch that computed it', () => {
    const { p, fnId, entry } = setup();
    const q = applyOps(p, [
      { op: 'add_function', ref: 'g', name: 'get_five', returnType: 'int' },
      { op: 'add_node', ref: 'r', graph: '$g', type: 'core.return', inputs: { value: 5 } },
      { op: 'connect', from: { node: '$g.entry', port: 'then' }, to: { node: '$r', port: 'exec' } },
      { op: 'add_node', ref: 'br', graph: fnId, type: 'core.branch' },
      { op: 'add_node', ref: 'call', graph: fnId, type: 'core.call_function', props: { function: 'get_five' } },
      { op: 'add_node', ref: 'pr', graph: fnId, type: 'core.print' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$br', port: 'exec' } },
      { op: 'connect', from: { node: '$br', port: 'true' }, to: { node: '$call', port: 'exec' } },
      { op: 'connect', from: { node: '$br', port: 'false' }, to: { node: '$pr', port: 'exec' } },
      { op: 'connect', from: { node: '$call', port: 'result' }, to: { node: '$pr', port: 'value' } },
    ], tc).project;
    expect(codes(q)).toContain('E_VALUE_NOT_AVAILABLE');
  });

  it('missing return on some path', () => {
    const { p } = setup();
    const q = applyOps(p, [
      { op: 'add_function', ref: 'g', name: 'sign_of', params: [{ name: 'x', type: 'int' }], returnType: 'int' },
      { op: 'add_node', ref: 'br', graph: '$g', type: 'core.branch' },
      { op: 'add_node', ref: 'r', graph: '$g', type: 'core.return', inputs: { value: 1 } },
      { op: 'connect', from: { node: '$g.entry', port: 'then' }, to: { node: '$br', port: 'exec' } },
      { op: 'connect', from: { node: '$br', port: 'true' }, to: { node: '$r', port: 'exec' } },
    ], tc).project;
    expect(codes(q)).toContain('E_MISSING_RETURN');
  });

  it('break outside a loop, unreachable nodes and unused pure nodes', () => {
    const { p, fnId, entry } = setup();
    const q = applyOps(p, [
      { op: 'add_node', ref: 'b', graph: fnId, type: 'core.break' },
      { op: 'add_node', ref: 'lonely', graph: fnId, type: 'core.print' },
      { op: 'add_node', graph: fnId, type: 'core.add' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$b', port: 'exec' } },
    ], tc).project;
    const c = codes(q);
    expect(c).toContain('E_BREAK_OUTSIDE_LOOP');
    expect(c).toContain('W_UNREACHABLE');
    expect(c).toContain('I_UNUSED_NODE');
  });

  it('exec cycles in a hand-edited document', () => {
    const { p, fnId, entry } = setup();
    const q = applyOps(p, [
      { op: 'add_node', ref: 'a', graph: fnId, type: 'core.print' },
      { op: 'add_node', ref: 'b', graph: fnId, type: 'core.print' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$a', port: 'exec' } },
      { op: 'connect', from: { node: '$a', port: 'then' }, to: { node: '$b', port: 'exec' } },
    ], tc);
    const g = q.project.scripts[0].functions.find((f) => f.id === fnId)!.graph;
    g.edges.push({ id: 'e_cycle', from: { node: q.created.b, port: 'then' }, to: { node: q.created.a, port: 'exec' } });
    expect(codes(q.project)).toContain('E_EXEC_CYCLE');
  });

  it('type mismatches, dangling edges, unknown nodes and fan-in in hand-edited documents', () => {
    const { p, fnId, entry } = setup();
    const r = applyOps(p, [
      { op: 'add_node', ref: 'pr', graph: fnId, type: 'core.print' },
      { op: 'add_node', ref: 'br', graph: fnId, type: 'core.branch' },
      { op: 'add_node', ref: 's', graph: fnId, type: 'core.literal_string' },
      { op: 'add_node', ref: 's2', graph: fnId, type: 'core.literal_string' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$br', port: 'exec' } },
    ], tc);
    const g = r.project.scripts[0].functions.find((f) => f.id === fnId)!.graph;
    g.edges.push({ id: 'e_bad', from: { node: r.created.s, port: 'value' }, to: { node: r.created.br, port: 'condition' } });
    g.edges.push({ id: 'e_dangle', from: { node: 'n_gone', port: 'value' }, to: { node: r.created.pr, port: 'value' } });
    g.edges.push({ id: 'e_fan1', from: { node: r.created.s, port: 'value' }, to: { node: r.created.pr, port: 'value' } });
    g.edges.push({ id: 'e_fan2', from: { node: r.created.s2, port: 'value' }, to: { node: r.created.pr, port: 'value' } });
    g.nodes.push({ id: 'n_alien', type: 'unknown.thing', position: { x: 0, y: 0 }, props: {}, inputs: {} } as GraphNode);
    const c = codes(r.project);
    expect(c).toEqual(expect.arrayContaining(['E_TYPE_MISMATCH', 'E_DANGLING_EDGE', 'E_UNKNOWN_NODE', 'E_MULTIPLE_INPUTS']));
  });

  it('declaration problems: duplicates, reserved words, bad types, shadowing, bad events', () => {
    const { p } = setup();
    const s = p.scripts[0];
    s.variables.push({ id: 'v1', name: 'speed', type: 'float' }, { id: 'v2', name: 'speed', type: 'int' }, { id: 'v3', name: 'class', type: 'int' }, { id: 'v4', name: 'thing', type: 'NotAType' }, { id: 'v5', name: 'n', type: 'int', default: 'x' });
    const f = createFunction({ name: 'go', params: [{ id: 'p1', name: 'speed', type: 'int' }] });
    s.functions.push(f, { ...createFunction({ name: '_process' }), kind: 'event', event: '_process' });
    const c = codes(p);
    expect(c).toEqual(expect.arrayContaining(['E_DUPLICATE_IDENTIFIER', 'E_RESERVED_IDENTIFIER', 'E_UNKNOWN_TYPE', 'E_INVALID_DEFAULT', 'E_SHADOWED_IDENTIFIER', 'E_EVENT_SIGNATURE']));
  });

  it('missing script configuration and target pins', () => {
    const { p, fnId, entry } = setup();
    const q = applyOps(p, [
      { op: 'update_script', settings: { extends: 'Node' } },
      { op: 'add_node', ref: 'm', graph: fnId, type: 'godot.characterbody2d.move_and_slide' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$m', port: 'exec' } },
    ], tc).project;
    expect(codes(q)).toContain('E_TARGET_REQUIRED');
    q.scripts[0].settings.extends = '';
    expect(codes(q)).toContain('W_NO_BASE_CLASS');
  });

  it('diagnostics carry graph, node and port ids', () => {
    const { p, fnId, entry } = setup();
    const r = applyOps(p, [
      { op: 'add_node', ref: 'w', graph: fnId, type: 'core.while' },
      { op: 'connect', from: { node: entry, port: 'then' }, to: { node: '$w', port: 'exec' } },
    ], tc);
    const d = compileScript(tc, r.project.scripts[0]).diagnostics.find((x) => x.code === 'E_MISSING_INPUT')!;
    expect(d).toMatchObject({ severity: 'error', nodeId: r.created.w, portId: 'condition', functionId: fnId });
    expect(d.suggestion).toBeTruthy();
  });
});
