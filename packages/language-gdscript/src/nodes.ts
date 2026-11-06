/**
 * GDScript / Godot node pack. Language-specific constructs lower to IR `lang` nodes that only the
 * GDScript backend prints.
 */
import { T, type TypeRef } from '@cs/type-system';
import type { GraphNode, JsonValue } from '@cs/graph-core';
import type { IRExpr } from '@cs/intermediate-representation';
import { data, exec, type LowerContext, type NodeContext, type NodeDefinition, type PortSpec } from '@cs/node-registry';
import { GODOT_API, type ApiMember } from './api';

export const LANG = 'gdscript';
const L = [LANG];

const str = (v: JsonValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);
const lang = (op: string, args: IRExpr[] = [], d?: Record<string, JsonValue>): IRExpr => ({ k: 'lang', lang: LANG, op, args, ...(d ? { data: d } : {}) });

function humanize(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function zero(t: TypeRef): JsonValue | undefined {
  switch (t.kind) {
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'named':
      if (t.name === 'Vector2') return { x: 0, y: 0 };
      if (t.name === 'Vector3') return { x: 0, y: 0, z: 0 };
      if (t.name === 'Color') return { r: 1, g: 1, b: 1, a: 1 };
      return undefined;
    default:
      return undefined;
  }
}

const typeIdPart = (s: string) => (s === '@GlobalScope' ? 'global' : s.toLowerCase());

/** Target port for object members. Unconnected = self (checked when lowering). */
function targetPort(a: ApiMember): PortSpec[] {
  if (a.kind === 'function' || a.singleton) return [];
  return [data.in('target', a.valueType ? a.cls : `${a.cls} (self)`, T.named(a.cls), { connectionOnly: true, required: !!a.valueType, description: a.valueType ? undefined : 'Unconnected = self' })];
}

/** Resolve the call target: the connected object, or nothing (= self) when self is compatible. */
function target(lc: LowerContext, a: ApiMember): IRExpr | undefined {
  if (a.kind === 'function') return undefined;
  if (a.singleton) return { k: 'ref', name: a.cls };
  if (lc.isConnected('target')) return lc.input('target');
  if (a.valueType) return lc.input('target'); // reports missing input
  const self = lc.ctx.selfType();
  if (!self || self.kind !== 'named' || !lc.ctx.isSubclass(self.name, a.cls)) {
    lc.error('E_TARGET_REQUIRED', `This script extends ${self && self.kind === 'named' ? self.name : 'nothing'}, which is not a ${a.cls}. Connect a ${a.cls} to the target pin.`, { port: 'target', suggestion: `Use a Get Node node, a ${a.cls} variable, or change the script's base class.` });
  }
  return undefined;
}

function apiNode(a: ApiMember): NodeDefinition[] {
  const id = `godot.${typeIdPart(a.cls)}`;
  const category = a.cls === '@GlobalScope' ? 'Godot/Math' : `Godot/${a.cls}`;
  const keywords = [a.cls, a.name, ...(a.keywords ?? [])];
  const params = (ctx: NodeContext) => (a.params ?? []).map(([name, type, def]) => {
    const t = ctx.type(type);
    const d = def ?? zero(t);
    return data.in(name, humanize(name), t, d !== undefined ? { default: d } : { required: true, connectionOnly: t.kind === 'named' && !['Vector2', 'Vector3', 'Color'].includes(t.name) });
  });
  if (a.kind === 'property') {
    const get: NodeDefinition = {
      type: `${id}.get_${a.name}`,
      title: `Get ${humanize(a.name)}`,
      category,
      description: `${a.cls}.${a.name}: ${a.description}`,
      keywords: [...keywords, 'get'],
      flavor: 'pure',
      languages: L,
      props: [],
      ports: (_n, ctx) => [...targetPort(a), data.out('value', humanize(a.name), ctx.type(a.type))],
      lowerExpr: (_p, lc) => {
        const t = target(lc, a);
        return t ? { k: 'prop', target: t, name: a.name } : { k: 'ref', name: a.name };
      },
    };
    if (a.readonly) return [get];
    const set: NodeDefinition = {
      type: `${id}.set_${a.name}`,
      title: `Set ${humanize(a.name)}`,
      category,
      description: `Assign ${a.cls}.${a.name}: ${a.description}`,
      keywords: [...keywords, 'set'],
      flavor: 'exec',
      languages: L,
      props: [],
      ports: (_n, ctx) => {
        const t = ctx.type(a.type);
        const d = zero(t);
        return [exec.in(), ...targetPort(a), data.in('value', humanize(a.name), t, d !== undefined ? { default: d } : { required: true }), exec.out()];
      },
      lowerExec: (lc) => {
        const t = target(lc, a);
        return { stmts: [{ k: 'assign', target: t ? { k: 'prop', target: t, name: a.name } : { k: 'ref', name: a.name }, value: lc.input('value') }], next: 'then' };
      },
    };
    return [get, set];
  }
  const callExpr = (lc: LowerContext): IRExpr => {
    const args = (a.params ?? []).map(([name]) => lc.input(name));
    const t = target(lc, a);
    return t ? { k: 'call', name: a.name, target: t, args } : { k: 'call', name: a.name, args };
  };
  const base = {
    type: `${id}.${a.name}`,
    title: a.title ?? humanize(a.name),
    category,
    description: `${a.cls === '@GlobalScope' ? '' : `${a.cls}.`}${a.name}(): ${a.description}`,
    keywords,
    languages: L,
    props: [],
  };
  if (a.pure) {
    return [{ ...base, flavor: 'pure', ports: (_n, ctx) => [...targetPort(a), ...params(ctx), data.out('result', 'Result', ctx.type(a.type))], lowerExpr: (_p, lc) => callExpr(lc) }];
  }
  return [
    {
      ...base,
      flavor: 'exec',
      ports: (_n, ctx) => {
        const rt = ctx.type(a.type);
        return [exec.in(), ...targetPort(a), ...params(ctx), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
      },
      lowerExec: (lc) => {
        const rt = lc.ctx.type(a.type);
        const call = callExpr(lc);
        if (rt.kind === 'void') return { stmts: [{ k: 'expr', expr: call }], next: 'then' };
        return { stmts: lc.bind('result', call, { type: rt, nameHint: a.name === 'instantiate' ? 'instance' : `${a.name}_result`, sideEffect: true }), next: 'then' };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Hand-written Godot nodes
// ---------------------------------------------------------------------------

const getNode: NodeDefinition = {
  type: 'godot.get_node',
  title: 'Get Node',
  category: 'Godot/Scene',
  description: 'A node from the scene tree by path ($Path). Prefer an @onready variable for nodes used often.',
  keywords: ['$', 'find', 'child', 'node path', 'reference'],
  flavor: 'pure',
  languages: L,
  requires: ['classes'],
  props: [
    { key: 'path', label: 'Node path', kind: 'string', default: 'Sprite2D', description: 'Relative to this node, e.g. "Head/Camera3D" or "../Player".' },
    { key: 'type', label: 'Node class', kind: 'type', default: 'Node' },
  ],
  displayTitle: (n) => `$${str(n.props.path, '?')}`,
  ports: (n, ctx) => [data.out('node', 'Node', ctx.type(str(n.props.type, 'Node') || 'Node'))],
  check: (n, ctx, report) => {
    if (!str(n.props.path).trim()) report('E_EMPTY_PATH', 'Node path is empty.');
    const t = ctx.type(str(n.props.type, 'Node') || 'Node');
    if (t.kind !== 'named' || !ctx.isSubclass(t.name, 'Node')) report('E_INVALID_PROPERTY', 'Node class must be Node or a subclass of Node.');
  },
  lowerExpr: (_p, lc) => lang('get_node', [], { path: str(lc.node.props.path), type: str(lc.node.props.type, 'Node') || 'Node' }),
};

const emitSignal: NodeDefinition = {
  type: 'godot.emit_signal',
  title: 'Emit Signal',
  category: 'Godot/Signals',
  description: 'Emit one of this script’s signals.',
  keywords: ['signal', 'emit', 'event', 'notify', 'broadcast'],
  flavor: 'exec',
  languages: L,
  requires: ['signals'],
  props: [{ key: 'signal', label: 'Signal', kind: 'signal', default: '' }],
  displayTitle: (n, ctx) => `Emit ${ctx.signal(n.props.signal)?.name ?? '(missing signal)'}`,
  ports: (n, ctx) => [exec.in(), ...(ctx.signal(n.props.signal)?.params ?? []).map((p) => data.in(p.id, p.name, ctx.type(p.type), { required: true })), exec.out()],
  check: (n, ctx, report) => {
    if (!ctx.signal(n.props.signal)) report('E_UNDEFINED_SIGNAL', 'This node emits a signal that does not exist.', { suggestion: 'Pick a signal in the inspector.' });
  },
  lowerExec: (lc) => {
    const s = lc.ctx.signal(lc.node.props.signal);
    return { stmts: [{ k: 'lang', lang: LANG, op: 'emit', args: (s?.params ?? []).map((p) => lc.input(p.id)), data: { signal: s?.name ?? '__missing' } }], next: 'then' };
  },
};

const connectSignal: NodeDefinition = {
  type: 'godot.connect_signal',
  title: 'Connect Signal',
  category: 'Godot/Signals',
  description: 'Call one of this script’s functions whenever a signal fires (e.g. a Timer’s "timeout").',
  keywords: ['signal', 'connect', 'listen', 'subscribe', 'handler'],
  flavor: 'exec',
  languages: L,
  requires: ['signals'],
  props: [
    { key: 'signal', label: 'Signal name', kind: 'string', default: 'timeout', description: 'Name of the signal on the source object (this script’s own signals or engine signals like "timeout", "body_entered").' },
    { key: 'method', label: 'Handler function', kind: 'function', default: '' },
  ],
  displayTitle: (n, ctx) => `Connect ${str(n.props.signal, '?')} → ${ctx.func(n.props.method)?.name ?? '?'}`,
  ports: () => [exec.in(), data.in('source', 'Source (self)', T.named('Object'), { connectionOnly: true, description: 'Unconnected = self' }), exec.out()],
  check: (n, ctx, report) => {
    const sig = str(n.props.signal);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sig)) report('E_INVALID_IDENTIFIER', 'Signal name must be a valid identifier.');
    const f = ctx.func(n.props.method);
    if (!f) report('E_UNDEFINED_FUNCTION', 'Choose the function to call when the signal fires.');
    const own = ctx.script.signals.find((s) => s.name === sig);
    if (own && f && own.params.length !== f.params.length) report('E_SIGNAL_ARITY', `Signal ${sig} passes ${own.params.length} argument(s) but ${f.name} takes ${f.params.length}.`);
  },
  lowerExec: (lc) => {
    const f = lc.ctx.func(lc.node.props.method);
    const args: IRExpr[] = lc.isConnected('source') ? [lc.input('source')] : [];
    return { stmts: [{ k: 'lang', lang: LANG, op: 'connect', args, data: { signal: str(lc.node.props.signal), method: f?.name ?? '__missing' } }], next: 'then' };
  },
};

const delay: NodeDefinition = {
  type: 'godot.delay',
  title: 'Delay',
  category: 'Godot/Time',
  description: 'Wait a number of seconds before continuing (await a SceneTree timer). Makes the function a coroutine.',
  keywords: ['wait', 'sleep', 'timer', 'await', 'seconds'],
  flavor: 'exec',
  languages: L,
  requires: ['coroutines'],
  props: [],
  ports: () => [exec.in(), data.in('seconds', 'Seconds', T.float, { default: 1 }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'lang', lang: LANG, op: 'await_timer', args: [lc.input('seconds')] }], next: 'then' }),
};

const awaitSignal: NodeDefinition = {
  type: 'godot.await_signal',
  title: 'Await Signal',
  category: 'Godot/Signals',
  description: 'Pause until an object emits a signal (e.g. AnimationPlayer "animation_finished").',
  keywords: ['await', 'wait', 'yield', 'signal'],
  flavor: 'exec',
  languages: L,
  requires: ['coroutines'],
  props: [{ key: 'signal', label: 'Signal name', kind: 'string', default: 'timeout' }],
  displayTitle: (n) => `Await ${str(n.props.signal, '?')}`,
  ports: () => [exec.in(), data.in('source', 'Source (self)', T.named('Object'), { connectionOnly: true, description: 'Unconnected = self' }), exec.out()],
  check: (n, _ctx, report) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(str(n.props.signal))) report('E_INVALID_IDENTIFIER', 'Signal name must be a valid identifier.');
  },
  lowerExec: (lc) => ({ stmts: [{ k: 'lang', lang: LANG, op: 'await_signal', args: lc.isConnected('source') ? [lc.input('source')] : [], data: { signal: str(lc.node.props.signal) } }], next: 'then' }),
};

