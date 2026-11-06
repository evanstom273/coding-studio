import { describe, expect, it } from 'vitest';
import { canonicalFromTs, parseDisplay } from '@cs/language-typescript';

describe('library signatures from the TypeScript service', () => {
  it('maps TS types to node port types (or any)', () => {
    expect(canonicalFromTs('string')).toBe('string');
    expect(canonicalFromTs('number | undefined')).toBe('float?');
    expect(canonicalFromTs('string[]')).toBe('array<string>');
    expect(canonicalFromTs('Array<number>')).toBe('array<float>');
    expect(canonicalFromTs('Record<string, boolean>')).toBe('map<string, bool>');
    expect(canonicalFromTs('(value: string) => void')).toBe('fn(string) -> void');
    expect(canonicalFromTs('Date')).toBe('Date');
    expect(canonicalFromTs('Table<T, TKey>')).toBe('any');
    expect(canonicalFromTs('T', new Set(['T']))).toBe('any');
    expect(canonicalFromTs("'a' | 'b'")).toBe('any');
    expect(canonicalFromTs("'a'")).toBe('string');
  });

  it('parses functions, aliases, overloads, consts, methods and classes', () => {
    expect(parseDisplay('function format(date: Date | number | string, formatStr: string, options?: FormatOptions): string')).toMatchObject({
      kind: 'function',
      name: 'format',
      params: [{ name: 'date', type: 'any' }, { name: 'formatStr', type: 'string' }, { name: 'options', optional: true, type: 'any' }],
      returnType: 'string',
      async: false,
    });
    expect(parseDisplay('(alias) function addDays<DateType extends Date>(date: DateType | number, amount: number): DateType (+1 overload)\nimport addDays')).toMatchObject({ name: 'addDays', params: [{ type: 'any' }, { type: 'float' }], returnType: 'any', overloads: 1 });
    expect(parseDisplay('const liveQuery: <T>(querier: () => T | Promise<T>) => Observable<T>')).toMatchObject({ kind: 'function', name: 'liveQuery', params: [{ name: 'querier' }] });
    expect(parseDisplay('(method) Dexie.table<T = any, TKey = any>(tableName: string): Table<T, TKey>')).toMatchObject({ kind: 'function', name: 'table', params: [{ name: 'tableName', type: 'string' }], returnType: 'any' });
    expect(parseDisplay('(method) Table<T, TKey>.get(key: TKey): PromiseExtended<T | undefined> (+1 overload)')).toMatchObject({ name: 'get', async: true, overloads: 1 });
    expect(parseDisplay('(method) Response.json(): Promise<any>')).toMatchObject({ name: 'json', async: true, returnType: 'any' });
    expect(parseDisplay('class Dexie')).toEqual({ kind: 'class', name: 'Dexie' });
    expect(parseDisplay('(alias) class Dexie\nimport Dexie')).toEqual({ kind: 'class', name: 'Dexie' });
    expect(parseDisplay('(property) Dexie.name: string')).toEqual({ kind: 'value', name: 'name', type: 'string' });
    expect(parseDisplay('interface Foo')).toBeUndefined();
    expect(parseDisplay('interface Dexie\nnamespace Dexie\nvar Dexie: DexieConstructor')).toEqual({ kind: 'value', name: 'Dexie', type: 'any' });
    expect(parseDisplay('(alias) interface Dexie\n(alias) namespace Dexie\n(alias) var Dexie: DexieConstructor\nexport default')).toMatchObject({ kind: 'value', name: 'Dexie' });
  });
});
