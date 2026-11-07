/**
 * A small JSON-Schema-like description used for forms, validation and suggestions. It is plain
 * data, so schemas for new file kinds are easy to add (see schemas.ts).
 */
import { isObject, typeOf, type Path, type Value, type ValueType } from './model';

export interface Schema {
  type?: ValueType | ValueType[];
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  /** Schema for keys not listed in `properties` (a "map"); false = no other keys allowed. */
  additionalProperties?: Schema | false;
  items?: Schema;
  enum?: Value[];
  /** Labels for enum values. */
  enumLabels?: string[];
  default?: Value;
  examples?: Value[];
  format?: 'color' | 'uri' | 'email' | 'semver' | 'version-range' | 'identifier' | 'path' | 'class-name' | 'java-package';
  pattern?: string;
  patternMessage?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  anyOf?: Schema[];
  /** Forms: show in this section. */
  group?: string;
  placeholder?: string;
  /** Forms: how a map's keys are called (e.g. "Package"). */
  keyTitle?: string;
  /** Forms: suggested keys for a map (e.g. common dependencies). */
  keySuggestions?: { key: string; value?: Value; description?: string }[];
  /** Forms: hide unless the value exists (advanced fields). */
  advanced?: boolean;
}

export interface Issue {
  path: Path;
  message: string;
  severity: 'error' | 'warning';
}

const types = (s: Schema): ValueType[] | undefined => (s.type === undefined ? undefined : Array.isArray(s.type) ? s.type : [s.type]);
const fits = (v: Value, t: ValueType) => typeOf(v) === t || (t === 'number' && typeof v === 'number');

const FORMATS: Record<string, [RegExp, string]> = {
  color: [/^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/i, 'a colour like #ff8800'],
  uri: [/^[a-z][a-z0-9+.-]*:\S+$/i, 'a web address like https://example.com'],
  email: [/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'an email address'],
  semver: [/^\d+\.\d+\.\d+([-+][\w.+-]*)?$/, 'a version like 1.0.0'],
  identifier: [/^[a-z][a-z0-9_-]{1,63}$/, 'lower-case letters, digits, - or _ (starting with a letter)'],
  'class-name': [/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(::\w+)?$/, 'a class name like com.example.MyMod'],
  'java-package': [/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/, 'a package like com.example.mymod'],
};

export function validate(value: Value | undefined, schema: Schema | undefined, path: Path = []): Issue[] {
  if (!schema || value === undefined) return [];
  const out: Issue[] = [];
  const err = (message: string, p: Path = path, severity: Issue['severity'] = 'error') => out.push({ path: p, message, severity });
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => !validate(value, s, path).some((i) => i.severity === 'error'));
    if (!ok) {
      const best = schema.anyOf.find((s) => !types(s) || types(s)!.some((t) => fits(value, t)));
      return best ? validate(value, best, path) : [{ path, message: `Should be ${schema.anyOf.map((s) => describeType(s)).join(' or ')}`, severity: 'error' }];
    }
    return [];
  }
  const ts = types(schema);
  if (ts && !ts.some((t) => fits(value, t))) {
    err(`Should be ${ts.map(article).join(' or ')}, not ${article(typeOf(value))}`);
    return out;
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err(`Should be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) err(schema.patternMessage ?? `Doesn't match the expected pattern`);
    const f = schema.format && FORMATS[schema.format];
    if (f && value && !f[0].test(value)) err(`Should be ${f[1]}`, path, 'warning');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`Should be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`Should be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) err(`Needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    if (schema.items) value.forEach((v, i) => out.push(...validate(v, schema.items, [...path, i])));
  }
  if (isObject(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) err(`${schema.properties?.[r]?.title ?? r} is required`, [...path, r]);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k] ?? (schema.additionalProperties === false ? undefined : schema.additionalProperties);
      if (!sub && schema.additionalProperties === false) err(`Unknown field "${k}"`, [...path, k], 'warning');
      out.push(...validate(v, sub, [...path, k]));
    }
  }
  return out;
}

const article = (t: string) => (t === 'object' ? 'an object' : t === 'array' ? 'a list' : t === 'null' ? 'empty (null)' : t === 'string' ? 'text' : `a ${t === 'boolean' ? 'yes/no value' : t}`);
export const describeType = (s: Schema) => (types(s) ?? ['anything']).map(article).join(' or ');

/** The schema that applies at `path` inside `schema` (following properties, items, maps, anyOf). */
export function schemaAt(schema: Schema | undefined, path: Path, value?: Value): Schema | undefined {
  let s = schema;
  for (const seg of path) {
    if (!s) return undefined;
    s = pick(s, value);
    if (typeof seg === 'number') s = s?.items;
    else s = s?.properties?.[seg] ?? (s?.additionalProperties || undefined);
    value = value === undefined ? undefined : isObject(value) ? value[String(seg)] : Array.isArray(value) ? value[seg as number] : undefined;
  }
  return s && pick(s, value);
}

/** For anyOf: the variant that fits the value (or the first object/array one). */
export function pick(s: Schema, value?: Value): Schema {
  if (!s.anyOf) return s;
  const t = value === undefined ? undefined : typeOf(value);
  return s.anyOf.find((x) => t && types(x)?.includes(t)) ?? s.anyOf[0];
}

/** Keys the schema suggests at an object (not yet present). */
export function suggestKeys(schema: Schema | undefined, value: Value | undefined): { key: string; schema?: Schema; description?: string; value?: Value }[] {
  if (!schema) return [];
  const have = isObject(value) ? value : {};
  const props = Object.entries(schema.properties ?? {}).filter(([k]) => !(k in have)).map(([key, s]) => ({ key, schema: s, description: s.description }));
  const extra = (schema.keySuggestions ?? []).filter((k) => !(k.key in have));
  return [...props, ...extra];
}

/** A starting value for a schema (default, first enum, or empty of its type). */
export function initialValue(s: Schema | undefined): Value {
  if (!s) return '';
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  const t = types(pick(s))?.[0];
  if (t === 'object') {
    const o: Record<string, Value> = {};
    for (const r of s.required ?? []) o[r] = initialValue(s.properties?.[r]);
    return o;
  }
  return t === 'number' ? 0 : t === 'boolean' ? false : t === 'array' ? [] : t === 'null' ? null : '';
}
