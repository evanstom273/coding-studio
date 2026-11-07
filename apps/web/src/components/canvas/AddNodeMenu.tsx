import { useEffect, useMemo, useRef, useState } from 'react';
import type { FunctionDecl, JsonValue, ScriptDoc } from '@cs/graph-core';
import { checkConnection, makeNodeContext, nodeInfo, scopeChain, type Toolchain } from '@cs/compiler-core';
import { defaultProps, matchesQuery, type NodeDefinition, type PortSpec } from '@cs/node-registry';
import type { EditOp } from '@cs/project-format';
import { toolchainFor } from '@web/lib/toolchain';
import { useEditor } from '@web/store/editor';
import { relativeModule, scanExports, type ExportedFunction } from '@cs/language-typescript';
import type { FileRecord } from '@cs/workspace';
import { useCatalog, type CatalogEntry } from '@web/lib/catalogStore';
import { headerColor } from './model';

export interface PendingConnection {
  nodeId: string;
  portId: string;
  /** 'source' = dragged from an output, 'target' = dragged from an input */
  handleType: 'source' | 'target';
}

export interface MenuEntry {
  key: string;
  title: string;
  category: string;
  description: string;
  type: string;
  props?: Record<string, JsonValue>;
  def: NodeDefinition;
  /** Creating the node also creates a new inline function owned by the current one. */
  newClosure?: boolean;
  /** Creating the node also creates a new React state variable in the enclosing component. */
  newState?: { component: string };
}

/** Edit operations that add a palette entry's node (with `ref: 'n'`) at a position. */
export function opsForEntry(e: Pick<MenuEntry, 'type' | 'props' | 'newClosure' | 'newState'>, fn: FunctionDecl, script: ScriptDoc, position: { x: number; y: number }): EditOp[] {
  const at = { x: Math.round(position.x), y: Math.round(position.y) };
  if (e.newState) {
    const owner = script.functions.find((f) => f.id === e.newState!.component);
    const taken = new Set([...script.variables, ...script.functions, ...scopeChain(script, fn).flatMap((f) => [...f.params, ...f.locals])].map((x) => x.name));
    let name = 'count';
    for (let i = 2; taken.has(name) || taken.has(`set${name[0].toUpperCase()}${name.slice(1)}`); i++) name = `count${i}`;
    return [
      { op: 'add_variable', ref: 'v', function: owner?.id ?? fn.id, name, type: 'number', default: 0, attributes: { state: true } },
      { op: 'add_node', ref: 'n', graph: fn.id, type: 'core.get_var', position: at, props: { variable: '$v' } },
    ];
  }
  if (e.newClosure) {
    const taken = new Set(script.functions.map((f) => f.name));
    let name = 'callback';
    for (let i = 2; taken.has(name); i++) name = `callback${i}`;
    return [
      { op: 'add_function', ref: 'lam', kind: 'lambda', owner: fn.id, name },
      { op: 'add_node', ref: 'n', graph: fn.id, type: e.type, position: at, props: { function: '$lam' } },
    ];
  }
  return [{ op: 'add_node', ref: 'n', type: e.type, position: at, ...(e.props ? { props: e.props } : {}) }];
}

/** Palette entries for the active script: every node type plus shortcuts for its own variables, functions and signals. */
/** `others`: the project's other scripts (their exported functions become Call entries where the language has modules). */
const exportCache = new Map<string, ExportedFunction[]>();
const exportsOf = (f: FileRecord) => exportCache.get(f.hash) ?? (exportCache.set(f.hash, scanExports(f.text ?? '')), exportCache.get(f.hash)!);

