import { describe, expect, it } from 'vitest';
import { scanExports } from '@cs/language-typescript';

describe('scanning exported functions', () => {
  it('finds functions and arrow consts with params, return types and async', () => {
    const src = `
import x from 'y';
/** Formats a date. */
export function formatDate(d: Date, withTime?: boolean): string { return '' }
export async function loadTodos(db: Dexie, limit = 10): Promise<Todo[]> { return [] }
export const add = (a: number, b: number): number => a + b;
export const greet = async (name: string) => \`hi \${name}\`;
export function identity<T extends { a: (x: number) => void }>(value: T): T { return value }
// export function commented(): void {}
/* export function alsoCommented() {} */
function notExported() {}
export default function main() {}
`;
    const r = scanExports(src);
    expect(r.map((f) => f.name)).toEqual(['formatDate', 'loadTodos', 'add', 'greet', 'identity', 'main']);
    expect(r[0]).toEqual({ name: 'formatDate', params: [{ name: 'd', type: 'Date' }, { name: 'withTime', type: 'bool', optional: true }], returnType: 'string', async: false });
    expect(r[1]).toMatchObject({ async: true, returnType: 'array<Todo>', params: [{ name: 'db', type: 'Dexie' }, { name: 'limit', type: 'any', optional: true }] });
    expect(r[2]).toMatchObject({ params: [{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }], returnType: 'float' });
    expect(r[3]).toMatchObject({ async: true, params: [{ name: 'name', type: 'string' }] });
    expect(r[4].params[0].name).toBe('value');
  });
});
