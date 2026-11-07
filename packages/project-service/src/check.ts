/**
 * check_project: every problem in a project at once, so the person or AI fixing it can fix all of
 * them before saying it's done (instead of one failed deploy at a time). Runs everywhere (editor
 * and cloud); the editor adds TypeScript's own type check, which is what `npm run build` runs.
 */
import type { Project } from '@cs/project-format';
import { formatFor, parseData, schemaFor, validate } from '@cs/structured-data';
import { parseManifest, lockfileStatus } from '@cs/dependencies';
import { isStaticVite, WORKFLOW_DIR, WRANGLER_CONFIGS } from '@cs/git';
import type { FileRecord } from '@cs/workspace';
import { compileAll } from './index';

export interface Problem {
  severity: 'error' | 'warning';
  area: 'graph' | 'types' | 'config' | 'packages' | 'deploy' | 'build';
  /** Where: "src/App › App (node n_123)", "package.json › dependencies", "src/db.ts:12". */
  where: string;
  message: string;
  fix?: string;
  nodeId?: string;
  path?: string;
}

export interface TypeProblem {
  path: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  where?: string;
}

const BUILTINS = new Set(['react/jsx-runtime', 'node:fs', 'node:path', 'fs', 'path', 'crypto', 'node:crypto', 'url', 'node:url', 'os', 'node:os', 'child_process', 'node:child_process', 'events', 'node:events', 'util', 'node:util', 'stream', 'node:stream', 'http', 'https', 'buffer', 'node:buffer', 'process', 'node:process']);

/** Bare package name of an import specifier ("@scope/pkg/sub" → "@scope/pkg"). */
const pkgOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

function imports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    const s = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (s && !s.startsWith('.') && !s.startsWith('/') && !/^[a-z]+:\/\//.test(s)) out.add(s);
  }
  return [...out];
}

