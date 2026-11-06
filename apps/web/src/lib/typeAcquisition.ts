/**
 * Types for the project's npm dependencies: whenever package.json changes, each dependency's
 * declarations are fetched from jsDelivr (cached in IndexedDB for a week) and given to the
 * TypeScript service as node_modules/<name>/… — imports, completions and graph nodes then know
 * the library without installing anything.
 */
import { acquireTypes, parseManifest, type AcquiredTypes } from '@cs/dependencies';
import { getSetting, setSetting } from '@web/db/projects';
import { useEditor } from '@web/store/editor';
import { tsLanguage } from './monaco';
import { useDeps, type DepState } from './depsStore';
import { scheduleCheck } from './tsProject';

const TTL = 7 * 24 * 3600 * 1000;
const fetchJson = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.json();
};
const fetchText = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return r.text();
};

/** Extra libs added per dependency name. */
const loaded = new Map<string, { range: string; dispose: () => void }>();
let lastManifest: string | undefined = '\0';
let generation = 0;

function patch(name: string, p: Partial<DepState>) {
  useDeps.setState((s) => ({ deps: s.deps.map((d) => (d.name === name ? { ...d, ...p } : d)) }));
}

async function typesFor(name: string, range: string): Promise<AcquiredTypes[]> {
  const key = `types:${name}@${range}`;
  const cached = await getSetting<{ at: number; types: AcquiredTypes[] } | null>(key, null);
  if (cached && Date.now() - cached.at < TTL) return cached.types;
  const types = await acquireTypes(fetchJson, fetchText, name, range);
  await setSetting(key, { at: Date.now(), types }).catch(() => undefined);
  return types;
}

function install(name: string, range: string, types: AcquiredTypes[]) {
  const disposers = types.flatMap((t) => t.files.flatMap((f) => [tsLanguage.typescriptDefaults.addExtraLib(f.content, `file:///${f.path}`), tsLanguage.javascriptDefaults.addExtraLib(f.content, `file:///${f.path}`)]));
  loaded.get(name)?.dispose();
  loaded.set(name, { range, dispose: () => disposers.forEach((d) => d.dispose()) });
}

export async function refreshTypes(force = false) {
  const text = useEditor.getState().workspace?.files.get('package.json')?.text;
  if (!force && text === lastManifest) return;
  lastManifest = text;
  const gen = ++generation;
  let m;
  try {
    m = parseManifest(text);
  } catch (e) {
    useDeps.setState({ deps: [] });
    return void e;
  }
  const wanted: DepState[] = [
    ...Object.entries(m.dependencies).map(([name, range]) => ({ name, range, dev: false, state: 'loading' as const })),
    ...Object.entries(m.devDependencies).map(([name, range]) => ({ name, range, dev: true, state: 'loading' as const })),
  ];
  // Drop libraries no longer declared.
  for (const [name, l] of loaded) {
    if (!wanted.some((w) => w.name === name)) {
      l.dispose();
      loaded.delete(name);
    }
  }
  const prev = new Map(useDeps.getState().deps.map((d) => [d.name, d]));
  useDeps.setState({ deps: wanted.map((w) => (loaded.get(w.name)?.range === w.range && prev.get(w.name) ? { ...prev.get(w.name)!, dev: w.dev } : w)) });
  await Promise.all(
    wanted.map(async (w) => {
      if (loaded.get(w.name)?.range === w.range) return;
      try {
        const types = await typesFor(w.name, w.range);
        if (gen !== generation) return;
        install(w.name, w.range, types);
        const main = types[0];
        patch(w.name, { state: main.source === 'none' ? 'no-types' : 'types', version: main.version, source: main.source, typesPackage: main.typesPackage, files: types.reduce((a, t) => a + t.files.length, 0) });
      } catch (e) {
        if (gen === generation) patch(w.name, { state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  if (gen === generation) {
    scheduleCheck(100);
    const typed = useDeps.getState().deps.filter((d) => d.state === 'types').map((d) => d.name);
    void import('./apiCatalog').then((m) => m.refreshCatalogs(typed));
  }
}

export function startTypeAcquisition(): () => void {
  lastManifest = '\0';
  void refreshTypes();
  const unsub = useEditor.subscribe((s, p) => {
    if (s.workspace?.files.get('package.json') !== p.workspace?.files.get('package.json')) void refreshTypes();
  });
  return () => {
    unsub();
    for (const l of loaded.values()) l.dispose();
    loaded.clear();
    useDeps.setState({ deps: [] });
  };
}
