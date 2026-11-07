/**
 * Library-aware nodes: for each dependency whose types are loaded, ask the TypeScript service
 * what the package exports (completions on `import * as m from 'pkg'; m.`), read each export's
 * signature (completion details), constructors (signature help) and the methods of exported
 * classes and of the object types they return. The result becomes palette entries for the
 * Call / New / Call Method nodes, grouped by package.
 */
import { parseDisplay, parseParams, type ApiSignature } from '@cs/language-typescript';
import { monaco, tsLanguage } from './monaco';
import { useCatalog, type CatalogEntry } from './catalogStore';

interface CompletionEntry {
  name: string;
  kind: string;
}
interface Worker {
  getCompletionsAtPosition(file: string, pos: number): Promise<{ entries: CompletionEntry[] } | undefined>;
  getCompletionEntryDetails(file: string, pos: number, name: string): Promise<{ displayParts: { text: string }[]; documentation?: { text: string }[] } | undefined>;
  getSignatureHelpItems(file: string, pos: number, opts: object): Promise<{ items: { parameters: { displayParts: { text: string }[] }[] }[] } | undefined>;
}

const MAX_EXPORTS = 200;
const MAX_MEMBERS = 60;
/** Display text, without the `__m.` alias the probe files import the package as. */
const text = (parts?: { text: string }[]) => (parts ?? []).map((p) => p.text).join('').replace(/\b__m\./g, '');

async function withModel<T>(pkg: string, source: string, fn: (w: Worker, file: string, pos: number) => Promise<T>): Promise<T> {
  const uri = monaco.Uri.parse(`file:///__catalog__/${pkg.replace(/[^a-zA-Z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 8)}.ts`);
  const model = monaco.editor.createModel(source, 'typescript', uri);
  try {
    const getWorker = await tsLanguage.getTypeScriptWorker();
    const w = (await getWorker(uri)) as unknown as Worker;
    return await fn(w, uri.toString(), source.length);
  } finally {
    model.dispose();
  }
}

