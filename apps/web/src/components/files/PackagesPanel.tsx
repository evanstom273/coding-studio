/** npm dependencies: what's declared, whether types loaded, search and add, remove. */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Package, Plus, Search, X, XCircle } from 'lucide-react';
import { isPackageName, lockfileStatus, removeDependency, resolveVersion, searchPackages, setDependency, type SearchResult } from '@cs/dependencies';
import { configOf } from '@cs/workspace';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { useDeps } from '@web/lib/depsStore';
import { cx, IconButton, inputCls } from '../ui/primitives';

const fetchJson = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`npm registry: ${r.status}`);
  return r.json();
};

function writeManifest(text: string, label: string) {
  try {
    useEditor.getState().applyFiles([{ op: 'write_file', path: 'package.json', content: text }], label);
    return true;
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function addPackage(name: string, opts: { dev?: boolean; range?: string } = {}) {
  const ws = useEditor.getState().workspace!;
  const version = opts.range ?? (await resolveVersion(fetchJson, name, 'latest'));
  if (!version) throw new Error(`No package "${name}" on npm`);
  const range = opts.range ?? `^${version}`;
  const text = setDependency(ws.files.get('package.json')?.text, name, range, opts.dev, { name: configOf(ws).name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app' });
  if (writeManifest(text, `Add ${name}`)) toast('success', `Added ${name} ${range}`);
}

export function PackagesPanel() {
  const ws = useEditor((s) => s.workspace)!;
  const deps = useDeps((s) => s.deps);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dev, setDev] = useState(false);
  const manifest = ws.files.get('package.json');
  const lock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map((p) => ws.files.get(p)).find(Boolean);
  const lockState = useMemo(() => lockfileStatus(manifest?.text, lock ? { path: lock.path, text: lock.text } : undefined), [manifest, lock]);

  useEffect(() => {
    if (!q.trim()) return setResults(null);
    const t = setTimeout(() => {
      searchPackages(fetchJson, q, 15)
        .then(setResults)
        .catch((e) => toast('error', e instanceof Error ? e.message : String(e)));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const add = async (name: string) => {
    setBusy(name);
    try {
      await addPackage(name, { dev });
      setQ('');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]" data-testid="packages-panel">
      <div className="space-y-1.5 p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input className={`${inputCls} pl-7`} placeholder="Search npm (react, dexie, date-fns…)" value={q} onChange={(e) => setQ(e.target.value)} data-testid="package-search" />
        </div>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} /> add as dev dependency
        </label>
      </div>
      {results && (
        <div className="max-h-[50%] shrink-0 overflow-auto border-b border-border pb-1">
          {results.length === 0 && <div className="px-3 text-muted">Nothing found.</div>}
          {isPackageName(q.trim()) && !results.some((r) => r.name === q.trim()) && (
            <button className="mx-1 block w-[calc(100%-8px)] rounded px-2 py-1 text-left hover:bg-panel-2" onClick={() => void add(q.trim())}>
              Add “{q.trim()}”
            </button>
          )}
          {results.map((r) => (
            <div key={r.name} className="mx-1 flex items-start gap-2 rounded px-2 py-1 hover:bg-panel-2" data-testid="package-result">
              <Package size={13} className="mt-0.5 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <b>{r.name}</b> <span className="text-[11px] text-muted">{r.version}</span>
                </div>
                {r.description && <div className="truncate text-[11px] text-muted">{r.description}</div>}
              </div>
              <IconButton label={`Add ${r.name}`} disabled={!!busy} onClick={() => void add(r.name)} className="h-6 min-w-6" data-testid="package-add">
                {busy === r.name ? <CircleDashed size={13} className="animate-spin" /> : <Plus size={13} />}
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {lockState === 'out-of-date' && (
        <div className="mx-2 my-1 flex gap-1.5 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-[11.5px] text-amber-100" data-testid="lockfile-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {lock!.path} doesn't match package.json any more. It's updated by running an install (on a computer, or in CI with <code>npm install</code>); until then <code>npm ci</code> will refuse to run. Types in the editor already work.
          </span>
        </div>
      )}
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Dependencies ({deps.length})</div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {!manifest && <div className="px-3 text-muted">No package.json yet: adding a package creates one.</div>}
        {deps.map((d) => (
          <div key={d.name} className="group mx-1 flex items-center gap-1.5 rounded px-2 py-[3px] hover:bg-panel-2" data-testid="dependency" data-name={d.name} data-state={d.state}>
            {d.state === 'loading' ? <CircleDashed size={12} className="shrink-0 animate-spin text-muted" /> : d.state === 'types' ? <CheckCircle2 size={12} className="shrink-0 text-emerald-400" /> : d.state === 'error' ? <XCircle size={12} className="shrink-0 text-red-400" /> : <CircleDashed size={12} className="shrink-0 text-muted" />}
            <span className="truncate">{d.name}</span>
            <span className="truncate text-[10.5px] text-muted">
              {d.range}
              {d.dev ? ' · dev' : ''}
            </span>
            <span className={cx('ml-auto shrink-0 text-[10.5px]', d.state === 'types' ? 'text-emerald-300' : 'text-muted')} title={d.message ?? (d.typesPackage ? `Types from ${d.typesPackage}` : undefined)}>
              {d.state === 'types' ? (d.source === 'definitelytyped' ? 'types (@types)' : 'types') : d.state === 'no-types' ? 'no types' : d.state === 'error' ? 'failed' : '…'}
            </span>
            <button className="rounded p-0.5 text-muted opacity-0 hover:text-err group-hover:opacity-100" aria-label={`Remove ${d.name}`} data-testid="dependency-remove" onClick={() => writeManifest(removeDependency(manifest?.text, d.name), `Remove ${d.name}`)}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">Packages are declared in package.json; installing them happens on a computer or in CI.</div>
    </div>
  );
}
