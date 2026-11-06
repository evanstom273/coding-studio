/**
 * The compiler is not hard-wired to GDScript: a test-only JavaScript adapter reuses the core node
 * pack and the same pipeline, and its generated code is executed.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { createToolchain } from '@cs/toolchain';
import { compileScript } from '@cs/compiler-core';
import { applyOps, createProject, OpError } from '@cs/project-format';
import { jsReferenceAdapter } from '../fixtures/js-reference-adapter';

const tc = createToolchain(jsReferenceAdapter);

function run(code: string, fn: string, args: unknown[] = []): { out: unknown[]; ret: unknown } {
  const out: unknown[] = [];
  const src = code.replace(/^export /gm, '') + `\n;__ret = ${fn}(...__args);`;
  const ctx = vm.createContext({ print: (v: unknown) => out.push(v), __args: args, __ret: undefined });
  vm.runInContext(src, ctx);
  return { out, ret: ctx.__ret };
}

describe('test-only JavaScript reference adapter', () => {
  it('compiles a core-node graph to JavaScript that runs', () => {
    let p = createProject(tc.adapter, 'JS', { template: 'module' });
    p = applyOps(p, [
      { op: 'add_variable', name: 'total', type: 'int', default: 0 },
      { op: 'add_function', ref: 'f', name: 'sumTo', params: [{ name: 'n', type: 'int' }], returnType: 'int' },
      { op: 'add_node', ref: 'loop', graph: '$f', type: 'core.for_range', inputs: { from: 1 } },
      { op: 'add_node', ref: 'n1', graph: '$f', type: 'core.add', props: { type: 'int' }, inputs: { b: 1 } },
      { op: 'add_node', ref: 'acc', graph: '$f', type: 'core.set_var', props: { variable: 'total', operation: '+' } },
      { op: 'add_node', ref: 'even', graph: '$f', type: 'core.modulo', props: { type: 'int' }, inputs: { b: 2 } },
      { op: 'add_node', ref: 'iszero', graph: '$f', type: 'core.equal', props: { type: 'int' }, inputs: { b: 0 } },
      { op: 'add_node', ref: 'br', graph: '$f', type: 'core.branch' },
      { op: 'add_node', ref: 'pr', graph: '$f', type: 'core.print' },
      { op: 'add_node', ref: 'tot', graph: '$f', type: 'core.get_var', props: { variable: 'total' } },
      { op: 'add_node', ref: 'ret', graph: '$f', type: 'core.return' },
      { op: 'connect', from: { node: '$f.entry', port: 'then' }, to: { node: '$loop', port: 'exec' } },
      { op: 'connect', from: { node: '$f.entry', port: 'n' }, to: { node: '$n1', port: 'a' } },
      { op: 'connect', from: { node: '$n1', port: 'result' }, to: { node: '$loop', port: 'to' } },
      { op: 'connect', from: { node: '$loop', port: 'body' }, to: { node: '$acc', port: 'exec' } },
      { op: 'connect', from: { node: '$loop', port: 'index' }, to: { node: '$acc', port: 'value' } },
      { op: 'connect', from: { node: '$acc', port: 'then' }, to: { node: '$br', port: 'exec' } },
      { op: 'connect', from: { node: '$loop', port: 'index' }, to: { node: '$even', port: 'a' } },
      { op: 'connect', from: { node: '$even', port: 'result' }, to: { node: '$iszero', port: 'a' } },
      { op: 'connect', from: { node: '$iszero', port: 'result' }, to: { node: '$br', port: 'condition' } },
      { op: 'connect', from: { node: '$br', port: 'true' }, to: { node: '$pr', port: 'exec' } },
      { op: 'connect', from: { node: '$loop', port: 'index' }, to: { node: '$pr', port: 'value' } },
      { op: 'connect', from: { node: '$loop', port: 'completed' }, to: { node: '$ret', port: 'exec' } },
      { op: 'connect', from: { node: '$tot', port: 'value' }, to: { node: '$ret', port: 'value' } },
    ], tc).project;
    const r = compileScript(tc, p.scripts[0]);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const { out, ret } = run(r.files[0].content, 'sumTo', [6]);
    expect(out).toEqual([2, 4, 6]);
    expect(ret).toBe(21);
    expect(r.files[0].path).toBe('main.mjs');
  });

  it('rejects language-specific nodes from another language pack', () => {
    const p = createProject(tc.adapter, 'JS', { template: 'module' });
    expect(() => applyOps(p, [{ op: 'add_function', ref: 'f', name: 'go' }, { op: 'add_node', graph: '$f', type: 'godot.delay' }], tc)).toThrow(OpError);
    expect(() => applyOps(p, [{ op: 'add_function', ref: 'f', name: 'go' }, { op: 'add_node', graph: '$f', type: 'core.self' }], tc)).toThrow(/not available/);
  });

  it('reports unsupported capabilities instead of emitting code', () => {
    const p = createProject(tc.adapter, 'JS', { template: 'module' });
    p.scripts[0].signals.push({ id: 'sig_x', name: 'changed', params: [] });
    const r = compileScript(tc, p.scripts[0]);
    expect(r.ok).toBe(false);
    expect(r.files).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === 'E_UNSUPPORTED_FEATURE')).toBe(true);
  });
});
