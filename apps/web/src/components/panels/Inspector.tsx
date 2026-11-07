import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { FunctionDecl, JsonValue, ParamDecl, ScriptDoc, VariableDecl } from '@cs/graph-core';
import { makeNodeContext, nodeInfo, resolveType } from '@cs/compiler-core';
import type { PropSchema } from '@cs/node-registry';
import type { EditOp, ParamInput } from '@cs/project-format';
import { toolchainFor } from '@web/lib/toolchain';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { useCompile } from '@web/compile/store';
import { IconButton, inputCls } from '../ui/primitives';
import { ElementStyle } from './ElementStyle';

const d = (ops: EditOp[], label: string, mergeKey?: string) => useEditor.getState().tryDispatch(ops, label, { mergeKey });

/** Text input that commits on blur / Enter (for renames and types, which must be valid as a whole). */
function CommitInput({ value, onCommit, placeholder, testId, list, mono }: { value: string; onCommit: (v: string) => void; placeholder?: string; testId?: string; list?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`${inputCls} ${mono ? 'font-mono' : ''}`}
      value={v}
      list={list}
      placeholder={placeholder}
      data-testid={testId}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[11px] font-medium text-muted" title={hint}>
        {label}
      </div>
      {children}
    </div>
  );
}

function TypeDatalist({ script }: { script: ScriptDoc }) {
  const project = useEditor((s) => s.project)!;
  const types = toolchainFor(project.language).adapter.types.pickerTypes();
  return (
    <datalist id="cs-types">
      {[...types, ...script.enums.map((e) => e.name)].map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

function TypeInput({ value, onCommit, testId }: { value: string; onCommit: (v: string) => void; testId?: string }) {
  return <CommitInput value={value} onCommit={onCommit} list="cs-types" mono testId={testId} />;
}

function PropEditor({ prop, value, onChange, script, fn }: { prop: PropSchema; value: JsonValue | undefined; onChange: (v: JsonValue, merge?: boolean) => void; script: ScriptDoc; fn: FunctionDecl }) {
  switch (prop.kind) {
    case 'string':
      return <input className={inputCls} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value, true)} data-testid={`prop-${prop.key}`} />;
    case 'text':
      return <textarea className={`${inputCls} h-16 py-1`} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value, true)} data-testid={`prop-${prop.key}`} />;
    case 'int':
    case 'number':
      return <input className={inputCls} type="number" step={prop.kind === 'int' ? 1 : 'any'} min={prop.min} max={prop.max} value={typeof value === 'number' ? value : 0} onChange={(e) => e.target.value !== '' && Number.isFinite(+e.target.value) && onChange(prop.kind === 'int' ? Math.trunc(+e.target.value) : +e.target.value, true)} data-testid={`prop-${prop.key}`} />;
    case 'boolean':
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} data-testid={`prop-${prop.key}`} />;
    case 'select':
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`prop-${prop.key}`}>
          {prop.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'type':
      if (prop.typeOptions)
        return (
          <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`prop-${prop.key}`}>
            {prop.default === '' && <option value="">(same as left)</option>}
            {prop.typeOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      return <TypeInput value={String(value ?? '')} onCommit={(v) => onChange(v)} testId={`prop-${prop.key}`} />;
    case 'variable': {
      const scopes = prop.variableScopes ?? ['member', 'local', 'param'];
      const groups: [string, (VariableDecl | ParamDecl)[]][] = [
        ['Parameters', scopes.includes('param') ? fn.params : []],
        ['Local variables', scopes.includes('local') ? fn.locals : []],
        ['Script variables', scopes.includes('member') ? script.variables : []],
      ];
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`prop-${prop.key}`}>
          <option value="">— choose —</option>
          {groups.map(([g, list]) =>
            list.length ? (
              <optgroup key={g} label={g}>
                {list.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}: {v.type}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
      );
    }
    case 'function':
    case 'signal':
    case 'enum': {
      const list = prop.kind === 'function' ? script.functions : prop.kind === 'signal' ? script.signals : script.enums;
      return (
        <select className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} data-testid={`prop-${prop.key}`}>
          <option value="">— choose —</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      );
    }
    case 'string_list':
      return <StringList value={Array.isArray(value) ? value.map(String) : []} onCommit={(v) => onChange(v)} />;
  }
}

