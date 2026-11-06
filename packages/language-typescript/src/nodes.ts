/**
 * TypeScript / JavaScript node pack: async/await, try/catch/throw, template strings, object
 * literals, optional chaining, callbacks, and calling functions from modules (npm packages,
 * other scripts of the project, or globals such as fetch / JSON / setTimeout).
 */
import { T, type TypeRef } from '@cs/type-system';
import type { GraphNode, JsonValue } from '@cs/graph-core';
import type { IRExpr } from '@cs/intermediate-representation';
import { data, exec, type NodeContext, type NodeDefinition, type PropSchema } from '@cs/node-registry';
import { IDENT } from './printer';

export const LANG = 'typescript';
const L = [LANG];

const str = (v: JsonValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);
const typeProp = (key: string, label: string, def: string, description?: string): PropSchema => ({ key, label, kind: 'type', default: def, ...(description ? { description } : {}) });
const tp = (n: GraphNode, ctx: NodeContext, key: string, def: string): TypeRef => ctx.type(str(n.props[key], def) || def);
const list = (v: JsonValue | undefined): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** Relative import specifier from one script path to another ("ui/hud" → "../lib/util" → "../lib/util"). */
export function relativeModule(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join('/');
  return up ? `${'../'.repeat(up)}${rest}` : `./${rest}`;
}

/** Placeholders in a template: "Hi {name}!" → ["name"]. */
const PLACEHOLDER = /\{\{|\}\}|\$?\{([A-Za-z_$][\w$]*)\}/g;
export function templateFields(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(PLACEHOLDER)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Split a template into text and placeholder names. {name} and ${name} are placeholders; {{ and }} are literal braces. */
export function templateParts(t: string): (string | { field: string })[] {
  const out: (string | { field: string })[] = [];
  let text = '';
  let last = 0;
  for (const m of t.matchAll(PLACEHOLDER)) {
    text += t.slice(last, m.index);
    last = m.index! + m[0].length;
    if (!m[1]) {
      text += m[0][0];
      continue;
    }
    if (text) out.push(text);
    text = '';
    out.push({ field: m[1] });
  }
  text += t.slice(last);
  if (text) out.push(text);
  return out;
}

const awaitNode: NodeDefinition = {
  type: 'ts.await',
  title: 'Await',
  category: 'Async',
  description: 'Wait for a Promise and use its value. Only inside async functions (tick "async" on the function).',
  keywords: ['await', 'async', 'promise', 'wait', 'then'],
  flavor: 'exec',
  languages: L,
  props: [typeProp('type', 'Value type', 'any', 'Type of the value the promise resolves to')],
  ports: (n, ctx) => {
    const t = tp(n, ctx, 'type', 'any');
    return [exec.in(), data.in('promise', 'Promise', T.named('Promise', [t]), { required: true, connectionOnly: true }), exec.out(), ...(t.kind === 'void' ? [] : [data.out('value', 'Value', t)])];
  },
  check: (_n, ctx, report) => {
    if (!ctx.fn.async) report('E_AWAIT_OUTSIDE_ASYNC', `Await can only be used in async functions, and ${ctx.fn.name} isn't async.`, { suggestion: `Tick "async" on ${ctx.fn.name} in the inspector.` });
  },
  lowerExec: (lc) => {
    const e: IRExpr = { k: 'await', expr: lc.input('promise') };
    const t = tp(lc.node, lc.ctx, 'type', 'any');
    if (t.kind === 'void' || !lc.isOutputUsed('value')) return { stmts: [{ k: 'expr', expr: e }], next: 'then' };
    return { stmts: lc.bind('value', e, { type: t, nameHint: 'value', sideEffect: true }), next: 'then' };
  },
};

const tryNode: NodeDefinition = {
  type: 'ts.try',
  title: 'Try / Catch',
  category: 'Errors',
  description: 'Run Try; if it throws, run Catch with the error. Finally always runs. Then continues afterwards.',
  keywords: ['try', 'catch', 'error', 'exception', 'finally'],
  flavor: 'exec',
  languages: L,
  props: [],
  ports: () => [exec.in(), exec.out('try', 'Try', 'body'), exec.out('catch', 'Catch', 'body'), data.out('error', 'Error', T.any, { description: 'What was thrown (usually an Error)' }), exec.out('finally', 'Finally', 'body'), exec.out('then', 'Then')],
  lowerExec: (lc) => {
    const catchVar = lc.uniqueName('error');
    const body = lc.body('try', { region: 'branch' });
    const handler = lc.body('catch', { region: 'branch', bindings: { error: { k: 'ref', name: catchVar } } });
    const fin = lc.body('finally', { region: 'branch' });
    return { stmts: [{ k: 'try', body, catchVar: lc.isOutputUsed('error') ? catchVar : undefined, handler, ...(fin.length ? { finally: fin } : {}) }], next: 'then' };
  },
};

const throwNode: NodeDefinition = {
  type: 'ts.throw',
  title: 'Throw Error',
  category: 'Errors',
  description: 'Stop with an error (new Error(message)). Catch it with Try / Catch.',
  keywords: ['throw', 'error', 'raise', 'fail'],
  flavor: 'exec',
  languages: L,
  props: [],
  ports: () => [exec.in(), data.in('message', 'Message', T.string, { default: 'Something went wrong' })],
  lowerExec: (lc) => ({ stmts: [{ k: 'throw', value: { k: 'new', type: T.named('Error'), args: [lc.input('message')] } }] }),
};

const template: NodeDefinition = {
  type: 'ts.template',
  title: 'Format Text',
  category: 'Strings',
  description: 'Text with values filled in: write {name} where a value goes ("Hello {name}, you have {count} messages"). Use {{ and }} for literal braces.',
  keywords: ['template', 'format', 'interpolate', 'string', '`'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'template', label: 'Template', kind: 'text', default: 'Hello {name}!' }],
  ports: (n) => [...templateFields(str(n.props.template)).map((f) => data.in(f, f, T.any, { default: '' })), data.out('text', 'Text', T.string)],
  lowerExpr: (_p, lc) => {
    const parts = templateParts(str(lc.node.props.template)).map((p) => (typeof p === 'string' ? p : lc.input(p.field)));
    return { k: 'template', parts };
  },
};