const preload: NodeDefinition = {
  type: 'godot.preload',
  title: 'Preload',
  category: 'Godot/Resources',
  description: 'Load a resource when the script loads (res:// path known in advance).',
  keywords: ['load', 'scene', 'resource', 'packedscene', 'texture'],
  flavor: 'pure',
  languages: L,
  props: [
    { key: 'path', label: 'Resource path', kind: 'string', default: 'res://scene.tscn' },
    { key: 'type', label: 'Resource type', kind: 'type', default: 'PackedScene' },
  ],
  displayTitle: (n) => `Preload ${str(n.props.path).split('/').pop() ?? ''}`,
  ports: (n, ctx) => [data.out('resource', 'Resource', ctx.type(str(n.props.type, 'Resource') || 'Resource'))],
  check: (n, _ctx, report) => {
    if (!/^res:\/\/.+/.test(str(n.props.path))) report('E_INVALID_PATH', 'Preload needs a res:// path.');
  },
  lowerExpr: (_p, lc) => lang('preload', [], { path: str(lc.node.props.path), type: str(lc.node.props.type, 'Resource') || 'Resource' }),
};

const loadNode: NodeDefinition = {
  type: 'godot.load',
  title: 'Load Resource',
  category: 'Godot/Resources',
  description: 'Load a resource at run time from a path.',
  keywords: ['load', 'resource', 'scene'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'type', label: 'Resource type', kind: 'type', default: 'Resource' }],
  ports: (n, ctx) => [data.in('path', 'Path', T.string, { default: 'res://' }), data.out('resource', 'Resource', ctx.type(str(n.props.type, 'Resource') || 'Resource'))],
  lowerExpr: (_p, lc) => lang('load', [lc.input('path')], { type: str(lc.node.props.type, 'Resource') || 'Resource' }),
};

