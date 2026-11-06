/**
 * Language-neutral node pack: flow control, variables, literals, maths, logic, strings,
 * collections, conversions, functions, objects and debugging. Everything lowers to neutral IR;
 * backends decide the spelling.
 */
import { T, type TypeRef } from '@cs/type-system';
import type { GraphNode, JsonValue } from '@cs/graph-core';
import type { BinaryOp, BuiltinOp, IRExpr } from '@cs/intermediate-representation';
import { data, exec, type NodeContext, type NodeDefinition, type PortSpec, type PropSchema } from './index';

const str = (v: JsonValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);
const int = (v: JsonValue | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d);

const typeProp = (key: string, label: string, def: string, typeOptions?: string[], description?: string): PropSchema => ({ key, label, kind: 'type', default: def, typeOptions, description });
const countProp = (def: number, min: number, max: number, label = 'Inputs'): PropSchema => ({ key: 'count', label, kind: 'int', default: def, min, max });
const NUMERIC = ['int', 'float'];

const tp = (node: GraphNode, ctx: NodeContext, key = 'type', def = 'float'): TypeRef => ctx.type(str(node.props[key], def) || def);

// ---------------------------------------------------------------------------
// Flow control
// ---------------------------------------------------------------------------

const entry: NodeDefinition = {
  type: 'core.entry',
  title: 'Entry',
  category: 'Flow',
  description: 'Where the function starts. Outputs the function parameters.',
  flavor: 'entry',
  internal: true,
  props: [],
  displayTitle: (_n, ctx) => (ctx.fn.kind === 'event' ? `Event ${ctx.fn.name}` : ctx.fn.name),
  ports: (_n, ctx) => [exec.out('then'), ...ctx.fn.params.map((p) => data.out(p.id, p.name, ctx.type(p.type)))],
};

const returnNode: NodeDefinition = {
  type: 'core.return',
  title: 'Return',
  category: 'Flow',
  description: 'Leave the function, optionally returning a value.',
  keywords: ['exit', 'result'],
  flavor: 'exec',
  props: [],
  ports: (_n, ctx) => {
    const rt = ctx.type(ctx.fn.returnType);
    return [exec.in(), ...(rt.kind === 'void' ? [] : [data.in('value', 'Value', rt, { required: true })])];
  },
  lowerExec: (lc) => {
    const rt = lc.ctx.type(lc.ctx.fn.returnType);
    return { stmts: [rt.kind === 'void' ? { k: 'return' } : { k: 'return', value: lc.input('value') }] };
  },
};

const branch: NodeDefinition = {
  type: 'core.branch',
  title: 'Branch',
  category: 'Flow',
  description: 'If the condition is true run the True chain, otherwise the False chain. Both continue where the chains meet again.',
  keywords: ['if', 'else', 'condition'],
  flavor: 'exec',
  props: [],
  ports: () => [exec.in(), data.in('condition', 'Condition', T.bool, { default: false }), exec.out('true', 'True'), exec.out('false', 'False')],
  lowerExec: (lc) => {
    const thenBody = lc.body('true');
    const elseBody = lc.body('false');
    return { stmts: [{ k: 'if', cond: lc.input('condition'), then: thenBody, ...(elseBody.length ? { else: elseBody } : {}) }], next: 'join' };
  },
};

const sequence: NodeDefinition = {
  type: 'core.sequence',
  title: 'Sequence',
  category: 'Flow',
  description: 'Run several chains one after another.',
  keywords: ['then', 'order'],
  flavor: 'exec',
  props: [countProp(2, 2, 16, 'Outputs')],
  ports: (n) => [exec.in(), ...Array.from({ length: int(n.props.count, 2) }, (_, i) => exec.out(`then_${i}`, `Then ${i}`))],
  lowerExec: (lc) => ({ stmts: Array.from({ length: int(lc.node.props.count, 2) }, (_, i) => lc.body(`then_${i}`)).flat(), next: 'join' }),
};

const forRange: NodeDefinition = {
  type: 'core.for_range',
  title: 'For Loop',
  category: 'Flow',
  description: 'Run the Body for each index from First up to (but not including) Last.',
  keywords: ['loop', 'repeat', 'range', 'for'],
  flavor: 'exec',
  props: [{ key: 'indexName', label: 'Index name', kind: 'string', default: 'i' }],
  ports: () => [
    exec.in(),
    data.in('from', 'First', T.int, { default: 0 }),
    data.in('to', 'Last (exclusive)', T.int, { default: 10 }),
    data.in('step', 'Step', T.int, { default: 1 }),
    exec.out('body', 'Body', 'body'),
    data.out('index', 'Index', T.int),
    exec.out('completed', 'Completed'),
  ],
  check: (n, _ctx, report) => {
    if (typeof n.inputs.step === 'number' && n.inputs.step === 0) report('E_ZERO_STEP', 'A loop step of 0 never ends.', { port: 'step' });
  },
  lowerExec: (lc) => {
    const v = lc.uniqueName(str(lc.node.props.indexName, 'i') || 'i');
    const step = lc.isConnected('step') || (lc.node.inputs.step !== undefined && lc.node.inputs.step !== 1) ? lc.input('step') : undefined;
    const body = lc.body('body', { bindings: { index: { k: 'ref', name: v } }, region: 'loop' });
    return { stmts: [{ k: 'for_range', var: v, from: lc.input('from'), to: lc.input('to'), ...(step ? { step } : {}), body }], next: 'completed' };
  },
};

const forEach: NodeDefinition = {
  type: 'core.for_each',
  title: 'For Each',
  category: 'Flow',
  description: 'Run the Body once for every element of an array.',
  keywords: ['loop', 'iterate', 'foreach', 'array'],
  flavor: 'exec',
  props: [typeProp('elementType', 'Element type', 'any'), { key: 'elementName', label: 'Element name', kind: 'string', default: 'item' }],
  ports: (n, ctx) => {
    const el = tp(n, ctx, 'elementType', 'any');
    return [exec.in(), data.in('array', 'Array', T.array(el), { required: true, connectionOnly: true }), exec.out('body', 'Body', 'body'), data.out('element', 'Element', el), exec.out('completed', 'Completed')];
  },
  lowerExec: (lc) => {
    const v = lc.uniqueName(str(lc.node.props.elementName, 'item') || 'item');
    const el = tp(lc.node, lc.ctx, 'elementType', 'any');
    const iterable = lc.input('array');
    const body = lc.body('body', { bindings: { element: { k: 'ref', name: v } }, region: 'loop' });
    return { stmts: [{ k: 'for_each', var: v, iterable, body, ...(el.kind === 'any' ? {} : { elementType: el }) }], next: 'completed' };
  },
};

