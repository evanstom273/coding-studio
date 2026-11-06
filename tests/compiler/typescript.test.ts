/**
 * TypeScript backend: graphs built with the normal edit operations → TypeScript that passes
 * `tsc --strict`, and JavaScript that runs in Node with the expected output. Golden files pin
 * the exact text.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';
import { compileProject } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';

const tc = toolchainFor('typescript');
const GOLDEN = join(__dirname, '../fixtures/golden/typescript');

function build(): Project {
  const p = createProject(tc.adapter, 'TS Demo', { template: 'empty', scriptName: 'Main' });
  const ops: EditOp[] = [
    { op: 'update_script', script: p.scripts[0].id, path: 'app/main' },
    // --- utils module ---
    { op: 'add_script', ref: 'u', name: 'utils', path: 'lib/utils', template: 'empty' },
    { op: 'add_function', ref: 'double', script: '$u', name: 'double', params: [{ name: 'n', type: 'int' }], returnType: 'int', exported: true, description: 'Twice n.' },
    { op: 'add_node', ref: 'mul', graph: '$double', type: 'core.multiply', props: { type: 'int' }, inputs: { b: 2 } },
    { op: 'add_node', ref: 'ret', graph: '$double', type: 'core.return' },
    { op: 'connect', graph: '$double', from: { node: '$double.entry', port: 'n' }, to: { node: '$mul', port: 'a' } },
    { op: 'connect', graph: '$double', from: { node: '$double.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
    { op: 'connect', graph: '$double', from: { node: '$mul', port: 'result' }, to: { node: '$ret', port: 'value' } },
    { op: 'add_function', ref: 'greet', script: '$u', name: 'greet', params: [{ name: 'name', type: 'string' }], returnType: 'string', exported: true },
    { op: 'add_node', ref: 'tpl', graph: '$greet', type: 'ts.template', props: { template: 'Hello ${name}! {{braces}} `tick`' } },
    { op: 'add_node', ref: 'gret', graph: '$greet', type: 'core.return' },
    { op: 'connect', graph: '$greet', from: { node: '$greet.entry', port: 'name' }, to: { node: '$tpl', port: 'name' } },
    { op: 'connect', graph: '$greet', from: { node: '$greet.entry', port: 'then' }, to: { node: '$gret', port: 'exec' } },
    { op: 'connect', graph: '$greet', from: { node: '$tpl', port: 'text' }, to: { node: '$gret', port: 'value' } },
    // --- main module ---
    { op: 'add_enum', script: p.scripts[0].id, name: 'Mood', members: ['HAPPY', 'SAD'] },
    { op: 'add_variable', script: p.scripts[0].id, name: 'count', type: 'int', default: 0, exported: true },
    { op: 'add_function', ref: 'classify', script: p.scripts[0].id, name: 'classify', params: [{ name: 'n', type: 'int' }], returnType: 'string' },
    { op: 'add_node', ref: 'sw', graph: '$classify', type: 'core.switch', props: { type: 'int', cases: ['1', '2'] } },
    { op: 'add_node', ref: 'r1', graph: '$classify', type: 'core.return', inputs: { value: 'one' } },
    { op: 'add_node', ref: 'r2', graph: '$classify', type: 'core.return', inputs: { value: 'two' } },
    { op: 'add_node', ref: 'r3', graph: '$classify', type: 'core.return', inputs: { value: 'many' } },
    { op: 'connect', graph: '$classify', from: { node: '$classify.entry', port: 'then' }, to: { node: '$sw', port: 'exec' } },
    { op: 'connect', graph: '$classify', from: { node: '$classify.entry', port: 'n' }, to: { node: '$sw', port: 'value' } },
    { op: 'connect', graph: '$classify', from: { node: '$sw', port: 'case_0' }, to: { node: '$r1', port: 'exec' } },
    { op: 'connect', graph: '$classify', from: { node: '$sw', port: 'case_1' }, to: { node: '$r2', port: 'exec' } },
    { op: 'connect', graph: '$classify', from: { node: '$sw', port: 'default' }, to: { node: '$r3', port: 'exec' } },

    { op: 'add_function', ref: 'main', script: p.scripts[0].id, name: 'main', exported: true, async: true, description: 'Runs everything.' },
    // for i in 0..3: print(double(i))
    { op: 'add_node', ref: 'loop', graph: '$main', type: 'core.for_range', inputs: { from: 0, to: 3 } },
    { op: 'add_node', ref: 'callDouble', graph: '$main', type: 'ts.call', props: { scriptPath: 'lib/utils', name: 'double', argNames: ['n'], argTypes: ['int'], returnType: 'int' } },
    { op: 'add_node', ref: 'p1', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$main.entry', port: 'then' }, to: { node: '$loop', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$loop', port: 'body' }, to: { node: '$callDouble', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$loop', port: 'index' }, to: { node: '$callDouble', port: 'arg_0' } },
    { op: 'connect', graph: '$main', from: { node: '$callDouble', port: 'then' }, to: { node: '$p1', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$callDouble', port: 'result' }, to: { node: '$p1', port: 'value' } },
    // after the loop: maps
    { op: 'add_variable', function: '$main', name: 'scores', type: 'map<string, int>' },
    { op: 'add_node', ref: 'map', graph: '$main', type: 'core.make_map', props: { keyType: 'string', valueType: 'int', count: 1 }, inputs: { key_0: 'x', value_0: 1 } },
    { op: 'add_node', ref: 'setScores', graph: '$main', type: 'core.set_var', props: { variable: 'scores' } },
    { op: 'add_node', ref: 'getScores', graph: '$main', type: 'core.get_var', props: { variable: 'scores' } },
    { op: 'connect', graph: '$main', from: { node: '$map', port: 'map' }, to: { node: '$setScores', port: 'value' } },
    { op: 'add_node', ref: 'mset', graph: '$main', type: 'core.map_set', props: { keyType: 'string', valueType: 'int' }, inputs: { key: 'y', value: 2 } },
    { op: 'add_node', ref: 'mget', graph: '$main', type: 'core.map_get', props: { keyType: 'string', valueType: 'int' }, inputs: { key: 'y', default: 0 } },
    { op: 'add_node', ref: 'p2', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$loop', port: 'completed' }, to: { node: '$setScores', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$setScores', port: 'then' }, to: { node: '$mset', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$getScores', port: 'value' }, to: { node: '$mset', port: 'map' } },
    { op: 'connect', graph: '$main', from: { node: '$getScores', port: 'value' }, to: { node: '$mget', port: 'map' } },
    { op: 'connect', graph: '$main', from: { node: '$mset', port: 'then' }, to: { node: '$p2', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$mget', port: 'value' }, to: { node: '$p2', port: 'value' } },
    // try { throw } catch (e) { print(e.message) }
    { op: 'add_node', ref: 'try', graph: '$main', type: 'ts.try' },
    { op: 'add_node', ref: 'throw', graph: '$main', type: 'ts.throw', inputs: { message: 'boom' } },
    { op: 'add_node', ref: 'msg', graph: '$main', type: 'ts.get_field', props: { name: 'message', type: 'string', optional: true } },
    { op: 'add_node', ref: 'p3', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$p2', port: 'then' }, to: { node: '$try', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$try', port: 'try' }, to: { node: '$throw', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$try', port: 'catch' }, to: { node: '$p3', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$try', port: 'error' }, to: { node: '$msg', port: 'object' } },
    { op: 'connect', graph: '$main', from: { node: '$msg', port: 'value' }, to: { node: '$p3', port: 'value' } },
    // greet + classify + await + object + JSON + ??
    { op: 'add_node', ref: 'callGreet', graph: '$main', type: 'ts.call', props: { scriptPath: 'lib/utils', name: 'greet', argNames: ['name'], argTypes: ['string'], returnType: 'string' }, inputs: { arg_0: 'Lyra' } },
    { op: 'add_node', ref: 'p4', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$try', port: 'then' }, to: { node: '$callGreet', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$callGreet', port: 'then' }, to: { node: '$p4', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$callGreet', port: 'result' }, to: { node: '$p4', port: 'value' } },
    { op: 'add_node', ref: 'callClassify', graph: '$main', type: 'core.call_function', props: { function: '$classify' }, inputs: {} },
    { op: 'add_node', ref: 'p5', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$p4', port: 'then' }, to: { node: '$callClassify', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$callClassify', port: 'then' }, to: { node: '$p5', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$callClassify', port: 'result' }, to: { node: '$p5', port: 'value' } },
    { op: 'add_node', ref: 'resolve', graph: '$main', type: 'ts.call', props: { name: 'Promise.resolve', argNames: ['value'], argTypes: ['int'], returnType: 'int', await: true }, inputs: { arg_0: 42 } },
    { op: 'add_node', ref: 'obj', graph: '$main', type: 'ts.object', props: { keys: ['answer', 'mood'] } },
    { op: 'add_node', ref: 'mood', graph: '$main', type: 'core.enum_value', props: { enum: 'Mood', member: 'SAD' } },
    { op: 'add_node', ref: 'json', graph: '$main', type: 'ts.call', props: { name: 'JSON.stringify', argNames: ['value'], argTypes: ['any'], returnType: 'string' } },
    { op: 'add_node', ref: 'p6', graph: '$main', type: 'core.print' },
    { op: 'connect', graph: '$main', from: { node: '$p5', port: 'then' }, to: { node: '$resolve', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$resolve', port: 'result' }, to: { node: '$obj', port: 'answer' } },
    { op: 'connect', graph: '$main', from: { node: '$mood', port: 'value' }, to: { node: '$obj', port: 'mood' } },
    { op: 'connect', graph: '$main', from: { node: '$resolve', port: 'then' }, to: { node: '$json', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$obj', port: 'object' }, to: { node: '$json', port: 'arg_0' } },
    { op: 'connect', graph: '$main', from: { node: '$json', port: 'then' }, to: { node: '$p6', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$json', port: 'result' }, to: { node: '$p6', port: 'value' } },
    { op: 'add_node', ref: 'nil', graph: '$main', type: 'ts.call', props: { name: 'JSON.parse', argNames: ['text'], argTypes: ['string'], returnType: 'string?' }, inputs: { arg_0: 'null' } },
    { op: 'add_node', ref: 'dflt', graph: '$main', type: 'ts.default_value', props: { type: 'string' }, inputs: { default: 'fallback' } },
    { op: 'add_node', ref: 'p7', graph: '$main', type: 'core.print' },
    { op: 'add_node', ref: 'inc', graph: '$main', type: 'core.set_var', props: { variable: 'count', operation: '+' }, inputs: { value: 1 } },
    { op: 'connect', graph: '$main', from: { node: '$p6', port: 'then' }, to: { node: '$nil', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$nil', port: 'then' }, to: { node: '$p7', port: 'exec' } },
    { op: 'connect', graph: '$main', from: { node: '$nil', port: 'result' }, to: { node: '$dflt', port: 'value' } },
    { op: 'connect', graph: '$main', from: { node: '$dflt', port: 'result' }, to: { node: '$p7', port: 'value' } },
    { op: 'connect', graph: '$main', from: { node: '$p7', port: 'then' }, to: { node: '$inc', port: 'exec' } },
  ];
  // classify(2): inline input on the call node
  const r = applyOps(p, ops, tc);
  const main = r.project.scripts.find((s) => s.name === 'Main')!;
  const call = main.functions.find((f) => f.name === 'main')!.graph.nodes.find((n) => n.id === r.created.callClassify)!;
  const param = main.functions.find((f) => f.name === 'classify')!.params[0];
  return applyOps(r.project, [{ op: 'update_node', node: call.id, inputs: { [param.id]: 2 } }], tc).project;
}

function withOutput(p: Project, output: 'ts' | 'js'): Project {
  return { ...p, scripts: p.scripts.map((s) => ({ ...s, settings: { ...s.settings, output } })) };
}

function writeAll(dir: string, files: { path: string; content: string }[]) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
}

describe('TypeScript backend', () => {
  const project = build();

  it('compiles without diagnostics and matches the golden files', () => {
    const r = compileProject(tc, project);
    expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(r.files.map((f) => f.path).sort()).toEqual(['app/main.ts', 'lib/utils.ts']);
    for (const f of r.files) {
      const golden = join(GOLDEN, f.path);
      if (process.env.UPDATE_GOLDEN || !existsSync(golden)) {
        mkdirSync(dirname(golden), { recursive: true });
        writeFileSync(golden, f.content);
      }
      expect(f.content).toBe(readFileSync(golden, 'utf8'));
    }
  });

  it('the TypeScript passes tsc --strict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-ts-'));
    writeAll(dir, compileProject(tc, project).files);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom'], noUnusedLocals: false, skipLibCheck: true }, include: ['**/*.ts'] }));
    let out = '';
    try {
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(out).toBe('');
  }, 60_000);

  it('the JavaScript output runs and prints what the graph says', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-js-'));
    const r = compileProject(tc, withOutput(project, 'js'));
    expect(r.files.map((f) => f.path).sort()).toEqual(['app/main.js', 'lib/utils.js']);
    expect(r.files.find((f) => f.path === 'app/main.js')!.content).not.toMatch(/: (number|string|void)\b/);
    writeAll(dir, r.files);
    writeFileSync(join(dir, 'run.js'), "import { main, count } from './app/main.js';\nawait main();\nconsole.log('count', count);\n");
    const bundle = join(dir, 'bundle.mjs');
    buildSync({ entryPoints: [join(dir, 'run.js')], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' });
    const out = execFileSync(process.execPath, [bundle], { encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(['0', '2', '4', '2', 'boom', 'Hello Lyra! {braces} `tick`', 'two', '{"answer":42,"mood":1}', 'fallback', 'count 1']);
  }, 60_000);

  it('reports misuse clearly', () => {
    const p = createProject(tc.adapter, 'Bad', { template: 'module' });
    const f = p.scripts[0].functions[0];
    const r = applyOps(p, [{ op: 'add_node', graph: f.id, type: 'ts.await', props: { type: 'int' } }], tc);
    const d = compileProject(tc, r.project).diagnostics;
    expect(d.some((x) => x.code === 'E_AWAIT_OUTSIDE_ASYNC')).toBe(true);
    // GDScript can't be async
    const g = toolchainFor('gdscript');
    const gp = createProject(g.adapter, 'G', { template: 'node' });
    expect(() => applyOps(gp, [{ op: 'update_function', function: gp.scripts[0].functions[0].id, async: true }], g)).toThrow(/can't be marked async|engine event/);
  });
});

describe('inline functions (closures)', () => {
  it('capture and update the owner\'s locals, work as array callbacks, and run', () => {
    let p = createProject(tc.adapter, 'Closures', { template: 'empty', scriptName: 'Main' });
    p = { ...p, scripts: p.scripts.map((s) => ({ ...s, settings: { output: 'js' } })) };
    const r = applyOps(
      p,
      [
        { op: 'add_function', ref: 'main', name: 'main', exported: true },
        { op: 'add_variable', function: '$main', name: 'factor', type: 'int', default: 3 },
        { op: 'add_variable', function: '$main', name: 'total', type: 'int', default: 0 },
        // scale = (x) => x * factor
        { op: 'add_function', ref: 'scale', kind: 'lambda', owner: '$main', name: 'scale', params: [{ name: 'x', type: 'int' }], returnType: 'int' },
        { op: 'add_node', ref: 'fx', graph: '$scale', type: 'core.get_var', props: { variable: 'factor' } },
        { op: 'add_node', ref: 'mul', graph: '$scale', type: 'core.multiply', props: { type: 'int' } },
        { op: 'add_node', ref: 'ret', graph: '$scale', type: 'core.return' },
        { op: 'connect', graph: '$scale', from: { node: '$scale.entry', port: 'x' }, to: { node: '$mul', port: 'a' } },
        { op: 'connect', graph: '$scale', from: { node: '$fx', port: 'value' }, to: { node: '$mul', port: 'b' } },
        { op: 'connect', graph: '$scale', from: { node: '$scale.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
        { op: 'connect', graph: '$scale', from: { node: '$mul', port: 'result' }, to: { node: '$ret', port: 'value' } },
        // add = (x) => { total += x }
        { op: 'add_function', ref: 'add', kind: 'lambda', owner: '$main', name: 'addToTotal', params: [{ name: 'x', type: 'int' }] },
        { op: 'add_node', ref: 'inc', graph: '$add', type: 'core.set_var', props: { variable: 'total', operation: '+' } },
        { op: 'connect', graph: '$add', from: { node: '$add.entry', port: 'then' }, to: { node: '$inc', port: 'exec' } },
        { op: 'connect', graph: '$add', from: { node: '$add.entry', port: 'x' }, to: { node: '$inc', port: 'value' } },
        // main: const nums = [1, 2, 3].map(scale); nums.forEach(add); print(JSON.stringify(nums)); print(total)
        { op: 'add_node', ref: 'arr', graph: '$main', type: 'core.make_array', props: { elementType: 'int', count: 3 }, inputs: { item_0: 1, item_1: 2, item_2: 3 } },
        { op: 'add_node', ref: 'cScale', graph: '$main', type: 'ts.closure', props: { function: '$scale' } },
        { op: 'add_node', ref: 'map', graph: '$main', type: 'ts.call_method', props: { name: 'map', argNames: ['fn'], argTypes: ['fn(int) -> int'], returnType: 'array<int>' } },
        { op: 'add_node', ref: 'cAdd', graph: '$main', type: 'ts.closure', props: { function: '$add' } },
        { op: 'add_node', ref: 'each', graph: '$main', type: 'ts.call_method', props: { name: 'forEach', argNames: ['fn'], argTypes: ['fn(int) -> void'] } },
        { op: 'add_node', ref: 'json', graph: '$main', type: 'ts.call', props: { name: 'JSON.stringify', argTypes: ['any'], returnType: 'string' } },
        { op: 'add_node', ref: 'p1', graph: '$main', type: 'core.print' },
        { op: 'add_node', ref: 'tot', graph: '$main', type: 'core.get_var', props: { variable: 'total' } },
        { op: 'add_node', ref: 'p2', graph: '$main', type: 'core.print' },
        { op: 'connect', graph: '$main', from: { node: '$main.entry', port: 'then' }, to: { node: '$map', port: 'exec' } },
        { op: 'connect', graph: '$main', from: { node: '$arr', port: 'array' }, to: { node: '$map', port: 'object' } },
        { op: 'connect', graph: '$main', from: { node: '$cScale', port: 'fn' }, to: { node: '$map', port: 'arg_0' } },
        { op: 'connect', graph: '$main', from: { node: '$map', port: 'then' }, to: { node: '$each', port: 'exec' } },
        { op: 'connect', graph: '$main', from: { node: '$map', port: 'result' }, to: { node: '$each', port: 'object' } },
        { op: 'connect', graph: '$main', from: { node: '$cAdd', port: 'fn' }, to: { node: '$each', port: 'arg_0' } },
        { op: 'connect', graph: '$main', from: { node: '$each', port: 'then' }, to: { node: '$json', port: 'exec' } },
        { op: 'connect', graph: '$main', from: { node: '$map', port: 'result' }, to: { node: '$json', port: 'arg_0' } },
        { op: 'connect', graph: '$main', from: { node: '$json', port: 'then' }, to: { node: '$p1', port: 'exec' } },
        { op: 'connect', graph: '$main', from: { node: '$json', port: 'result' }, to: { node: '$p1', port: 'value' } },
        { op: 'connect', graph: '$main', from: { node: '$p1', port: 'then' }, to: { node: '$p2', port: 'exec' } },
        { op: 'connect', graph: '$main', from: { node: '$tot', port: 'value' }, to: { node: '$p2', port: 'value' } },
      ],
      tc,
    );
    const c = compileProject(tc, r.project);
    expect(c.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    const js = c.files[0].content;
    expect(js).toContain('let map_result = [1, 2, 3].map((x) => {\n\t\treturn x * factor;\n\t});');
    expect(js).toContain('map_result.forEach((x) => {\n\t\ttotal += x;\n\t});');
    const dir = mkdtempSync(join(tmpdir(), 'cs-closure-'));
    writeFileSync(join(dir, 'main.mjs'), `${js}\nmain();\n`);
    expect(execFileSync(process.execPath, [join(dir, 'main.mjs')], { encoding: 'utf8' }).trim().split('\n')).toEqual(['[3,6,9]', '18']);
    // and the TypeScript version type-checks
    const ts = compileProject(tc, { ...r.project, scripts: r.project.scripts.map((s) => ({ ...s, settings: { output: 'ts' } })) }).files[0];
    expect(ts.content).toContain('.map((x: number): number => {');
    // deleting the owner deletes its inline functions
    const del = applyOps(r.project, [{ op: 'delete_function', function: r.created.main }], tc).project;
    expect(del.scripts[0].functions).toEqual([]);
  });
});