const instantiate: NodeDefinition = {
  type: 'godot.instantiate',
  title: 'Instantiate Scene',
  category: 'Godot/Scene',
  description: 'Create a node tree from a PackedScene. Add it to the tree with Add Child.',
  keywords: ['spawn', 'instance', 'create', 'packedscene'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'type', label: 'Root node class', kind: 'type', default: 'Node' }],
  ports: (n, ctx) => [exec.in(), data.in('scene', 'Scene', T.named('PackedScene'), { required: true, connectionOnly: true }), exec.out(), data.out('instance', 'Instance', ctx.type(str(n.props.type, 'Node') || 'Node'))],
  lowerExec: (lc) => {
    const ty = str(lc.node.props.type, 'Node') || 'Node';
    return { stmts: lc.bind('instance', lang('instantiate', [lc.input('scene')], { type: ty }), { type: T.named(ty), nameHint: 'instance', sideEffect: true }), next: 'then' };
  },
};

const changeScene: NodeDefinition = {
  type: 'godot.change_scene',
  title: 'Change Scene',
  category: 'Godot/Scene',
  description: 'Switch to another scene file.',
  keywords: ['level', 'load', 'scene', 'goto'],
  flavor: 'exec',
  languages: L,
  requires: ['classes'],
  props: [],
  ports: () => [exec.in(), data.in('path', 'Scene path', T.string, { default: 'res://main.tscn' }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'call', name: 'change_scene_to_file', target: { k: 'call', name: 'get_tree', args: [] }, args: [lc.input('path')] } }], next: 'then' }),
};

