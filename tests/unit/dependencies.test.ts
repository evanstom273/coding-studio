import { describe, expect, it } from 'vitest';
import { acquireTypes, compareVersions, importedPackages, parseManifest, removeDependency, searchPackages, setDependency, typesPackageFor } from '@cs/dependencies';

/** A tiny fake of the npm registry + jsDelivr. */
function fakeNet() {
  const pkgs: Record<string, { versions: string[]; json: Record<string, unknown>; files: Record<string, string> }> = {
    dexie: { versions: ['3.2.0', '4.0.11'], json: { name: 'dexie', version: '4.0.11', types: 'dist/dexie.d.ts' }, files: { '/dist/dexie.d.ts': "export declare class Dexie { constructor(name: string) }\nexport default Dexie;\n", '/dist/dexie.js': 'x' } },
    react: { versions: ['19.1.0'], json: { name: 'react', version: '19.1.0' }, files: { '/index.js': 'x' } },
    '@types/react': { versions: ['18.3.0', '19.1.2'], json: { name: '@types/react', version: '19.1.2', dependencies: { csstype: '^3.0.2' } }, files: { '/index.d.ts': "import * as CSS from 'csstype';\nexport function useState<S>(s: S): [S, (s: S) => void];\n", '/ts5.0/index.d.ts': '// old', '/global.d.ts': 'interface X {}' } },
    csstype: { versions: ['3.1.3'], json: { name: 'csstype', version: '3.1.3', types: 'index.d.ts' }, files: { '/index.d.ts': 'export type Property = string;' } },
    untyped: { versions: ['1.0.0'], json: { name: 'untyped', version: '1.0.0' }, files: { '/index.js': 'x' } },
  };
  const calls: string[] = [];
  const resolve = (name: string, range: string) => {
    const p = pkgs[name];
    if (!p) return undefined;
    if (range === 'latest') return p.versions[p.versions.length - 1];
    const major = range.replace(/^[\^~]/, '').split('.')[0];
    return [...p.versions].reverse().find((v) => v === range || v.startsWith(`${major}.`));
  };
  const fetchJson = async (url: string) => {
    calls.push(url);
    let m = /resolve\/npm\/(.+)@([^@]+)$/.exec(url);
    if (m) return { version: resolve(m[1], decodeURIComponent(m[2])) ?? null };
    m = /package\/npm\/(.+)@([^@/]+)\/flat$/.exec(url);
    if (m) return { files: Object.entries(pkgs[m[1]].files).map(([name, c]) => ({ name, size: c.length })) };
    if (url.includes('/-/v1/search')) return { objects: [{ package: { name: 'dexie', version: '4.0.11', description: 'IndexedDB' }, downloads: { weekly: 9 } }] };
    throw new Error(`unexpected ${url}`);
  };
  const fetchText = async (url: string) => {
    calls.push(url);
    const m = /npm\/(.+)@([^@/]+)(\/.*)$/.exec(url)!;
    const p = pkgs[m[1]];
    if (m[3] === '/package.json') return JSON.stringify({ ...p.json, version: m[2] });
    return p.files[m[3]];
  };
  return { fetchJson, fetchText, calls };
}

describe('package.json', () => {
  it('adds, moves and removes dependencies, keeping them sorted', () => {
    let t = setDependency(undefined, 'react', '^19.1.0', false, { name: 'my-app' });
    expect(parseManifest(t)).toMatchObject({ name: 'my-app', dependencies: { react: '^19.1.0' } });
    t = setDependency(t, 'dexie', '^4.0.11');
    expect(Object.keys(parseManifest(t).dependencies)).toEqual(['dexie', 'react']);
    t = setDependency(t, 'dexie', '^4.0.11', true);
    expect(parseManifest(t)).toMatchObject({ dependencies: { react: '^19.1.0' }, devDependencies: { dexie: '^4.0.11' } });
    t = removeDependency(t, 'dexie');
    expect(parseManifest(t).devDependencies).toEqual({});
    expect(t).not.toContain('devDependencies');
    expect(() => setDependency(t, 'Bad Name', '1')).toThrow(/not a valid package name/);
    expect(() => parseManifest('{nope')).toThrow(/not valid JSON/);
  });
  it('versions and names', () => {
    expect(compareVersions('4.10.0', '4.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(typesPackageFor('@scope/pkg')).toBe('@types/scope__pkg');
    expect(importedPackages("import x from 'a';\nexport * from '@s/b/deep';\nimport('./local');\n/// <reference types=\"node\" />")).toEqual(['a', '@s/b', 'node']);
  });
});

describe('type acquisition', () => {
  it('bundled types, @types fallback with its dependencies, and packages without types', async () => {
    const net = fakeNet();
    const dexie = await acquireTypes(net.fetchJson, net.fetchText, 'dexie', '^4');
    expect(dexie[0]).toMatchObject({ name: 'dexie', version: '4.0.11', source: 'bundled' });
    expect(dexie[0].files.map((f) => f.path)).toEqual(['node_modules/dexie/package.json', 'node_modules/dexie/dist/dexie.d.ts']);

    const react = await acquireTypes(net.fetchJson, net.fetchText, 'react', '^19.1.0');
    expect(react.map((r) => [r.name, r.source, r.typesPackage])).toEqual([
      ['react', 'definitelytyped', '@types/react'],
      ['csstype', 'bundled', undefined],
    ]);
    expect(react[0].files.map((f) => f.path)).toEqual(['node_modules/react/package.json', 'node_modules/react/index.d.ts', 'node_modules/react/global.d.ts']);
    expect(react[0].dependencies).toEqual(['csstype']);

    const none = await acquireTypes(net.fetchJson, net.fetchText, 'untyped', '1.0.0');
    expect(none[0].source).toBe('none');
    expect((await searchPackages(net.fetchJson, 'dex'))[0]).toMatchObject({ name: 'dexie', weeklyDownloads: 9 });
  });

  it.skipIf(!process.env.LIVE_NET)('live: real dexie and react types from jsDelivr', async () => {
    const fetchJson = async (u: string) => (await fetch(u)).json();
    const fetchText = async (u: string) => (await fetch(u)).text();
    const r = await acquireTypes(fetchJson, fetchText, 'react', '^19');
    expect(r[0].source).toBe('definitelytyped');
    expect(r.some((x) => x.name === 'csstype')).toBe(true);
    const d = await acquireTypes(fetchJson, fetchText, 'dexie', '^4');
    expect(d[0].files.some((f) => /\.d\.ts$/.test(f.path) && f.content.includes('Dexie'))).toBe(true);
  }, 60_000);
});