const whileLoop: NodeDefinition = {
  type: 'core.while',
  title: 'While Loop',
  category: 'Flow',
  description: 'Run the Body while the condition is true. The condition is re-evaluated before every iteration.',
  keywords: ['loop', 'repeat'],
  flavor: 'exec',
  props: [],
  ports: () => [exec.in(), data.in('condition', 'Condition', T.bool, { required: true }), exec.out('body', 'Body', 'body'), exec.out('completed', 'Completed')],
  lowerExec: (lc) => {
    const cond = lc.input('condition');
    return { stmts: [{ k: 'while', cond, body: lc.body('body', { region: 'loop' }) }], next: 'completed' };
  },
};

const breakNode: NodeDefinition = {
  type: 'core.break',
  title: 'Break',
  category: 'Flow',
  description: 'Leave the innermost loop.',
  flavor: 'exec',
  props: [],
  ports: () => [exec.in()],
  lowerExec: (lc) => {
    if (lc.loopDepth === 0) lc.error('E_BREAK_OUTSIDE_LOOP', 'Break can only be used inside a loop body.');
    return { stmts: [{ k: 'break' }] };
  },
};

const continueNode: NodeDefinition = {
  type: 'core.continue',
  title: 'Continue',
  category: 'Flow',
  description: 'Skip to the next iteration of the innermost loop.',
  flavor: 'exec',
  props: [],
  ports: () => [exec.in()],
  lowerExec: (lc) => {
    if (lc.loopDepth === 0) lc.error('E_CONTINUE_OUTSIDE_LOOP', 'Continue can only be used inside a loop body.');
    return { stmts: [{ k: 'continue' }] };
  },
};

const switchNode: NodeDefinition = {
  type: 'core.switch',
  title: 'Switch',
  category: 'Flow',
  description: 'Run the chain whose case equals the value, or Default.',
  keywords: ['match', 'case', 'select'],
  flavor: 'exec',
  props: [typeProp('type', 'Value type', 'int', ['int', 'string']), { key: 'cases', label: 'Cases', kind: 'string_list', default: ['0', '1'] }],
  ports: (n, ctx) => {
    const cases = Array.isArray(n.props.cases) ? n.props.cases.map(String) : [];
    return [exec.in(), data.in('value', 'Value', tp(n, ctx, 'type', 'int'), { required: true }), ...cases.map((c, i) => exec.out(`case_${i}`, c)), exec.out('default', 'Default')];
  },
  check: (n, ctx, report) => {
    const t = tp(n, ctx, 'type', 'int');
    const cases = Array.isArray(n.props.cases) ? n.props.cases.map(String) : [];
    if (t.kind === 'int') cases.forEach((c) => !/^-?\d+$/.test(c.trim()) && report('E_INVALID_CASE', `Case "${c}" is not an integer.`));
    if (new Set(cases).size !== cases.length) report('E_DUPLICATE_CASE', 'Switch cases must be unique.');
  },
  lowerExec: (lc) => {
    const t = tp(lc.node, lc.ctx, 'type', 'int');
    const cases = Array.isArray(lc.node.props.cases) ? lc.node.props.cases.map(String) : [];
    const arms = cases.map((c, i) => ({ values: [t.kind === 'int' ? ({ k: 'lit', value: Number.parseInt(c, 10), type: T.int } as IRExpr) : ({ k: 'lit', value: c, type: T.string } as IRExpr)], body: lc.body(`case_${i}`) }));
    const def = lc.body('default');
    return { stmts: [{ k: 'match', subject: lc.input('value'), arms, ...(def.length ? { default: def } : {}) }], next: 'join' };
  },
};

const rerouteExec: NodeDefinition = {
  type: 'core.reroute_exec',
  title: 'Reroute (Exec)',
  category: 'Utility',
  description: 'A bend point for execution wires.',
  flavor: 'exec',
  props: [],
  ports: () => [exec.in(), exec.out('then')],
  lowerExec: () => ({ stmts: [], next: 'then' }),
};

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const varProp: PropSchema = { key: 'variable', label: 'Variable', kind: 'variable', default: '', variableScopes: ['member', 'local', 'param'] };

const getVar: NodeDefinition = {
  type: 'core.get_var',
  title: 'Get Variable',
  category: 'Variables',
  description: 'Read a variable, constant or parameter.',
  keywords: ['get', 'read', 'variable'],
  flavor: 'pure',
  props: [varProp],
  displayTitle: (n, ctx) => ctx.variable(n.props.variable)?.name ?? 'Get (missing variable)',
  ports: (n, ctx) => [data.out('value', 'Value', ctx.variable(n.props.variable)?.type ?? T.any)],
  check: (n, ctx, report) => {
    if (!ctx.variable(n.props.variable)) report('E_UNDEFINED_VARIABLE', 'This node refers to a variable that does not exist.', { suggestion: 'Pick a variable in the inspector or delete the node.' });
  },
  lowerExpr: (_p, lc) => ({ k: 'ref', name: lc.ctx.variable(lc.node.props.variable)?.name ?? '__missing' }),
};

const setVar: NodeDefinition = {
  type: 'core.set_var',
  title: 'Set Variable',
  category: 'Variables',
  description: 'Assign a value to a variable (or add/subtract/multiply/divide it).',
  keywords: ['set', 'assign', 'write', 'increment', '+=', 'variable'],
  flavor: 'exec',
  props: [
    varProp,
    {
      key: 'operation',
      label: 'Operation',
      kind: 'select',
      default: '=',
      options: [
        { value: '=', label: '= (assign)' },
        { value: '+', label: '+= (add)' },
        { value: '-', label: '-= (subtract)' },
        { value: '*', label: '*= (multiply)' },
        { value: '/', label: '/= (divide)' },
      ],
    },
  ],
  displayTitle: (n, ctx) => {
    const v = ctx.variable(n.props.variable);
    const op = str(n.props.operation, '=');
    return v ? `${op === '=' ? 'Set' : `${op}=`} ${v.name}` : 'Set (missing variable)';
  },
  ports: (n, ctx) => {
    const v = ctx.variable(n.props.variable);
    return [exec.in(), data.in('value', 'Value', v?.type ?? T.any, { required: true }), exec.out('then'), data.out('result', 'Result', v?.type ?? T.any)];
  },
  check: (n, ctx, report) => {
    const v = ctx.variable(n.props.variable);
    if (!v) report('E_UNDEFINED_VARIABLE', 'This node refers to a variable that does not exist.', { suggestion: 'Pick a variable in the inspector or delete the node.' });
    else if (v.constant) report('E_ASSIGN_CONSTANT', `"${v.name}" is a constant and cannot be assigned.`);
    const op = str(n.props.operation, '=');
    if (v && op !== '=' && !ctx.operatorResult(op as BinaryOp, v.type, v.type)) report('E_UNSUPPORTED_OPERATOR', `${op}= is not supported for ${ctx.formatType(v.type)}.`);
  },
  lowerExec: (lc) => {
    const v = lc.ctx.variable(lc.node.props.variable);
    const name = v?.name ?? '__missing';
    const op = str(lc.node.props.operation, '=');
    const stmts = [{ k: 'assign' as const, target: { k: 'ref' as const, name }, value: lc.input('value'), ...(op !== '=' ? { op: op as '+' | '-' | '*' | '/' } : {}) }];
    // Result output reads the variable after assignment.
    return { stmts: [...stmts, ...lc.bind('result', { k: 'ref', name }, { sideEffect: false })], next: 'then' };
  },
};

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