function makeVec(name: string, fields: string[], ft: TypeRef): NodeDefinition {
  return {
    type: `godot.make_${name.toLowerCase()}`,
    title: `Make ${name}`,
    category: 'Godot/Vectors',
    description: `Build a ${name} from its components.`,
    keywords: [name, 'vector', 'new', 'construct'],
    flavor: 'pure',
    languages: L,
    props: [],
    ports: () => [...fields.map((f) => data.in(f, f.toUpperCase(), ft, { default: name === 'Color' && f === 'a' ? 1 : 0 })), data.out('result', name, T.named(name))],
    lowerExpr: (_p, lc) => ({ k: 'new', type: T.named(name), args: fields.map((f) => lc.input(f)) }),
  };
}

function breakVec(name: string, fields: string[], ft: TypeRef): NodeDefinition {
  return {
    type: `godot.break_${name.toLowerCase()}`,
    title: `Break ${name}`,
    category: 'Godot/Vectors',
    description: `Split a ${name} into its components.`,
    keywords: [name, 'vector', 'split', 'components', ...fields],
    flavor: 'pure',
    languages: L,
    props: [],
    ports: () => [data.in('value', name, T.named(name), { required: true, connectionOnly: true }), ...fields.map((f) => data.out(f, f.toUpperCase(), ft))],
    lowerExpr: (port, lc) => ({ k: 'prop', target: lc.input('value'), name: port }),
  };
}

