/**
 * Example projects. Each one is built with the same edit operations the editor and MCP use, so
 * the results are ordinary editable graphs compiled by the normal pipeline — nothing here knows
 * what GDScript they produce.
 */
import type { JsonValue } from '@cs/graph-core';
import type { Toolchain } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp, type ParamInput, type Project } from '@cs/project-format';

export interface ExampleInfo {
  id: string;
  title: string;
  description: string;
  build(tc: Toolchain): Project;
}

const COL = 300;
const ROW = 150;

class Builder {
  ops: EditOp[] = [];
  constructor(readonly script = '$script') {}
  setup(name: string, settings: Record<string, JsonValue>, description: string) {
    this.ops.push({ op: 'add_script', ref: 'script', name, template: 'refcounted', settings, description });
  }
  variable(name: string, type: string, extra: Partial<Extract<EditOp, { op: 'add_variable' }>> = {}) {
    this.ops.push({ op: 'add_variable', script: this.script, name, type, ...extra });
  }
  signal(name: string, params: ParamInput[] = [], description?: string) {
    this.ops.push({ op: 'add_signal', script: this.script, name, params, ...(description ? { description } : {}) });
  }
  event(id: string): Graph {
    this.ops.push({ op: 'add_function', ref: id, script: this.script, kind: 'event', event: id });
    return new Graph(this, id);
  }
  fn(name: string, params: ParamInput[] = [], returnType = 'void', description?: string): Graph {
    this.ops.push({ op: 'add_function', ref: name, script: this.script, name, params, returnType, ...(description ? { description } : {}) });
    return new Graph(this, name);
  }
  local(fn: string, name: string, type: string, def?: JsonValue) {
    this.ops.push({ op: 'add_variable', script: this.script, function: `$${fn}`, name, type, ...(def !== undefined ? { default: def } : {}) });
  }
}

class Graph {
  constructor(
    readonly b: Builder,
    readonly fn: string,
  ) {
    this.b.ops.push({ op: 'move_nodes', nodes: [`$${fn}.entry`], positions: { [`$${fn}.entry`]: { x: 0, y: 0 } } });
  }
  /** Add a node at grid cell (col, row); returns its "$ref". */
  n(ref: string, type: string, col: number, row: number, props?: Record<string, JsonValue>, inputs?: Record<string, JsonValue>): string {
    const r = `${this.fn}_${ref}`;
    this.b.ops.push({ op: 'add_node', ref: r, graph: `$${this.fn}`, type, position: { x: col * COL, y: row * ROW }, ...(props ? { props } : {}), ...(inputs ? { inputs } : {}) });
    return `$${r}`;
  }
  get entry() {
    return `$${this.fn}.entry`;
  }
  /** Wire "ref.port" → "ref.port". */
  w(from: string, to: string) {
    const [fn, fp] = splitPort(from);
    const [tn, tp] = splitPort(to);
    this.b.ops.push({ op: 'connect', from: { node: fn, port: fp }, to: { node: tn, port: tp } });
  }
  /** Chain exec: a.then → b.exec → … (custom ports with "ref.port"). */
  chain(...refs: string[]) {
    for (let i = 0; i < refs.length - 1; i++) {
      const from = refs[i].includes('.') && !refs[i].endsWith('.entry') ? refs[i] : refs[i] === this.entry ? `${refs[i]}.then` : `${refs[i]}.then`;
      const to = refs[i + 1].includes('.') && !refs[i + 1].endsWith('.entry') ? refs[i + 1] : `${refs[i + 1]}.exec`;
      this.w(from, to);
    }
  }
}

function splitPort(s: string): [string, string] {
  const i = s.lastIndexOf('.');
  return [s.slice(0, i), s.slice(i + 1)];
}

function make(tc: Toolchain, title: string, build: (b: Builder) => void): Project {
  const p = createProject(tc.adapter, title, { withScript: false });
  const b = new Builder();
  build(b);
  const r = applyOps(p, b.ops, tc);
  const project = r.project;
  const s = project.scripts[0];
  project.editor = { activeScriptId: s.id, activeFunctionId: s.functions[0]?.id };
  return project;
}

// ---------------------------------------------------------------------------

