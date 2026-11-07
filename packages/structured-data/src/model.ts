/**
 * Structured data shared by every visual config editor: a JSON-like value tree, paths into it,
 * and edit operations. Each file format applies the same edits to its own text with as small a
 * change as possible, so comments, key order and unrelated fields survive.
 */
export type Value = string | number | boolean | null | Value[] | { [k: string]: Value };
export type PathSeg = string | number;
export type Path = PathSeg[];
export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export type Edit =
  | { op: 'set'; path: Path; value: Value }
  | { op: 'delete'; path: Path }
  | { op: 'rename'; path: Path; to: string }
  /** Move an array item (or object key) to position `to` among its siblings. */
  | { op: 'move'; path: Path; to: number }
  /** Insert into an array at `index` (default: the end). */
  | { op: 'insert'; path: Path; index?: number; value: Value };

export const typeOf = (v: Value | undefined): ValueType => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : (typeof v as ValueType));

export const isObject = (v: unknown): v is { [k: string]: Value } => !!v && typeof v === 'object' && !Array.isArray(v);

export function getIn(v: Value | undefined, path: Path): Value | undefined {
  let cur: Value | undefined = v;
  for (const s of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof s === 'number') cur = Array.isArray(cur) ? cur[s] : undefined;
    else cur = isObject(cur) ? cur[s] : undefined;
  }
  return cur;
}

const clone = <T extends Value>(v: T): T => (v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Apply edits to a plain value (the reference every format is checked against). */
export function applyToValue(root: Value | undefined, edits: Edit[]): Value {
  let out: Value = clone((root ?? {}) as Value);
  for (const e of edits) out = applyOne(out, e);
  return out;
}

function applyOne(root: Value, e: Edit): Value {
  if (e.op === 'set' && !e.path.length) return clone(e.value);
  const parentPath = e.op === 'insert' ? e.path : e.path.slice(0, -1);
  const last = e.path[e.path.length - 1];
  // Create missing parents for set / insert.
  let parent: Value | undefined = root;
  for (let i = 0; i < parentPath.length; i++) {
    const seg = parentPath[i];
    let next = getIn(parent, [seg]);
    if (next === undefined && (e.op === 'set' || e.op === 'insert')) {
      next = typeof parentPath[i + 1] === 'number' || (i === parentPath.length - 1 && e.op === 'insert') ? [] : {};
      if (Array.isArray(parent) && typeof seg === 'number') parent[seg] = next;
      else if (isObject(parent)) parent[String(seg)] = next;
    }
    if (next === undefined) return root;
    parent = next;
  }
  switch (e.op) {
    case 'set':
      if (Array.isArray(parent) && typeof last === 'number') parent[last] = clone(e.value);
      else if (isObject(parent)) parent[String(last)] = clone(e.value);
      return root;
    case 'insert':
      if (Array.isArray(parent)) parent.splice(e.index ?? parent.length, 0, clone(e.value));
      return root;
    case 'delete':
      if (Array.isArray(parent) && typeof last === 'number') parent.splice(last, 1);
      else if (isObject(parent)) delete parent[String(last)];
      return root;
    case 'rename': {
      if (!isObject(parent) || typeof last !== 'string' || !(last in parent) || e.to === last) return root;
      const entries = Object.entries(parent).map(([k, v]) => [k === last ? e.to : k, v] as const);
      for (const k of Object.keys(parent)) delete parent[k];
      for (const [k, v] of entries) parent[k] = v;
      return root;
    }
    case 'move': {
      if (Array.isArray(parent) && typeof last === 'number') {
        const [item] = parent.splice(last, 1);
        parent.splice(Math.max(0, Math.min(e.to, parent.length)), 0, item);
      } else if (isObject(parent) && typeof last === 'string') {
        const entries = Object.entries(parent);
        const i = entries.findIndex(([k]) => k === last);
        if (i < 0) return root;
        const [item] = entries.splice(i, 1);
        entries.splice(Math.max(0, Math.min(e.to, entries.length)), 0, item);
        for (const k of Object.keys(parent)) delete parent[k];
        for (const [k, v] of entries) parent[k] = v;
      }
      return root;
    }
  }
}

/** A sensible empty value of a type (for "add property" / type changes). */
export function emptyOf(t: ValueType): Value {
  return t === 'string' ? '' : t === 'number' ? 0 : t === 'boolean' ? false : t === 'null' ? null : t === 'array' ? [] : {};
}

/** Convert a value to another type, keeping what can be kept. */
export function convert(v: Value | undefined, t: ValueType): Value {
  const from = typeOf(v);
  if (from === t) return v as Value;
  if (t === 'string') return from === 'null' ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (t === 'number') {
    const n = Number(v);
    return Number.isFinite(n) && typeof v !== 'object' ? n : 0;
  }
  if (t === 'boolean') return v === 'true' || v === 1 || v === true;
  if (t === 'array') return from === 'null' ? [] : [v as Value];
  return emptyOf(t);
}

export const pathKey = (p: Path) => p.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('') || '(root)';
export const samePath = (a: Path, b: Path) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Same value with object keys sorted (for order-insensitive comparison). */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}
