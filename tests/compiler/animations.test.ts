/** Visual animations on React elements: CSS @keyframes + rules, replay on change, click via the Web Animations API. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProject } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';
import { PRESETS, type AnimationSpec } from '@cs/styling';

const tc = toolchainFor('typescript');
const preset = (name: string, trigger: AnimationSpec['trigger']): AnimationSpec => ({ ...PRESETS.find((p) => p.name === name)!, trigger });

function counter() {
  const p = createProject(tc.adapter, 'Counter', { template: 'empty', scriptName: 'App' });
  const ops: EditOp[] = [
    { op: 'update_script', script: p.scripts[0].id, path: 'src/App' },
    { op: 'add_function', ref: 'app', name: 'App', component: true, exported: true, returnType: 'any' },
    { op: 'add_variable', function: '$app', name: 'count', type: 'int', default: 0, attributes: { state: true } },
    { op: 'add_function', ref: 'add', kind: 'lambda', owner: '$app', name: 'add' },
    { op: 'add_node', ref: 'inc', graph: '$add', type: 'core.set_var', props: { variable: 'count', operation: '+' }, inputs: { value: 1 } },
    { op: 'connect', graph: '$add', from: { node: '$add.entry', port: 'then' }, to: { node: '$inc', port: 'exec' } },
    // <h1 className="text-4xl">{count}</h1> bouncing whenever count changes, fading in on load
    { op: 'add_node', ref: 'cnt', graph: '$app', type: 'core.get_var', props: { variable: 'count' } },
    { op: 'add_node', ref: 'cnt2', graph: '$app', type: 'core.get_var', props: { variable: 'count' } },
    { op: 'add_node', ref: 'h1', graph: '$app', type: 'ts.element', props: { tag: 'h1', attributes: ['className'], children: 1, animations: [preset('Bounce', 'change'), preset('Fade in', 'load')] as never }, inputs: { attr_className: 'text-4xl' } },
    // <button onClick={add}> that pops when clicked and wiggles on hover
    { op: 'add_node', ref: 'cb', graph: '$app', type: 'ts.closure', props: { function: '$add' } },
    { op: 'add_node', ref: 'btn', graph: '$app', type: 'ts.element', props: { tag: 'button', attributes: ['onClick'], children: 1, animations: [preset('Pop', 'click'), preset('Wiggle', 'hover')] as never }, inputs: { child_0: 'Add' } },
    { op: 'add_node', ref: 'div', graph: '$app', type: 'ts.element', props: { tag: 'div', attributes: [], children: 2 } },
    { op: 'add_node', ref: 'ret', graph: '$app', type: 'core.return' },
    { op: 'connect', graph: '$app', from: { node: '$cnt', port: 'value' }, to: { node: '$h1', port: 'child_0' } },
    { op: 'connect', graph: '$app', from: { node: '$cnt2', port: 'value' }, to: { node: '$h1', port: 'anim_0' } },
    { op: 'connect', graph: '$app', from: { node: '$cb', port: 'fn' }, to: { node: '$btn', port: 'attr_onClick' } },
    { op: 'connect', graph: '$app', from: { node: '$h1', port: 'element' }, to: { node: '$div', port: 'child_0' } },
    { op: 'connect', graph: '$app', from: { node: '$btn', port: 'element' }, to: { node: '$div', port: 'child_1' } },
    { op: 'connect', graph: '$app', from: { node: '$app.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
    { op: 'connect', graph: '$app', from: { node: '$div', port: 'element' }, to: { node: '$ret', port: 'value' } },
  ];
  return applyOps(p, ops, tc).project;
}

describe('animations', () => {
  it('generate @keyframes, replay-on-change keys, hover rules and click handlers', () => {
    const r = compileProject(tc, counter());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const tsx = r.files.find((f) => f.path === 'src/App.tsx')!.content;
    const css = r.files.find((f) => f.path === 'src/App.anim.css')!.content;
    expect(tsx).toContain("import './App.anim.css';");
    // the number: its own class + the animation class, re-created (so the bounce replays) when count changes
    expect(tsx).toMatch(/<h1 className="text-4xl cs-anim-\w+" key=\{String\(count\)\}>\{count\}<\/h1>/);
    // the button: the pop runs first, then the existing handler
    expect(tsx).toMatch(/onClick=\{\(event: any\): void => \{\n[^]*event\.currentTarget\.animate\(\[\{"offset":0,"scale":"1"\},\{"offset":0\.5,"scale":"1\.25"\},\{"offset":1,"scale":"1"\}\], \{"duration":300/);
    expect(css).toMatch(/@keyframes cs-bounce-\w+ \{\n {2}0% \{ translate: 0px 0px; \}\n {2}30% \{ translate: 0px -16px; \}/);
    expect(css).toMatch(/\.cs-anim-\w+ \{\n {2}animation: cs-bounce-\w+ 600ms ease-out 0ms 1 normal both, cs-fade-in-\w+ 500ms ease-out 0ms 1 normal both;\n\}/);
    expect(css).toMatch(/\.cs-anim-\w+:hover \{\n {2}animation: cs-wiggle-\w+ 500ms ease-in-out/);
    expect(css).not.toContain('cs-pop');
  });

  it('elements without animations are unchanged; bad animations are reported', () => {
    const p = counter();
    const app = p.scripts[0].functions.find((f) => f.name === 'App')!;
    const h1 = app.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'h1')!;
    const bad = applyOps(p, [{ op: 'update_node', graph: app.id, node: h1.id, props: { animations: [{ name: 'X', trigger: 'sometimes', keyframes: [], duration: 0 }] } }], tc).project;
    expect(compileProject(tc, bad).diagnostics.find((d) => d.code === 'E_INVALID_ANIMATION')?.message).toMatch(/isn't a trigger.*at least two keyframes.*more than 0 ms/);
  });

  it('the TSX passes tsc --strict against the React types', () => {
    const files = compileProject(tc, counter()).files;
    const dir = mkdtempSync(join(tmpdir(), 'cs-anim-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    writeFileSync(join(dir, 'src', 'css.d.ts'), "declare module '*.css';\n");
    const nm = join(process.cwd(), 'node_modules');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, jsx: 'react-jsx', target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, lib: ['ES2022', 'DOM'], typeRoots: [join(nm, '@types')], baseUrl: '.', paths: { react: [join(nm, '@types/react')], 'react/*': [join(nm, '@types/react/*')] } }, include: ['src/**/*'] }));
    let out = '';
    try {
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(out).toBe('');
  }, 60_000);
});