function literalNode(type: 'bool' | 'int' | 'float' | 'string', title: string, def: JsonValue): NodeDefinition {
  const t: TypeRef = { kind: type };
  return {
    type: `core.literal_${type}`,
    title,
    category: 'Literals',
    description: `A constant ${type} value.`,
    keywords: ['literal', 'constant', 'value', type],
    flavor: 'pure',
    props: [{ key: 'value', label: 'Value', kind: type === 'bool' ? 'boolean' : type === 'string' ? 'text' : type === 'int' ? 'int' : 'number', default: def }],
    ports: () => [data.out('value', 'Value', t)],
    check: (n, _ctx, report) => {
      const v = n.props.value;
      const ok = type === 'bool' ? typeof v === 'boolean' : type === 'string' ? typeof v === 'string' : typeof v === 'number' && Number.isFinite(v) && (type === 'float' || Number.isInteger(v));
      if (!ok) report('E_INVALID_LITERAL', `Value must be a valid ${type}.`);
    },
    lowerExpr: (_p, lc) => ({ k: 'lit', value: lc.node.props.value ?? def, type: t }),
  };
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

function binaryNode(op: BinaryOp, id: string, title: string, category: string, keywords: string[], defType: string, opts: { result?: TypeRef; typeOptions?: string[]; rhs?: boolean } = {}): NodeDefinition {
  const props: PropSchema[] = [typeProp('type', 'Type', defType, opts.typeOptions)];
  if (opts.rhs) props.push(typeProp('rhsType', 'Right type', '', opts.typeOptions, 'Leave empty to use the same type as the left operand (e.g. Vector2 × float).'));
  const types = (n: GraphNode, ctx: NodeContext) => {
    const l = tp(n, ctx, 'type', defType);
    const r = opts.rhs && str(n.props.rhsType) ? tp(n, ctx, 'rhsType', defType) : l;
    return { l, r, res: opts.result ?? ctx.operatorResult(op, l, r) };
  };
  return {
    type: `core.${id}`,
    title,
    category,
    description: `${title}: A ${op} B.`,
    keywords,
    flavor: 'pure',
    props,
    ports: (n, ctx) => {
      const { l, r, res } = types(n, ctx);
      return [data.in('a', 'A', l, { default: zeroOf(l) }), data.in('b', 'B', r, { default: op === '/' || op === '*' ? oneOf(r) : zeroOf(r) }), data.out('result', 'Result', res ?? T.any)];
    },
    check: (n, ctx, report) => {
      const { l, r } = types(n, ctx);
      if (!ctx.operatorResult(op, l, r)) report('E_UNSUPPORTED_OPERATOR', `${title} (${op}) is not supported for ${ctx.formatType(l)} and ${ctx.formatType(r)} in this language.`);
    },
    lowerExpr: (_p, lc) => ({ k: 'bin', op, left: lc.input('a'), right: lc.input('b') }),
  };
}

function zeroOf(t: TypeRef): JsonValue {
  switch (t.kind) {
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    default:
      return null;
  }
}
function oneOf(t: TypeRef): JsonValue {
  return t.kind === 'int' || t.kind === 'float' ? 1 : zeroOf(t);
}

const ARITH_TYPES = undefined; // any type the language accepts for the operator

const notNode: NodeDefinition = {
  type: 'core.not',
  title: 'NOT',
  category: 'Logic',
  description: 'True when the input is false.',
  keywords: ['not', 'invert', '!'],
  flavor: 'pure',
  props: [],
  ports: () => [data.in('a', 'A', T.bool, { default: false }), data.out('result', 'Result', T.bool)],
  lowerExpr: (_p, lc) => ({ k: 'un', op: 'not', operand: lc.input('a') }),
};

const negate: NodeDefinition = {
  type: 'core.negate',
  title: 'Negate',
  category: 'Math',
  description: 'Flip the sign: -A.',
  keywords: ['minus', 'negative'],
  flavor: 'pure',
  props: [typeProp('type', 'Type', 'float')],
  ports: (n, ctx) => {
    const t = tp(n, ctx);
    return [data.in('a', 'A', t, { default: zeroOf(t) }), data.out('result', 'Result', t)];
  },
  lowerExpr: (_p, lc) => ({ k: 'un', op: 'neg', operand: lc.input('a') }),
};

const select: NodeDefinition = {
  type: 'core.select',
  title: 'Select',
  category: 'Logic',
  description: 'Pick A when the condition is true, otherwise B (ternary).',
  keywords: ['ternary', 'if', 'choose', '?:'],
  flavor: 'pure',
  props: [typeProp('type', 'Type', 'float')],
  ports: (n, ctx) => {
    const t = tp(n, ctx);
    return [data.in('condition', 'Condition', T.bool, { default: false }), data.in('a', 'If true', t, { default: zeroOf(t) }), data.in('b', 'If false', t, { default: zeroOf(t) }), data.out('result', 'Result', t)];
  },
  lowerExpr: (_p, lc) => ({ k: 'ternary', cond: lc.input('condition'), then: lc.input('a'), else: lc.input('b') }),
};

// ---------------------------------------------------------------------------
// Built-in functions (pure)
// ---------------------------------------------------------------------------

interface BuiltinSpec {
  id: string;
  op: BuiltinOp;
  title: string;
  category: string;
  description: string;
  keywords?: string[];
  /** Inputs: [id, name, type or 'T', default] */
  inputs: [string, string, TypeRef | 'T', JsonValue?][];
  output: TypeRef | 'T';
  generic?: { def: string; options?: string[] };
  connectionOnly?: string[];
}

function builtinNode(s: BuiltinSpec): NodeDefinition {
  const resolve = (t: TypeRef | 'T', n: GraphNode, ctx: NodeContext) => (t === 'T' ? tp(n, ctx, 'type', s.generic?.def ?? 'float') : t);
  return {
    type: `core.${s.id}`,
    title: s.title,
    category: s.category,
    description: s.description,
    keywords: s.keywords,
    flavor: 'pure',
    props: s.generic ? [typeProp('type', 'Type', s.generic.def, s.generic.options)] : [],
    ports: (n, ctx) => [
      ...s.inputs.map(([id, name, t, d]) => {
        const rt = resolve(t, n, ctx);
        return data.in(id, name, rt, { default: d ?? zeroOf(rt), ...(s.connectionOnly?.includes(id) ? { required: true, connectionOnly: true } : {}) });
      }),
      data.out('result', 'Result', resolve(s.output, n, ctx)),
    ],
    lowerExpr: (_p, lc) => ({ k: 'builtin', op: s.op, args: s.inputs.map(([id]) => lc.input(id)), ...(s.generic ? { type: tp(lc.node, lc.ctx, 'type', s.generic.def) } : s.output !== 'T' && s.output.kind === 'float' ? { type: T.float } : {}) }),
  };
}

const BUILTINS: BuiltinSpec[] = [
  { id: 'abs', op: 'abs', title: 'Absolute', category: 'Math', description: 'Absolute value.', inputs: [['a', 'A', 'T']], output: 'T', generic: { def: 'float', options: NUMERIC } },
  { id: 'min', op: 'min', title: 'Min', category: 'Math', description: 'The smaller of A and B.', inputs: [['a', 'A', 'T'], ['b', 'B', 'T']], output: 'T', generic: { def: 'float', options: NUMERIC } },
  { id: 'max', op: 'max', title: 'Max', category: 'Math', description: 'The larger of A and B.', inputs: [['a', 'A', 'T'], ['b', 'B', 'T']], output: 'T', generic: { def: 'float', options: NUMERIC } },
  { id: 'clamp', op: 'clamp', title: 'Clamp', category: 'Math', description: 'Limit a value to the range [Min, Max].', inputs: [['value', 'Value', 'T'], ['min', 'Min', 'T', 0], ['max', 'Max', 'T', 1]], output: 'T', generic: { def: 'float', options: NUMERIC } },
  { id: 'pow', op: 'pow', title: 'Power', category: 'Math', description: 'Base raised to Exponent.', keywords: ['exponent', '^'], inputs: [['base', 'Base', T.float, 2], ['exp', 'Exponent', T.float, 2]], output: T.float },
  { id: 'sqrt', op: 'sqrt', title: 'Square Root', category: 'Math', description: 'Square root.', inputs: [['a', 'A', T.float]], output: T.float },
  { id: 'floor', op: 'floor', title: 'Floor', category: 'Math', description: 'Round down.', inputs: [['a', 'A', T.float]], output: T.float },
  { id: 'ceil', op: 'ceil', title: 'Ceil', category: 'Math', description: 'Round up.', inputs: [['a', 'A', T.float]], output: T.float },
  { id: 'round', op: 'round', title: 'Round', category: 'Math', description: 'Round to the nearest whole number.', inputs: [['a', 'A', T.float]], output: T.float },
  { id: 'lerp', op: 'lerp', title: 'Lerp', category: 'Math', description: 'Linear interpolation from A to B by Alpha (0–1).', keywords: ['interpolate', 'mix'], inputs: [['a', 'A', T.float], ['b', 'B', T.float, 1], ['t', 'Alpha', T.float, 0.5]], output: T.float },
  { id: 'sin', op: 'sin', title: 'Sin', category: 'Math', description: 'Sine (radians).', inputs: [['a', 'Radians', T.float]], output: T.float },
  { id: 'cos', op: 'cos', title: 'Cos', category: 'Math', description: 'Cosine (radians).', inputs: [['a', 'Radians', T.float]], output: T.float },
  { id: 'random_float', op: 'random_float', title: 'Random Float', category: 'Math', description: 'A random number in [0, 1].', keywords: ['rand'], inputs: [], output: T.float },
  { id: 'random_int', op: 'random_int_range', title: 'Random Integer In Range', category: 'Math', description: 'A random integer between Min and Max (inclusive).', keywords: ['rand'], inputs: [['min', 'Min', T.int, 0], ['max', 'Max', T.int, 10]], output: T.int },
  // strings
  { id: 'string_length', op: 'str_length', title: 'String Length', category: 'Strings', description: 'Number of characters.', inputs: [['s', 'String', T.string]], output: T.int },
  { id: 'string_upper', op: 'str_upper', title: 'To Upper Case', category: 'Strings', description: 'Upper-case copy of the string.', inputs: [['s', 'String', T.string]], output: T.string },
  { id: 'string_lower', op: 'str_lower', title: 'To Lower Case', category: 'Strings', description: 'Lower-case copy of the string.', inputs: [['s', 'String', T.string]], output: T.string },
  { id: 'string_contains', op: 'str_contains', title: 'String Contains', category: 'Strings', description: 'Whether String contains Search.', inputs: [['s', 'String', T.string], ['search', 'Search', T.string]], output: T.bool },
  { id: 'substring', op: 'str_substring', title: 'Substring', category: 'Strings', description: 'Length characters starting at From.', keywords: ['slice', 'substr'], inputs: [['s', 'String', T.string], ['from', 'From', T.int, 0], ['length', 'Length', T.int, 1]], output: T.string },
  // conversions
  { id: 'to_string', op: 'to_string', title: 'To String', category: 'Conversions', description: 'Convert any value to text.', keywords: ['str', 'string', 'convert'], inputs: [['value', 'Value', T.any, '']], output: T.string },
  { id: 'to_int', op: 'to_int', title: 'To Integer', category: 'Conversions', description: 'Convert a value to an integer (truncates floats, parses strings).', keywords: ['int', 'convert', 'parse'], inputs: [['value', 'Value', T.any, 0]], output: T.int },
  { id: 'to_float', op: 'to_float', title: 'To Float', category: 'Conversions', description: 'Convert a value to a float.', keywords: ['float', 'convert', 'parse'], inputs: [['value', 'Value', T.any, 0]], output: T.float },
  { id: 'to_bool', op: 'to_bool', title: 'To Boolean', category: 'Conversions', description: 'Convert a value to a boolean.', keywords: ['bool', 'convert'], inputs: [['value', 'Value', T.any, false]], output: T.bool },
];

const concat: NodeDefinition = {
  type: 'core.concat',
  title: 'Concatenate',
  category: 'Strings',
  description: 'Join strings together. Use To String for numbers.',
  keywords: ['join', 'append', 'string', '+'],
  flavor: 'pure',
  props: [countProp(2, 2, 12)],
  ports: (n) => [...Array.from({ length: int(n.props.count, 2) }, (_, i) => data.in(`s${i}`, String.fromCharCode(65 + i), T.string, { default: '' })), data.out('result', 'Result', T.string)],
  lowerExpr: (_p, lc) => ({ k: 'builtin', op: 'str_concat', args: Array.from({ length: int(lc.node.props.count, 2) }, (_, i) => lc.input(`s${i}`)) }),
};

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const elProp = typeProp('elementType', 'Element type', 'any');
const arrT = (n: GraphNode, ctx: NodeContext) => tp(n, ctx, 'elementType', 'any');

const makeArray: NodeDefinition = {
  type: 'core.make_array',
  allocates: true,
  title: 'Make Array',
  category: 'Arrays',
  description: 'Build an array from its items.',
  keywords: ['list', 'array', 'new'],
  flavor: 'pure',
  props: [elProp, countProp(2, 0, 32, 'Items')],
  ports: (n, ctx) => {
    const el = arrT(n, ctx);
    return [...Array.from({ length: int(n.props.count, 2) }, (_, i) => data.in(`item_${i}`, `[${i}]`, el, { default: zeroOf(el) })), data.out('array', 'Array', T.array(el))];
  },
  lowerExpr: (_p, lc) => {
    const el = arrT(lc.node, lc.ctx);
    return { k: 'array', items: Array.from({ length: int(lc.node.props.count, 2) }, (_, i) => lc.input(`item_${i}`)), ...(el.kind === 'any' ? {} : { element: el }) };
  },
};

const arrIn = (n: GraphNode, ctx: NodeContext) => data.in('array', 'Array', T.array(arrT(n, ctx)), { required: true, connectionOnly: true });

const arrayGet: NodeDefinition = {
  type: 'core.array_get',
  title: 'Array Get',
  category: 'Arrays',
  description: 'The element at Index.',
  keywords: ['index', 'item', '[]'],
  flavor: 'pure',
  props: [elProp],
  ports: (n, ctx) => [arrIn(n, ctx), data.in('index', 'Index', T.int, { default: 0 }), data.out('value', 'Value', arrT(n, ctx))],
  lowerExpr: (_p, lc) => ({ k: 'index', target: lc.input('array'), index: lc.input('index') }),
};

const arraySet: NodeDefinition = {
  type: 'core.array_set',
  title: 'Array Set',
  category: 'Arrays',
  description: 'Replace the element at Index.',
  flavor: 'exec',
  props: [elProp],
  ports: (n, ctx) => [exec.in(), arrIn(n, ctx), data.in('index', 'Index', T.int, { default: 0 }), data.in('value', 'Value', arrT(n, ctx), { required: true }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'assign', target: { k: 'index', target: lc.input('array'), index: lc.input('index') }, value: lc.input('value') }], next: 'then' }),
};