const makeObject: NodeDefinition = {
  type: 'ts.object',
  allocates: true,
  title: 'Make Object',
  category: 'Objects',
  description: 'Build an object literal { key: value, … } from its fields.',
  keywords: ['object', 'literal', 'record', 'json', '{}'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'keys', label: 'Fields', kind: 'string_list', default: ['name', 'value'] }, typeProp('type', 'Object type', 'any', 'Optional: the type this object satisfies')],
  ports: (n, ctx) => [...list(n.props.keys).map((k) => data.in(k, k, T.any, { required: true })), data.out('object', 'Object', tp(n, ctx, 'type', 'any'))],
  check: (n, _ctx, report) => {
    const keys = list(n.props.keys);
    if (new Set(keys).size !== keys.length) report('E_DUPLICATE_KEY', 'Each field name can only appear once.');
    if (keys.some((k) => !k.trim())) report('E_INVALID', 'Field names cannot be empty.');
  },
  lowerExpr: (_p, lc) => ({ k: 'object', entries: list(lc.node.props.keys).map((key) => ({ key, value: lc.input(key) })) }),
};

const getField: NodeDefinition = {
  type: 'ts.get_field',
  title: 'Get Field',
  category: 'Objects',
  description: 'Read a field of an object (obj.name). "Optional" reads obj?.name: no error when obj is null or undefined.',
  keywords: ['property', 'field', 'member', 'dot', 'optional chaining', '?.'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'name', label: 'Field', kind: 'string', default: 'name' }, { key: 'optional', label: 'Optional (?.)', kind: 'boolean', default: false }, typeProp('type', 'Field type', 'any')],
  displayTitle: (n) => `Get ${n.props.optional === true ? '?.' : '.'}${str(n.props.name, 'field')}`,
  ports: (n, ctx) => [data.in('object', 'Object', T.any, { required: true, connectionOnly: true }), data.out('value', 'Value', tp(n, ctx, 'type', 'any'))],
  check: (n, _ctx, report) => {
    if (!IDENT.test(str(n.props.name))) report('E_INVALID_IDENTIFIER', 'Field name must be an identifier.');
  },
  lowerExpr: (_p, lc) => (lc.node.props.optional === true ? { k: 'optional_prop', target: lc.input('object'), name: str(lc.node.props.name) } : { k: 'prop', target: lc.input('object'), name: str(lc.node.props.name) }),
};

