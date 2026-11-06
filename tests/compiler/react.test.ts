/**
 * React components as graphs: a component function with React state, an inline click handler
 * that updates it, and JSX built from Element nodes → .tsx that passes tsc --strict against the
 * real React types and renders with react-dom/server.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { compileProject } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';

const tc = toolchainFor('typescript');

function counterProject() {
  const p = createProject(tc.adapter, 'Counter', { template: 'empty', scriptName: 'App' });
  const ops: EditOp[] = [
    { op: 'update_script', script: p.scripts[0].id, path: 'src/App' },
    { op: 'add_function', ref: 'app', name: 'App', component: true, exported: true, params: [{ name: 'title', type: 'string', default: 'Clicks' }], returnType: 'any' },
    { op: 'add_variable', function: '$app', name: 'count', type: 'int', default: 0, attributes: { state: true } },
    // const add = () => setCount(count + 1)
    { op: 'add_function', ref: 'add', kind: 'lambda', owner: '$app', name: 'add' },
    { op: 'add_node', ref: 'inc', graph: '$add', type: 'core.set_var', props: { variable: 'count', operation: '+' }, inputs: { value: 1 } },
    { op: 'connect', graph: '$add', from: { node: '$add.entry', port: 'then' }, to: { node: '$inc', port: 'exec' } },
    // return <div className="card"><h1>{title}: {count}</h1><button onClick={add}>Add</button></div>
    { op: 'add_node', ref: 'label', graph: '$app', type: 'ts.template', props: { template: '{title}: {count}' } },
    { op: 'add_node', ref: 'title', graph: '$app', type: 'core.get_var', props: { variable: 'title' } },
    { op: 'add_node', ref: 'cnt', graph: '$app', type: 'core.get_var', props: { variable: 'count' } },
    { op: 'add_node', ref: 'h1', graph: '$app', type: 'ts.element', props: { tag: 'h1', attributes: [], children: 1 } },
    { op: 'add_node', ref: 'cb', graph: '$app', type: 'ts.closure', props: { function: '$add' } },
    { op: 'add_node', ref: 'btn', graph: '$app', type: 'ts.element', props: { tag: 'button', attributes: ['onClick'], children: 1 }, inputs: { child_0: 'Add' } },
    { op: 'add_node', ref: 'div', graph: '$app', type: 'ts.element', props: { tag: 'div', attributes: ['className'], children: 2 }, inputs: { attr_className: 'card' } },
    { op: 'add_node', ref: 'ret', graph: '$app', type: 'core.return' },
    { op: 'connect', graph: '$app', from: { node: '$title', port: 'value' }, to: { node: '$label', port: 'title' } },
    { op: 'connect', graph: '$app', from: { node: '$cnt', port: 'value' }, to: { node: '$label', port: 'count' } },
    { op: 'connect', graph: '$app', from: { node: '$label', port: 'text' }, to: { node: '$h1', port: 'child_0' } },
    { op: 'connect', graph: '$app', from: { node: '$cb', port: 'fn' }, to: { node: '$btn', port: 'attr_onClick' } },
    { op: 'connect', graph: '$app', from: { node: '$h1', port: 'element' }, to: { node: '$div', port: 'child_0' } },
    { op: 'connect', graph: '$app', from: { node: '$btn', port: 'element' }, to: { node: '$div', port: 'child_1' } },
    { op: 'connect', graph: '$app', from: { node: '$app.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
    { op: 'connect', graph: '$app', from: { node: '$div', port: 'element' }, to: { node: '$ret', port: 'value' } },
  ];
  return applyOps(p, ops, tc).project;
}

describe('React components', () => {
  it('compile to readable TSX with useState and handlers', () => {
    const r = compileProject(tc, counterProject());
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const f = r.files[0];
    expect(f.path).toBe('src/App.tsx');
    expect(f.content).toContain("import { useState } from 'react';");
    expect(f.content).toContain("export function App({ title = 'Clicks' }: { title?: string }) {");
    expect(f.content).toContain('const [count, setCount] = useState(0);');
    expect(f.content).toContain('setCount(count + 1);');
    expect(f.content).toContain('return (\n\t\t<div className="card">\n\t\t\t<h1>{`${title}: ${count}`}</h1>\n\t\t\t<button onClick={(): void => {');
  });

  it('passes tsc --strict against the React types and renders', () => {
    const files = compileProject(tc, counterProject()).files;
    const dir = mkdtempSync(join(tmpdir(), 'cs-react-'));
    for (const f of files) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    const nm = join(process.cwd(), 'node_modules');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, jsx: 'react-jsx', target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, typeRoots: [join(nm, '@types')], baseUrl: '.', paths: { react: [join(nm, '@types/react')], 'react/*': [join(nm, '@types/react/*')] } }, include: ['src/**/*.tsx'] }));
    let out = '';
    try {
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(out).toBe('');
    writeFileSync(join(dir, 'render.tsx'), "import { renderToString } from 'react-dom/server';\nimport { App } from './src/App';\nconsole.log(renderToString(<App title=\"Taps\" />));\n");
    const bundle = join(dir, 'out.mjs');
    buildSync({ entryPoints: [join(dir, 'render.tsx')], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile: bundle, nodePaths: [nm], logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
    const html = execFileSync(process.execPath, [bundle], { encoding: 'utf8' });
    expect(html).toContain('<div class="card"><h1>Taps: 0</h1><button>Add</button></div>');
  }, 60_000);
});

describe('web app starter', () => {
  it('builds a Vite + React + Tailwind + Dexie project whose graph compiles, type-checks and bundles', async () => {
    const { buildWebStarter } = await import('@cs/examples');
    const { deriveProject } = await import('@cs/workspace');
    const ws = buildWebStarter(tc, 'Todo Demo');
    expect([...ws.files.keys()].sort()).toEqual(['README.md', 'codingstudio.json', 'index.html', 'package.json', 'src/App.vgraph', 'src/TodoList.tsx', 'src/db.ts', 'src/index.css', 'src/main.tsx', 'tsconfig.json', 'vite.config.ts']);
    expect(JSON.parse(ws.files.get('package.json')!.text!).name).toBe('todo-demo');
    const r = compileProject(tc, deriveProject(ws).project);
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const app = r.files[0];
    expect(app.path).toBe('src/App.tsx');
    expect(app.content).toContain("import { addTodo } from './db';");
    expect(app.content).toContain("import { TodoList } from './TodoList';");
    expect(app.content).toContain('addTodo(`Todo ${count + 1}`);');
    expect(app.content).toContain('<TodoList />');
    // bundles for the preview (npm packages left to the import map)
    const esbuild = await import('esbuild');
    const { bundle } = await import('@cs/preview');
    const files = new Map([...ws.files.values()].map((f) => [f.path, { path: f.path, text: f.text }]));
    files.set(app.path, { path: app.path, text: app.content });
    const b = await bundle(esbuild, files);
    expect(b.errors).toEqual([]);
    expect(b.entry).toBe('src/main.tsx');
    expect(b.css).toContain('@import "tailwindcss"');
  });
});