function arrayStmt(id: string, op: BuiltinOp, title: string, description: string, extra: (n: GraphNode, ctx: NodeContext) => PortSpec[], keywords: string[] = []): NodeDefinition {
  return {
    type: `core.${id}`,
    title,
    category: 'Arrays',
    description,
    keywords,
    flavor: 'exec',
    props: [elProp],
    ports: (n, ctx) => [exec.in(), arrIn(n, ctx), ...extra(n, ctx), exec.out()],
    lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'builtin', op, args: [lc.input('array'), ...extra(lc.node, lc.ctx).map((p) => lc.input(p.id))] } }], next: 'then' }),
  };
}

function arrayPure(id: string, op: BuiltinOp, title: string, description: string, extra: (n: GraphNode, ctx: NodeContext) => PortSpec[], out: TypeRef): NodeDefinition {
  return {
    type: `core.${id}`,
    title,
    category: 'Arrays',
    description,
    flavor: 'pure',
    props: [elProp],
    ports: (n, ctx) => [arrIn(n, ctx), ...extra(n, ctx), data.out('result', 'Result', out)],
    lowerExpr: (_p, lc) => ({ k: 'builtin', op, args: [lc.input('array'), ...extra(lc.node, lc.ctx).map((p) => lc.input(p.id))] }),
  };
}