export function checkProject(p: Project | undefined, files: ReadonlyMap<string, FileRecord>, types?: { problems: TypeProblem[] } | { unavailable: string }) {
  const problems: Problem[] = [];
  // 1. graphs: the compiler's own diagnostics (unknown nodes, missing wires, type mismatches…)
  const compiled = p && p.scripts.length ? compileAll(p) : undefined;
  if (p && compiled) {
    for (const d of compiled.diagnostics) {
      const sc = p.scripts.find((s) => s.id === d.scriptId);
      const fn = sc?.functions.find((f) => f.id === d.functionId);
      problems.push({ severity: d.severity === 'error' ? 'error' : 'warning', area: 'graph', where: [sc?.path ?? sc?.name, fn?.name].filter(Boolean).join(' › ') + (d.nodeId ? ` (node ${d.nodeId})` : ''), message: d.message, ...(d.suggestion ? { fix: d.suggestion } : {}), ...(d.nodeId ? { nodeId: d.nodeId } : {}) });
    }
  }
  // 2. config files: can they be read, and do they match their schema?
  for (const f of files.values()) {
    if (f.path.startsWith('.codingstudio/') || f.kind !== 'text') continue;
    const fmt = formatFor(f.path);
    if (!fmt || f.path.endsWith('-lock.json')) continue;
    const parsed = parseData(fmt, f.text ?? '');
    if (parsed.errors.length) {
      for (const e of parsed.errors.slice(0, 3)) problems.push({ severity: 'error', area: 'config', where: `${f.path}:${e.line}`, path: f.path, message: `Can't be read: ${e.message}` });
      continue;
    }
    for (const i of validate(parsed.value, schemaFor(f.path))) problems.push({ severity: i.severity, area: 'config', where: `${f.path} › ${i.path.join('.') || '(top)'}`, path: f.path, message: i.message, fix: 'Change it in the file\'s Form view (or edit_config).' });
  }
  // 3. packages: everything the code imports must be listed in package.json, or the build can't find it
  const pkgText = files.get('package.json')?.text;
  const manifest = parseManifest(pkgText);
  const declared = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]);
  const sources: { path: string; text: string }[] = [...[...files.values()].filter((f) => f.kind === 'text' && /\.(m?[jt]sx?|cjs|cts)$/.test(f.path) && !f.path.startsWith('node_modules/')).map((f) => ({ path: f.path, text: f.text ?? '' })), ...(compiled?.files ?? []).filter((f) => /\.[jt]sx?$/.test(f.path)).map((f) => ({ path: f.path, text: f.content }))];
  if (pkgText !== undefined || sources.some((s) => imports(s.text).length)) {
    const missing = new Map<string, string[]>();
    for (const s of sources)
      for (const spec of imports(s.text)) {
        const name = pkgOf(spec);
        if (BUILTINS.has(spec) || BUILTINS.has(name) || declared.has(name)) continue;
        if (name === 'react' && /jsx/.test(spec)) continue;
        missing.set(name, [...(missing.get(name) ?? []), s.path]);
      }
    for (const [name, where] of missing) problems.push({ severity: 'error', area: 'packages', where: where.slice(0, 3).join(', '), message: `Imports "${name}", but package.json doesn't list it, so the build can't find it.`, fix: `Add it: deps_add {"name":"${name}"} (or the Packages tab).` });
    const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map((x) => files.get(x)).find(Boolean);
    if (lock && lockfileStatus(pkgText, { path: lock.path, text: lock.text }) === 'out-of-date') problems.push({ severity: 'error', area: 'packages', where: lock.path, path: lock.path, message: `${lock.path} doesn't match package.json, so "npm ci" in GitHub Actions fails.`, fix: `Delete ${lock.path} (the workflow then uses "npm install"), or regenerate it on a computer.` });
  }
  // 4. build & deploy configuration
  if (pkgText !== undefined) {
    const scripts = (JSON.parse(pkgText || '{}') as { scripts?: Record<string, string> }).scripts ?? {};
    const workflows = [...files.keys()].filter((x) => x.startsWith(`${WORKFLOW_DIR}/`));
    const usesBuild = workflows.some((w) => /run build/.test(files.get(w)?.text ?? ''));
    if (usesBuild && !scripts.build) problems.push({ severity: 'error', area: 'build', where: 'package.json › scripts', message: 'A workflow runs "npm run build" but package.json has no build script.', fix: 'Add a "build" script (e.g. "tsc --noEmit && vite build") with edit_config.' });
    const deploys = workflows.some((w) => /wrangler/.test(files.get(w)?.text ?? ''));
    const wcfg = WRANGLER_CONFIGS.find((c) => files.has(c));
    if (deploys && !wcfg) problems.push({ severity: 'error', area: 'deploy', where: 'wrangler config', message: 'The deploy workflow runs Wrangler, but there is no wrangler.jsonc / wrangler.toml, so it fails with "Missing entry-point".', fix: isStaticVite(pkgText) ? 'Add the Cloudflare workflow again (ci_add_workflow cloudflare): it adds the static-site wrangler.jsonc.' : 'Add a wrangler config with "main" (a Worker) or "assets" (a static site).' });
    if (wcfg) {
      const cfg = parseData(formatFor(wcfg)!, files.get(wcfg)?.text ?? '').value as { main?: string; assets?: { directory?: string } } | undefined;
      if (cfg?.main && !files.has(cfg.main.replace(/^\.\//, '')) && !(compiled?.files ?? []).some((g) => g.path === cfg.main!.replace(/^\.\//, ''))) problems.push({ severity: 'error', area: 'deploy', where: `${wcfg} › main`, path: wcfg, message: `"main" points at ${cfg.main}, which doesn't exist.` });
      if (!cfg?.main && !cfg?.assets) problems.push({ severity: 'error', area: 'deploy', where: wcfg, path: wcfg, message: 'Neither "main" (a Worker) nor "assets" (a static site) is set, so Wrangler has nothing to deploy.' });
    }
    if (scripts.build && /tsc/.test(scripts.build) && !files.has('tsconfig.json')) problems.push({ severity: 'error', area: 'build', where: 'tsconfig.json', message: 'The build runs tsc but there is no tsconfig.json.' });
  }
  // 5. TypeScript (from the editor's type checker)
  let typesNote: string | undefined;
  if (types && 'problems' in types) {
    for (const t of types.problems) problems.push({ severity: t.severity, area: 'types', where: t.where ?? `${t.path}${t.line ? `:${t.line}` : ''}`, path: t.path, message: t.message, ...(t.nodeId ? { nodeId: t.nodeId } : {}) });
  } else if (types && 'unavailable' in types) typesNote = types.unavailable;

  const errors = problems.filter((x) => x.severity === 'error').length;
  const warnings = problems.length - errors;
  return {
    ok: errors === 0,
    errors,
    warnings,
    checked: ['graphs', 'config files', 'packages', 'build & deploy config', ...(types && 'problems' in types ? ['TypeScript types'] : [])],
    ...(typesNote ? { types_not_checked: typesNote } : {}),
    problems: problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)),
    next: errors ? `Not finished: fix ALL ${errors} error(s) above (not just the first), then call check_project again. Only tell the user it's done when it reports 0 errors.` : warnings ? 'No errors. Warnings are worth a look but don\'t stop the build.' : 'Everything checks out.',
  };
}
