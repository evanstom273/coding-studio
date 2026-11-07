/** Class scripts: extend a library class (Phaser.Scene), fields, constructor with super(), methods using this. */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProject } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';

const tc = toolchainFor('typescript');

function phaserScene() {
  const p = createProject(tc.adapter, 'Platformer', { template: 'class', scriptName: 'MainScene' });
  const sid = p.scripts[0].id;
  const ops: EditOp[] = [
    { op: 'update_script', script: sid, path: 'src/MainScene', settings: { output: 'ts', kind: 'class', extends: 'Phaser.Scene', extendsFrom: 'phaser' } },
    { op: 'add_variable', script: sid, name: 'speed', type: 'float', default: 200 },
    { op: 'add_variable', script: sid, name: 'player', type: 'any' },
    // constructor() { super('main') }
    { op: 'add_function', ref: 'ctor', script: sid, name: 'constructor' },
    { op: 'add_node', ref: 'sup', graph: '$ctor', type: 'ts.super', props: { args: 1 }, inputs: { arg_0: 'main' } },
    { op: 'connect', graph: '$ctor', from: { node: '$ctor.entry', port: 'then' }, to: { node: '$sup', port: 'exec' } },
    // create() { this.player = this.physics.add.sprite(100, 100, 'player') }
    { op: 'add_function', ref: 'create', script: sid, name: 'create' },
    { op: 'add_node', ref: 'self', graph: '$create', type: 'core.self' },
    { op: 'add_node', ref: 'physics', graph: '$create', type: 'ts.get_field', props: { name: 'physics' } },
    { op: 'add_node', ref: 'add', graph: '$create', type: 'ts.get_field', props: { name: 'add' } },
    { op: 'add_node', ref: 'sprite', graph: '$create', type: 'ts.call_method', props: { name: 'sprite', argNames: ['x', 'y', 'key'], argTypes: ['number', 'number', 'string'], returnType: 'any' }, inputs: { arg_0: 100, arg_1: 100, arg_2: 'player' } },
    { op: 'add_node', ref: 'setp', graph: '$create', type: 'core.set_var', props: { variable: 'player' } },
    { op: 'connect', graph: '$create', from: { node: '$self', port: 'self' }, to: { node: '$physics', port: 'object' } },
    { op: 'connect', graph: '$create', from: { node: '$physics', port: 'value' }, to: { node: '$add', port: 'object' } },
    { op: 'connect', graph: '$create', from: { node: '$add', port: 'value' }, to: { node: '$sprite', port: 'object' } },
    { op: 'connect', graph: '$create', from: { node: '$create.entry', port: 'then' }, to: { node: '$sprite', port: 'exec' } },
    { op: 'connect', graph: '$create', from: { node: '$sprite', port: 'then' }, to: { node: '$setp', port: 'exec' } },
    { op: 'connect', graph: '$create', from: { node: '$sprite', port: 'result' }, to: { node: '$setp', port: 'value' } },
    // update() { this.player.setVelocityX(this.speed) }
    { op: 'add_function', ref: 'update', script: sid, name: 'update' },
    { op: 'add_node', ref: 'gp', graph: '$update', type: 'core.get_var', props: { variable: 'player' } },
    { op: 'add_node', ref: 'gs', graph: '$update', type: 'core.get_var', props: { variable: 'speed' } },
    { op: 'add_node', ref: 'vx', graph: '$update', type: 'ts.call_method', props: { name: 'setVelocityX', argNames: ['x'], argTypes: ['number'], returnType: 'any' } },
    { op: 'connect', graph: '$update', from: { node: '$gp', port: 'value' }, to: { node: '$vx', port: 'object' } },
    { op: 'connect', graph: '$update', from: { node: '$gs', port: 'value' }, to: { node: '$vx', port: 'arg_0' } },
    { op: 'connect', graph: '$update', from: { node: '$update.entry', port: 'then' }, to: { node: '$vx', port: 'exec' } },
  ];
  return applyOps(p, ops, tc).project;
}

describe('TypeScript class scripts', () => {
  it('compiles a Phaser scene class: import, extends, fields, constructor with super, this.* members', () => {
    const r = compileProject(tc, phaserScene());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const code = r.files.find((f) => f.path === 'src/MainScene.ts')!.content;
    expect(code).toContain("import * as Phaser from 'phaser';");
    expect(code).toContain('export class MainScene extends Phaser.Scene {');
    expect(code).toContain('speed: number = 200;');
    expect(code).toMatch(/constructor\(\) \{\n\t\tsuper\('main'\);\n\t\}/);
    expect(code).toContain('create(): void {');
    expect(code).toMatch(/= this\.physics\.add\.sprite\(100, 100, 'player'\);\n\t\tthis\.player = /);
    expect(code).toContain('player: any;');
    expect(code).toContain('this.player.setVelocityX(this.speed);');
    expect(code).not.toMatch(/^let /m);
  });

  it('module scripts are unchanged, and Self / constructor are only allowed in classes', () => {
    const p = createProject(tc.adapter, 'Mod', { template: 'module', scriptName: 'Main' });
    const r = compileProject(tc, applyOps(p, [{ op: 'add_function', script: p.scripts[0].id, name: 'constructor' }], tc).project);
    expect(r.diagnostics.some((d) => d.code === 'E_INVALID_NAME')).toBe(true);
    const ok = compileProject(tc, p);
    expect(ok.files[0].content).toContain('export function main(): void {');
  });

  it.skipIf(!process.env.LIVE_NET)('LIVE_NET: the generated scene type-checks against the real Phaser types (tsc --strict)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-phaser-'));
    const r = compileProject(tc, phaserScene());
    mkdirSync(join(dir, 'src'));
    for (const f of r.files) writeFileSync(join(dir, f.path), f.content);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, type: 'module', dependencies: { phaser: '^3.88.0' }, devDependencies: { typescript: '^5.8.0' } }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, lib: ['ES2022', 'DOM'] }, include: ['src'] }));
    execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    const out = execSync('npx tsc -p . 2>&1 || true', { cwd: dir, encoding: 'utf8' });
    expect(out.trim()).toBe('');
  }, 400_000);
});