const isIdent = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);
const describe = (s: ApiSignature, owner: string) => `${owner}${s.name}(${s.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.tsType}`).join(', ')}): ${s.tsReturnType}${s.overloads ? ` (+${s.overloads} overloads)` : ''}`;
const argProps = (s: ApiSignature) => {
  // Optional parameters are left off the node; rest parameters become one argument.
  const ps = s.params.filter((p) => !p.optional);
  return { argNames: ps.map((p) => p.name), argTypes: ps.map((p) => p.type) };
};

async function membersOf(pkg: string, typeExpr: string, owner: string, category: string): Promise<CatalogEntry[]> {
  return withModel(pkg, `import * as __m from '${pkg}';\ndeclare const __i: ${typeExpr};\n__i.`, async (w, file, pos) => {
    const c = await w.getCompletionsAtPosition(file, pos);
    const out: CatalogEntry[] = [];
    for (const e of (c?.entries ?? []).filter((x) => x.kind === 'method').slice(0, MAX_MEMBERS)) {
      const d = await w.getCompletionEntryDetails(file, pos, e.name);
      const p = parseDisplay(text(d?.displayParts));
      if (!p || p.kind !== 'function') continue;
      out.push({ title: `${owner}.${p.name}()`, category, description: `${describe(p, `${owner}.`)}${d?.documentation?.length ? `\n\n${text(d.documentation)}` : ''}`, type: 'ts.call_method', props: { name: p.name, ...argProps(p), returnType: p.async ? p.returnType : p.returnType, await: p.async } });
    }
    return out;
  });
}

/** Build (or rebuild) the catalog for one package. */
export async function buildCatalog(pkg: string): Promise<CatalogEntry[]> {
  const category = `Library/${pkg}`;
  const out: CatalogEntry[] = [];
  const classes: string[] = [];
  const returned = new Set<string>();
  const exports = await withModel(pkg, `import * as __m from '${pkg}';\n__m.`, async (w, file, pos) => {
    const c = await w.getCompletionsAtPosition(file, pos);
    const found: { name: string; display: string; doc: string }[] = [];
    for (const e of (c?.entries ?? []).filter((x) => ['function', 'class', 'const', 'let', 'var', 'alias', 'module'].includes(x.kind)).slice(0, MAX_EXPORTS)) {
      const d = await w.getCompletionEntryDetails(file, pos, e.name);
      found.push({ name: e.name, display: text(d?.displayParts), doc: text(d?.documentation) });
    }
    return found;
  });
  const seenClass = new Set<string>();
  const instanceTypes: { expr: string; shown: string }[] = [];
  for (const x of exports) {
    const p = parseDisplay(x.display);
    if (!p) continue;
    const isDefault = x.name === 'default';
    if (p.kind === 'class') {
      // `export default Dexie` and `export { Dexie }` describe the same class: list it once.
      if (seenClass.has(p.name)) continue;
      seenClass.add(p.name);
      const importName = isDefault ? p.name : x.name;
      const ctor = await withModel(pkg, `import * as __m from '${pkg}';\nnew __m.${isDefault ? 'default' : x.name}(`, async (w, file, pos) => {
        const h = await w.getSignatureHelpItems(file, pos, {});
        return parseParams((h?.items[0]?.parameters ?? []).map((q) => text(q.displayParts)));
      }).catch(() => []);
      const req = ctor.filter((q) => !q.optional);
      out.push({ title: `new ${p.name}`, category, description: `new ${p.name}(${ctor.map((q) => `${q.name}${q.optional ? '?' : ''}: ${q.tsType}`).join(', ')})${x.doc ? `\n\n${x.doc}` : ''}`, type: 'ts.new', props: { module: pkg, name: importName, importKind: isDefault ? 'default' : 'named', argNames: req.map((q) => q.name), argTypes: req.map((q) => q.type) } });
      classes.push(isDefault ? 'default' : x.name);
      continue;
    }
    if (p.kind === 'value' && /^[A-Z]/.test(isDefault ? p.name : x.name)) {
      // A value with construct signatures (`declare var Dexie: DexieConstructor`) acts as a class.
      const shown = isDefault ? p.name : x.name;
      if (seenClass.has(shown)) continue;
      const ctor = await withModel(pkg, `import * as __m from '${pkg}';\nnew __m.${x.name}(`, async (w, file, pos) => {
        const h = await w.getSignatureHelpItems(file, pos, {});
        return h?.items.length ? parseParams((h.items[0].parameters ?? []).map((q) => text(q.displayParts))) : undefined;
      }).catch(() => undefined);
      if (!ctor) continue;
      seenClass.add(shown);
      const req = ctor.filter((q) => !q.optional);
      out.push({ title: `new ${shown}`, category, description: `new ${shown}(${ctor.map((q) => `${q.name}${q.optional ? '?' : ''}: ${q.tsType}`).join(', ')})${x.doc ? `\n\n${x.doc}` : ''}`, type: 'ts.new', props: { module: pkg, name: shown, importKind: isDefault ? 'default' : 'named', argNames: req.map((q) => q.name), argTypes: req.map((q) => q.type) } });
      instanceTypes.push({ expr: `InstanceType<typeof __m.${x.name}>`, shown });
      continue;
    }
    if (p.kind !== 'function') continue;
    const name = isDefault ? (pkg.split('/').pop() ?? 'lib').replace(/[^A-Za-z0-9_$]/g, '_') : x.name;
    if (!isIdent(name)) continue;
    out.push({ title: `${name}()`, category, description: `${describe(p, '')}${x.doc ? `\n\n${x.doc}` : ''}`, type: 'ts.call', props: { module: pkg, name, importKind: isDefault ? 'default' : 'named', ...argProps(p), returnType: p.returnType, await: p.async } });
    const ret = /^([A-Z][\w$]*)(<|$)/.exec(p.tsReturnType.replace(/^(Promise|PromiseExtended)<(.+)>$/, '$2'));
    if (ret) returned.add(ret[1]);
  }
  // Methods of exported classes, and of object types that exported functions/methods return.
  for (const c of classes) {
    const cls = exports.find((e) => e.name === c);
    const shown = c === 'default' ? (parseDisplay(cls?.display ?? '') as { name?: string })?.name ?? 'default' : c;
    const members = await membersOf(pkg, `__m.${c}`, shown, `${category}/${shown}`).catch(() => []);
    out.push(...members);
    for (const m of members) {
      const r = /^([A-Z][\w$]*)(<|$)/.exec(m.description.split('): ').pop()?.replace(/^(Promise|PromiseExtended)<(.+)>$/, '$2') ?? '');
      if (r) returned.add(r[1]);
    }
  }
  for (const it of instanceTypes) {
    const members = await membersOf(pkg, it.expr, it.shown, `${category}/${it.shown}`).catch(() => []);
    out.push(...members);
    for (const m of members) {
      const r = /^([A-Z][\w$]*)(<|$)/.exec(m.description.split('): ').pop()?.replace(/^(Promise|PromiseExtended)<(.+)>$/, '$2') ?? '');
      if (r) returned.add(r[1]);
    }
  }
  for (const t of returned) {
    if (classes.includes(t) || out.some((e) => e.category === `${category}/${t}`)) continue;
    // Generic interfaces: try without type arguments (defaults), then with one or two `any`s.
    for (const args of ['', '<any>', '<any, any>']) {
      const members = await membersOf(pkg, `__m.${t}${args}`, t, `${category}/${t}`).catch(() => []);
      if (members.length) {
        out.push(...members);
        break;
      }
    }
  }
  return out;
}

let queue: Promise<void> = Promise.resolve();

/** Rebuild catalogs for these packages (one at a time, in the background). */
export function refreshCatalogs(packages: string[]) {
  const keep = new Set(packages);
  useCatalog.setState((s) => ({ byPackage: Object.fromEntries(Object.entries(s.byPackage).filter(([k]) => keep.has(k))) }));
  for (const pkg of packages) {
    queue = queue.then(async () => {
      try {
        const entries = await buildCatalog(pkg);
        if (keep.has(pkg)) useCatalog.setState((s) => ({ byPackage: { ...s.byPackage, [pkg]: entries } }));
      } catch {
        /* no catalog for this package */
      }
    });
  }
}

/** Debugging aid: what the TypeScript service reports for a package's exports. */
export async function probeExports(pkg: string) {
  return withModel(pkg, `import * as __m from '${pkg}';\n__m.`, async (w, file, pos) => {
    const c = await w.getCompletionsAtPosition(file, pos);
    const out: { name: string; kind: string; display: string }[] = [];
    for (const e of c?.entries ?? []) {
      const d = await w.getCompletionEntryDetails(file, pos, e.name);
      out.push({ name: e.name, kind: e.kind, display: text(d?.displayParts) });
    }
    return out;
  });
}

/**
 * What an object of a type offers (methods → Call Method nodes, properties → Get Field nodes),
 * e.g. "Phaser.Scene" from "phaser": this.physics, this.add, this.input… For AI tools.
 */
export async function typeMembers(pkg: string, typeName: string): Promise<CatalogEntry[]> {
  const [root, ...rest] = typeName.split('.');
  const expr = rest.length ? `__m.${[root === pkg || /^[A-Z]/.test(root) ? '' : root, ...rest].filter(Boolean).join('.')}` : `__m.${root}`;
  const shown = typeName;
  // `Phaser.Scene` in a package whose namespace is Phaser: __m.Scene; try both spellings.
  const candidates = [...new Set([expr, `__m.${typeName}`, `__m.${rest.join('.') || root}`])];
  for (const c of candidates) {
    const found = await withModel(pkg, `import * as __m from '${pkg}';\ndeclare const __i: InstanceType<typeof ${c}>;\n__i.`, async (w, file, pos) => {
      const comp = await w.getCompletionsAtPosition(file, pos);
      const out: CatalogEntry[] = [];
      for (const e of (comp?.entries ?? []).filter((x) => x.kind === 'method' || x.kind === 'property' || x.kind === 'getter').slice(0, 150)) {
        const d = await w.getCompletionEntryDetails(file, pos, e.name);
        const disp = text(d?.displayParts);
        const doc = d?.documentation?.length ? `\n\n${text(d.documentation).slice(0, 300)}` : '';
        if (e.kind === 'method') {
          const p = parseDisplay(disp);
          if (!p || p.kind !== 'function') continue;
          out.push({ title: `${shown}.${p.name}()`, category: `Library/${pkg}/${shown}`, description: `${describe(p, `${shown}.`)}${doc}`, type: 'ts.call_method', props: { name: p.name, ...argProps(p), returnType: p.returnType, await: p.async } });
        } else {
          const t = /:\s*(.+)$/s.exec(disp)?.[1]?.trim() ?? 'any';
          out.push({ title: `${shown}.${e.name}`, category: `Library/${pkg}/${shown}`, description: `${shown}.${e.name}: ${t}${doc}`, type: 'ts.get_field' as CatalogEntry['type'], props: { name: e.name, type: 'any' } });
        }
      }
      return out;
    }).catch(() => [] as CatalogEntry[]);
    if (found.length) return found;
  }
  return [];
}