const setField: NodeDefinition = {
  type: 'ts.set_field',
  title: 'Set Field',
  category: 'Objects',
  description: 'Assign a field of an object (obj.name = value).',
  keywords: ['property', 'field', 'assign', 'set'],
  flavor: 'exec',
  languages: L,
  props: [{ key: 'name', label: 'Field', kind: 'string', default: 'name' }],
  displayTitle: (n) => `Set .${str(n.props.name, 'field')}`,
  ports: () => [exec.in(), data.in('object', 'Object', T.any, { required: true, connectionOnly: true }), data.in('value', 'Value', T.any, { required: true }), exec.out()],
  check: (n, _ctx, report) => {
    if (!IDENT.test(str(n.props.name))) report('E_INVALID_IDENTIFIER', 'Field name must be an identifier.');
  },
  lowerExec: (lc) => ({ stmts: [{ k: 'assign', target: { k: 'prop', target: lc.input('object'), name: str(lc.node.props.name) }, value: lc.input('value') }], next: 'then' }),
};

const funcRef: NodeDefinition = {
  type: 'ts.function_ref',
  title: 'Function as Value',
  category: 'Functions',
  description: 'Use one of this script\'s functions as a value: an event handler, a callback for setTimeout or array methods, …',
  keywords: ['callback', 'handler', 'reference', 'lambda', 'arrow'],
  flavor: 'pure',
  languages: L,
  props: [{ key: 'function', label: 'Function', kind: 'function', default: '' }],
  displayTitle: (n, ctx) => `${ctx.func(n.props.function)?.name ?? '(function)'} as value`,
  ports: (n, ctx) => {
    const f = ctx.func(n.props.function);
    const t: TypeRef = f ? { kind: 'function', params: f.params.map((p) => ctx.type(p.type)), returns: ctx.type(f.returnType) } : T.any;
    return [data.out('fn', 'Function', t)];
  },
  check: (n, ctx, report) => {
    if (!ctx.func(n.props.function)) report('E_UNDEFINED_FUNCTION', 'Pick a function in the inspector.');
  },
  lowerExpr: (_p, lc) => ({ k: 'func_ref', name: lc.ctx.func(lc.node.props.function)?.name ?? 'undefined' }),
};

