/** npm dependency tools (deps_list / deps_search / deps_add / deps_remove), shared by both hosts. */
import { lockfileStatus, parseManifest, removeDependency, resolveVersion, searchPackages, setDependency, type FetchJson } from '@cs/dependencies';
import { ServiceError, str } from './index';

type Files = { get(path: string): { text?: string; path: string } | undefined };

export async function depsCall(method: string, files: Files, params: Record<string, unknown>, fetchJson: FetchJson, projectName: string): Promise<{ result: unknown; write?: { path: string; content: string; label: string } }> {
  const manifest = files.get('package.json')?.text;
  const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map((p) => files.get(p)).find(Boolean);
  switch (method) {
    case 'deps_list': {
      const m = parseManifest(manifest);
      return { result: { dependencies: m.dependencies, devDependencies: m.devDependencies, scripts: m.scripts, lockfile: lock ? { path: lock.path, status: lockfileStatus(manifest, lock) } : null, ...(manifest ? {} : { note: 'No package.json yet: deps_add creates one.' }) } };
    }
    case 'deps_search':
      return { result: await searchPackages(fetchJson, String(params.query ?? ''), Math.min(Number(params.limit) || 10, 30)) };
    case 'deps_add': {
      const name = str(params.name);
      if (!name) throw new ServiceError('E_INVALID', 'name is required');
      const range = str(params.version) ? (/^\d/.test(str(params.version)!) ? `^${str(params.version)}` : str(params.version)!) : undefined;
      const exact = await resolveVersion(fetchJson, name, range ?? 'latest');
      if (!exact) throw new ServiceError('E_NOT_FOUND', `No version of "${name}" matches ${range ?? 'latest'} on npm.`);
      const content = setDependency(manifest, name, range ?? `^${exact}`, params.dev === true, { name: projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app' });
      return { result: { added: name, range: range ?? `^${exact}`, resolves_to: exact, dev: params.dev === true, note: 'package.json updated; the editor loads its types. Installing happens on a computer or in CI (npm install).' }, write: { path: 'package.json', content, label: `Claude: add ${name}` } };
    }
    case 'deps_remove': {
      const name = str(params.name);
      if (!name) throw new ServiceError('E_INVALID', 'name is required');
      const m = parseManifest(manifest);
      if (!(name in { ...m.dependencies, ...m.devDependencies, ...m.peerDependencies })) throw new ServiceError('E_NOT_FOUND', `"${name}" is not a dependency.`);
      return { result: { removed: name }, write: { path: 'package.json', content: removeDependency(manifest, name), label: `Claude: remove ${name}` } };
    }
  }
  throw new ServiceError('E_INVALID', `Unknown call ${method}`);
}
