/**
 * Language-neutral type representation.
 *
 * Documents store types in a canonical textual form ("int", "array<float>", "map<string, any>",
 * "Vector2", "Node2D?") so they stay readable in JSON and easy to write over MCP. Language
 * adapters decide how those types are spelled in source code and which conversions are legal.
 */

export type PrimitiveKind = 'any' | 'void' | 'bool' | 'int' | 'float' | 'string';

export type TypeRef =
  | { kind: PrimitiveKind; nullable?: boolean }
  | { kind: 'array'; element: TypeRef; nullable?: boolean }
  | { kind: 'map'; key: TypeRef; value: TypeRef; nullable?: boolean }
  /** Named type: a class, struct-like value type (Vector2), enum or custom type. `args` = generic arguments. */
  | { kind: 'named'; name: string; args?: TypeRef[]; nullable?: boolean }
  | { kind: 'function'; params: TypeRef[]; returns: TypeRef; nullable?: boolean };

export const T = {
  any: { kind: 'any' } as TypeRef,
  void: { kind: 'void' } as TypeRef,
  bool: { kind: 'bool' } as TypeRef,
  int: { kind: 'int' } as TypeRef,
  float: { kind: 'float' } as TypeRef,
  string: { kind: 'string' } as TypeRef,
  array: (element: TypeRef = { kind: 'any' }): TypeRef => ({ kind: 'array', element }),
  map: (key: TypeRef = { kind: 'any' }, value: TypeRef = { kind: 'any' }): TypeRef => ({ kind: 'map', key, value }),
  named: (name: string, args?: TypeRef[]): TypeRef => (args?.length ? { kind: 'named', name, args } : { kind: 'named', name }),
};

const PRIMITIVES = new Set<string>(['any', 'void', 'bool', 'int', 'float', 'string']);

export class TypeParseError extends Error {}

/** Canonical text form. Inverse of parseType. */
export function formatType(t: TypeRef): string {
  let s: string;
  switch (t.kind) {
    case 'array':
      s = `array<${formatType(t.element)}>`;
      break;
    case 'map':
      s = `map<${formatType(t.key)}, ${formatType(t.value)}>`;
      break;
    case 'named':
      s = t.args?.length ? `${t.name}<${t.args.map(formatType).join(', ')}>` : t.name;
      break;
    case 'function':
      s = `fn(${t.params.map(formatType).join(', ')}) -> ${formatType(t.returns)}`;
      break;
    default:
      s = t.kind;
  }
  return t.nullable ? `${s}?` : s;
}

/** Parse the canonical text form. Throws TypeParseError with a readable message. */
export function parseType(text: string): TypeRef {
  const p = new Parser(text);
  const t = p.type();
  p.skipWs();
  if (!p.eof()) throw new TypeParseError(`Unexpected "${text.slice(p.i)}" in type "${text}"`);
  return t;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  eof() {
    return this.i >= this.s.length;
  }
  skipWs() {
    while (!this.eof() && /\s/.test(this.s[this.i])) this.i++;
  }
  expect(ch: string) {
    this.skipWs();
    if (this.s[this.i] !== ch) throw new TypeParseError(`Expected "${ch}" in type "${this.s}"`);
    this.i++;
  }
  peek() {
    this.skipWs();
    return this.s[this.i];
  }
  ident(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.s.slice(this.i));
    if (!m) throw new TypeParseError(`Expected a type name in "${this.s}"`);
    this.i += m[0].length;
    return m[0];
  }
  args(): TypeRef[] {
    const out: TypeRef[] = [];
    this.expect('<');
    out.push(this.type());
    while (this.peek() === ',') {
      this.i++;
      out.push(this.type());
    }
    this.expect('>');
    return out;
  }
  type(): TypeRef {
    const name = this.ident();
    let t: TypeRef;
    if (name === 'fn') {
      this.expect('(');
      const params: TypeRef[] = [];
      if (this.peek() !== ')') {
        params.push(this.type());
        while (this.peek() === ',') {
          this.i++;
          params.push(this.type());
        }
      }
      this.expect(')');
      this.expect('-');
      this.expect('>');
      t = { kind: 'function', params, returns: this.type() };
    } else if (name === 'array') {
      const a = this.peek() === '<' ? this.args() : [T.any];
      if (a.length !== 1) throw new TypeParseError('array takes one type argument');
      t = { kind: 'array', element: a[0] };
    } else if (name === 'map') {
      const a = this.peek() === '<' ? this.args() : [T.any, T.any];
      if (a.length !== 2) throw new TypeParseError('map takes two type arguments');
      t = { kind: 'map', key: a[0], value: a[1] };
    } else if (PRIMITIVES.has(name)) {
      t = { kind: name as PrimitiveKind };
    } else {
      t = this.peek() === '<' ? { kind: 'named', name, args: this.args() } : { kind: 'named', name };
    }
    if (this.peek() === '?') {
      this.i++;
      t = { ...t, nullable: true };
    }
    return t;
  }
}

