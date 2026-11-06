/** TypeScript types: canonical type text ⇄ TS spelling, compatibility and operators. */
import type { BinaryOp } from '@cs/intermediate-representation';
import type { LanguageTypes } from '@cs/language-sdk';
import { defaultCompatibility, formatType, T, type Compatibility, type TypeRef, type TypeUniverse } from '@cs/type-system';

/** Built-in classes worth knowing (anything else named is treated as a user/library type). */
export const TS_CLASS_PARENTS: Record<string, string | undefined> = {
  Object: undefined,
  Error: 'Object',
  TypeError: 'Error',
  RangeError: 'Error',
  Date: 'Object',
  RegExp: 'Object',
  Promise: 'Object',
  Set: 'Object',
  Map: 'Object',
  Response: 'Object',
  Request: 'Object',
  URL: 'Object',
  Event: 'Object',
  MouseEvent: 'Event',
  KeyboardEvent: 'Event',
  EventTarget: 'Object',
  Node: 'EventTarget',
  Element: 'Node',
  HTMLElement: 'Element',
  HTMLInputElement: 'HTMLElement',
  HTMLButtonElement: 'HTMLElement',
  HTMLCanvasElement: 'HTMLElement',
  Document: 'Node',
};

export const universe: TypeUniverse = {
  parentOf: (n) => TS_CLASS_PARENTS[n],
  isReferenceType: () => true,
  isKnown: (n) => n in TS_CLASS_PARENTS,
};

export function tsType(t: TypeRef): string {
  let s: string;
  switch (t.kind) {
    case 'any':
      s = 'any';
      break;
    case 'void':
      s = 'void';
      break;
    case 'bool':
      s = 'boolean';
      break;
    case 'int':
    case 'float':
      s = 'number';
      break;
    case 'string':
      s = 'string';
      break;
    case 'array': {
      const e = tsType(t.element);
      s = /[|&(=]/.test(e) ? `Array<${e}>` : `${e}[]`;
      break;
    }
    case 'map':
      s = `Map<${tsType(t.key)}, ${tsType(t.value)}>`;
      break;
    case 'named':
      s = t.args?.length ? `${t.name}<${t.args.map(tsType).join(', ')}>` : t.name;
      break;
    case 'function':
      s = `(${t.params.map((p, i) => `a${i}: ${tsType(p)}`).join(', ')}) => ${tsType(t.returns)}`;
      break;
  }
  return t.nullable ? `${t.kind === 'function' ? `(${s})` : s} | null` : s;
}

/** TS spellings → canonical text ("number" → "float", "string[]" → "array<string>", "Record<K, V>" → "map<K, V>"). */
export function normalize(text: string): string | undefined {
  let s = text.trim();
  let nullable = false;
  const nul = /^(.*?)\s*\|\s*(null|undefined)$/.exec(s);
  if (nul) {
    s = nul[1];
    nullable = true;
  }
  const done = (c: string | undefined) => (c === undefined ? undefined : nullable ? `${c}?` : c);
  if (s === 'number') return done('float');
  if (s === 'boolean') return done('bool');
  if (s === 'unknown') return done('any');
  if (s === 'undefined') return done('void');
  if (s.endsWith('[]')) {
    const inner = normalize(s.slice(0, -2));
    return done(`array<${inner ?? s.slice(0, -2)}>`);
  }
  const gen = /^(Array|Map|Record|ReadonlyArray)<(.+)>$/.exec(s);
  if (gen) {
    const parts = splitTop(gen[2]).map((p) => normalize(p) ?? p);
    if (gen[1] === 'Array' || gen[1] === 'ReadonlyArray') return done(`array<${parts[0]}>`);
    return done(`map<${parts[0]}, ${parts[1] ?? 'any'}>`);
  }
  return nullable ? `${s}?` : undefined;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const num = (t: TypeRef) => t.kind === 'int' || t.kind === 'float';

export function operatorResult(op: BinaryOp, l: TypeRef, r: TypeRef): TypeRef | undefined {
  const isAny = l.kind === 'any' || r.kind === 'any';
  switch (op) {
    case '+':
      if (l.kind === 'string' || r.kind === 'string') return T.string;
      if (isAny) return T.any;
      if (num(l) && num(r)) return l.kind === 'int' && r.kind === 'int' ? T.int : T.float;
      return undefined;
    case '-':
    case '*':
    case '%':
      if (isAny) return T.any;
      if (num(l) && num(r)) return l.kind === 'int' && r.kind === 'int' ? T.int : T.float;
      return undefined;
    case '/':
      if (isAny) return T.any;
      return num(l) && num(r) ? T.float : undefined;
    case '==':
    case '!=':
      return T.bool;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (isAny || (num(l) && num(r)) || (l.kind === 'string' && r.kind === 'string')) return T.bool;
      if (l.kind === 'named' && r.kind === 'named' && l.name === 'Date' && r.name === 'Date') return T.bool;
      return undefined;
    case 'and':
    case 'or':
      return T.bool;
  }
}

export function compatibility(from: TypeRef, to: TypeRef): Compatibility {
  // Both are `number` at runtime.
  if (from.kind === 'float' && to.kind === 'int') return 'implicit';
  // Anything is truthy/falsy, but make it explicit to keep graphs honest.
  if (from.kind === 'named' && to.kind === 'named' && !universe.isKnown(from.name) && !universe.isKnown(to.name) && from.name !== to.name) return 'incompatible';
  return defaultCompatibility(from, to, universe);
}

export const typescriptTypes: LanguageTypes = {
  universe,
  openTypes: true,
  normalize,
  format: tsType,
  compatibility,
  operatorResult,
  structFields: () => undefined,
  pickerTypes: () => ['bool', 'int', 'float', 'string', 'any', 'array<any>', 'array<string>', 'array<float>', 'map<string, any>', 'Date', 'Error', 'Promise<any>', 'Promise<void>', 'HTMLElement', 'Event'],
  check: (t) => (t.kind === 'named' && !/^[A-Za-z_$][\w$.]*$/.test(t.name) ? `"${formatType(t)}" is not a valid TypeScript type name` : undefined),
};