export const EXAMPLES: ExampleInfo[] = [
  {
    id: 'hello-world',
    title: 'Hello World',
    description: 'Print a message when the node is ready.',
    build: (tc) =>
      make(tc, 'Hello World', (b) => {
        b.setup('HelloWorld', { extends: 'Node' }, 'Prints a greeting when the scene starts.');
        const g = b.event('_ready');
        const p = g.n('print', 'core.print', 1, 0, undefined, { value: 'Hello, world!' });
        g.chain(g.entry, p);
      }),
  },
  {
    id: 'variables-arithmetic',
    title: 'Variables and Arithmetic',
    description: 'Member variables, a constant, compound assignment and maths.',
    build: (tc) =>
      make(tc, 'Variables and Arithmetic', (b) => {
        b.setup('ScoreKeeper', { extends: 'Node' }, 'Keeps a score and does some arithmetic with it.');
        b.variable('MAX_SCORE', 'int', { default: 100, constant: true });
        b.variable('score', 'int', { default: 0, description: 'Points collected so far.' });
        b.variable('multiplier', 'float', { default: 1.5, exported: true });
        const g = b.event('_ready');
        const add = g.n('add10', 'core.set_var', 1, 0, { variable: 'score', operation: '+' }, { value: 10 });
        const mul = g.n('times3', 'core.set_var', 2, 0, { variable: 'score', operation: '*' }, { value: 3 });
        const p1 = g.n('p1', 'core.print', 3, 0);
        const c1 = g.n('c1', 'core.concat', 2, 1, undefined, { s0: 'Score: ' });
        const s1 = g.n('s1', 'core.to_string', 1, 1);
        const score = g.n('score', 'core.get_var', 0, 1, { variable: 'score' });
        g.chain(g.entry, add, mul, p1);
        g.w(`${score}.value`, `${s1}.value`);
        g.w(`${s1}.result`, `${c1}.s1`);
        g.w(`${c1}.result`, `${p1}.value`);
        const p2 = g.n('p2', 'core.print', 4, 0);
        const weighted = g.n('weighted', 'core.multiply', 2, 2, { type: 'float' });
        const m = g.n('mult', 'core.get_var', 1, 3, { variable: 'multiplier' });
        const s2 = g.n('s2', 'core.to_string', 3, 2);
        const c2 = g.n('c2', 'core.concat', 3, 3, undefined, { s0: 'Weighted: ' });
        g.w(`${score}.value`, `${weighted}.a`);
        g.w(`${m}.value`, `${weighted}.b`);
        g.w(`${weighted}.result`, `${s2}.value`);
        g.w(`${s2}.result`, `${c2}.s1`);
        g.w(`${c2}.result`, `${p2}.value`);
        const p3 = g.n('p3', 'core.print', 5, 0);
        const min = g.n('min', 'core.min', 4, 2, { type: 'int' });
        const max = g.n('max', 'core.get_var', 3, 4, { variable: 'MAX_SCORE' });
        g.w(`${score}.value`, `${min}.a`);
        g.w(`${max}.value`, `${min}.b`);
        g.w(`${min}.result`, `${p3}.value`);
        g.chain(p1, p2, p3);
      }),
  },
  {
    id: 'conditional-logic',
    title: 'Conditional Logic',
    description: 'Nested branches that become if / elif / else.',
    build: (tc) =>
      make(tc, 'Conditional Logic', (b) => {
        b.setup('HealthCheck', { extends: 'Node' }, 'Reports how healthy the player is.');
        b.variable('health', 'int', { default: 75, exported: true });
        const g = b.event('_ready');
        const hp = g.n('hp', 'core.get_var', 0, 1, { variable: 'health' });
        const gt50 = g.n('gt50', 'core.greater', 1, 1, { type: 'int' }, { b: 50 });
        const gt20 = g.n('gt20', 'core.greater', 2, 2, { type: 'int' }, { b: 20 });
        const b1 = g.n('b1', 'core.branch', 1, 0);
        const b2 = g.n('b2', 'core.branch', 2, 1);
        const healthy = g.n('healthy', 'core.print', 3, 0, undefined, { value: 'Healthy' });
        const hurt = g.n('hurt', 'core.print', 3, 1, undefined, { value: 'Hurt' });
        const critical = g.n('critical', 'core.print', 3, 2, undefined, { value: 'Critical!' });
        const done = g.n('done', 'core.print', 4, 0, undefined, { value: 'Check complete' });
        g.chain(g.entry, b1);
        g.w(`${hp}.value`, `${gt50}.a`);
        g.w(`${hp}.value`, `${gt20}.a`);
        g.w(`${gt50}.result`, `${b1}.condition`);
        g.w(`${gt20}.result`, `${b2}.condition`);
        g.w(`${b1}.true`, `${healthy}.exec`);
        g.w(`${b1}.false`, `${b2}.exec`);
        g.w(`${b2}.true`, `${hurt}.exec`);
        g.w(`${b2}.false`, `${critical}.exec`);
        g.chain(healthy, done);
        g.chain(hurt, done);
        g.chain(critical, done);
      }),
  },
  {
    id: 'loops',
    title: 'Loops',
    description: 'For, for-each and while loops.',
    build: (tc) =>
      make(tc, 'Loops', (b) => {
        b.setup('Loops', { extends: 'Node' }, 'Demonstrates the three loop kinds.');
        const g = b.event('_ready');
        b.local('_ready', 'countdown', 'int', 3);
        const forr = g.n('for', 'core.for_range', 1, 0, undefined, { from: 1, to: 6 });
        const sq = g.n('sq', 'core.multiply', 2, 2, { type: 'int' });
        const sqs = g.n('sqs', 'core.to_string', 3, 2);
        const p1 = g.n('p1', 'core.print', 3, 1);
        g.chain(g.entry, forr);
        g.w(`${forr}.body`, `${p1}.exec`);
        g.w(`${forr}.index`, `${sq}.a`);
        g.w(`${forr}.index`, `${sq}.b`);
        g.w(`${sq}.result`, `${sqs}.value`);
        g.w(`${sqs}.result`, `${p1}.value`);
        const arr = g.n('arr', 'core.make_array', 3, 4, { elementType: 'string', count: 3 }, { item_0: 'sword', item_1: 'shield', item_2: 'potion' });
        const each = g.n('each', 'core.for_each', 4, 0, { elementType: 'string', elementName: 'item' });
        const label = g.n('label', 'core.concat', 5, 3, undefined, { s0: 'Item: ' });
        const p2 = g.n('p2', 'core.print', 5, 1);
        g.w(`${forr}.completed`, `${each}.exec`);
        g.w(`${arr}.array`, `${each}.array`);
        g.w(`${each}.body`, `${p2}.exec`);
        g.w(`${each}.element`, `${label}.s1`);
        g.w(`${label}.result`, `${p2}.value`);
        const cd = g.n('cd', 'core.get_var', 6, 3, { variable: 'countdown' });
        const pos = g.n('pos', 'core.greater', 7, 3, { type: 'int' }, { b: 0 });
        const wh = g.n('while', 'core.while', 7, 0);
        const cds = g.n('cds', 'core.to_string', 8, 3);
        const p3 = g.n('p3', 'core.print', 8, 1);
        const dec = g.n('dec', 'core.set_var', 9, 1, { variable: 'countdown', operation: '-' }, { value: 1 });
        const lift = g.n('lift', 'core.print', 8, 0, undefined, { value: 'Liftoff!' });
        g.w(`${each}.completed`, `${wh}.exec`);
        g.w(`${cd}.value`, `${pos}.a`);
        g.w(`${pos}.result`, `${wh}.condition`);
        g.w(`${wh}.body`, `${p3}.exec`);
        g.w(`${cd}.value`, `${cds}.value`);
        g.w(`${cds}.result`, `${p3}.value`);
        g.chain(p3, dec);
        g.w(`${wh}.completed`, `${lift}.exec`);
      }),
  },
  {
    id: 'functions',
    title: 'Functions',
    description: 'Functions with parameters and return values, called from _ready.',
    build: (tc) =>
      make(tc, 'Functions', (b) => {
        b.setup('MathHelpers', { extends: 'Node' }, 'Small helper functions.');
        const add = b.fn('add', [{ name: 'a', type: 'int' }, { name: 'b', type: 'int' }], 'int', 'Returns the sum of a and b.');
        const sum = add.n('sum', 'core.add', 1, 1, { type: 'int' });
        const ret = add.n('ret', 'core.return', 2, 0);
        add.chain(add.entry, ret);
        add.w(`${add.entry}.a`, `${sum}.a`);
        add.w(`${add.entry}.b`, `${sum}.b`);
        add.w(`${sum}.result`, `${ret}.value`);

        const desc = b.fn('parity', [{ name: 'n', type: 'int' }], 'string', 'Describes whether n is even or odd.');
        const mod = desc.n('mod', 'core.modulo', 1, 1, { type: 'int' }, { b: 2 });
        const eq = desc.n('eq', 'core.equal', 2, 1, { type: 'int' }, { b: 0 });
        const br = desc.n('br', 'core.branch', 2, 0);
        const even = desc.n('even', 'core.return', 3, 0, undefined, { value: 'even' });
        const odd = desc.n('odd', 'core.return', 3, 1, undefined, { value: 'odd' });
        desc.chain(desc.entry, br);
        desc.w(`${desc.entry}.n`, `${mod}.a`);
        desc.w(`${mod}.result`, `${eq}.a`);
        desc.w(`${eq}.result`, `${br}.condition`);
        desc.w(`${br}.true`, `${even}.exec`);
        desc.w(`${br}.false`, `${odd}.exec`);

        const g = b.event('_ready');
        const c1 = g.n('c1', 'core.call_function', 1, 0, { function: 'add' }, { a: 2, b: 3 });
        const c2 = g.n('c2', 'core.call_function', 2, 0, { function: 'parity' });
        const str = g.n('str', 'core.to_string', 2, 1);
        const cat = g.n('cat', 'core.concat', 3, 1, { count: 3 }, { s1: ' is ' });
        const p = g.n('p', 'core.print', 4, 0);
        g.chain(g.entry, c1, c2, p);
        g.w(`${c1}.result`, `${c2}.n`);
        g.w(`${c1}.result`, `${str}.value`);
        g.w(`${str}.result`, `${cat}.s0`);
        g.w(`${c2}.result`, `${cat}.s2`);
        g.w(`${cat}.result`, `${p}.value`);
      }),
  },
  {
    id: 'signals',
    title: 'Signals',
    description: 'Declare, emit and connect signals.',
    build: (tc) =>
      make(tc, 'Signals', (b) => {
        b.setup('Health', { extends: 'Node' }, 'A health component that announces changes with signals.');
        b.signal('health_changed', [{ name: 'new_health', type: 'int' }], 'Emitted after damage is taken.');
        b.signal('died');
        b.variable('health', 'int', { default: 100 });
        const on = b.fn('_on_health_changed', [{ name: 'new_health', type: 'int' }]);
        const s = on.n('s', 'core.to_string', 1, 1);
        const c = on.n('c', 'core.concat', 2, 1, undefined, { s0: 'Health: ' });
        const p = on.n('p', 'core.print', 2, 0);
        on.chain(on.entry, p);
        on.w(`${on.entry}.new_health`, `${s}.value`);
        on.w(`${s}.result`, `${c}.s1`);
        on.w(`${c}.result`, `${p}.value`);

        const td = b.fn('take_damage', [{ name: 'amount', type: 'int' }], 'void', 'Reduce health and notify listeners.');
        const sub = td.n('sub', 'core.set_var', 1, 0, { variable: 'health', operation: '-' });
        const hp = td.n('hp', 'core.get_var', 1, 2, { variable: 'health' });
        const emit = td.n('emit', 'godot.emit_signal', 2, 0, { signal: 'health_changed' });
        const le = td.n('le', 'core.less_equal', 2, 2, { type: 'int' }, { b: 0 });
        const br = td.n('br', 'core.branch', 3, 0);
        const died = td.n('died', 'godot.emit_signal', 4, 0, { signal: 'died' });
        td.chain(td.entry, sub, emit, br);
        td.w(`${td.entry}.amount`, `${sub}.value`);
        td.w(`${hp}.value`, `${emit}.new_health`);
        td.w(`${hp}.value`, `${le}.a`);
        td.w(`${le}.result`, `${br}.condition`);
        td.w(`${br}.true`, `${died}.exec`);

        const g = b.event('_ready');
        const con = g.n('con', 'godot.connect_signal', 1, 0, { signal: 'health_changed', method: '_on_health_changed' });
        const hit1 = g.n('hit1', 'core.call_function', 2, 0, { function: 'take_damage' }, { amount: 30 });
        const hit2 = g.n('hit2', 'core.call_function', 3, 0, { function: 'take_damage' }, { amount: 80 });
        g.chain(g.entry, con, hit1, hit2);
      }),
  },
  {
    id: 'movement-2d',
    title: '2D Character Movement',
    description: 'Top-down CharacterBody2D movement with the arrow keys.',
    build: (tc) =>
      make(tc, '2D Character Movement', (b) => {
        b.setup('TopDownPlayer', { extends: 'CharacterBody2D' }, 'Moves in eight directions with the ui_* actions.');
        b.variable('speed', 'float', { default: 300, exported: true, description: 'Pixels per second.' });
        const g = b.event('_physics_process');
        const dir = g.n('dir', 'godot.input.get_vector', 0, 2);
        const sp = g.n('speed', 'core.get_var', 0, 3, { variable: 'speed' });
        const mul = g.n('mul', 'core.multiply', 1, 2, { type: 'Vector2', rhsType: 'float' });
        const set = g.n('set', 'godot.characterbody2d.set_velocity', 1, 0);
        const move = g.n('move', 'godot.characterbody2d.move_and_slide', 2, 0);
        g.chain(g.entry, set, move);
        g.w(`${dir}.result`, `${mul}.a`);
        g.w(`${sp}.value`, `${mul}.b`);
        g.w(`${mul}.result`, `${set}.value`);
      }),
  },
  {
    id: 'movement-3d',
    title: '3D Character Movement',
    description: 'CharacterBody3D movement relative to the facing direction, with gravity.',
    build: (tc) =>
      make(tc, '3D Character Movement', (b) => {
        b.setup('Player3D', { extends: 'CharacterBody3D' }, 'Walks on the ground relative to where it faces.');
        b.variable('speed', 'float', { default: 5, exported: true });
        b.variable('gravity', 'float', { default: 9.8, exported: true });
        const g = b.event('_physics_process');
        b.local('_physics_process', 'input_dir', 'Vector2');
        b.local('_physics_process', 'direction', 'Vector3');
        // gravity
        const onFloor = g.n('onfloor', 'godot.characterbody3d.is_on_floor', 0, 2);
        const notFloor = g.n('not', 'core.not', 1, 2);
        const br = g.n('br', 'core.branch', 1, 0);
        const vel = g.n('vel', 'godot.characterbody3d.get_velocity', 1, 3);
        const grav = g.n('grav', 'core.get_var', 1, 4, { variable: 'gravity' });
        const gd = g.n('gd', 'core.multiply', 2, 4, { type: 'float' });
        const down = g.n('down', 'godot.make_vector3', 3, 4);
        const fall = g.n('fall', 'core.subtract', 3, 3, { type: 'Vector3' });
        const setFall = g.n('setfall', 'godot.characterbody3d.set_velocity', 4, 1);
        g.chain(g.entry, br);
        g.w(`${onFloor}.result`, `${notFloor}.a`);
        g.w(`${notFloor}.result`, `${br}.condition`);
        g.w(`${br}.true`, `${setFall}.exec`);
        g.w(`${grav}.value`, `${gd}.a`);
        g.w(`${g.entry}.delta`, `${gd}.b`);
        g.w(`${gd}.result`, `${down}.y`);
        g.w(`${vel}.value`, `${fall}.a`);
        g.w(`${down}.result`, `${fall}.b`);
        g.w(`${fall}.result`, `${setFall}.value`);
        // direction from input, rotated by the body's basis
        const input = g.n('input', 'godot.input.get_vector', 4, 5);
        const setInput = g.n('setinput', 'core.set_var', 4, 0, { variable: 'input_dir' });
        const inDir = g.n('indir', 'core.get_var', 5, 6, { variable: 'input_dir' });
        const brk = g.n('brk', 'godot.break_vector2', 5, 5);
        const flat = g.n('flat', 'godot.make_vector3', 6, 5);
        const basis = g.n('basis', 'godot.node3d.get_basis', 6, 4);
        const rot = g.n('rot', 'core.multiply', 7, 4, { type: 'Basis', rhsType: 'Vector3' });
        const norm = g.n('norm', 'godot.vector3.normalized', 8, 4);
        const setDir = g.n('setdir', 'core.set_var', 5, 0, { variable: 'direction' });
        g.w(`${input}.result`, `${setInput}.value`);
        g.w(`${inDir}.value`, `${brk}.value`);
        g.w(`${brk}.x`, `${flat}.x`);
        g.w(`${brk}.y`, `${flat}.z`);
        g.w(`${basis}.value`, `${rot}.a`);
        g.w(`${flat}.result`, `${rot}.b`);
        g.w(`${rot}.result`, `${norm}.target`);
        g.w(`${norm}.result`, `${setDir}.value`);
        g.w(`${br}.false`, `${setInput}.exec`);
        g.w(`${setFall}.then`, `${setInput}.exec`);
        g.chain(setInput, setDir);
        // horizontal velocity
        const d = g.n('d', 'core.get_var', 6, 2, { variable: 'direction' });
        const db = g.n('db', 'godot.break_vector3', 7, 2);
        const sp = g.n('sp', 'core.get_var', 7, 3, { variable: 'speed' });
        const vx = g.n('vx', 'core.multiply', 8, 2, { type: 'float' });
        const vz = g.n('vz', 'core.multiply', 8, 3, { type: 'float' });
        const v2 = g.n('v2', 'godot.characterbody3d.get_velocity', 7, 1);
        const vb = g.n('vb', 'godot.break_vector3', 8, 1);
        const nv = g.n('nv', 'godot.make_vector3', 9, 2);
        const setVel = g.n('setvel', 'godot.characterbody3d.set_velocity', 9, 0);
        const move = g.n('move', 'godot.characterbody3d.move_and_slide', 10, 0);
        g.w(`${d}.value`, `${db}.value`);
        g.w(`${db}.x`, `${vx}.a`);
        g.w(`${sp}.value`, `${vx}.b`);
        g.w(`${db}.z`, `${vz}.a`);
        g.w(`${sp}.value`, `${vz}.b`);
        g.w(`${v2}.value`, `${vb}.value`);
        g.w(`${vx}.result`, `${nv}.x`);
        g.w(`${vb}.y`, `${nv}.y`);
        g.w(`${vz}.result`, `${nv}.z`);
        g.w(`${nv}.result`, `${setVel}.value`);
        g.chain(setDir, setVel, move);
      }),
  },
  {
    id: 'jump-gravity',
    title: 'Jumping and Gravity',
    description: 'A 2D platformer controller: gravity, jumping and running.',
    build: (tc) =>
      make(tc, 'Jumping and Gravity', (b) => {
        b.setup('PlatformerPlayer', { extends: 'CharacterBody2D' }, 'Side-scrolling player with gravity and jumping.');
        b.variable('speed', 'float', { default: 300, exported: true });
        b.variable('jump_velocity', 'float', { default: -400, exported: true });
        b.variable('gravity', 'float', { default: 980, exported: true });
        const g = b.event('_physics_process');
        b.local('_physics_process', 'vel', 'Vector2');
        const cur = g.n('cur', 'godot.characterbody2d.get_velocity', 0, 1);
        const store = g.n('store', 'core.set_var', 1, 0, { variable: 'vel' });
        g.chain(g.entry, store);
        g.w(`${cur}.value`, `${store}.value`);
        // gravity
        const floor = g.n('floor', 'godot.characterbody2d.is_on_floor', 1, 3);
        const air = g.n('air', 'core.not', 2, 3);
        const b1 = g.n('b1', 'core.branch', 2, 0);
        const grav = g.n('grav', 'core.get_var', 2, 4, { variable: 'gravity' });
        const gd = g.n('gd', 'core.multiply', 3, 4, { type: 'float' });
        const gv = g.n('gv', 'godot.make_vector2', 4, 4);
        const fall = g.n('fall', 'core.set_var', 3, 1, { variable: 'vel', operation: '+' });
        g.chain(store, b1);
        g.w(`${floor}.result`, `${air}.a`);
        g.w(`${air}.result`, `${b1}.condition`);
        g.w(`${grav}.value`, `${gd}.a`);
        g.w(`${g.entry}.delta`, `${gd}.b`);
        g.w(`${gd}.result`, `${gv}.y`);
        g.w(`${gv}.result`, `${fall}.value`);
        g.w(`${b1}.true`, `${fall}.exec`);
        // jump
        const jp = g.n('jp', 'godot.input.is_action_just_pressed', 4, 3, undefined, { action: 'ui_accept' });
        const can = g.n('can', 'core.and', 5, 3);
        const b2 = g.n('b2', 'core.branch', 5, 0);
        const v = g.n('v', 'core.get_var', 5, 5, { variable: 'vel' });
        const vb = g.n('vb', 'godot.break_vector2', 6, 5);
        const jv = g.n('jv', 'core.get_var', 6, 4, { variable: 'jump_velocity' });
        const jvec = g.n('jvec', 'godot.make_vector2', 7, 4);
        const jump = g.n('jump', 'core.set_var', 6, 1, { variable: 'vel' });
        g.w(`${b1}.false`, `${b2}.exec`);
        g.w(`${fall}.then`, `${b2}.exec`);
        g.w(`${jp}.result`, `${can}.a`);
        g.w(`${floor}.result`, `${can}.b`);
        g.w(`${can}.result`, `${b2}.condition`);
        g.w(`${v}.value`, `${vb}.value`);
        g.w(`${vb}.x`, `${jvec}.x`);
        g.w(`${jv}.value`, `${jvec}.y`);
        g.w(`${jvec}.result`, `${jump}.value`);
        g.w(`${b2}.true`, `${jump}.exec`);
        // run
        const axis = g.n('axis', 'godot.input.get_axis', 7, 6);
        const sp = g.n('sp', 'core.get_var', 7, 7, { variable: 'speed' });
        const vx = g.n('vx', 'core.multiply', 8, 6, { type: 'float' });
        const run = g.n('run', 'godot.make_vector2', 9, 6);
        const setRun = g.n('setrun', 'core.set_var', 8, 0, { variable: 'vel' });
        const apply = g.n('apply', 'godot.characterbody2d.set_velocity', 9, 0);
        const move = g.n('move', 'godot.characterbody2d.move_and_slide', 10, 0);
        g.w(`${b2}.false`, `${setRun}.exec`);
        g.w(`${jump}.then`, `${setRun}.exec`);
        g.w(`${axis}.result`, `${vx}.a`);
        g.w(`${sp}.value`, `${vx}.b`);
        g.w(`${vx}.result`, `${run}.x`);
        g.w(`${vb}.y`, `${run}.y`);
        g.w(`${run}.result`, `${setRun}.value`);
        const v3 = g.n('v3', 'core.get_var', 9, 1, { variable: 'vel' });
        g.w(`${v3}.value`, `${apply}.value`);
        g.chain(setRun, apply, move);
      }),
  },
  {
    id: 'mouse-look',
    title: 'Mouse-Look Camera',
    description: 'First-person mouse look: yaw the body, pitch the head, clamp the pitch.',
    build: (tc) =>
      make(tc, 'Mouse-Look Camera', (b) => {
        b.setup('FirstPersonLook', { extends: 'CharacterBody3D' }, 'Expects a child Node3D called "Head" holding the Camera3D.');
        b.variable('sensitivity', 'float', { default: 0.003, exported: true, description: 'Radians per pixel of mouse movement.' });
        b.variable('head', 'Node3D', { attributes: { onreadyPath: 'Head' } });
        const r = b.event('_ready');
        const cap = r.n('cap', 'godot.set_mouse_mode', 1, 0, { mode: 'MOUSE_MODE_CAPTURED' });
        r.chain(r.entry, cap);

        const g = b.event('_unhandled_input');
        const seq = g.n('seq', 'core.sequence', 1, 0);
        const isMotion = g.n('ismotion', 'core.is_instance', 1, 2, { type: 'InputEventMouseMotion' });
        const b1 = g.n('b1', 'core.branch', 2, 0);
        const cast = g.n('cast', 'core.cast', 2, 3, { type: 'InputEventMouseMotion' });
        const rel = g.n('rel', 'godot.inputeventmousemotion.get_relative', 3, 3);
        const rb = g.n('rb', 'godot.break_vector2', 4, 3);
        const sens = g.n('sens', 'core.get_var', 4, 5, { variable: 'sensitivity' });
        const yawAmt = g.n('yawamt', 'core.multiply', 5, 3, { type: 'float' });
        const yawNeg = g.n('yawneg', 'core.negate', 6, 3, { type: 'float' });
        const yaw = g.n('yaw', 'godot.node3d.rotate_y', 3, 0);
        const pitchAmt = g.n('pitchamt', 'core.multiply', 5, 4, { type: 'float' });
        const pitchNeg = g.n('pitchneg', 'core.negate', 6, 4, { type: 'float' });
        const head = g.n('head', 'core.get_var', 5, 6, { variable: 'head' });
        const pitch = g.n('pitch', 'godot.node3d.rotate_x', 4, 0);
        g.chain(g.entry, seq);
        g.w(`${seq}.then_0`, `${b1}.exec`);
        g.w(`${g.entry}.event`, `${isMotion}.object`);
        g.w(`${isMotion}.result`, `${b1}.condition`);
        g.w(`${g.entry}.event`, `${cast}.object`);
        g.w(`${cast}.result`, `${rel}.target`);
        g.w(`${rel}.value`, `${rb}.value`);
        g.w(`${rb}.x`, `${yawAmt}.a`);
        g.w(`${sens}.value`, `${yawAmt}.b`);
        g.w(`${yawAmt}.result`, `${yawNeg}.a`);
        g.w(`${yawNeg}.result`, `${yaw}.angle`);
        g.w(`${rb}.y`, `${pitchAmt}.a`);
        g.w(`${sens}.value`, `${pitchAmt}.b`);
        g.w(`${pitchAmt}.result`, `${pitchNeg}.a`);
        g.w(`${pitchNeg}.result`, `${pitch}.angle`);
        g.w(`${head}.value`, `${pitch}.target`);
        g.w(`${b1}.true`, `${yaw}.exec`);
        g.chain(yaw, pitch);
        // clamp pitch
        const hr = g.n('hr', 'godot.node3d.get_rotation', 6, 6);
        const hb = g.n('hb', 'godot.break_vector3', 7, 6);
        const lo = g.n('lo', 'godot.global.deg_to_rad', 7, 7, undefined, { deg: -89 });
        const hi = g.n('hi', 'godot.global.deg_to_rad', 7, 8, undefined, { deg: 89 });
        const cl = g.n('cl', 'core.clamp', 8, 6, { type: 'float' });
        const nr = g.n('nr', 'godot.make_vector3', 9, 6);
        const setRot = g.n('setrot', 'godot.node3d.set_rotation', 5, 0);
        g.w(`${head}.value`, `${hr}.target`);
        g.w(`${hr}.value`, `${hb}.value`);
        g.w(`${hb}.x`, `${cl}.value`);
        g.w(`${lo}.result`, `${cl}.min`);
        g.w(`${hi}.result`, `${cl}.max`);
        g.w(`${cl}.result`, `${nr}.x`);
        g.w(`${hb}.y`, `${nr}.y`);
        g.w(`${hb}.z`, `${nr}.z`);
        g.w(`${nr}.result`, `${setRot}.value`);
        g.w(`${head}.value`, `${setRot}.target`);
        g.chain(pitch, setRot);
        // escape releases the mouse
        const esc = g.n('esc', 'godot.inputevent.is_action_pressed', 2, 9, undefined, { action: 'ui_cancel' });
        const b2 = g.n('b2', 'core.branch', 3, 9);
        const free = g.n('free', 'godot.set_mouse_mode', 4, 9, { mode: 'MOUSE_MODE_VISIBLE' });
        g.w(`${seq}.then_1`, `${b2}.exec`);
        g.w(`${g.entry}.event`, `${esc}.target`);
        g.w(`${esc}.result`, `${b2}.condition`);
        g.w(`${b2}.true`, `${free}.exec`);
      }),
  },
  {
    id: 'interaction',
    title: 'Interaction System',
    description: 'An Area2D that lets a "player"-group body interact with it.',
    build: (tc) =>
      make(tc, 'Interaction System', (b) => {
        b.setup('Interactable', { extends: 'Area2D' }, 'Add to an Area2D with a CollisionShape2D. Bodies in the "player" group can interact with ui_accept.');
        b.signal('interacted');
        b.variable('prompt', 'string', { default: 'Press Enter to interact', exported: true });
        b.variable('player_inside', 'bool', { default: false });
        for (const [name, value] of [
          ['_on_body_entered', true],
          ['_on_body_exited', false],
        ] as const) {
          const f = b.fn(name, [{ name: 'body', type: 'Node2D' }]);
          const inGroup = f.n('ingroup', 'godot.node.is_in_group', 1, 2, undefined, { group: 'player' });
          const br = f.n('br', 'core.branch', 1, 0);
          const set = f.n('set', 'core.set_var', 2, 0, { variable: 'player_inside' }, { value });
          f.chain(f.entry, br);
          f.w(`${f.entry}.body`, `${inGroup}.target`);
          f.w(`${inGroup}.result`, `${br}.condition`);
          f.w(`${br}.true`, `${set}.exec`);
          if (value) {
            const pr = f.n('pr', 'core.get_var', 2, 2, { variable: 'prompt' });
            const p = f.n('p', 'core.print', 3, 0);
            f.w(`${pr}.value`, `${p}.value`);
            f.chain(set, p);
          }
        }
        const r = b.event('_ready');
        const c1 = r.n('c1', 'godot.connect_signal', 1, 0, { signal: 'body_entered', method: '_on_body_entered' });
        const c2 = r.n('c2', 'godot.connect_signal', 2, 0, { signal: 'body_exited', method: '_on_body_exited' });
        r.chain(r.entry, c1, c2);
        const g = b.event('_unhandled_input');
        const inside = g.n('inside', 'core.get_var', 0, 2, { variable: 'player_inside' });
        const pressed = g.n('pressed', 'godot.inputevent.is_action_pressed', 0, 3, undefined, { action: 'ui_accept' });
        const both = g.n('both', 'core.and', 1, 2);
        const br = g.n('br', 'core.branch', 1, 0);
        const emit = g.n('emit', 'godot.emit_signal', 2, 0, { signal: 'interacted' });
        const p = g.n('p', 'core.print', 3, 0, undefined, { value: 'Interacted!' });
        g.chain(g.entry, br);
        g.w(`${g.entry}.event`, `${pressed}.target`);
        g.w(`${inside}.value`, `${both}.a`);
        g.w(`${pressed}.result`, `${both}.b`);
        g.w(`${both}.result`, `${br}.condition`);
        g.w(`${br}.true`, `${emit}.exec`);
        g.chain(emit, p);
      }),
  },
  {
    id: 'timer',
    title: 'Timer-Based Actions',
    description: 'Create a Timer in code, react to its timeout, and await a delay.',
    build: (tc) =>
      make(tc, 'Timer-Based Actions', (b) => {
        b.setup('Ticker', { extends: 'Node' }, 'Ticks five times, then stops.');
        b.variable('interval', 'float', { default: 1, exported: true });
        b.variable('ticks', 'int', { default: 0 });
        b.variable('timer', 'Timer');
        const t = b.fn('_on_timer_timeout');
        const inc = t.n('inc', 'core.set_var', 1, 0, { variable: 'ticks', operation: '+' }, { value: 1 });
        const ticks = t.n('ticks', 'core.get_var', 1, 2, { variable: 'ticks' });
        const ts = t.n('ts', 'core.to_string', 2, 2);
        const msg = t.n('msg', 'core.concat', 3, 2, undefined, { s0: 'Tick ' });
        const p = t.n('p', 'core.print', 2, 0);
        const ge = t.n('ge', 'core.greater_equal', 3, 3, { type: 'int' }, { b: 5 });
        const br = t.n('br', 'core.branch', 3, 0);
        const tm = t.n('tm', 'core.get_var', 3, 4, { variable: 'timer' });
        const stop = t.n('stop', 'godot.timer.stop', 4, 0);
        const done = t.n('done', 'core.print', 5, 0, undefined, { value: 'Timer finished' });
        t.chain(t.entry, inc, p, br);
        t.w(`${ticks}.value`, `${ts}.value`);
        t.w(`${ts}.result`, `${msg}.s1`);
        t.w(`${msg}.result`, `${p}.value`);
        t.w(`${ticks}.value`, `${ge}.a`);
        t.w(`${ge}.result`, `${br}.condition`);
        t.w(`${br}.true`, `${stop}.exec`);
        t.w(`${tm}.value`, `${stop}.target`);
        t.chain(stop, done);

        const g = b.event('_ready');
        const hello = g.n('hello', 'core.print', 1, 0, undefined, { value: 'Starting in half a second…' });
        const wait = g.n('wait', 'godot.delay', 2, 0, undefined, { seconds: 0.5 });
        const create = g.n('create', 'core.new_object', 3, 0, { type: 'Timer' });
        const store = g.n('store', 'core.set_var', 4, 0, { variable: 'timer' });
        const tv = g.n('tv', 'core.get_var', 4, 2, { variable: 'timer' });
        const iv = g.n('iv', 'core.get_var', 5, 3, { variable: 'interval' });
        const wt = g.n('wt', 'godot.timer.set_wait_time', 5, 0);
        const con = g.n('con', 'godot.connect_signal', 6, 0, { signal: 'timeout', method: '_on_timer_timeout' });
        const add = g.n('add', 'godot.node.add_child', 7, 0);
        const start = g.n('start', 'godot.timer.start', 8, 0);
        g.chain(g.entry, hello, wait, create, store, wt, con, add, start);
        g.w(`${create}.object`, `${store}.value`);
        g.w(`${tv}.value`, `${wt}.target`);
        g.w(`${iv}.value`, `${wt}.value`);
        g.w(`${tv}.value`, `${con}.source`);
        g.w(`${tv}.value`, `${add}.node`);
        g.w(`${tv}.value`, `${start}.target`);
      }),
  },
];

export function exampleById(id: string): ExampleInfo | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
export { buildWebStarter } from './webStarter';