export function paletteEntries(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl, others: ScriptDoc[] = [], files?: Iterable<FileRecord>, catalog?: Record<string, CatalogEntry[]>): MenuEntry[] {
  const out: MenuEntry[] = [];
  const reg = tc.registry;
  const def = (t: string) => reg.get(t)!;
  const [own, ...outer] = scopeChain(script, fn);
  const vars = [
    ...own.params.map((p) => ({ ...p, scope: 'parameter' })),
    ...own.locals.map((v) => ({ ...v, scope: v.constant ? 'constant' : 'local' })),
    // Inline functions see the parameters and locals of the functions around them.
    ...outer.flatMap((o) => [...o.params.map((p) => ({ ...p, scope: `${o.name} parameter` })), ...o.locals.map((v) => ({ ...v, scope: v.constant ? 'constant' : `${o.name} local` }))]),
    ...script.variables.map((v) => ({ ...v, scope: v.constant ? 'constant' : 'member' })),
  ];
  for (const v of vars) {
    out.push({ key: `get:${v.id}`, title: `Get ${v.name}`, category: 'Variables', description: `Read ${v.scope} ${v.name}: ${v.type}`, type: 'core.get_var', props: { variable: v.id }, def: def('core.get_var') });
    if (v.scope !== 'constant') out.push({ key: `set:${v.id}`, title: `Set ${v.name}`, category: 'Variables', description: `Assign ${v.scope} ${v.name}: ${v.type}`, type: 'core.set_var', props: { variable: v.id }, def: def('core.set_var') });
  }
  for (const f of script.functions) {
    if (f.kind === 'event' || f.kind === 'lambda') continue;
    out.push({ key: `call:${f.id}`, title: `Call ${f.name}`, category: 'Functions', description: f.description ?? `Call ${f.name}()`, type: 'core.call_function', props: { function: f.id }, def: def('core.call_function') });
  }
  if (reg.get('godot.emit_signal') && tc.adapter.capabilities.signals) {
    for (const s of script.signals) out.push({ key: `emit:${s.id}`, title: `Emit ${s.name}`, category: 'Godot/Signals', description: `Emit signal ${s.name}`, type: 'godot.emit_signal', props: { signal: s.id }, def: def('godot.emit_signal') });
  }
  for (const e of script.enums) for (const m of e.members) out.push({ key: `enum:${e.id}:${m.name}`, title: `${e.name}.${m.name}`, category: 'Variables', description: `Enum value`, type: 'core.enum_value', props: { enum: e.id, member: m.name }, def: def('core.enum_value') });
  for (const d of reg.available(tc.adapter.id, tc.adapter.capabilities)) {
    out.push({ key: d.type, title: d.title, category: d.category, description: d.description, type: d.type, def: d });
    d.presets?.forEach((p, i) => out.push({ key: `${d.type}#${i}`, title: p.title, category: p.category ?? d.category, description: p.description ?? d.description, type: d.type, props: p.props, def: d }));
  }
  // React state: offered in a component or hook, and in the inline functions inside one.
  const component = tc.adapter.id === 'typescript' ? scopeChain(script, fn).find((f) => f.component || /^use[A-Z]/.test(f.name)) : undefined;
  if (component) out.push({ key: 'state#new', title: 'New React State', category: 'Variables', description: `Add a state variable to ${component.name} (useState) and read it. Change it with Set: the component re-renders.`, type: 'core.get_var', newState: { component: component.id }, def: def('core.get_var') });
  const closure = reg.get('ts.closure');
  if (closure && tc.adapter.capabilities.closures) {
    out.push({ key: 'closure#new', title: 'New Inline Function', category: 'Functions', description: closure.description, type: 'ts.closure', newClosure: true, def: closure });
    for (const l of script.functions) if (l.kind === 'lambda' && l.owner === fn.id) out.push({ key: `closure#${l.id}`, title: `${l.name} (inline function)`, category: 'Functions', description: l.description ?? closure.description, type: 'ts.closure', props: { function: l.id }, def: closure });
  }
  const call = reg.get('ts.call');
  if (call && tc.adapter.capabilities.modules) {
    for (const s of others) {
      if (s.id === script.id) continue;
      for (const f of s.functions) {
        if (!f.exported) continue;
        const props = { scriptPath: s.path, name: f.name, argNames: f.params.map((p) => p.name), argTypes: f.params.map((p) => p.type), returnType: f.returnType, await: !!f.async && !!fn.async };
        out.push({ key: `xcall#${s.id}#${f.id}`, title: `${s.name}.${f.name}()`, category: `Project/${s.name}`, description: f.description ?? `Call ${f.name} exported by ${s.path}`, type: 'ts.call', props, def: call });
      }
    }
  }
  // Functions exported by hand-written TS/JS files in the project.
  if (call && tc.adapter.capabilities.modules && files) {
    for (const f of files) {
      if (f.kind !== 'text' || !/\.(ts|tsx|js|jsx|mjs|mts)$/.test(f.path) || /\.d\.ts$/.test(f.path) || f.size > 512 * 1024) continue;
      const mod = relativeModule(script.path, f.path.replace(/\.(ts|tsx|js|jsx|mjs|mts)$/, ''));
      for (const x of exportsOf(f)) {
        const props = { module: mod, name: x.name, importKind: x.isDefault ? 'default' : 'named', argNames: x.params.map((p) => p.name), argTypes: x.params.map((p) => p.type), returnType: x.returnType, await: x.async && !!fn.async };
        out.push({ key: `fcall#${f.path}#${x.name}`, title: `${x.name}()`, category: `Project/${f.path}`, description: `${x.isDefault ? 'Default export' : 'Exported'} from ${f.path}: ${x.name}(${x.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) → ${x.returnType}`, type: 'ts.call', props, def: call });
      }
    }
  }
  // Library nodes built from the dependencies' types.
  if (catalog && tc.adapter.capabilities.modules) {
    for (const [pkg, entries] of Object.entries(catalog)) {
      entries.forEach((e, i) => {
        const def = reg.get(e.type);
        if (!def) return;
        const props = 'await' in e.props ? { ...e.props, await: e.props.await === true && !!fn.async } : e.props;
        out.push({ key: `lib#${pkg}#${i}`, title: e.title, category: e.category, description: e.description, type: e.type, props, def });
      });
    }
  }
  return out;
}