function StringList({ value, onCommit }: { value: string[]; onCommit: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return <textarea className={`${inputCls} h-20 py-1 font-mono`} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text.split('\n').map((s) => s.trim()).filter(Boolean))} placeholder="one per line" />;
}

function NodeInspector({ nodeId, script, fn }: { nodeId: string; script: ScriptDoc; fn: FunctionDecl }) {
  const project = useEditor((s) => s.project)!;
  const node = fn.graph.nodes.find((n) => n.id === nodeId);
  const diagnostics = useCompile((s) => s.diagnostics);
  const tc = toolchainFor(project.language);
  const info = useMemo(() => (node ? nodeInfo(tc, makeNodeContext(tc, script, fn), node) : undefined), [tc, script, fn, node]);
  if (!node || !info) return null;
  const nodeDiags = diagnostics.filter((x) => x.nodeId === nodeId);
  return (
    <div data-testid="node-inspector">
      <div className="mb-1 text-[14px] font-semibold">{info.title}</div>
      <div className="mb-3 font-mono text-[10.5px] text-muted">{node.type}</div>
      {info.def && <p className="mb-3 text-[12px] leading-snug text-[#c3c9d4]">{info.def.description}</p>}
      {nodeDiags.map((x, i) => (
        <div key={i} className={`mb-2 rounded px-2 py-1 text-[11.5px] ${x.severity === 'error' ? 'bg-red-500/15 text-red-200' : x.severity === 'warning' ? 'bg-amber-400/10 text-amber-200' : 'bg-panel-2 text-muted'}`}>
          {x.message}
          {x.suggestion && <div className="mt-0.5 opacity-80">→ {x.suggestion}</div>}
        </div>
      ))}
      {info.def?.props.map((p) => (
        <Row key={p.key} label={p.label} hint={p.description}>
          <PropEditor prop={p} value={node.props[p.key]} script={script} fn={fn} onChange={(v, merge) => d([{ op: 'update_node', node: node.id, props: { [p.key]: v } }], `Set ${p.label}`, merge ? `prop:${node.id}:${p.key}` : undefined)} />
          {p.description && <div className="mt-0.5 text-[10.5px] text-muted">{p.description}</div>}
        </Row>
      ))}
      {(node.type === 'ts.element' || node.type === 'ts.classes') && <ElementStyle node={node} fn={fn} />}
      {info.ports.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Pins</div>
          <table className="w-full text-[11.5px]">
            <tbody>
              {info.ports.map((p) => (
                <tr key={`${p.direction}${p.id}`} className="border-t border-border/50">
                  <td className="py-0.5 pr-2 text-muted">{p.direction === 'in' ? '→' : '←'}</td>
                  <td className="py-0.5 pr-2">{p.name || p.id}</td>
                  <td className="py-0.5 font-mono text-[10.5px] text-muted">{p.kind === 'exec' ? 'exec' : p.type ? tc.adapter.types.format(p.type) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ParamsEditor({ params, onCommit, label }: { params: ParamDecl[]; onCommit: (p: ParamInput[]) => void; label: string }) {
  const list: ParamInput[] = params.map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default } : {}) }));
  return (
    <Row label={label}>
      {params.map((p, i) => (
        <div key={p.id} className="mb-1 flex gap-1">
          <CommitInput value={p.name} onCommit={(v) => onCommit(list.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
          <TypeInput value={p.type} onCommit={(v) => onCommit(list.map((x, j) => (j === i ? { ...x, type: v } : x)))} />
          <IconButton label={`Remove ${p.name}`} onClick={() => onCommit(list.filter((_, j) => j !== i))}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
      <button
        className="flex items-center gap-1 text-[11.5px] text-accent hover:underline"
        onClick={() => {
          let n = 'arg';
          for (let i = 2; params.some((p) => p.name === n); i++) n = `arg${i}`;
          onCommit([...list, { name: n, type: 'float' }]);
        }}
      >
        <Plus size={12} /> Add parameter
      </button>
    </Row>
  );
}

function VariableEditor({ v, script, fn }: { v: VariableDecl; script: ScriptDoc; fn?: FunctionDecl }) {
  const project = useEditor((s) => s.project)!;
  const tc = toolchainFor(project.language);
  const t = resolveType(tc.adapter, v.type).type;
  const base = { variable: v.id, ...(fn ? { function: fn.id } : { script: script.id }) };
  const upd = (patch: Record<string, unknown>, label: string, merge?: string) => d([{ op: 'update_variable', ...base, ...patch } as EditOp], label, merge);
  const fields = t?.kind === 'named' ? tc.adapter.types.structFields(t.name) : undefined;
  return (
    <div data-testid="variable-inspector">
      <Row label="Name">
        <CommitInput value={v.name} onCommit={(name) => upd({ name }, 'Rename variable')} testId="var-name" />
      </Row>
      <Row label="Type">
        <TypeInput value={v.type} onCommit={(type) => upd({ type, default: null }, 'Change type')} testId="var-type" />
      </Row>
      <Row label="Default value">
        {t?.kind === 'bool' ? (
          <input type="checkbox" checked={v.default === true} onChange={(e) => upd({ default: e.target.checked }, 'Set default')} />
        ) : t?.kind === 'int' || t?.kind === 'float' ? (
          <input className={inputCls} type="number" step={t.kind === 'int' ? 1 : 'any'} value={typeof v.default === 'number' ? v.default : ''} placeholder="(none)" onChange={(e) => upd({ default: e.target.value === '' ? null : t.kind === 'int' ? Math.trunc(+e.target.value) : +e.target.value }, 'Set default', `vdef:${v.id}`)} data-testid="var-default" />
        ) : t?.kind === 'string' ? (
          <input className={inputCls} value={typeof v.default === 'string' ? v.default : ''} onChange={(e) => upd({ default: e.target.value }, 'Set default', `vdef:${v.id}`)} data-testid="var-default" />
        ) : fields ? (
          <div className="flex gap-1">
            {fields.map((f) => {
              const o = (v.default && typeof v.default === 'object' && !Array.isArray(v.default) ? v.default : {}) as Record<string, JsonValue>;
              return <input key={f.name} aria-label={f.name} className={inputCls} type="number" step="any" value={typeof o[f.name] === 'number' ? (o[f.name] as number) : 0} onChange={(e) => upd({ default: { ...Object.fromEntries(fields.map((x) => [x.name, typeof o[x.name] === 'number' ? o[x.name] : 0])), [f.name]: +e.target.value } }, 'Set default', `vdef:${v.id}`)} />;
            })}
          </div>
        ) : t?.kind === 'named' && script.enums.some((e) => e.name === t.name) ? (
          <select className={inputCls} value={String(v.default ?? '')} onChange={(e) => upd({ default: e.target.value || null }, 'Set default')}>
            <option value="">(first member)</option>
            {script.enums.find((e) => e.name === t.name)!.members.map((m) => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
        ) : (
          <div className="text-[11px] text-muted">{t?.kind === 'named' ? 'Objects start as null.' : 'Set in the graph.'}</div>
        )}
      </Row>
      {!fn && (
        <>
          {tc.adapter.capabilities.exportedVariables && (
            <label className="mb-1.5 flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!v.exported} onChange={(e) => upd({ exported: e.target.checked }, 'Toggle export')} data-testid="var-exported" /> Exported (@export — editable in the Godot inspector)
            </label>
          )}
          <label className="mb-2.5 flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={!!v.constant} onChange={(e) => upd({ constant: e.target.checked }, 'Toggle constant')} /> Constant
          </label>
          {project.language === 'gdscript' && (
            <Row label="@onready node path" hint="Initialise from a scene node when the node is ready, e.g. Head/Camera3D">
              <CommitInput value={typeof v.attributes?.onreadyPath === 'string' ? v.attributes.onreadyPath : ''} placeholder="(none)" onCommit={(p) => upd({ attributes: p ? { ...v.attributes, onreadyPath: p } : null }, 'Set @onready path')} />
            </Row>
          )}
        </>
      )}
      <Row label="Description">
        <textarea className={`${inputCls} h-14 py-1`} value={v.description ?? ''} onChange={(e) => upd({ description: e.target.value }, 'Edit description', `vdesc:${v.id}`)} />
      </Row>
    </div>
  );
}

/** "Program starts here": the project's entry point, its host, and how to run it. */
function EntryPointEditor({ fn }: { fn: FunctionDecl }) {
  const project = useEditor((s) => s.project)!;
  const result = useCompile((s) => s.result);
  const ep = toolchainFor(project.language).adapter.entryPoint;
  if (!ep) return null;
  const isEntry = project.entry?.functionId === fn.id;
  const info = isEntry ? result?.scripts.find((s) => s.entry?.functionId === fn.id)?.entry : undefined;
  const host = project.entry?.host;
  return (
    <div className={`mb-3 rounded border px-2.5 py-2 text-[12px] ${isEntry ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-border'}`} data-testid="entry-point">
      <label className="flex items-center gap-1.5 font-medium">
        <input type="checkbox" checked={isEntry} data-testid="entry-toggle" onChange={(e) => d([{ op: 'update_project', entry: e.target.checked ? { function: fn.id } : null } as EditOp], e.target.checked ? `Start the program at ${fn.name}` : 'No entry point')} />
        ▶ Program starts here
      </label>
      {isEntry && (
        <>
          <select className={`${inputCls} mt-2`} value={host} onChange={(e) => d([{ op: 'update_project', entry: { function: fn.id, host: e.target.value } } as EditOp], 'Change where the program runs')} data-testid="entry-host">
            {ep.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted">{ep.hosts.find((h) => h.id === host)?.description}</p>
          {info?.instructions.map((t, i) => (
            <p key={i} className="mt-1 text-[11px] text-emerald-200" data-testid="entry-instructions">
              {t}
            </p>
          ))}
        </>
      )}
      {!isEntry && project.entry && <p className="mt-1 text-[11px] text-muted">The program currently starts at {project.scripts.flatMap((s) => s.functions).find((f) => f.id === project.entry!.functionId)?.name ?? '(missing)'}.</p>}
    </div>
  );
}

function FunctionEditor({ fn, script }: { fn: FunctionDecl; script: ScriptDoc }) {
  const isEvent = fn.kind === 'event';
  const project = useEditor((s) => s.project)!;
  const ev = isEvent ? toolchainFor(project.language).adapter.events.find((e) => e.id === fn.event) : undefined;
  const upd = (patch: Record<string, unknown>, label: string, merge?: string) => d([{ op: 'update_function', function: fn.id, ...patch } as EditOp], label, merge);
  return (
    <div data-testid="function-inspector">
      <div className="mb-3 text-[14px] font-semibold">{isEvent ? `Event ${fn.name}` : `Function ${fn.name}`}</div>
      {fn.kind !== 'lambda' && <EntryPointEditor fn={fn} />}
      {isEvent ? (
        <p className="mb-3 text-[12px] text-[#c3c9d4]">{ev?.description} The engine calls it with a fixed signature.</p>
      ) : (
        <>
          <Row label="Name">
            <CommitInput value={fn.name} onCommit={(name) => upd({ name }, 'Rename function')} testId="fn-name" />
          </Row>
          <ParamsEditor label="Parameters" params={fn.params} onCommit={(params) => upd({ params }, 'Edit parameters')} />
          <Row label="Return type">
            <TypeInput value={fn.returnType} onCommit={(returnType) => upd({ returnType }, 'Change return type')} testId="fn-return" />
          </Row>
          <Row label="Description">
            <textarea className={`${inputCls} h-14 py-1`} value={fn.description ?? ''} onChange={(e) => upd({ description: e.target.value }, 'Edit description', `fdesc:${fn.id}`)} />
          </Row>
          {project.language !== 'gdscript' && (
            <div className="mb-2 flex gap-4 text-[12px]">
              {toolchainFor(project.language).adapter.capabilities.async && (
                <label className="flex items-center gap-1.5" title="Lets the function use Await; it returns a Promise.">
                  <input type="checkbox" checked={!!fn.async} onChange={(e) => upd({ async: e.target.checked }, e.target.checked ? 'Make async' : 'Make not async')} data-testid="fn-async" /> async
                </label>
              )}
              {project.language === 'typescript' && fn.kind === 'function' && (
                <label className="flex items-center gap-1.5" title="A React component: parameters are its props, it returns elements.">
                  <input type="checkbox" checked={!!fn.component} onChange={(e) => upd({ component: e.target.checked }, e.target.checked ? 'Make component' : 'Make plain function')} data-testid="fn-component" /> component
                </label>
              )}
              {toolchainFor(project.language).adapter.capabilities.modules && (
                <label className="flex items-center gap-1.5" title="Other files (and other scripts' Call nodes) can import it.">
                  <input type="checkbox" checked={!!fn.exported} onChange={(e) => upd({ exported: e.target.checked }, e.target.checked ? 'Export function' : 'Stop exporting function')} data-testid="fn-exported" /> export
                </label>
              )}
            </div>
          )}
        </>
      )}
      <Row label="Local variables">
        {fn.locals.map((l) => (
          <details key={l.id} className="mb-1 rounded border border-border px-2 py-1">
            <summary className="cursor-pointer text-[12px]">
              {l.name}: <span className="font-mono text-muted">{l.type}</span>
            </summary>
            <div className="mt-2">
              <VariableEditor v={l} script={script} fn={fn} />
              {project.language === 'typescript' && (fn.component || /^use[A-Z]/.test(fn.name)) && (
                <label className="mb-2 flex items-center gap-1.5 text-[12px]" title="Remembered between renders; Set re-renders the component (useState).">
                  <input type="checkbox" checked={l.attributes?.state === true} onChange={(e) => d([{ op: 'update_variable', variable: l.id, function: fn.id, attributes: { ...(l.attributes ?? {}), state: e.target.checked } }], e.target.checked ? 'Make React state' : 'Make plain variable')} data-testid="local-state" /> React state
                </label>
              )}
              <button className="mb-1 text-[11.5px] text-err hover:underline" onClick={() => d([{ op: 'delete_variable', variable: l.id, function: fn.id }], 'Delete local')}>
                Delete local variable
              </button>
            </div>
          </details>
        ))}
        <button
          className="flex items-center gap-1 text-[11.5px] text-accent hover:underline"
          onClick={() => {
            const taken = new Set([...fn.params, ...fn.locals, ...script.variables, ...script.functions, ...script.signals].map((x) => x.name));
            let n = 'temp';
            for (let i = 2; taken.has(n); i++) n = `temp${i}`;
            d([{ op: 'add_variable', function: fn.id, name: n, type: 'float', default: 0 }], 'Add local variable');
          }}
        >
          <Plus size={12} /> Add local variable
        </button>
      </Row>
    </div>
  );
}

function ScriptEditor({ script }: { script: ScriptDoc }) {
  const project = useEditor((s) => s.project)!;
  const adapter = toolchainFor(project.language).adapter;
  const upd = (patch: Record<string, unknown>, label: string, merge?: string) => d([{ op: 'update_script', script: script.id, ...patch } as EditOp], label, merge);
  return (
    <div data-testid="script-inspector">
      <div className="mb-3 text-[14px] font-semibold">Script {script.name}</div>
      <Row label="Name">
        <CommitInput value={script.name} onCommit={(name) => upd({ name }, 'Rename script')} />
      </Row>
      <Row label={`Output path (${adapter.extensions[0]} added)`}>
        <CommitInput value={script.path} onCommit={(path) => upd({ path }, 'Change path')} mono testId="script-path" />
      </Row>
      {adapter.scriptSettings.map((p) => (
        <Row key={p.key} label={p.label} hint={p.description}>
          {p.kind === 'boolean' ? (
            <input type="checkbox" checked={script.settings[p.key] === true} onChange={(e) => upd({ settings: { [p.key]: e.target.checked } }, `Set ${p.label}`)} />
          ) : (
            <CommitInput value={String(script.settings[p.key] ?? '')} onCommit={(v) => upd({ settings: { [p.key]: v } }, `Set ${p.label}`)} testId={`setting-${p.key}`} list={p.key === 'extends' ? 'cs-types' : undefined} />
          )}
          {p.description && <div className="mt-0.5 text-[10.5px] text-muted">{p.description}</div>}
        </Row>
      ))}
      <Row label="Description">
        <textarea className={`${inputCls} h-14 py-1`} value={script.description ?? ''} onChange={(e) => upd({ description: e.target.value }, 'Edit description', `sdesc:${script.id}`)} />
      </Row>
    </div>
  );
}

function SignalEditor({ id, script }: { id: string; script: ScriptDoc }) {
  const s = script.signals.find((x) => x.id === id);
  if (!s) return null;
  return (
    <div>
      <div className="mb-3 text-[14px] font-semibold">Signal {s.name}</div>
      <Row label="Name">
        <CommitInput value={s.name} onCommit={(name) => d([{ op: 'update_signal', signal: s.id, name }], 'Rename signal')} />
      </Row>
      <ParamsEditor label="Parameters" params={s.params} onCommit={(params) => d([{ op: 'update_signal', signal: s.id, params }], 'Edit signal parameters')} />
    </div>
  );
}

function EnumEditor({ id, script }: { id: string; script: ScriptDoc }) {
  const e = script.enums.find((x) => x.id === id);
  if (!e) return null;
  return (
    <div>
      <div className="mb-3 text-[14px] font-semibold">Enum {e.name}</div>
      <Row label="Name">
        <CommitInput value={e.name} onCommit={(name) => d([{ op: 'update_enum', enum: e.id, name }], 'Rename enum')} />
      </Row>
      <Row label="Members">
        <StringList value={e.members.map((m) => m.name)} onCommit={(members) => d([{ op: 'update_enum', enum: e.id, members }], 'Edit enum members')} />
      </Row>
    </div>
  );
}

function InterfaceEditor({ id, script }: { id: string; script: ScriptDoc }) {
  const t = (script.interfaces ?? []).find((x) => x.id === id);
  if (!t) return null;
  const upd = (patch: Record<string, unknown>, label: string) => d([{ op: 'update_interface', interface: t.id, ...patch } as EditOp], label);
  const fields = t.fields;
  const setField = (i: number, patch: Partial<(typeof fields)[number]>) => upd({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }, 'Edit field');
  return (
    <div data-testid="interface-inspector">
      <div className="mb-3 text-[14px] font-semibold">Type {t.name}</div>
      <Row label="Name">
        <CommitInput value={t.name} onCommit={(name) => upd({ name }, 'Rename type')} testId="type-name" />
      </Row>
      <label className="mb-2 flex items-center gap-1.5 text-[12px]">
        <input type="checkbox" checked={!!t.exported} onChange={(e) => upd({ exported: e.target.checked }, 'Export type')} /> export
      </label>
      <Row label="Fields">
        {fields.map((f, i) => (
          <div key={`${f.name}-${i}`} className="mb-1 flex items-center gap-1">
            <div className="w-[38%]">
              <CommitInput value={f.name} onCommit={(name) => setField(i, { name })} mono />
            </div>
            <div className="flex-1">
              <TypeInput value={f.type} onCommit={(type) => setField(i, { type })} />
            </div>
            <label className="flex items-center gap-0.5 text-[11px] text-muted" title="Optional field (may be missing)">
              <input type="checkbox" checked={!!f.optional} onChange={(e) => setField(i, { optional: e.target.checked })} />?
            </label>
            <button className="px-1 text-muted hover:text-err" aria-label={`Remove ${f.name}`} onClick={() => upd({ fields: fields.filter((_, j) => j !== i) }, 'Remove field')}>
              ×
            </button>
          </div>
        ))}
        <button
          className="text-[12px] text-accent hover:underline"
          data-testid="add-field"
          onClick={() => {
            let n = 'field';
            for (let i = 2; fields.some((f) => f.name === n); i++) n = `field${i}`;
            upd({ fields: [...fields, { name: n, type: 'string' }] }, 'Add field');
          }}
        >
          + Add field
        </button>
      </Row>
      <Row label="Description">
        <CommitInput value={t.description ?? ''} onCommit={(description) => upd({ description }, 'Edit description')} />
      </Row>
    </div>
  );
}

function ProjectEditor() {
  const project = useEditor((s) => s.project)!;
  const adapter = toolchainFor(project.language).adapter;
  const cs = project.compilerSettings;
  const upd = (op: Omit<Extract<EditOp, { op: 'update_project' }>, 'op'>, label: string, merge?: string) => d([{ op: 'update_project', ...op }], label, merge);
  return (
    <div>
      <div className="mb-3 text-[14px] font-semibold">Project</div>
      <Row label="Name">
        <CommitInput value={project.name} onCommit={(name) => upd({ name }, 'Rename project')} />
      </Row>
      <Row label="Language">
        <div className="text-[12px]">{adapter.name}</div>
      </Row>
      <Row label="Target version">
        <select className={inputCls} value={project.languageVersion} onChange={(e) => upd({ languageVersion: e.target.value }, 'Change version')}>
          {adapter.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Indentation">
        <select className={inputCls} value={cs.indent} onChange={(e) => upd({ compilerSettings: { indent: e.target.value as 'tab' | 'spaces' } }, 'Change indentation')}>
          <option value="tab">Tabs (Godot default)</option>
          <option value="spaces">Spaces</option>
        </select>
      </Row>
      <label className="mb-1.5 flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={cs.header} onChange={(e) => upd({ compilerSettings: { header: e.target.checked } }, 'Toggle header')} /> "Generated by" header comment
      </label>
      <label className="mb-2.5 flex items-center gap-2 text-[12px]">
        <input type="checkbox" checked={cs.comments} onChange={(e) => upd({ compilerSettings: { comments: e.target.checked } }, 'Toggle doc comments')} /> Emit descriptions as ## doc comments
      </label>
      <Row label="Description">
        <textarea className={`${inputCls} h-14 py-1`} value={project.description ?? ''} onChange={(e) => upd({ description: e.target.value }, 'Edit description', 'pdesc')} />
      </Row>
    </div>
  );
}

export function Inspector() {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  const activeScriptId = useEditor((s) => s.activeScriptId);
  const activeFunctionId = useEditor((s) => s.activeFunctionId);
  const inspect = useUI((s) => s.inspect);
  const script = project.scripts.find((s) => s.id === activeScriptId);
  const fn = script?.functions.find((f) => f.id === activeFunctionId);
  let body: React.ReactNode;
  if (script && fn && selection.nodes.length === 1) body = <NodeInspector nodeId={selection.nodes[0]} script={script} fn={fn} />;
  else if (selection.nodes.length > 1) body = <div className="text-muted">{selection.nodes.length} nodes selected. Ctrl+D duplicates, Del deletes, C wraps them in a comment frame.</div>;
  else if (inspect?.kind === 'project') body = <ProjectEditor />;
  else if (script && inspect?.kind === 'variable' && script.variables.some((v) => v.id === inspect.id)) body = <VariableEditor v={script.variables.find((v) => v.id === inspect.id)!} script={script} />;
  else if (script && inspect?.kind === 'signal') body = <SignalEditor id={inspect.id!} script={script} />;
  else if (script && inspect?.kind === 'enum') body = <EnumEditor id={inspect.id!} script={script} />;
  else if (script && inspect?.kind === 'interface') body = <InterfaceEditor id={inspect.id!} script={script} />;
  else if (script && inspect?.kind === 'script') body = <ScriptEditor script={script} />;
  else if (script && fn) body = <FunctionEditor fn={fn} script={script} />;
  else if (script) body = <ScriptEditor script={script} />;
  else body = <ProjectEditor />;
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Inspector
        <button className="ml-auto font-normal normal-case text-accent hover:underline" onClick={() => {
            useEditor.getState().select([]);
            useUI.getState().set({ inspect: { kind: 'project' } });
          }}>
          Project settings
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {script && <TypeDatalist script={script} />}
        {body}
      </div>
    </div>
  );
}