const valueOfEl = (n: GraphNode, ctx: NodeContext) => [data.in('value', 'Value', arrT(n, ctx), { required: true })];

const mapProps: PropSchema[] = [typeProp('keyType', 'Key type', 'string'), typeProp('valueType', 'Value type', 'any')];
const mapTypes = (n: GraphNode, ctx: NodeContext) => ({ k: tp(n, ctx, 'keyType', 'string'), v: tp(n, ctx, 'valueType', 'any') });
const mapIn = (n: GraphNode, ctx: NodeContext) => {
  const { k, v } = mapTypes(n, ctx);
  return data.in('map', 'Dictionary', T.map(k, v), { required: true, connectionOnly: true });
};

const makeMap: NodeDefinition = {
  type: 'core.make_map',
  allocates: true,
  title: 'Make Dictionary',
  category: 'Dictionaries',
  description: 'Build a dictionary from key/value pairs.',
  keywords: ['map', 'dictionary', 'dict', 'new'],
  flavor: 'pure',
  props: [...mapProps, countProp(1, 0, 16, 'Entries')],
  ports: (n, ctx) => {
    const { k, v } = mapTypes(n, ctx);
    const c = int(n.props.count, 1);
    return [...Array.from({ length: c }, (_, i) => [data.in(`key_${i}`, `Key ${i}`, k, { default: zeroOf(k) }), data.in(`value_${i}`, `Value ${i}`, v, { default: zeroOf(v) })]).flat(), data.out('map', 'Dictionary', T.map(k, v))];
  },
  lowerExpr: (_p, lc) => ({ k: 'map', entries: Array.from({ length: int(lc.node.props.count, 1) }, (_, i) => ({ key: lc.input(`key_${i}`), value: lc.input(`value_${i}`) })) }),
};

const mapGet: NodeDefinition = {
  type: 'core.map_get',
  title: 'Dictionary Get',
  category: 'Dictionaries',
  description: 'Value for Key, or Default when the key is missing.',
  keywords: ['map', 'lookup'],
  flavor: 'pure',
  props: mapProps,
  ports: (n, ctx) => {
    const { k, v } = mapTypes(n, ctx);
    return [mapIn(n, ctx), data.in('key', 'Key', k, { default: zeroOf(k) }), data.in('default', 'Default', v, { default: zeroOf(v) }), data.out('value', 'Value', v)];
  },
  lowerExpr: (_p, lc) => ({ k: 'builtin', op: 'map_get', args: [lc.input('map'), lc.input('key'), lc.input('default')] }),
};

const mapSet: NodeDefinition = {
  type: 'core.map_set',
  title: 'Dictionary Set',
  category: 'Dictionaries',
  description: 'Store Value under Key.',
  keywords: ['map', 'put', 'insert'],
  flavor: 'exec',
  props: mapProps,
  ports: (n, ctx) => {
    const { k, v } = mapTypes(n, ctx);
    return [exec.in(), mapIn(n, ctx), data.in('key', 'Key', k, { default: zeroOf(k) }), data.in('value', 'Value', v, { required: true }), exec.out()];
  },
  lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'builtin', op: 'map_set', args: [lc.input('map'), lc.input('key'), lc.input('value')] } }], next: 'then' }),
};