const callFn: NodeDefinition = {
  type: 'ts.call',
  title: 'Call',
  category: 'Functions',
  description: 'Call a function from an npm package ("Module" = package name), from another script of this project, or a global such as fetch or JSON.parse (Module empty). Types of the arguments and result are set on the node.',
  keywords: ['call', 'import', 'module', 'package', 'library', 'npm', 'function', 'global'],
  flavor: 'exec',
  languages: L,
  props: [
    { key: 'module', label: 'Module', kind: 'string', default: '', description: 'Package or path ("date-fns", "./utils"). Empty = a global (fetch, JSON.parse, Math.max…).' },
    { key: 'scriptPath', label: 'Project script', kind: 'string', default: '', description: 'Set instead of Module to call a function exported by another script of this project.' },
    { key: 'name', label: 'Function', kind: 'string', default: 'fn', description: 'Name, or a dotted path (Math.max, axios.get)' },
    { key: 'importKind', label: 'Import', kind: 'select', default: 'named', options: [{ value: 'named', label: 'import { name }' }, { value: 'default', label: 'import name (default)' }, { value: 'namespace', label: 'import * as name' }] },
    { key: 'argNames', label: 'Argument names', kind: 'string_list', default: [] },
    { key: 'argTypes', label: 'Argument types', kind: 'string_list', default: [] },
    typeProp('returnType', 'Returns', 'void'),
    { key: 'await', label: 'Await the result', kind: 'boolean', default: false, description: 'For functions that return a Promise (the function must be async).' },
  ],
  displayTitle: (n) => {
    const name = str(n.props.name, 'fn');
    const where = str(n.props.scriptPath) || str(n.props.module);
    return `${n.props.await === true ? 'await ' : ''}${name}()${where ? ` · ${where.split('/').pop()}` : ''}`;
  },
  ports: (n, ctx) => {
    const types = list(n.props.argTypes);
    const names = list(n.props.argNames);
    const rt = tp(n, ctx, 'returnType', 'void');
    return [exec.in(), ...types.map((t, i) => data.in(`arg_${i}`, names[i] || `arg ${i}`, ctx.type(t), { required: true })), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
  },
  check: (n, ctx, report) => {
    const name = str(n.props.name);
    if (!name.split('.').every((p) => IDENT.test(p))) report('E_INVALID_IDENTIFIER', `"${name}" is not a valid function name or dotted path.`);
    if (n.props.await === true && !ctx.fn.async) report('E_AWAIT_OUTSIDE_ASYNC', `Awaiting needs an async function, and ${ctx.fn.name} isn't async.`, { suggestion: `Tick "async" on ${ctx.fn.name}, or untick "Await the result".` });
    if (str(n.props.scriptPath) === ctx.script.path) report('E_SELF_IMPORT', 'This is the current script: use Call Function instead.');
  },
  lowerExec: (lc) => {
    const n = lc.node;
    const parts = str(n.props.name, 'fn').split('.');
    const module = str(n.props.scriptPath) ? relativeModule(lc.ctx.script.path, str(n.props.scriptPath)) : str(n.props.module);
    const kind = str(n.props.importKind, 'named') as 'named' | 'default' | 'namespace';
    let callee: IRExpr = module ? { k: 'import', module, name: parts[0], kind } : { k: 'ref', name: parts[0] };
    for (const p of parts.slice(1)) callee = { k: 'prop', target: callee, name: p };
    let call: IRExpr = { k: 'invoke', callee, args: list(n.props.argTypes).map((_, i) => lc.input(`arg_${i}`)) };
    if (n.props.await === true) call = { k: 'await', expr: call };
    const rt = tp(n, lc.ctx, 'returnType', 'void');
    if (rt.kind === 'void' || !lc.isOutputUsed('result')) return { stmts: [{ k: 'expr', expr: call }], next: 'then' };
    return { stmts: lc.bind('result', call, { type: rt, nameHint: `${parts[parts.length - 1]}_result`, sideEffect: true }), next: 'then' };
  },
  presets: [
    { title: 'fetch (HTTP request)', category: 'Web', keywords: ['http', 'request', 'api', 'get'], props: { module: '', name: 'fetch', argNames: ['url'], argTypes: ['string'], returnType: 'Response', await: true } },
    { title: 'JSON.parse', category: 'Web', keywords: ['json', 'parse', 'decode'], props: { module: '', name: 'JSON.parse', argNames: ['text'], argTypes: ['string'], returnType: 'any' } },
    { title: 'JSON.stringify', category: 'Web', keywords: ['json', 'stringify', 'encode', 'serialize'], props: { module: '', name: 'JSON.stringify', argNames: ['value'], argTypes: ['any'], returnType: 'string' } },
    { title: 'setTimeout', category: 'Async', keywords: ['delay', 'timer', 'later'], props: { module: '', name: 'setTimeout', argNames: ['callback', 'ms'], argTypes: ['fn() -> void', 'int'], returnType: 'any' } },
    { title: 'Date.now', category: 'Time', keywords: ['time', 'timestamp', 'now', 'clock'], props: { module: '', name: 'Date.now', argNames: [], argTypes: [], returnType: 'int' } },
    { title: 'document.querySelector', category: 'Web', keywords: ['dom', 'element', 'find', 'selector'], props: { module: '', name: 'document.querySelector', argNames: ['selector'], argTypes: ['string'], returnType: 'HTMLElement?' } },
    { title: 'localStorage.getItem', category: 'Web', keywords: ['storage', 'save', 'load'], props: { module: '', name: 'localStorage.getItem', argNames: ['key'], argTypes: ['string'], returnType: 'string?' } },
    { title: 'localStorage.setItem', category: 'Web', keywords: ['storage', 'save'], props: { module: '', name: 'localStorage.setItem', argNames: ['key', 'value'], argTypes: ['string', 'string'], returnType: 'void' } },
  ],
};

const callMethod: NodeDefinition = {
  type: 'ts.call_method',
  title: 'Call Method',
  category: 'Objects',
  description: 'Call a method on an object: object.name(args). "Optional" calls object?.name(…) (skipped when the object is null).',
  keywords: ['method', 'call', 'invoke', 'object'],
  flavor: 'exec',
  languages: L,
  props: [
    { key: 'name', label: 'Method', kind: 'string', default: 'method' },
    { key: 'argNames', label: 'Argument names', kind: 'string_list', default: [] },
    { key: 'argTypes', label: 'Argument types', kind: 'string_list', default: [] },
    typeProp('returnType', 'Returns', 'void'),
    { key: 'await', label: 'Await the result', kind: 'boolean', default: false },
    { key: 'optional', label: 'Optional (?.)', kind: 'boolean', default: false },
  ],
  displayTitle: (n) => `${n.props.await === true ? 'await ' : ''}${n.props.optional === true ? '?.' : '.'}${str(n.props.name, 'method')}()`,
  ports: (n, ctx) => {
    const names = list(n.props.argNames);
    const rt = tp(n, ctx, 'returnType', 'void');
    return [exec.in(), data.in('object', 'Object', T.any, { required: true, connectionOnly: true }), ...list(n.props.argTypes).map((t, i) => data.in(`arg_${i}`, names[i] || `arg ${i}`, ctx.type(t), { required: true })), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
  },
  check: (n, ctx, report) => {
    if (!IDENT.test(str(n.props.name))) report('E_INVALID_IDENTIFIER', 'Method name must be an identifier.');
    if (n.props.await === true && !ctx.fn.async) report('E_AWAIT_OUTSIDE_ASYNC', `Awaiting needs an async function, and ${ctx.fn.name} isn't async.`, { suggestion: `Tick "async" on ${ctx.fn.name}.` });
  },
  presets: [
    { title: 'Response → JSON', category: 'Web', keywords: ['json', 'response', 'body', 'fetch'], props: { name: 'json', argNames: [], argTypes: [], returnType: 'any', await: true } },
    { title: 'Response → text', category: 'Web', keywords: ['text', 'response', 'body', 'fetch'], props: { name: 'text', argNames: [], argTypes: [], returnType: 'string', await: true } },
    { title: 'Element: add event listener', category: 'Web', keywords: ['click', 'event', 'listener', 'dom'], props: { name: 'addEventListener', argNames: ['event', 'handler'], argTypes: ['string', 'fn(Event) -> void'], returnType: 'void', optional: true } },
  ],
  lowerExec: (lc) => {
    const n = lc.node;
    const target = lc.input('object');
    const fnExpr: IRExpr = n.props.optional === true ? { k: 'optional_prop', target, name: str(n.props.name) } : { k: 'prop', target, name: str(n.props.name) };
    let call: IRExpr = { k: 'invoke', callee: fnExpr, args: list(n.props.argTypes).map((_, i) => lc.input(`arg_${i}`)) };
    if (n.props.await === true) call = { k: 'await', expr: call };
    const rt = tp(n, lc.ctx, 'returnType', 'void');
    if (rt.kind === 'void' || !lc.isOutputUsed('result')) return { stmts: [{ k: 'expr', expr: call }], next: 'then' };
    return { stmts: lc.bind('result', call, { type: rt, nameHint: `${str(n.props.name)}_result`, sideEffect: true }), next: 'then' };
  },
};

const nullish: NodeDefinition = {
  type: 'ts.default_value',
  title: 'Value or Default (??)',
  category: 'Logic',
  description: 'The value, or Default when the value is null or undefined.',
  keywords: ['??', 'nullish', 'coalesce', 'default', 'fallback'],
  flavor: 'pure',
  languages: L,
  props: [typeProp('type', 'Type', 'any')],
  ports: (n, ctx) => {
    const t = tp(n, ctx, 'type', 'any');
    return [data.in('value', 'Value', { ...t, nullable: true } as TypeRef, { required: true, connectionOnly: true }), data.in('default', 'Default', t, { required: true }), data.out('result', 'Result', t)];
  },
  lowerExpr: (_p, lc) => ({ k: 'lang', lang: LANG, op: 'nullish', args: [lc.input('value'), lc.input('default')] }),
};

export function typescriptNodes(): NodeDefinition[] {
  return [awaitNode, tryNode, throwNode, template, makeObject, getField, setField, funcRef, callFn, callMethod, nullish];
}
