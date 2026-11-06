/**
 * Library catalog: turn the TypeScript service's description of a package's exports
 * ("function format(date: Date | number, formatStr: string): string",
 *  "(method) Dexie.table<T = any>(tableName: string): Table<T>") into node signatures.
 *
 * Port types use our canonical types where the TS type maps cleanly (primitives, arrays, maps,
 * functions, built-in classes); anything else (library types, generics, unions) becomes `any`,
 * and the generated code is left un-annotated there so TypeScript infers the real type — the
 * TypeScript check of the generated code then catches misuse and points at the node.
 */
import { parseType, formatType, type TypeRef } from '@cs/type-system';
import { normalize, TS_CLASS_PARENTS } from './types';

export interface ApiParam {
  name: string;
  type: string;
  /** The TypeScript type as written in the library (for tooltips). */
  tsType: string;
  optional?: boolean;
  rest?: boolean;
}

export interface ApiSignature {
  name: string;
  params: ApiParam[];
  returnType: string;
  tsReturnType: string;
  /** Returns a Promise: the node offers to await it. */
  async: boolean;
  overloads?: number;
}

function matchingClose(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '<': '>', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && s[i + 1] === '>') {
      i++;
      continue;
    }
    if (c in pairs) stack.push(pairs[c]);
    else if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '=' && s[i + 1] === '>') {
      cur += '=>';
      i++;
      continue;
    }
    if ('([{<'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const PRIMS: Record<string, string> = { string: 'string', number: 'float', boolean: 'bool', void: 'void', undefined: 'void', any: 'any', unknown: 'any', never: 'void', null: 'any', object: 'any', bigint: 'any', symbol: 'any' };

/** TS type text → canonical type text (or "any" when it doesn't map cleanly). */
export function canonicalFromTs(tsText: string, generics: Set<string> = new Set()): string {
  let t = tsText.trim();
  if (!t) return 'any';
  // T | undefined / T | null → nullable T
  const parts = splitTopLevel(t, '|');
  let nullable = false;
  if (parts.length > 1) {
    const rest = parts.filter((p) => p !== 'undefined' && p !== 'null');
    if (rest.length !== 1) return 'any';
    nullable = true;
    t = rest[0];
  }
  const done = (c: string) => (nullable && c !== 'any' && c !== 'void' ? `${c}?` : c);
  if (generics.has(t)) return 'any';
  if (t in PRIMS) return done(PRIMS[t]);
  if (/^(['"]).*\1$/.test(t)) return done('string');
  if (/^-?\d+(\.\d+)?$/.test(t)) return done('float');
  if (t.endsWith('[]')) {
    const inner = canonicalFromTs(t.slice(0, -2), generics);
    return done(`array<${inner.replace(/\?$/, '')}>`);
  }
  const gen = /^([A-Za-z_$][\w$.]*)<(.+)>$/.exec(t);
  if (gen) {
    const args = splitTopLevel(gen[2]).map((a) => canonicalFromTs(a, generics).replace(/\?$/, ''));
    if (gen[1] === 'Array' || gen[1] === 'ReadonlyArray') return done(`array<${args[0] ?? 'any'}>`);
    if (gen[1] === 'Map' || gen[1] === 'Record') return done(`map<${args[0] ?? 'any'}, ${args[1] ?? 'any'}>`);
    if (gen[1] === 'Promise' || gen[1] === 'PromiseLike') return done(`Promise<${args[0] ?? 'any'}>`);
    return 'any';
  }
  if (t.startsWith('(') && t.includes('=>')) {
    const close = matchingClose(t, 0);
    const after = t.slice(close + 1).trim();
    if (close > 0 && after.startsWith('=>')) {
      const ps = splitTopLevel(t.slice(1, close)).map((p) => canonicalFromTs(p.replace(/^\.\.\./, '').replace(/^[\w$]+\??\s*:\s*/, ''), generics));
      return done(`fn(${ps.join(', ')}) -> ${canonicalFromTs(after.slice(2), generics)}`);
    }
    return 'any';
  }
  if (/^[A-Za-z_$][\w$]*$/.test(t) && t in TS_CLASS_PARENTS) return done(t);
  const n = normalize(t);
  if (n) {
    try {
      parseType(n);
      return done(n);
    } catch {
      return 'any';
    }
  }
  return 'any';
}

function stripPrefix(text: string): string {
  // Multi-line object types are joined; the trailing "import x" line of aliases is dropped.
  let t = text
    .split('\n')
    .filter((l) => !/^import\s/.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^\(alias\)\s*/, '').replace(/^\((method|property|function|function property|getter|setter|constructor)\)\s*/, '');
  t = t.replace(/^(export\s+)?(declare\s+)?(default\s+)?/, '');
  return t;
}

/** Parse "name<T>(a: string, b?: number): R" (after the name may come a qualified prefix like Dexie.table). */
function parseCallable(name: string, rest: string): ApiSignature | undefined {
  let i = 0;
  const generics = new Set<string>();
  rest = rest.trim();
  if (rest.startsWith('<')) {
    const close = matchingClose(rest, 0);
    if (close < 0) return undefined;
    for (const g of splitTopLevel(rest.slice(1, close))) generics.add(g.split(/\s|=|extends/)[0].trim());
    i = close + 1;
  }
  if (rest[i] !== '(') return undefined;
  const close = matchingClose(rest, i);
  if (close < 0) return undefined;
  const paramText = rest.slice(i + 1, close);
  let after = rest.slice(close + 1).trim();
  const overloads = /\(\+(\d+) overloads?\)\s*$/.exec(after);
  after = after.replace(/\(\+\d+ overloads?\)\s*$/, '').trim();
  const retTs = after.startsWith(':') ? after.slice(1).trim() : after.startsWith('=>') ? after.slice(2).trim() : 'void';
  const params: ApiParam[] = splitTopLevel(paramText).map((p, k) => {
    const rest = p.startsWith('...');
    const m = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*(?::\s*([\s\S]+))?$/.exec(p);
    const tsType = m?.[3]?.trim() ?? 'any';
    return { name: m?.[1] ?? `arg${k}`, tsType, type: rest ? 'any' : canonicalFromTs(tsType, generics), ...(m?.[2] ? { optional: true } : {}), ...(rest ? { rest: true } : {}) };
  });
  const promise = /^(Promise|PromiseLike|PromiseExtended)<([\s\S]+)>$/.exec(retTs);
  const ret = promise ? canonicalFromTs(promise[2], generics) : canonicalFromTs(retTs, generics);
  return { name, params, returnType: ret, tsReturnType: retTs, async: !!promise, ...(overloads ? { overloads: Number(overloads[1]) } : {}) };
}

/**
 * Parse one completion-detail text. Returns a callable signature for functions, methods and
 * function-typed constants; `{ kind: 'class' }` for classes; undefined for anything else.
 */
export function parseDisplay(text: string): ({ kind: 'function' } & ApiSignature) | { kind: 'class'; name: string } | { kind: 'value'; name: string; type: string } | undefined {
  const t = stripPrefix(text);
  let m = /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(t);
  if (m) return { kind: 'class', name: m[1] };
  m = /^function\s+([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(t);
  if (m) {
    const s = parseCallable(m[1], m[2]);
    return s ? { kind: 'function', ...s } : undefined;
  }
  m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(t);
  if (m) {
    const s = /^(<[\s\S]*?>)?\s*\(/.test(m[2]) ? parseCallable(m[1], m[2]) : undefined;
    return s ? { kind: 'function', ...s } : { kind: 'value', name: m[1], type: canonicalFromTs(m[2]) };
  }
  // Methods: "Owner<T>.name<U>(…): R" or "name(…): R"
  m = /^(?:[A-Za-z_$][\w$]*(?:<[^()]*?>)?\.)?([A-Za-z_$][\w$]*)\s*((?:<[\s\S]*?>)?\s*\([\s\S]*)$/.exec(t);
  if (m) {
    const s = parseCallable(m[1], m[2]);
    return s ? { kind: 'function', ...s } : undefined;
  }
  m = /^(?:[A-Za-z_$][\w$]*(?:<[^()]*?>)?\.)?([A-Za-z_$][\w$]*)\??\s*:\s*([\s\S]+)$/.exec(t);
  if (m) return { kind: 'value', name: m[1], type: canonicalFromTs(m[2]) };
  return undefined;
}

/** Parameters from signature help ("new Dexie(databaseName: string, options?: DexieOptions)"). */
export function parseParams(paramTexts: string[]): ApiParam[] {
  return paramTexts.map((p, k) => {
    const m = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*(?::\s*([\s\S]+))?$/.exec(p.trim());
    const tsType = m?.[3]?.trim() ?? 'any';
    return { name: m?.[1] ?? `arg${k}`, tsType, type: p.trim().startsWith('...') ? 'any' : canonicalFromTs(tsType), ...(m?.[2] ? { optional: true } : {}) };
  });
}

export const typeText = (t: TypeRef) => formatType(t);
