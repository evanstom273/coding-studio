/**
 * Automatic type acquisition: the `.d.ts` files of a package (or of its `@types/…` package) and
 * of the packages those types import, downloaded from jsDelivr. The editor feeds them to the
 * TypeScript service as `node_modules/<name>/…`, so imports and completions work without
 * installing anything.
 */
import { typesPackageFor } from './manifest';
import { JSDELIVR_CDN, JSDELIVR_DATA, resolveVersion, type FetchJson, type FetchText } from './registry';

export interface TypeFile {
  /** e.g. "node_modules/dexie/dist/dexie.d.ts" */
  path: string;
  content: string;
}

export interface AcquiredTypes {
  name: string;
  version: string;
  /** Where the types came from: the package itself, @types, or nowhere. */
  source: 'bundled' | 'definitelytyped' | 'none';
  typesPackage?: string;
  files: TypeFile[];
  /** Other packages pulled in because these types import them. */
  dependencies: string[];
}

export interface AcquireOptions {
  maxFiles?: number;
  maxBytes?: number;
  /** Packages already acquired (by name), to avoid repeats across calls. */
  seen?: Set<string>;
  depth?: number;
}

const DTS = /\.d\.(ts|mts|cts)$/;

/** "@types/react" → "react", "@types/scope__pkg" → "@scope/pkg"; other names unchanged. */
export function untyped(name: string): string {
  if (!name.startsWith('@types/')) return name;
  const n = name.slice('@types/'.length);
  return n.includes('__') ? `@${n.replace('__', '/')}` : n;
}

interface PkgJson {
  name: string;
  version: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function hasTypesField(p: PkgJson): boolean {
  if (p.types || p.typings) return true;
  const walk = (x: unknown): boolean => (typeof x === 'string' ? DTS.test(x) : !!x && typeof x === 'object' && Object.entries(x as Record<string, unknown>).some(([k, v]) => k === 'types' || walk(v)));
  return walk(p.exports);
}

/** Bare module specifiers imported or referenced by a declaration file. */
export function importedPackages(dts: string): string[] {
  const out = new Set<string>();
  const add = (spec: string) => {
    if (spec.startsWith('.') || spec.startsWith('/')) return;
    const parts = spec.split('/');
    out.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  };
  for (const m of dts.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) add(m[1]);
  for (const m of dts.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  for (const m of dts.matchAll(/\/\/\/\s*<reference\s+types=['"]([^'"]+)['"]/g)) add(m[1]);
  for (const m of dts.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) add(m[1]);
  return [...out];
}

/**
 * `installAs`: the folder the files go in. DefinitelyTyped packages are installed under the name of
 * the package they describe (node_modules/react, not node_modules/@types/react): the editor's
 * TypeScript service resolves `import … from 'react'` there, and it never holds two copies.
 */
async function filesOf(fetchJson: FetchJson, fetchText: FetchText, name: string, version: string, opts: Required<Pick<AcquireOptions, 'maxFiles' | 'maxBytes'>>, installAs = name): Promise<TypeFile[]> {
  const flat = (await fetchJson(`${JSDELIVR_DATA}/package/npm/${name}@${version}/flat`)) as { files: { name: string; size: number }[] };
  const dts = flat.files.filter((f) => DTS.test(f.name) && !/\/(test|tests|__tests__|ts\d\.\d+)\//.test(f.name)).sort((a, b) => a.name.length - b.name.length);
  const picked: typeof dts = [];
  let bytes = 0;
  for (const f of dts) {
    if (picked.length >= opts.maxFiles || bytes + f.size > opts.maxBytes) break;
    picked.push(f);
    bytes += f.size;
  }
  const out: TypeFile[] = [{ path: `node_modules/${installAs}/package.json`, content: await fetchText(`${JSDELIVR_CDN}/${name}@${version}/package.json`) }];
  const results = await Promise.all(picked.map(async (f) => ({ path: `node_modules/${installAs}${f.name}`, content: await fetchText(`${JSDELIVR_CDN}/${name}@${version}${f.name}`) })));
  return [...out, ...results];
}

/**
 * Types for `name@range` (range may be exact, a semver range or a tag), plus the packages its
 * types import (recursively, up to `depth`).
 */
export async function acquireTypes(fetchJson: FetchJson, fetchText: FetchText, name: string, range: string, options: AcquireOptions = {}): Promise<AcquiredTypes[]> {
  const opts = { maxFiles: options.maxFiles ?? 400, maxBytes: options.maxBytes ?? 8 * 1024 * 1024 };
  const seen = options.seen ?? new Set<string>();
  const depth = options.depth ?? 3;
  if (seen.has(name)) return [];
  seen.add(name);
  const version = (await resolveVersion(fetchJson, name, range)) ?? (await resolveVersion(fetchJson, name, 'latest'));
  if (!version) return [{ name, version: range, source: 'none', files: [], dependencies: [] }];
  const pkg = JSON.parse(await fetchText(`${JSDELIVR_CDN}/${name}@${version}/package.json`)) as PkgJson;
  let result: AcquiredTypes;
  let files: TypeFile[];
  if (hasTypesField(pkg) || name.startsWith('@types/')) {
    files = await filesOf(fetchJson, fetchText, name, version, opts, untyped(name));
    result = { name, version, source: 'bundled', files, dependencies: [] };
  } else {
    const tp = typesPackageFor(name);
    const major = version.split('.')[0];
    const tv = (await resolveVersion(fetchJson, tp, `^${major}`)) ?? (await resolveVersion(fetchJson, tp, 'latest'));
    if (tv) {
      files = await filesOf(fetchJson, fetchText, tp, tv, opts, name);
      result = { name, version, source: 'definitelytyped', typesPackage: tp, files, dependencies: [] };
      seen.add(tp);
    } else {
      // No declarations anywhere: some packages still ship a root index.d.ts without saying so.
      const loose = await filesOf(fetchJson, fetchText, name, version, opts).catch(() => []);
      files = loose.filter((f) => DTS.test(f.path)).length ? loose : [];
      result = { name, version, source: files.length ? 'bundled' : 'none', files, dependencies: [] };
    }
  }
  if (depth <= 0) return [result];
  // Packages the declarations import (e.g. @types/react → csstype).
  const wanted = new Set<string>();
  for (const f of files) if (DTS.test(f.path)) importedPackages(f.content).forEach((p) => wanted.add(p));
  wanted.delete(name);
  if (result.typesPackage) wanted.delete(result.typesPackage);
  const more: AcquiredTypes[] = [];
  for (const dep of wanted) {
    if (seen.has(dep) || /^(node:|bun:)/.test(dep)) continue;
    const range = pkg.dependencies?.[dep] ?? pkg.peerDependencies?.[dep] ?? 'latest';
    try {
      more.push(...(await acquireTypes(fetchJson, fetchText, dep, range, { ...opts, seen, depth: depth - 1 })));
    } catch {
      /* an optional dependency's types failing to load shouldn't sink the main package */
    }
  }
  result.dependencies = more.map((m) => m.name);
  return [result, ...more];
}
