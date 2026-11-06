import { describe, expect, it } from 'vitest';
import { formatType, parseType, defaultCompatibility, TypeParseError } from '@cs/type-system';
import { EXIT, findCycles, immediatePostDominators, topoSort, stableStringify } from '@cs/graph-core';
import { gdscriptAdapter } from '@cs/language-gdscript';

describe('type system', () => {
  it('parses and formats canonical types', () => {
    for (const s of ['int', 'array<float>', 'map<string, array<int>>', 'Vector2', 'Node2D?', 'fn(int, string) -> bool']) expect(formatType(parseType(s))).toBe(s);
    expect(() => parseType('array<')).toThrow(TypeParseError);
    expect(() => parseType('int int')).toThrow(TypeParseError);
  });
  it('GDScript aliases normalise to canonical form', () => {
    const n = gdscriptAdapter.types.normalize!;
    expect(n('String')).toBe('string');
    expect(n('Array[int]')).toBe('array<int>');
    expect(n('Dictionary[String, Array[float]]')).toBe('map<string, array<float>>');
    expect(n('Variant')).toBe('any');
  });
  it('compatibility rules', () => {
    const u = gdscriptAdapter.types.universe;
    const c = (a: string, b: string) => gdscriptAdapter.types.compatibility(parseType(a), parseType(b));
    expect(c('int', 'float')).toBe('implicit');
    expect(c('float', 'int')).toBe('narrowing');
    expect(c('string', 'bool')).toBe('incompatible');
    expect(c('CharacterBody2D', 'Node')).toBe('implicit');
    expect(c('Node', 'CharacterBody2D')).toBe('incompatible');
    expect(c('array<int>', 'array<float>')).toBe('incompatible');
    expect(c('array<int>', 'array<any>')).toBe('exact');
    expect(c('string', 'StringName')).toBe('implicit');
    expect(defaultCompatibility(parseType('any'), parseType('Vector2'), u)).toBe('exact');
  });
  it('GDScript operator typing', () => {
    const r = (op: string, a: string, b: string) => {
      const t = gdscriptAdapter.types.operatorResult(op as never, parseType(a), parseType(b));
      return t && formatType(t);
    };
    expect(r('+', 'int', 'int')).toBe('int');
    expect(r('*', 'int', 'float')).toBe('float');
    expect(r('*', 'Vector2', 'float')).toBe('Vector2');
    expect(r('*', 'Basis', 'Vector3')).toBe('Vector3');
    expect(r('%', 'float', 'float')).toBeUndefined();
    expect(r('+', 'string', 'int')).toBeUndefined();
    expect(r('<', 'string', 'string')).toBe('bool');
  });
});

describe('graph algorithms', () => {
  const g: Record<string, string[]> = { a: ['b', 'c'], b: ['d'], c: ['d'], d: ['e'], e: [] };
  const succ = (n: string) => g[n] ?? [];
  it('immediate post-dominators find branch merges', () => {
    const ip = immediatePostDominators(Object.keys(g), succ);
    expect(ip.get('a')).toBe('d');
    expect(ip.get('b')).toBe('d');
    expect(ip.get('e')).toBe(EXIT);
  });
  it('no merge when one side exits', () => {
    const h: Record<string, string[]> = { a: ['b', EXIT], b: ['c'], c: [] };
    const ip = immediatePostDominators(['a', 'b', 'c'], (n) => h[n] ?? []);
    expect(ip.get('a')).toBe(EXIT);
  });
  it('cycle detection and topological order', () => {
    expect(findCycles(Object.keys(g), succ)).toEqual([]);
    const cyc: Record<string, string[]> = { a: ['b'], b: ['c'], c: ['a'], d: ['d'] };
    expect(findCycles(Object.keys(cyc), (n) => cyc[n]).length).toBe(2);
    expect(topoSort(Object.keys(g), succ)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(topoSort(Object.keys(cyc), (n) => cyc[n])).toBeNull();
  });
  it('stable stringify ignores key order', () => {
    expect(stableStringify({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(stableStringify({ a: [1, { x: 1, y: 2 }], b: 1 }));
  });
});