const mapHas: NodeDefinition = {
  type: 'core.map_has',
  title: 'Dictionary Has Key',
  category: 'Dictionaries',
  description: 'Whether the dictionary contains Key.',
  keywords: ['map', 'contains', 'has'],
  flavor: 'pure',
  props: mapProps,
  ports: (n, ctx) => [mapIn(n, ctx), data.in('key', 'Key', mapTypes(n, ctx).k, { default: zeroOf(mapTypes(n, ctx).k) }), data.out('result', 'Result', T.bool)],
  lowerExpr: (_p, lc) => ({ k: 'builtin', op: 'map_has', args: [lc.input('map'), lc.input('key')] }),
};

const mapKeys: NodeDefinition = {
  type: 'core.map_keys',
  title: 'Dictionary Keys',
  category: 'Dictionaries',
  description: 'All keys as an array.',
  flavor: 'pure',
  props: mapProps,
  ports: (n, ctx) => [mapIn(n, ctx), data.out('result', 'Keys', T.array(mapTypes(n, ctx).k))],
  lowerExpr: (_p, lc) => ({ k: 'builtin', op: 'map_keys', args: [lc.input('map')] }),
};

const mapSize: NodeDefinition = {
  type: 'core.map_size',
  title: 'Dictionary Size',
  category: 'Dictionaries',
  description: 'Number of entries.',
  flavor: 'pure',
  props: mapProps,
  ports: (n, ctx) => [mapIn(n, ctx), data.out('result', 'Size', T.int)],
  lowerExpr: (_p, lc) => ({ k: 'builtin', op: 'map_size', args: [lc.input('map')] }),
};

const mapErase: NodeDefinition = {
  type: 'core.map_erase',
  title: 'Dictionary Remove',
  category: 'Dictionaries',
  description: 'Remove Key from the dictionary.',
  keywords: ['map', 'erase', 'delete'],
  flavor: 'exec',
  props: mapProps,
  ports: (n, ctx) => [exec.in(), mapIn(n, ctx), data.in('key', 'Key', mapTypes(n, ctx).k, { default: zeroOf(mapTypes(n, ctx).k) }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'builtin', op: 'map_erase', args: [lc.input('map'), lc.input('key')] } }], next: 'then' }),
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const callFunction: NodeDefinition = {
  type: 'core.call_function',
  title: 'Call Function',
  category: 'Functions',
  description: 'Call a function of this script.',
  keywords: ['call', 'invoke', 'run', 'function'],
  flavor: 'exec',
  props: [{ key: 'function', label: 'Function', kind: 'function', default: '' }],
  displayTitle: (n, ctx) => {
    const f = ctx.func(n.props.function);
    return f ? `Call ${f.name}` : 'Call (missing function)';
  },
  ports: (n, ctx) => {
    const f = ctx.func(n.props.function);
    if (!f) return [exec.in(), exec.out()];
    const rt = ctx.type(f.returnType);
    return [exec.in(), ...f.params.map((p) => data.in(p.id, p.name, ctx.type(p.type), p.default !== undefined ? { default: p.default } : { required: true })), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
  },
  check: (n, ctx, report) => {
    const f = ctx.func(n.props.function);
    if (!f) report('E_UNDEFINED_FUNCTION', 'This node calls a function that does not exist.', { suggestion: 'Pick a function in the inspector or delete the node.' });
    else if (f.kind === 'lambda') report('E_CLOSURE_CALL', `${f.name} is an inline function: pass it as a value (its Inline Function node) rather than calling it here.`);
  },
  lowerExec: (lc) => {
    const f = lc.ctx.func(lc.node.props.function);
    if (!f) return { stmts: [], next: 'then' };
    const call: IRExpr = { k: 'call', name: f.name, args: f.params.map((p) => lc.input(p.id)) };
    const rt = lc.ctx.type(f.returnType);
    if (rt.kind === 'void') return { stmts: [{ k: 'expr', expr: call }], next: 'then' };
    return { stmts: lc.bind('result', call, { type: rt, nameHint: `${f.name}_result`, sideEffect: true }), next: 'then' };
  },
};

const callMethod: NodeDefinition = {
  type: 'core.call_method',
  title: 'Call Method (by name)',
  category: 'Objects',
  description: 'Call any method on an object by name. Argument and return types are declared on the node.',
  keywords: ['method', 'call', 'invoke', 'dynamic'],
  flavor: 'exec',
  requires: ['classes'],
  props: [
    { key: 'method', label: 'Method name', kind: 'string', default: 'method_name' },
    { key: 'argTypes', label: 'Argument types', kind: 'string_list', default: [] },
    typeProp('returnType', 'Return type', 'void'),
  ],
  displayTitle: (n) => `Call ${str(n.props.method, 'method')}()`,
  ports: (n, ctx) => {
    const args = Array.isArray(n.props.argTypes) ? n.props.argTypes.map(String) : [];
    const rt = tp(n, ctx, 'returnType', 'void');
    return [exec.in(), data.in('target', 'Target', T.any, { connectionOnly: true, description: 'Unconnected = self' }), ...args.map((t, i) => data.in(`arg_${i}`, `Arg ${i}`, ctx.type(t), { required: true })), exec.out(), ...(rt.kind === 'void' ? [] : [data.out('result', 'Result', rt)])];
  },
  check: (n, _ctx, report) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(str(n.props.method))) report('E_INVALID_IDENTIFIER', 'Method name must be a valid identifier.');
  },
  lowerExec: (lc) => {
    const args = Array.isArray(lc.node.props.argTypes) ? lc.node.props.argTypes : [];
    const target = lc.isConnected('target') ? lc.input('target') : undefined;
    const call: IRExpr = { k: 'call', name: str(lc.node.props.method), args: args.map((_, i) => lc.input(`arg_${i}`)), ...(target ? { target } : {}) };
    const rt = tp(lc.node, lc.ctx, 'returnType', 'void');
    if (rt.kind === 'void') return { stmts: [{ k: 'expr', expr: call }], next: 'then' };
    return { stmts: lc.bind('result', call, { type: rt, nameHint: `${str(lc.node.props.method)}_result`, sideEffect: true }), next: 'then' };
  },
};

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

const selfNode: NodeDefinition = {
  type: 'core.self',
  title: 'Self',
  category: 'Objects',
  description: 'The object this script is attached to.',
  keywords: ['this', 'self', 'owner'],
  flavor: 'pure',
  requires: ['classes'],
  props: [],
  ports: (_n, ctx) => [data.out('self', 'Self', ctx.selfType() ?? T.any)],
  lowerExpr: () => ({ k: 'self' }),
};

