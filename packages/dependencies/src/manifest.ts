/** package.json reading and editing (formatting: 2-space JSON, dependencies kept sorted, like npm). */
export interface Manifest {
  name?: string;
  version?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  scripts: Record<string, string>;
  raw: Record<string, unknown>;
}

export class ManifestError extends Error {
  readonly code = 'E_INVALID_MANIFEST';
}

const rec = (v: unknown): Record<string, string> => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {});

export function parseManifest(text: string | undefined): Manifest {
  let raw: Record<string, unknown>;
  try {
    raw = text?.trim() ? JSON.parse(text) : {};
  } catch (e) {
    throw new ManifestError(`package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManifestError('package.json must contain an object');
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    dependencies: rec(raw.dependencies),
    devDependencies: rec(raw.devDependencies),
    peerDependencies: rec(raw.peerDependencies),
    scripts: rec(raw.scripts),
    raw,
  };
}

/** Valid npm package name (scoped or not). */
export const isPackageName = (n: string) => /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(n) && n.length <= 214;

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Add or change a dependency. A package moves between dependencies and devDependencies. */
export function setDependency(text: string | undefined, name: string, range: string, dev = false, defaults: { name?: string } = {}): string {
  if (!isPackageName(name)) throw new ManifestError(`"${name}" is not a valid package name`);
  if (!range.trim()) throw new ManifestError('A version range is required');
  const m = parseManifest(text);
  const raw: Record<string, unknown> = text?.trim() ? { ...m.raw } : { name: defaults.name ?? 'app', version: '0.1.0', private: true, type: 'module' };
  const deps = { ...rec(raw.dependencies) };
  const devDeps = { ...rec(raw.devDependencies) };
  delete deps[name];
  delete devDeps[name];
  (dev ? devDeps : deps)[name] = range.trim();
  if (Object.keys(deps).length) raw.dependencies = sorted(deps);
  else delete raw.dependencies;
  if (Object.keys(devDeps).length) raw.devDependencies = sorted(devDeps);
  else delete raw.devDependencies;
  return JSON.stringify(raw, null, 2) + '\n';
}

export function removeDependency(text: string | undefined, name: string): string {
  const m = parseManifest(text);
  const raw: Record<string, unknown> = { ...m.raw };
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const d = { ...rec(raw[k]) };
    if (!(name in d)) continue;
    delete d[name];
    if (Object.keys(d).length) raw[k] = d;
    else delete raw[k];
  }
  return JSON.stringify(raw, null, 2) + '\n';
}

/** Compare plain versions (1.2.3, 1.2.3-beta.1). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((x) => parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** "@types/foo" for "foo", "@types/scope__pkg" for "@scope/pkg". */
export const typesPackageFor = (name: string) => (name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`);

/**
 * Does the lockfile still match package.json? Only package-lock.json is compared precisely;
 * for yarn/pnpm lockfiles any dependency missing from the lockfile counts as out of date.
 */
export function lockfileStatus(manifestText: string | undefined, lock: { path: string; text?: string } | undefined): 'none' | 'in-sync' | 'out-of-date' {
  if (!lock) return 'none';
  let m: Manifest;
  try {
    m = parseManifest(manifestText);
  } catch {
    return 'out-of-date';
  }
  const want = { ...m.dependencies, ...m.devDependencies };
  if (lock.path.endsWith('package-lock.json')) {
    try {
      const root = (JSON.parse(lock.text ?? '{}') as { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> }).packages?.[''] ?? {};
      const have = { ...root.dependencies, ...root.devDependencies };
      const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
      for (const k of keys) if (want[k] !== have[k]) return 'out-of-date';
      return 'in-sync';
    } catch {
      return 'out-of-date';
    }
  }
  const text = lock.text ?? '';
  return Object.keys(want).every((k) => text.includes(k)) ? 'in-sync' : 'out-of-date';
}
