/**
 * Program entry points: one function is where the program starts; each language turns that into
 * its own startup (a launcher module, a React render, a call from Godot's _ready + a scene).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';
import { compileProject } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';
import { deriveProject, projectToWorkspace } from '@cs/workspace';

const ts = toolchainFor('typescript');
const gd = toolchainFor('gdscript');

function tsProgram(opts: { async?: boolean; output?: 'ts' | 'js'; host?: string } = {}) {
  let p = createProject(ts.adapter, 'Prog', { template: 'empty', scriptName: 'Main' });
  p = { ...p, scripts: p.scripts.map((s) => ({ ...s, settings: { output: opts.output ?? 'ts' } })) };
  const ops: EditOp[] = [
    { op: 'add_function', ref: 'main', name: 'main', async: !!opts.async },
    { op: 'add_node', ref: 'p', graph: '$main', type: 'core.print', inputs: { value: 'started' } },
    { op: 'connect', graph: '$main', from: { node: '$main.entry', port: 'then' }, to: { node: '$p', port: 'exec' } },
    { op: 'update_project', entry: { function: 'main', ...(opts.host ? { host: opts.host } : {}) } },
  ];
  if (opts.async) {
    ops.splice(1, 0, { op: 'add_node', ref: 'w', graph: '$main', type: 'ts.call', props: { name: 'Promise.resolve', argTypes: ['int'], returnType: 'int', await: true }, inputs: { arg_0: 1 } });
    ops.splice(ops.length - 1, 0, { op: 'connect', graph: '$main', from: { node: '$p', port: 'then' }, to: { node: '$w', port: 'exec' } });
  }
  return applyOps(p, ops, ts).project;
}

function runNode(files: { path: string; content: string }[], entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cs-entry-'));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  const out = join(dir, 'bundle.mjs');
  buildSync({ entryPoints: [join(dir, entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
  return execFileSync(process.execPath, [out], { encoding: 'utf8' });
}

describe('TypeScript / JavaScript entry points', () => {
  it('a launcher starts main(), which is exported automatically, and it runs', () => {
    const r = compileProject(ts, tsProgram());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(['main.ts', 'main.entry.ts']);
    expect(r.files[0].content).toContain('export function main(): void {');
    expect(r.files[1].content).toContain("import { main } from './main';\n\nmain();\n");
    expect(r.scripts[0].entry).toMatchObject({ host: 'browser' });
    expect(runNode(r.files, 'main.entry.ts').trim()).toBe('started');
  });

  it('async functions are awaited; node host and JavaScript output', () => {
    const r = compileProject(ts, tsProgram({ async: true, output: 'js', host: 'node' }));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(['main.js', 'main.entry.js']);
    expect(r.files[1].content).toContain('await main();');
    expect(r.scripts[0].entry!.instructions[0]).toContain('node main.entry.js');
    expect(runNode(r.files, 'main.entry.js').trim()).toBe('started');
  });

  it('a React component is rendered into #root; components need the browser host', () => {
    let p = createProject(ts.adapter, 'UI', { template: 'empty', scriptName: 'App' });
    p = applyOps(
      p,
      [
        { op: 'update_script', script: p.scripts[0].id, path: 'src/App' },
        { op: 'add_function', ref: 'app', name: 'App', component: true, returnType: 'any' },
        { op: 'add_node', ref: 'el', graph: '$app', type: 'ts.element', props: { tag: 'p', attributes: [], children: 1 }, inputs: { child_0: 'hi' } },
        { op: 'add_node', ref: 'ret', graph: '$app', type: 'core.return' },
        { op: 'connect', graph: '$app', from: { node: '$app.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
        { op: 'connect', graph: '$app', from: { node: '$el', port: 'element' }, to: { node: '$ret', port: 'value' } },
        { op: 'update_project', entry: { function: 'App' } },
      ],
      ts,
    ).project;
    const r = compileProject(ts, p);
    expect(r.files.map((f) => f.path)).toEqual(['src/App.tsx', 'src/App.entry.tsx']);
    expect(r.files[1].content).toContain("import { createRoot } from 'react-dom/client';\nimport { App } from './App';");
    expect(r.files[1].content).toContain('createRoot(container).render(<App />);');
    const bad = compileProject(ts, applyOps(p, [{ op: 'update_project', entry: { function: 'App', host: 'node' } }], ts).project);
    expect(bad.diagnostics.some((d) => d.code === 'E_ENTRY_HOST')).toBe(true);
  });

  it('rejects entry functions that need arguments, inline functions, and unknown hosts', () => {
    const p = tsProgram();
    const withParam = applyOps(p, [{ op: 'add_function', name: 'go', params: [{ name: 'n', type: 'int' }] }, { op: 'update_project', entry: { function: 'go' } }], ts).project;
    expect(compileProject(ts, withParam).diagnostics.some((d) => d.code === 'E_ENTRY_PARAMS')).toBe(true);
    const withDefault = applyOps(p, [{ op: 'add_function', name: 'go', params: [{ name: 'n', type: 'int', default: 3 }] }, { op: 'update_project', entry: { function: 'go' } }], ts).project;
    expect(compileProject(ts, withDefault).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(() => applyOps(p, [{ op: 'update_project', entry: { function: 'main', host: 'mars' } }], ts)).toThrow(/host must be one of/);
  });
});

describe('GDScript entry points (Godot execution model)', () => {
  function gdProgram(extra: EditOp[] = [], template = 'node2d') {
    const p = createProject(gd.adapter, 'Game', { template, scriptName: 'Main' });
    return applyOps(
      p,
      [
        { op: 'add_function', ref: 'start', name: 'start' },
        { op: 'add_node', ref: 'p', graph: '$start', type: 'core.print', inputs: { value: 'started' } },
        { op: 'connect', graph: '$start', from: { node: '$start.entry', port: 'then' }, to: { node: '$p', port: 'exec' } },
        ...extra,
        { op: 'update_project', entry: { function: 'start' } },
      ],
      gd,
    ).project;
  }

  it('is called first thing in _ready(); _process keeps working; a main scene is generated', () => {
    const r = compileProject(gd, gdProgram());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const code = r.files.find((f) => f.path === 'main.gd')!.content;
    expect(code).toMatch(/func _ready\(\) -> void:\n\tstart\(\)\n/);
    expect(code).toContain('func _process(');
    const scene = r.files.find((f) => f.path === 'main.tscn')!.content;
    expect(scene).toBe('[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1_entry"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_entry")\n');
    expect(r.scripts[0].entry!.instructions[0]).toContain('Main Scene');
  });

  it('adds _ready when there is none, awaits coroutines, autoload host has no scene', () => {
    const plain = gdProgram([], 'character2d');
    const r1 = compileProject(gd, plain);
    expect(r1.files.find((f) => f.path === 'main.gd')!.content).toMatch(/func _ready\(\) -> void:\n\tstart\(\)\n/);
    const co = gdProgram([{ op: 'add_node', ref: 'd', graph: '$start', type: 'godot.delay', inputs: { seconds: 1 } }, { op: 'connect', graph: '$start', from: { node: '$p', port: 'then' }, to: { node: '$d', port: 'exec' } }]);
    expect(compileProject(gd, co).files.find((f) => f.path === 'main.gd')!.content).toContain('\tawait start()\n');
    const auto = applyOps(plain, [{ op: 'update_project', entry: { function: 'start', host: 'autoload' } }], gd).project;
    const r2 = compileProject(gd, auto);
    expect(r2.files.map((f) => f.path)).toEqual(['main.gd']);
    expect(r2.scripts[0].entry!.instructions[0]).toContain('Autoload');
  });

  it('scripts Godot never runs by themselves are refused; _ready itself can be the entry', () => {
    expect(compileProject(gd, gdProgram([], 'refcounted')).diagnostics.some((d) => d.code === 'E_ENTRY_HOST')).toBe(true);
    const p = createProject(gd.adapter, 'G', { template: 'node' });
    const ready = applyOps(p, [{ op: 'update_project', entry: { function: '_ready' } }], gd).project;
    const r = compileProject(gd, ready);
    expect(r.files.map((f) => f.path)).toEqual(['main.gd', 'main.tscn']);
    expect(r.files[0].content).toBe(compileProject(gd, p).files[0].content);
  });
});

describe('compatibility', () => {
  it('projects without an entry compile exactly as before; the entry survives files; deleting the function clears it', () => {
    const p = tsProgram();
    const none: Project = { ...p, entry: undefined };
    expect(compileProject(ts, none).files.map((f) => f.path)).toEqual(['main.ts']);
    const back = deriveProject(projectToWorkspace(p)).project;
    expect(back.entry).toEqual(p.entry);
    const fid = p.scripts[0].functions.find((f) => f.name === 'main')!.id;
    const r = applyOps(p, [{ op: 'delete_function', function: fid }], ts);
    expect(r.project.entry).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/entry point/);
  });
});