const getProperty: NodeDefinition = {
  type: 'core.get_property',
  title: 'Get Property',
  category: 'Objects',
  description: 'Read a property of an object by name.',
  keywords: ['property', 'field', 'member', 'get'],
  flavor: 'pure',
  requires: ['classes'],
  props: [{ key: 'property', label: 'Property', kind: 'string', default: 'position' }, typeProp('type', 'Type', 'any')],
  displayTitle: (n) => `Get ${str(n.props.property, 'property')}`,
  ports: (n, ctx) => [data.in('target', 'Target', T.any, { connectionOnly: true, description: 'Unconnected = self' }), data.out('value', 'Value', tp(n, ctx, 'type', 'any'))],
  check: (n, _ctx, report) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(str(n.props.property))) report('E_INVALID_IDENTIFIER', 'Property name must be a valid identifier.');
  },
  lowerExpr: (_p, lc) => (lc.isConnected('target') ? { k: 'prop', target: lc.input('target'), name: str(lc.node.props.property) } : { k: 'ref', name: str(lc.node.props.property) }),
};

const setProperty: NodeDefinition = {
  type: 'core.set_property',
  title: 'Set Property',
  category: 'Objects',
  description: 'Assign a property of an object by name.',
  keywords: ['property', 'field', 'member', 'set'],
  flavor: 'exec',
  requires: ['classes'],
  props: [{ key: 'property', label: 'Property', kind: 'string', default: 'position' }, typeProp('type', 'Type', 'any')],
  displayTitle: (n) => `Set ${str(n.props.property, 'property')}`,
  ports: (n, ctx) => [exec.in(), data.in('target', 'Target', T.any, { connectionOnly: true, description: 'Unconnected = self' }), data.in('value', 'Value', tp(n, ctx, 'type', 'any'), { required: true }), exec.out()],
  check: (n, _ctx, report) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(str(n.props.property))) report('E_INVALID_IDENTIFIER', 'Property name must be a valid identifier.');
  },
  lowerExec: (lc) => ({
    stmts: [{ k: 'assign', target: lc.isConnected('target') ? { k: 'prop', target: lc.input('target'), name: str(lc.node.props.property) } : { k: 'ref', name: str(lc.node.props.property) }, value: lc.input('value') }],
    next: 'then',
  }),
};

const castNode: NodeDefinition = {
  type: 'core.cast',
  title: 'Cast To',
  category: 'Objects',
  description: 'Treat an object as a more specific class. The result is null when the object is not of that class.',
  keywords: ['as', 'convert', 'downcast'],
  flavor: 'pure',
  requires: ['classes'],
  props: [typeProp('type', 'Class', 'Node')],
  displayTitle: (n) => `Cast To ${str(n.props.type, 'Node')}`,
  ports: (n, ctx) => [data.in('object', 'Object', T.any, { required: true, connectionOnly: true }), data.out('result', 'Result', { ...tp(n, ctx, 'type', 'Node'), nullable: true })],
  lowerExpr: (_p, lc) => ({ k: 'cast', expr: lc.input('object'), type: tp(lc.node, lc.ctx, 'type', 'Node') }),
};

const newObject: NodeDefinition = {
  type: 'core.new_object',
  allocates: true,
  title: 'Create Object',
  category: 'Objects',
  description: 'Create a new instance of a class (e.g. a Timer). Nodes must still be added to the tree.',
  keywords: ['new', 'construct', 'instance', 'create'],
  flavor: 'exec',
  requires: ['classes'],
  props: [typeProp('type', 'Class', 'Node')],
  displayTitle: (n) => `Create ${str(n.props.type, 'Object')}`,
  ports: (n, ctx) => [exec.in(), exec.out(), data.out('object', 'Object', tp(n, ctx, 'type', 'Node'))],
  check: (n, ctx, report) => {
    if (tp(n, ctx, 'type', 'Node').kind !== 'named') report('E_INVALID_PROPERTY', 'Class must be a class name.');
  },
  lowerExec: (lc) => {
    const t = tp(lc.node, lc.ctx, 'type', 'Node');
    return { stmts: lc.bind('object', { k: 'new', type: t, args: [] }, { type: t, nameHint: t.kind === 'named' ? `new_${t.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}` : 'object', sideEffect: true }), next: 'then' };
  },
};

const isInstance: NodeDefinition = {
  type: 'core.is_instance',
  title: 'Is Instance Of',
  category: 'Objects',
  description: 'Whether the value is an instance of the class.',
  keywords: ['is', 'typeof', 'instanceof', 'check'],
  flavor: 'pure',
  requires: ['classes'],
  props: [typeProp('type', 'Class', 'Node')],
  displayTitle: (n) => `Is ${str(n.props.type, 'Node')}`,
  ports: () => [data.in('object', 'Object', T.any, { required: true, connectionOnly: true }), data.out('result', 'Result', T.bool)],
  lowerExpr: (_p, lc) => ({ k: 'instanceof', expr: lc.input('object'), type: tp(lc.node, lc.ctx, 'type', 'Node') }),
};

const isNull: NodeDefinition = {
  type: 'core.is_null',
  title: 'Is Null',
  category: 'Objects',
  description: 'Whether the value is null.',
  keywords: ['null', 'none', 'nil', 'empty'],
  flavor: 'pure',
  props: [],
  ports: () => [data.in('value', 'Value', T.any, { required: true, connectionOnly: true }), data.out('result', 'Result', T.bool)],
  lowerExpr: (_p, lc) => ({ k: 'bin', op: '==', left: lc.input('value'), right: { k: 'null' } }),
};

const nullNode: NodeDefinition = {
  type: 'core.null',
  title: 'Null',
  category: 'Literals',
  description: 'The null value.',
  keywords: ['none', 'nil'],
  flavor: 'pure',
  props: [],
  ports: () => [data.out('value', 'Null', T.any)],
  lowerExpr: () => ({ k: 'null' }),
};

const enumValue: NodeDefinition = {
  type: 'core.enum_value',
  title: 'Enum Value',
  category: 'Variables',
  description: 'A member of one of the script enums.',
  keywords: ['enum', 'state', 'constant'],
  flavor: 'pure',
  requires: ['enums'],
  props: [
    { key: 'enum', label: 'Enum', kind: 'enum', default: '' },
    { key: 'member', label: 'Member', kind: 'string', default: '' },
  ],
  displayTitle: (n, ctx) => {
    const e = ctx.script.enums.find((x) => x.id === n.props.enum);
    return e ? `${e.name}.${str(n.props.member)}` : 'Enum (missing)';
  },
  ports: (n, ctx) => {
    const e = ctx.script.enums.find((x) => x.id === n.props.enum);
    return [data.out('value', 'Value', e ? T.named(e.name) : T.int)];
  },
  check: (n, ctx, report) => {
    const e = ctx.script.enums.find((x) => x.id === n.props.enum);
    if (!e) report('E_UNDEFINED_ENUM', 'This node refers to an enum that does not exist.');
    else if (!e.members.some((m) => m.name === n.props.member)) report('E_UNDEFINED_ENUM_MEMBER', `"${str(n.props.member)}" is not a member of ${e.name}.`);
  },
  lowerExpr: (_p, lc) => {
    const e = lc.ctx.script.enums.find((x) => x.id === lc.node.props.enum);
    return { k: 'enum', enumName: e?.name ?? '__missing', member: str(lc.node.props.member) };
  },
};

