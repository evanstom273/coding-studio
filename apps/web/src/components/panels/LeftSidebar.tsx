import { useMemo, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, FileCode2, Files, FunctionSquare, ListTree, Plus, Radio, Search, Shapes, Trash2, Variable, Zap } from 'lucide-react';
import { FileExplorer } from '../files/FileExplorer';
import { SearchPanel } from '../files/SearchPanel';
import type { ScriptDoc } from '@cs/graph-core';
import type { EditOp } from '@cs/project-format';
import { createBackup } from '@web/db/projects';
import { DND_MIME, type DragNodePayload } from '@web/lib/dnd';
import { toolchainFor } from '@web/lib/toolchain';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { useCompile } from '@web/compile/store';
import { useCompact, useTouch } from '@web/hooks/useLayout';
import { paletteEntries, type MenuEntry } from '../canvas/AddNodeMenu';
import { headerColor } from '../canvas/model';
import { confirmDialog, cx, IconButton } from '../ui/primitives';

function dragStart(e: React.DragEvent, payload: DragNodePayload) {
  e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

function NodeLibrary() {
  const project = useEditor((s) => s.project)!;
  const activeScriptId = useEditor((x) => x.activeScriptId);
  const activeFunctionId = useEditor((x) => x.activeFunctionId);
  const script = project.scripts.find((s) => s.id === activeScriptId);
  const fn = script?.functions.find((f) => f.id === activeFunctionId);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tc = toolchainFor(project.language);
  const entries = useMemo(() => (script && fn ? paletteEntries(tc, script, fn).filter((e) => !e.key.includes(':')) : []), [tc, script, fn]);
  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => words.every((w) => `${e.title} ${e.category} ${(e.def.keywords ?? []).join(' ')} ${e.type}`.toLowerCase().includes(w)));
  }, [entries, q]);
  const groups = useMemo(() => {
    const m = new Map<string, MenuEntry[]>();
    for (const e of filtered) (m.get(e.category) ?? m.set(e.category, []).get(e.category)!).push(e);
    return [...m].sort(([a], [b]) => (a.startsWith('Godot') === b.startsWith('Godot') ? a.localeCompare(b) : a.startsWith('Godot') ? 1 : -1));
  }, [filtered]);
  const touch = useTouch();
  const add = (e: MenuEntry) => {
    window.dispatchEvent(new CustomEvent('cs:add-node-type', { detail: e }));
    useUI.getState().set({ drawer: null });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative p-2">
        <Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
        <input data-testid="library-search" className="w-full rounded border border-border bg-[#0f1218] py-1.5 pl-7 pr-2 text-[12px] focus:border-accent focus:outline-none" placeholder={`Search ${entries.length} nodes…`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {groups.map(([cat, list]) => {
          const isClosed = !q && closed.has(cat);
          return (
            <div key={cat}>
              <button
                className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text"
                onClick={() =>
                  setClosed((s) => {
                    const n = new Set(s);
                    if (n.has(cat)) n.delete(cat);
                    else n.add(cat);
                    return n;
                  })
                }
              >
                {isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {cat} <span className="ml-auto font-normal">{list.length}</span>
              </button>
              {!isClosed &&
                list.map((e) => (
                  <div
                    key={e.key}
                    draggable
                    onDragStart={(ev) => dragStart(ev, { type: e.type, props: e.props })}
                    onDoubleClick={() => add(e)}
                    onClick={() => touch && add(e)}
                    title={`${e.description}\n\n${touch ? 'Tap to add it to the canvas.' : 'Drag onto the canvas, or double-click to add.'}`}
                    data-testid="library-item"
                    className="mx-1 flex cursor-grab items-center gap-2 rounded px-2 py-[3px] text-[12px] hover:bg-panel-2 active:cursor-grabbing"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: headerColor({ node: { id: '', type: e.type, position: { x: 0, y: 0 }, props: {}, inputs: {} }, def: e.def, ports: [], title: '' }) }} />
                    <span className="truncate">{e.title}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, icon, onAdd, addLabel, children, count }: { title: string; icon: React.ReactNode; onAdd?: () => void; addLabel?: string; children: React.ReactNode; count: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <button className="flex flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-text" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {icon} {title} <span className="font-normal">({count})</span>
        </button>
        {onAdd && (
          <IconButton label={addLabel ?? `Add ${title}`} onClick={onAdd} className="h-5 min-w-5" data-testid={`add-${title.toLowerCase()}`}>
            <Plus size={13} />
          </IconButton>
        )}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

function uniqueName(base: string, taken: Set<string>) {
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  return n;
}

function Row({ active, onClick, icon, label, sub, onDelete, draggablePayload, testId, errors }: { active?: boolean; onClick: () => void; icon: React.ReactNode; label: string; sub?: string; onDelete?: () => void; draggablePayload?: DragNodePayload; testId?: string; errors?: number }) {
  return (
    <div
      className={cx('group mx-1 flex cursor-pointer items-center gap-1.5 rounded px-2 py-[3px] text-[12px]', active ? 'bg-accent/20 text-text' : 'hover:bg-panel-2')}
      onClick={onClick}
      draggable={!!draggablePayload}
      onDragStart={draggablePayload ? (e) => dragStart(e, draggablePayload) : undefined}
      data-testid={testId}
      title={draggablePayload ? 'Drag onto the canvas for a Get node (Alt+drop for Set)' : undefined}
    >
      {icon}
      <span className="truncate">{label}</span>
      {sub && <span className="truncate text-[10.5px] text-muted">{sub}</span>}
      {!!errors && <span className="ml-auto rounded bg-red-500/20 px-1 text-[10px] text-red-300">{errors}</span>}
      {onDelete && (
        <button
          className={cx('rounded p-0.5 text-muted opacity-0 hover:text-err group-hover:opacity-100', !errors && 'ml-auto')}
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function ProjectExplorer() {
  const project = useEditor((s) => s.project)!;
  const activeScriptId = useEditor((s) => s.activeScriptId);
  const activeFunctionId = useEditor((s) => s.activeFunctionId);
  const inspect = useUI((s) => s.inspect);
  const setUI = useUI((s) => s.set);
  const compact = useCompact();
  const show = (inspect: { kind: 'script' | 'function' | 'variable' | 'signal' | 'enum'; id: string }) => {
    useEditor.getState().select([]);
    // Narrow screens: details live in the inspector drawer.
    setUI({ inspect, ...(compact && inspect.kind !== 'function' && inspect.kind !== 'script' ? { drawer: 'right' as const } : {}) });
  };
  const openGraph = (scriptId: string, fnId: string) => {
    useEditor.getState().setActive(scriptId, fnId);
    if (compact) setUI({ drawer: null });
  };
  const diagnostics = useCompile((s) => s.diagnostics);
  const script = project.scripts.find((s) => s.id === activeScriptId);
  const tc = toolchainFor(project.language);
  const [eventMenu, setEventMenu] = useState(false);
  const d = (ops: EditOp[], label: string) => useEditor.getState().tryDispatch(ops, label);
  const taken = (s: ScriptDoc) => new Set([...s.variables, ...s.functions, ...s.signals, ...s.enums].map((x) => x.name));
  const errorsIn = (fnId: string) => diagnostics.filter((x) => x.functionId === fnId && x.severity === 'error').length;

  const del = async (what: string, ops: EditOp[]) => {
    if (!(await confirmDialog({ title: `Delete ${what}?`, message: `${what} will be removed. A backup is created first and you can also undo with Ctrl+Z.`, confirm: 'Delete', danger: true }))) return;
    await createBackup(useEditor.getState().workspace!, `Before deleting ${what}`);
    d(ops, `Delete ${what}`);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
      <Section
        title="Scripts"
        icon={<FileCode2 size={12} />}
        count={project.scripts.length}
        onAdd={() => {
          const name = uniqueName('NewScript', new Set(project.scripts.map((s) => s.name)));
          const r = d([{ op: 'add_script', ref: 's', name, template: tc.adapter.templates[0]?.id }], 'Add script');
          if (r) {
            const s = r.project.scripts.find((x) => x.id === r.created.s)!;
            useEditor.getState().setActive(s.id, s.functions[0]?.id);
            show({ kind: 'script', id: s.id });
          }
        }}
      >
        {project.scripts.map((s) => (
          <Row
            key={s.id}
            testId="script-row"
            active={s.id === activeScriptId}
            icon={<FileCode2 size={13} className="text-sky-300" />}
            label={s.name}
            sub={`${s.path}${tc.adapter.extensions[0]}`}
            onClick={() => {
              useEditor.getState().setActive(s.id);
              show({ kind: 'script', id: s.id });
            }}
            onDelete={project.scripts.length > 1 ? () => void del(`script ${s.name}`, [{ op: 'delete_script', script: s.id }]) : undefined}
          />
        ))}
      </Section>
      {script && (
        <>
          <div className="mx-2 my-1 border-t border-border" />
          <Section title="Events" icon={<Zap size={12} />} count={script.functions.filter((f) => f.kind === 'event').length} onAdd={() => setEventMenu(!eventMenu)} addLabel="Add event">
            {eventMenu && (
              <div className="mx-2 mb-1 rounded border border-border bg-panel-2 py-1" data-testid="event-menu">
                {tc.adapter.events
                  .filter((ev) => !script.functions.some((f) => f.event === ev.id))
                  .map((ev) => (
                    <button
                      key={ev.id}
                      className="block w-full px-2 py-0.5 text-left hover:bg-accent/20"
                      title={ev.description}
                      onClick={() => {
                        setEventMenu(false);
                        const r = d([{ op: 'add_function', ref: 'f', kind: 'event', event: ev.id }], `Add ${ev.name}`);
                        if (r) useEditor.getState().setActive(script.id, r.created.f);
                      }}
                    >
                      {ev.name} <span className="text-[10.5px] text-muted">{ev.title}</span>
                    </button>
                  ))}
              </div>
            )}
            {script.functions
              .filter((f) => f.kind === 'event')
              .map((f) => (
                <Row key={f.id} testId="function-row" active={f.id === activeFunctionId} errors={errorsIn(f.id)} icon={<Zap size={13} className="text-red-300" />} label={f.name} onClick={() => openGraph(script.id, f.id)} onDelete={() => void del(`event ${f.name}`, [{ op: 'delete_function', function: f.id }])} />
              ))}
          </Section>
          <Section
            title="Functions"
            icon={<FunctionSquare size={12} />}
            count={script.functions.filter((f) => f.kind === 'function').length}
            onAdd={() => {
              const r = d([{ op: 'add_function', ref: 'f', name: uniqueName('new_function', taken(script)) }], 'Add function');
              if (r) {
                useEditor.getState().setActive(script.id, r.created.f);
                show({ kind: 'function', id: r.created.f });
              }
            }}
          >
            {script.functions
              .filter((f) => f.kind === 'function')
              .map((f) => (
                <Row
                  key={f.id}
                  testId="function-row"
                  active={f.id === activeFunctionId}
                  errors={errorsIn(f.id)}
                  icon={<FunctionSquare size={13} className="text-blue-300" />}
                  label={f.name}
                  sub={`(${f.params.map((p) => p.name).join(', ')})`}
                  draggablePayload={{ type: 'core.call_function', props: { function: f.id } }}
                  onClick={() => {
                    show({ kind: 'function', id: f.id });
                    openGraph(script.id, f.id);
                  }}
                  onDelete={() => void del(`function ${f.name}`, [{ op: 'delete_function', function: f.id }])}
                />
              ))}
          </Section>
          <Section
            title="Variables"
            icon={<Variable size={12} />}
            count={script.variables.length}
            onAdd={() => {
              const r = d([{ op: 'add_variable', ref: 'v', name: uniqueName('new_var', taken(script)), type: 'float', default: 0 }], 'Add variable');
              if (r) show({ kind: 'variable', id: r.created.v });
            }}
          >
            {script.variables.map((v) => (
              <Row
                key={v.id}
                testId="variable-row"
                active={inspect?.kind === 'variable' && inspect.id === v.id}
                icon={<span className="h-2.5 w-2.5 rounded-full" style={{ background: v.constant ? '#94a3b8' : '#4ade80' }} />}
                label={v.name}
                sub={`${v.type}${v.exported ? ' · export' : ''}${v.constant ? ' · const' : ''}`}
                draggablePayload={{ type: 'core.get_var', props: { variable: v.id } }}
                onClick={() => show({ kind: 'variable', id: v.id })}
                onDelete={() => void del(`variable ${v.name}`, [{ op: 'delete_variable', variable: v.id }])}
              />
            ))}
          </Section>
          {tc.adapter.capabilities.signals && (
            <Section
              title="Signals"
              icon={<Radio size={12} />}
              count={script.signals.length}
              onAdd={() => {
                const r = d([{ op: 'add_signal', ref: 's', name: uniqueName('new_signal', taken(script)) }], 'Add signal');
                if (r) show({ kind: 'signal', id: r.created.s });
              }}
            >
              {script.signals.map((s) => (
                <Row key={s.id} active={inspect?.kind === 'signal' && inspect.id === s.id} icon={<Radio size={13} className="text-orange-300" />} label={s.name} sub={`(${s.params.map((p) => p.name).join(', ')})`} draggablePayload={{ type: 'godot.emit_signal', props: { signal: s.id } }} onClick={() => show({ kind: 'signal', id: s.id })} onDelete={() => void del(`signal ${s.name}`, [{ op: 'delete_signal', signal: s.id }])} />
              ))}
            </Section>
          )}
          {tc.adapter.capabilities.enums && (
            <Section
              title="Enums"
              icon={<Shapes size={12} />}
              count={script.enums.length}
              onAdd={() => {
                const r = d([{ op: 'add_enum', ref: 'e', name: uniqueName('State', taken(script)), members: ['IDLE', 'ACTIVE'] }], 'Add enum');
                if (r) show({ kind: 'enum', id: r.created.e });
              }}
            >
              {script.enums.map((e) => (
                <Row key={e.id} active={inspect?.kind === 'enum' && inspect.id === e.id} icon={<Braces size={13} className="text-violet-300" />} label={e.name} sub={e.members.map((m) => m.name).join(', ')} onClick={() => show({ kind: 'enum', id: e.id })} onDelete={() => void del(`enum ${e.name}`, [{ op: 'delete_enum', enum: e.id }])} />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

export function LeftSidebar() {
  const tab = useUI((s) => s.leftTab);
  const setUI = useUI((s) => s.set);
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 border-b border-border" role="tablist">
        {(
          [
            ['files', 'Files', <Files key="f" size={13} />],
            ['project', 'Script', <ListTree key="p" size={13} />],
            ['nodes', 'Nodes', <Shapes key="n" size={13} />],
            ['search', 'Search', <Search key="s" size={13} />],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setUI({ leftTab: id })} title={label} className={cx('flex min-w-0 flex-1 items-center justify-center gap-1 py-2 text-[11.5px]', tab === id ? 'border-b-2 border-accent text-text' : 'text-muted hover:text-text')} data-testid={`left-tab-${id}`}>
            {icon} {label}
          </button>
        ))}
      </div>
      {tab === 'nodes' ? <NodeLibrary /> : tab === 'files' ? <FileExplorer /> : tab === 'search' ? <SearchPanel /> : <ProjectExplorer />}
    </div>
  );
}