export function typeEquals(a: TypeRef, b: TypeRef): boolean {
  return formatType(a) === formatType(b);
}

export function isNumeric(t: TypeRef): boolean {
  return t.kind === 'int' || t.kind === 'float';
}

/** Result of a compatibility check, decided by the language adapter. */
export type Compatibility =
  /** identical or trivially assignable */
  | 'exact'
  /** legal implicit conversion (e.g. int → float) */
  | 'implicit'
  /** legal but lossy, should warn (e.g. float → int in GDScript) */
  | 'narrowing'
  | 'incompatible';

/**
 * Class / named-type knowledge supplied by a language adapter: inheritance and value kinds.
 * The default rules in `defaultCompatibility` use it for subclass checks.
 */
export interface TypeUniverse {
  /** Parent class name, or undefined for roots / unknown types. */
  parentOf(name: string): string | undefined;
  /** Whether a named type is a reference (object) type that can be null. */
  isReferenceType(name: string): boolean;
  /** Whether the name is known at all (built-in or declared). */
  isKnown(name: string): boolean;
}

export function isSubclass(universe: TypeUniverse, child: string, ancestor: string): boolean {
  let cur: string | undefined = child;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = universe.parentOf(cur);
  }
  return false;
}

/**
 * Baseline compatibility rules that most statically-typed languages share. Adapters can call this
 * and then tighten or loosen specific cases.
 */
export function defaultCompatibility(from: TypeRef, to: TypeRef, universe: TypeUniverse): Compatibility {
  if (to.kind === 'any' || from.kind === 'any') return 'exact';
  if (to.kind === 'void' || from.kind === 'void') return 'incompatible';
  if (from.kind === to.kind) {
    switch (from.kind) {
      // Collections are invariant: array<int> is not an array<float>. `any` elements match anything.
      case 'array':
        return defaultCompatibility(from.element, (to as typeof from).element, universe) === 'exact' ? 'exact' : 'incompatible';
      case 'map': {
        const t = to as typeof from;
        return defaultCompatibility(from.key, t.key, universe) === 'exact' && defaultCompatibility(from.value, t.value, universe) === 'exact' ? 'exact' : 'incompatible';
      }
      case 'named': {
        const t = to as typeof from;
        if (from.name === t.name) return 'exact';
        if (isSubclass(universe, from.name, t.name)) return 'implicit';
        return 'incompatible';
      }
      case 'function':
        return typeEquals(from, to) ? 'exact' : 'incompatible';
      default:
        return 'exact';
    }
  }
  if (from.kind === 'int' && to.kind === 'float') return 'implicit';
  if (from.kind === 'float' && to.kind === 'int') return 'narrowing';
  return 'incompatible';
}

/** A colour family for port rendering. UI concern, but language-neutral, so it lives here. */
export function typeColorKey(t: TypeRef): string {
  switch (t.kind) {
    case 'named':
      return /^Vector|^Color$|^Rect|^Transform|^Basis|^Quaternion/.test(t.name) ? 'struct' : 'object';
    default:
      return t.kind;
  }
}