// ---------------------------------------------------------------------------
// Debug / utility
// ---------------------------------------------------------------------------

const printNode: NodeDefinition = {
  type: 'core.print',
  title: 'Print',
  category: 'Debug',
  description: 'Write a value to the output/console.',
  keywords: ['log', 'console', 'debug', 'output', 'hello'],
  flavor: 'exec',
  props: [],
  ports: () => [exec.in(), data.in('value', 'Value', T.any, { default: 'Hello' }), exec.out()],
  lowerExec: (lc) => ({ stmts: [{ k: 'expr', expr: { k: 'builtin', op: 'print', args: [lc.input('value')] } }], next: 'then' }),
};

const codeComment: NodeDefinition = {
  type: 'core.code_comment',
  title: 'Code Comment',
  category: 'Utility',
  description: 'Emit a comment line into the generated code at this point of the flow.',
  keywords: ['comment', 'note', 'todo'],
  flavor: 'exec',
  props: [{ key: 'text', label: 'Text', kind: 'text', default: 'TODO' }],
  ports: () => [exec.in(), exec.out()],
  lowerExec: (lc) => ({ stmts: str(lc.node.props.text) ? [{ k: 'comment', text: str(lc.node.props.text) }] : [], next: 'then' }),
};

const reroute: NodeDefinition = {
  type: 'core.reroute',
  title: 'Reroute',
  category: 'Utility',
  description: 'A bend point for data wires.',
  flavor: 'pure',
  props: [],
  ports: () => [data.in('in', '', T.any, { required: true, connectionOnly: true }), data.out('out', '', T.any)],
  lowerExpr: (_p, lc) => lc.input('in'),
};

const frame: NodeDefinition = {
  type: 'core.frame',
  title: 'Comment Frame',
  category: 'Utility',
  description: 'A labelled box for organising nodes. Has no effect on the generated code.',
  keywords: ['comment', 'group', 'box', 'note'],
  flavor: 'annotation',
  props: [
    { key: 'title', label: 'Title', kind: 'string', default: 'Comment' },
    { key: 'color', label: 'Colour', kind: 'select', default: 'slate', options: ['slate', 'blue', 'green', 'amber', 'red', 'violet'].map((c) => ({ value: c, label: c })) },
  ],
  ports: () => [],
};

// ---------------------------------------------------------------------------

export const CORE_NODES: NodeDefinition[] = [
  entry,
  returnNode,
  branch,
  sequence,
  forRange,
  forEach,
  whileLoop,
  breakNode,
  continueNode,
  switchNode,
  rerouteExec,
  getVar,
  setVar,
  literalNode('bool', 'Boolean', false),
  literalNode('int', 'Integer', 0),
  literalNode('float', 'Float', 0),
  literalNode('string', 'String', ''),
  nullNode,
  binaryNode('+', 'add', 'Add', 'Math', ['+', 'plus', 'sum'], 'float', { typeOptions: ARITH_TYPES, rhs: true }),
  binaryNode('-', 'subtract', 'Subtract', 'Math', ['-', 'minus'], 'float', { typeOptions: ARITH_TYPES, rhs: true }),
  binaryNode('*', 'multiply', 'Multiply', 'Math', ['*', 'times', 'product'], 'float', { typeOptions: ARITH_TYPES, rhs: true }),
  binaryNode('/', 'divide', 'Divide', 'Math', ['/', 'quotient'], 'float', { typeOptions: ARITH_TYPES, rhs: true }),
  binaryNode('%', 'modulo', 'Modulo', 'Math', ['%', 'remainder', 'mod'], 'int', { typeOptions: NUMERIC }),
  negate,
  ...BUILTINS.map(builtinNode),
  binaryNode('==', 'equal', 'Equal', 'Comparison', ['==', 'equals', 'same'], 'float', { result: T.bool }),
  binaryNode('!=', 'not_equal', 'Not Equal', 'Comparison', ['!=', 'different'], 'float', { result: T.bool }),
  binaryNode('<', 'less', 'Less Than', 'Comparison', ['<', 'smaller'], 'float', { result: T.bool, typeOptions: ['int', 'float', 'string'] }),
  binaryNode('<=', 'less_equal', 'Less Or Equal', 'Comparison', ['<='], 'float', { result: T.bool, typeOptions: ['int', 'float', 'string'] }),
  binaryNode('>', 'greater', 'Greater Than', 'Comparison', ['>', 'bigger'], 'float', { result: T.bool, typeOptions: ['int', 'float', 'string'] }),
  binaryNode('>=', 'greater_equal', 'Greater Or Equal', 'Comparison', ['>='], 'float', { result: T.bool, typeOptions: ['int', 'float', 'string'] }),
  binaryNode('and', 'and', 'AND', 'Logic', ['and', '&&', 'both'], 'bool', { result: T.bool, typeOptions: ['bool'] }),
  binaryNode('or', 'or', 'OR', 'Logic', ['or', '||', 'either'], 'bool', { result: T.bool, typeOptions: ['bool'] }),
  notNode,
  select,
  concat,
  makeArray,
  arrayGet,
  arraySet,
  arrayStmt('array_append', 'array_append', 'Array Append', 'Add Value to the end of the array.', valueOfEl, ['push', 'add', 'append']),
  arrayStmt('array_remove_at', 'array_remove_at', 'Array Remove At', 'Remove the element at Index.', () => [data.in('index', 'Index', T.int, { default: 0 })], ['delete', 'remove']),
  arrayStmt('array_clear', 'array_clear', 'Array Clear', 'Remove every element.', () => [], ['empty', 'reset']),
  arrayPure('array_length', 'array_length', 'Array Length', 'Number of elements.', () => [], T.int),
  arrayPure('array_contains', 'array_contains', 'Array Contains', 'Whether the array contains Value.', valueOfEl, T.bool),
  makeMap,
  mapGet,
  mapSet,
  mapHas,
  mapKeys,
  mapSize,
  mapErase,
  callFunction,
  callMethod,
  selfNode,
  getProperty,
  setProperty,
  castNode,
  newObject,
  isInstance,
  isNull,
  enumValue,
  printNode,
  codeComment,
  reroute,
  frame,
];