function score(e: MenuEntry, q: string): number {
  if (!q) return 1;
  const hay = `${e.title} ${e.category} ${e.type} ${(e.def.keywords ?? []).join(' ')}`.toLowerCase();
  if (!matchesQuery(hay, q)) return 0;
  const t = e.title.toLowerCase();
  return 1 + (t === q.toLowerCase() ? 100 : 0) + (t.startsWith(q.toLowerCase()) ? 40 : 0) + (t.includes(q.toLowerCase()) ? 15 : 0) + (e.key.includes(':') ? 5 : 0);
}

/** Which port of a would-be node accepts the pending connection, if any. */
export function compatiblePort(tc: Toolchain, script: ScriptDoc, fn: FunctionDecl, e: MenuEntry, pending: PendingConnection): PortSpec | undefined {
  const ctx = makeNodeContext(tc, script, fn);
  const src = fn.graph.nodes.find((n) => n.id === pending.nodeId);
  if (!src) return undefined;
  const srcPort = nodeInfo(tc, ctx, src).ports.find((p) => p.id === pending.portId && p.direction === (pending.handleType === 'source' ? 'out' : 'in'));
  if (!srcPort) return undefined;
  const fake = { id: '__new', type: e.type, position: { x: 0, y: 0 }, props: { ...defaultProps(e.def), ...e.props }, inputs: {} };
  const ports = nodeInfo(tc, ctx, fake).ports;
  return ports.find((p) => {
    if (pending.handleType === 'source') return p.direction === 'in' && checkConnection(tc, srcPort, p).severity !== 'error';
    return p.direction === 'out' && checkConnection(tc, p, srcPort).severity !== 'error';
  });
}

export function AddNodeMenu({ screen, flow, pending, onClose }: { screen: { x: number; y: number }; flow: { x: number; y: number }; pending?: PendingConnection; onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const script = project.scripts.find((s) => s.id === useEditor.getState().activeScriptId)!;
  const fn = script?.functions.find((f) => f.id === useEditor.getState().activeFunctionId);
  const tc = toolchainFor(project.language);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const scripts = useEditor((s) => s.project?.scripts);
  const wsFiles = useEditor((s) => s.workspace?.files);
  const catalog = useCatalog((s) => s.byPackage);
  const all = useMemo(() => (script && fn ? paletteEntries(tc, script, fn, scripts, wsFiles?.values(), catalog) : []), [tc, script, fn, scripts, wsFiles, catalog]);
  const contextual = useMemo(() => (pending && script && fn ? all.filter((e) => compatiblePort(tc, script, fn, e, pending)) : all), [all, pending, tc, script, fn]);
  const results = useMemo(
    () =>
      contextual
        .map((e) => ({ e, s: score(e, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.e.category.localeCompare(b.e.category) || a.e.title.localeCompare(b.e.title))
        .slice(0, 80)
        .map((x) => x.e),
    [contextual, q],
  );
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!script || !fn) return null;

  const choose = (e: MenuEntry) => {
    const ops = opsForEntry(e, fn, script, flow);
    if (pending) {
      const port = compatiblePort(tc, script, fn, e, pending);
      if (port) ops.push(pending.handleType === 'source' ? { op: 'connect', from: { node: pending.nodeId, port: pending.portId }, to: { node: '$n', port: port.id } } : { op: 'connect', from: { node: '$n', port: port.id }, to: { node: pending.nodeId, port: pending.portId } });
    }
    const r = useEditor.getState().tryDispatch(ops, `Add ${e.title}`);
    if (r) useEditor.getState().select([r.created.n]);
    onClose();
  };

  const width = Math.min(320, window.innerWidth - 16);
  const left = Math.max(8, Math.min(screen.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(screen.y, window.innerHeight - 440));
  let lastCat = '';
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="absolute flex flex-col rounded-md border border-border bg-panel shadow-2xl" style={{ left, top, width, maxHeight: Math.min(420, window.innerHeight - top - 8) }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Add node">
        <div className="border-b border-border p-2">
          <input
            ref={inputRef}
            data-testid="add-node-search"
            className="w-full rounded border border-border bg-[#0f1218] px-2 py-1.5 text-[12px] focus:border-accent focus:outline-none"
            placeholder={pending ? 'Search compatible nodes…' : 'Search nodes…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                choose(results[active]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          {pending && <div className="mt-1 text-[10.5px] text-muted">Showing nodes that can connect to the dragged pin ({contextual.length})</div>}
        </div>
        <div ref={listRef} className="flex-1 overflow-auto py-1" role="listbox">
          {results.length === 0 && <div className="px-3 py-2 text-muted">No matching nodes</div>}
          {results.map((e, i) => {
            const showCat = !q && e.category !== lastCat;
            lastCat = e.category;
            return (
              <div key={e.key}>
                {showCat && <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{e.category}</div>}
                <button
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  data-testid="add-node-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(e)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] [@media(pointer:coarse)]:py-2.5 [@media(pointer:coarse)]:text-[13px] ${i === active ? 'bg-accent/20' : ''}`}
                  title={e.description}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: headerColor({ node: { id: '', type: e.type, position: { x: 0, y: 0 }, props: {}, inputs: {} }, def: e.def, ports: [], title: '' }) }} />
                  <span className="truncate">{e.title}</span>
                  {q && <span className="ml-auto shrink-0 text-[10px] text-muted">{e.category}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