const CONSTANTS: { value: string; label: string; type: string }[] = [
  { value: 'Vector2.ZERO', label: 'Vector2.ZERO', type: 'Vector2' },
  { value: 'Vector2.UP', label: 'Vector2.UP', type: 'Vector2' },
  { value: 'Vector2.DOWN', label: 'Vector2.DOWN', type: 'Vector2' },
  { value: 'Vector2.LEFT', label: 'Vector2.LEFT', type: 'Vector2' },
  { value: 'Vector2.RIGHT', label: 'Vector2.RIGHT', type: 'Vector2' },
  { value: 'Vector3.ZERO', label: 'Vector3.ZERO', type: 'Vector3' },
  { value: 'Vector3.UP', label: 'Vector3.UP', type: 'Vector3' },
  { value: 'Vector3.FORWARD', label: 'Vector3.FORWARD', type: 'Vector3' },
  { value: 'PI', label: 'PI', type: 'float' },
  { value: 'TAU', label: 'TAU', type: 'float' },
  { value: 'INF', label: 'INF', type: 'float' },
  { value: 'MOUSE_BUTTON_LEFT', label: 'MOUSE_BUTTON_LEFT', type: 'int' },
  { value: 'MOUSE_BUTTON_RIGHT', label: 'MOUSE_BUTTON_RIGHT', type: 'int' },
  { value: 'KEY_ESCAPE', label: 'KEY_ESCAPE', type: 'int' },
  { value: 'KEY_SPACE', label: 'KEY_SPACE', type: 'int' },
  { value: 'KEY_E', label: 'KEY_E', type: 'int' },
];

const constant: NodeDefinition = {
  type: 'godot.constant',
  title: 'Godot Constant',
  category: 'Godot/Math',
  description: 'A built-in Godot constant (Vector2.UP, PI, MOUSE_BUTTON_LEFT…).',
  keywords: ['constant', 'pi', 'tau', 'zero', 'up', 'vector', 'mouse', 'key'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'constant', label: 'Constant', kind: 'select', default: 'Vector2.ZERO', options: CONSTANTS.map(({ value, label }) => ({ value, label })) }],
  displayTitle: (n) => str(n.props.constant, 'Constant'),
  ports: (n, ctx) => [data.out('value', 'Value', ctx.type(CONSTANTS.find((c) => c.value === n.props.constant)?.type ?? 'any'))],
  check: (n, _ctx, report) => {
    if (!CONSTANTS.some((c) => c.value === n.props.constant)) report('E_INVALID_PROPERTY', 'Unknown constant.');
  },
  lowerExpr: (_p, lc) => lang('constant', [], { name: str(lc.node.props.constant) }),
};

const MOUSE_MODES = ['MOUSE_MODE_VISIBLE', 'MOUSE_MODE_HIDDEN', 'MOUSE_MODE_CAPTURED', 'MOUSE_MODE_CONFINED'];
const setMouseMode: NodeDefinition = {
  type: 'godot.set_mouse_mode',
  title: 'Set Mouse Mode',
  category: 'Godot/Input',
  description: 'Show, hide, capture or confine the mouse cursor (capture for mouse-look cameras).',
  keywords: ['mouse', 'cursor', 'capture', 'lock'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'mode', label: 'Mode', kind: 'select', default: 'MOUSE_MODE_CAPTURED', options: MOUSE_MODES.map((m) => ({ value: m, label: m.replace('MOUSE_MODE_', '').toLowerCase() })) }],
  displayTitle: (n) => `Mouse Mode: ${str(n.props.mode).replace('MOUSE_MODE_', '').toLowerCase()}`,
  ports: () => [exec.in(), exec.out()],
  check: (n, _ctx, report) => {
    if (!MOUSE_MODES.includes(str(n.props.mode))) report('E_INVALID_PROPERTY', 'Unknown mouse mode.');
  },
  lowerExec: (lc) => ({ stmts: [{ k: 'assign', target: { k: 'prop', target: { k: 'ref', name: 'Input' }, name: 'mouse_mode' }, value: lang('constant', [], { name: `Input.${str(lc.node.props.mode)}` }) }], next: 'then' }),
};

export function godotNodes(): NodeDefinition[] {
  const vec2 = ['x', 'y'];
  const vec3 = ['x', 'y', 'z'];
  return [
    getNode,
    emitSignal,
    connectSignal,
    delay,
    awaitSignal,
    preload,
    loadNode,
    instantiate,
    changeScene,
    makeVec('Vector2', vec2, T.float),
    breakVec('Vector2', vec2, T.float),
    makeVec('Vector3', vec3, T.float),
    breakVec('Vector3', vec3, T.float),
    makeVec('Color', ['r', 'g', 'b', 'a'], T.float),
    constant,
    setMouseMode,
    ...GODOT_API.flatMap(apiNode),
  ];
}

export function isGodotNode(n: GraphNode): boolean {
  return n.type.startsWith('godot.');
}
