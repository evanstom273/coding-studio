/**
 * TEST-ONLY reference adapter: a deliberately small JavaScript (ES2020 module) backend.
 *
 * It exists to prove that the compiler pipeline, node registry and edit operations are not tied
 * to GDScript: it plugs into the same LanguageAdapter interface, reuses the core node pack, and
 * the tests *execute* its output. It is not shipped in the app and does not claim to be a
 * complete JavaScript/TypeScript backend.
 */
import { allCapabilities, CodeWriter, type LanguageAdapter } from '@cs/language-sdk';
import type { IRExpr, IRStmt } from '@cs/intermediate-representation';
import { defaultCompatibility, T, type TypeRef } from '@cs/type-system';

const universe = { parentOf: () => undefined, isReferenceType: () => false, isKnown: () => false };
const PREC: Record<string, number> = { or: 3, and: 4, '==': 8, '!=': 8, '<': 9, '<=': 9, '>': 9, '>=': 9, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12 };
const JS_OP: Record<string, string> = { and: '&&', or: '||', '==': '===', '!=': '!==' };

function expr(e: IRExpr, min = 0): string {
  const [s, p] = exprP(e);
  return p < min ? `(${s})` : s;
}

function exprP(e: IRExpr): [string, number] {
  switch (e.k) {
    case 'lit':
      return [JSON.stringify(e.value), 20];
    case 'null':
      return ['null', 20];
    case 'ref':
      return [e.name, 20];
    case 'bin': {
      const p = PREC[e.op];
      return [`${expr(e.left, p)} ${JS_OP[e.op] ?? e.op} ${expr(e.right, p + 1)}`, p];
    }
    case 'un':
      return [e.op === 'not' ? `!${expr(e.operand, 14)}` : `-${expr(e.operand, 14)}`, 14];
    case 'call':
      return [`${e.target ? `${expr(e.target, 20)}.` : ''}${e.name}(${e.args.map((a) => expr(a)).join(', ')})`, 20];
    case 'ternary':
      return [`${expr(e.cond, 3)} ? ${expr(e.then, 3)} : ${expr(e.else, 2)}`, 2];
    case 'array':
      return [`[${e.items.map((a) => expr(a)).join(', ')}]`, 20];
    case 'index':
      return [`${expr(e.target, 20)}[${expr(e.index)}]`, 20];
    case 'builtin': {
      const a = e.args.map((x) => expr(x));
      const m: Record<string, string> = {
        print: `print(${a[0]})`,
        to_string: `String(${a[0]})`,
        to_int: `Math.trunc(Number(${a[0]}))`,
        to_float: `Number(${a[0]})`,
        abs: `Math.abs(${a[0]})`,
        min: `Math.min(${a.join(', ')})`,
        max: `Math.max(${a.join(', ')})`,
        str_concat: a.join(' + '),
        str_length: `${a[0]}.length`,
        array_length: `${a[0]}.length`,
        array_append: `${a[0]}.push(${a[1]})`,
      };
      if (!(e.op in m)) throw new Error(`js-reference: built-in ${e.op} not supported`);
      return [m[e.op], e.op === 'str_concat' ? 11 : 20];
    }
    default:
      throw new Error(`js-reference: expression ${e.k} not supported`);
  }
}

function stmt(w: CodeWriter, s: IRStmt) {
  const block = (b: IRStmt[]) => {
    w.indent();
    b.forEach((x) => stmt(w, x));
    w.dedent();
  };
  switch (s.k) {
    case 'var':
      w.line(`let ${s.name}${s.init ? ` = ${expr(s.init)}` : ''};`);
      break;
    case 'assign':
      w.line(`${expr(s.target)} ${s.op ?? ''}= ${expr(s.value)};`);
      break;
    case 'expr':
      w.line(`${expr(s.expr)};`);
      break;
    case 'if':
      w.line(`if (${expr(s.cond)}) {`);
      block(s.then);
      if (s.else) {
        w.line('} else {');
        block(s.else);
      }
      w.line('}');
      break;
    case 'while':
      w.line(`while (${expr(s.cond)}) {`);
      block(s.body);
      w.line('}');
      break;
    case 'for_range':
      w.line(`for (let ${s.var} = ${expr(s.from)}; ${s.var} < ${expr(s.to)}; ${s.var} += ${s.step ? expr(s.step) : '1'}) {`);
      block(s.body);
      w.line('}');
      break;
    case 'for_each':
      w.line(`for (const ${s.var} of ${expr(s.iterable)}) {`);
      block(s.body);
      w.line('}');
      break;
    case 'match':
      w.line(`switch (${expr(s.subject)}) {`);
      w.indent();
      for (const a of s.arms) {
        a.values.forEach((v) => w.line(`case ${expr(v)}:`));
        block([...a.body, { k: 'break' }]);
      }
      if (s.default) {
        w.line('default:');
        block(s.default);
      }
      w.dedent();
      w.line('}');
      break;
    case 'break':
      w.line('break;');
      break;
    case 'continue':
      w.line('continue;');
      break;
    case 'return':
      w.line(s.value ? `return ${expr(s.value)};` : 'return;');
      break;
    case 'comment':
      w.line(`// ${s.text}`);
      break;
    default:
      throw new Error(`js-reference: statement ${s.k} not supported`);
  }
}

export const jsReferenceAdapter: LanguageAdapter = {
  id: 'js-reference',
  name: 'JavaScript (test reference)',
  extensions: ['.mjs'],
  versions: [{ id: 'es2020', label: 'ES2020' }],
  defaultVersion: 'es2020',
  capabilities: { ...allCapabilities(false), modules: true, memberVariables: true, dynamicTyping: true },
  types: {
    universe,
    format: (t) => t.kind,
    compatibility: (a, b) => defaultCompatibility(a, b, universe),
    operatorResult: (op, l: TypeRef, r: TypeRef) => {
      const num = (t: TypeRef) => t.kind === 'int' || t.kind === 'float';
      if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return T.bool;
      if (op === 'and' || op === 'or') return l.kind === 'bool' && r.kind === 'bool' ? T.bool : undefined;
      if (num(l) && num(r)) return l.kind === 'float' || r.kind === 'float' || op === '/' ? T.float : T.int;
      if (op === '+' && l.kind === 'string' && r.kind === 'string') return T.string;
      return undefined;
    },
    structFields: () => undefined,
    pickerTypes: () => ['bool', 'int', 'float', 'string'],
  },
  identifiers: { isValid: (n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n), reserved: new Set(['let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'this', 'var', 'print']), description: 'JavaScript identifier rules.' },
  scriptSettings: [],
  events: [],
  templates: [{ id: 'module', name: 'Module', description: 'An ES module', settings: {}, events: [] }],
  registerNodes: () => undefined,
  validate: () => [],
  generate(module) {
    const w = new CodeWriter('  ', module.scriptId);
    for (const m of module.members) {
      if (m.k === 'field') w.line(`${m.constant ? 'const' : 'let'} ${m.name}${m.init ? ` = ${expr(m.init)}` : ''};`);
    }
    for (const m of module.members) {
      if (m.k !== 'function') continue;
      w.blank();
      w.line(`export function ${m.name}(${m.params.map((p) => p.name).join(', ')}) {`);
      w.indent();
      m.body.forEach((s) => stmt(w, s));
      w.dedent();
      w.line('}');
    }
    const r = w.result();
    return [{ path: `${module.path}.mjs`, content: r.content, sourceMap: r.sourceMap }];
  },
};
