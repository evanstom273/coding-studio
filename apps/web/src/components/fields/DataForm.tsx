/**
 * Visual editing of structured data (JSON / YAML / TOML / XML / .properties):
 *  - SchemaForm: understandable fields from a schema (labels, choices, descriptions), with maps,
 *    lists and nested objects, and "other fields" for anything the schema doesn't know (kept).
 *  - DataTree: any value as an expandable tree (add / rename / retype / duplicate / move / delete).
 * Both only emit edits; the file format applies them without disturbing the rest of the file.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { convert, emptyOf, getIn, initialValue, isObject, pathKey, pick, suggestKeys, typeOf, type Edit, type Issue, type Path, type Schema, type Value, type ValueType } from '@cs/structured-data';
import { cx } from '../ui/primitives';
import { ColorControl, ctl, FieldRow, NumberControl, SelectControl, TagsControl, TextControl, ToggleControl } from './controls';

interface Ctx {
  root: Value | undefined;
  issues: Map<string, Issue[]>;
  edit: (edits: Edit[], mergeKey?: string) => void;
  showAll: boolean;
}
const DataCtx = createContext<Ctx | null>(null);
const useData = () => useContext(DataCtx)!;

const typesOf = (s?: Schema): ValueType[] => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
const TYPE_LABEL: Record<ValueType, string> = { string: 'Text', number: 'Number', boolean: 'Yes / no', null: 'Empty', object: 'Group', array: 'List' };

function issueFor(path: Path) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { issues } = useData();
  const list = issues.get(pathKey(path)) ?? [];
  return { error: list.find((i) => i.severity === 'error')?.message, warning: list.find((i) => i.severity === 'warning')?.message };
}

export function DataEditor({ root, schema, issues, onEdit, mode }: { root: Value | undefined; schema?: Schema; issues: Issue[]; onEdit: Ctx['edit']; mode: 'form' | 'tree' }) {
  const [showAll, setShowAll] = useState(false);
  const map = new Map<string, Issue[]>();
  for (const i of issues) map.set(pathKey(i.path), [...(map.get(pathKey(i.path)) ?? []), i]);
  return (
    <DataCtx.Provider value={{ root, issues: map, edit: onEdit, showAll }}>
      {mode === 'form' && schema ? (
        <div className="space-y-3">
          {schema.description && <p className="text-[12px] text-muted">{schema.description}</p>}
          <ObjectFields schema={schema} value={root} path={[]} grouped />
          <button type="button" className="text-[11.5px] text-accent hover:underline" onClick={() => setShowAll((v) => !v)} data-testid="data-show-all">
            {showAll ? 'Show the usual fields only' : 'Show all fields'}
          </button>
        </div>
      ) : (
        <DataTree value={root} />
      )}
    </DataCtx.Provider>
  );
}

// --- schema form ---------------------------------------------------------------------------------

function ObjectFields({ schema, value, path, grouped }: { schema: Schema; value: Value | undefined; path: Path; grouped?: boolean }) {
  const { showAll, edit } = useData();
  const obj = isObject(value) ? value : {};
  const props = Object.entries(schema.properties ?? {});
  const visible = props.filter(([k, s]) => showAll || !s.advanced || k in obj || (schema.required ?? []).includes(k));
  const known = new Set(props.map(([k]) => k));
  const others = Object.keys(obj).filter((k) => !known.has(k));
  const groups = new Map<string, [string, Schema][]>();
  for (const e of visible) {
    const g = grouped ? (e[1].group ?? 'General') : '';
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const hidden = props.length - visible.length;
  return (
    <div className="space-y-3">
      {[...groups].map(([g, entries]) => (
        <Section key={g} title={g} plain={!g}>
          {entries.map(([k, s]) => (
            <SchemaField key={k} name={k} schema={s} value={obj[k]} path={[...path, k]} required={(schema.required ?? []).includes(k)} />
          ))}
        </Section>
      ))}
      {schema.additionalProperties && !props.length && <MapEditor schema={schema} value={value} path={path} />}
      {!showAll && hidden > 0 && <div className="text-[11px] text-[#7d8696]">{hidden} more optional field(s) — “Show all fields”.</div>}
      {others.length > 0 && !schema.additionalProperties && (
        <Section title="Other fields" subtitle="Not described by this file's schema; kept as they are.">
          {others.map((k) => (
            <TreeNode key={k} name={k} value={obj[k]} path={[...path, k]} parent="object" index={Object.keys(obj).indexOf(k)} count={Object.keys(obj).length} />
          ))}
        </Section>
      )}
      {!isObject(value) && value !== undefined && (
        <button type="button" className="text-[11px] text-amber-200" onClick={() => edit([{ op: 'set', path, value: initialValue(schema) }])}>
          This should be a group of fields; replace it
        </button>
      )}
    </div>
  );
}

function Section({ title, subtitle, children, plain, defaultOpen = true }: { title: string; subtitle?: string; children: ReactNode; plain?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (plain) return <div className="space-y-3">{children}</div>;
  return (
    <section className="rounded border border-border" data-testid="data-section" data-title={title}>
      <button type="button" className="flex w-full items-center gap-1 px-2 py-2 text-left text-[12px] font-semibold" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {title}
        {subtitle && <span className="ml-1 font-normal text-[#7d8696]">{subtitle}</span>}
      </button>
      {open && <div className="space-y-3 px-3 pb-3">{children}</div>}
    </section>
  );
}

export function SchemaField({ name, schema: raw, value, path, required, label }: { name: string; schema: Schema; value: Value | undefined; path: Path; required?: boolean; label?: ReactNode }) {
  const { edit } = useData();
  const schema = pick(raw, value);
  const { error, warning } = issueFor(path);
  const title = label ?? raw.title ?? schema.title ?? name;
  const t = typesOf(schema)[0] ?? (value === undefined ? 'string' : typeOf(value));
  const set = (v: Value | undefined) => edit([v === undefined ? { op: 'delete', path } : { op: 'set', path, value: v }], `field:${pathKey(path)}`);
  const clear = !required && value !== undefined && (
    <button type="button" onClick={() => edit([{ op: 'delete', path }])} className="ml-1 align-middle text-[#7d8696] hover:text-red-300" title="Remove this field" aria-label={`Remove ${name}`} data-testid="field-remove">
      <X size={11} />
    </button>
  );
  const variants = raw.anyOf && raw.anyOf.length > 1 && (
    <select className="ml-2 rounded bg-transparent text-[10.5px] text-[#7d8696]" value={raw.anyOf.indexOf(schema)} onChange={(e) => edit([{ op: 'set', path, value: initialValue(raw.anyOf![+e.target.value]) }])} aria-label="Kind">
      {raw.anyOf.map((s, i) => (
        <option key={i} value={i}>
          {s.title ?? TYPE_LABEL[typesOf(s)[0] ?? 'string']}
        </option>
      ))}
    </select>
  );
  const head = (
    <>
      {title}
      {variants}
      {clear}
    </>
  );
  const testId = `field-${path.join('.')}`;

  if (schema.enum) {
    const opts = schema.enum.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number');
    return (
      <FieldRow label={head} description={raw.description ?? schema.description} error={error} warning={warning} required={required} testId={testId}>
        <SelectControl value={value as string | number | undefined} options={opts} labels={schema.enumLabels} onChange={(v) => set(v)} allowEmpty={required ? undefined : '(not set)'} testId={`${testId}-input`} />
      </FieldRow>
    );
  }
  if (t === 'boolean')
    return (
      <FieldRow label={head} description={raw.description ?? schema.description} error={error} required={required} testId={testId}>
        <ToggleControl value={value === true} onChange={(v) => set(v)} testId={`${testId}-input`} />
      </FieldRow>
    );
  if (t === 'number')
    return (
      <FieldRow label={head} description={raw.description ?? schema.description} error={error} warning={warning} required={required} testId={testId}>
        <NumberControl value={typeof value === 'number' ? value : undefined} min={schema.minimum} max={schema.maximum} onChange={(v) => set(v)} placeholder={schema.default !== undefined ? String(schema.default) : undefined} testId={`${testId}-input`} />
      </FieldRow>
    );
  if (t === 'string') {
    const control =
      schema.format === 'color' ? (
        <ColorControl value={typeof value === 'string' ? value : undefined} onChange={(v) => set(v)} testId={`${testId}-input`} />
      ) : (
        <TextControl value={typeof value === 'string' ? value : value === undefined ? '' : String(value)} onChange={(v) => set(v === '' && !required ? undefined : v)} placeholder={schema.placeholder ?? (schema.default !== undefined ? String(schema.default) : schema.examples?.[0] !== undefined ? String(schema.examples[0]) : undefined)} mono={schema.format === 'path' || schema.format === 'class-name' || schema.format === 'version-range'} testId={`${testId}-input`} />
      );
    return (
      <FieldRow label={head} description={raw.description ?? schema.description} error={error} warning={warning} required={required} testId={testId}>
        {control}
      </FieldRow>
    );
  }
  if (t === 'array') {
    const items = schema.items ? pick(schema.items) : undefined;
    const simple = items && typesOf(items)[0] === 'string' && !items.anyOf;
    const arr = Array.isArray(value) ? value : [];
    if (simple && arr.every((x) => typeof x === 'string'))
      return (
        <FieldRow label={head} description={raw.description ?? schema.description} error={error} required={required} testId={testId}>
          <TagsControl value={arr as string[]} onChange={(v) => set(v)} suggestions={items.enum?.map(String)} placeholder={items.title ? `Add ${items.title.toLowerCase()}…` : undefined} testId={`${testId}-input`} />
        </FieldRow>
      );
    return (
      <FieldRow label={head} description={raw.description ?? schema.description} error={error} required={required} testId={testId}>
        <ListEditor schema={schema} value={value} path={path} />
      </FieldRow>
    );
  }
  if (t === 'object') {
    // A map (keys you choose, like dependencies) is shown straight away, ready to add to.
    if (schema.additionalProperties && !schema.properties)
      return (
        <FieldRow label={head} description={raw.description ?? schema.description} error={error} required={required} testId={testId}>
          <MapEditor schema={schema} value={value} path={path} />
        </FieldRow>
      );
    if (value === undefined)
      return (
        <FieldRow label={head} description={raw.description ?? schema.description} error={error} required={required} testId={testId}>
          <button type="button" className={cx(ctl, 'flex items-center gap-1 text-muted hover:text-text')} onClick={() => set(initialValue(schema))} data-testid={`${testId}-add`}>
            <Plus size={12} /> Add {String(title).toLowerCase()}
          </button>
        </FieldRow>
      );
    return (
      <div data-testid={testId}>
        <Section title={String(raw.title ?? schema.title ?? name)} subtitle={raw.description ?? schema.description} defaultOpen>
          <ObjectFields schema={schema} value={value} path={path} />
        </Section>
      </div>
    );
  }
  return (
    <FieldRow label={head} error={error} testId={testId}>
      <TreeNode name={name} value={value as Value} path={path} parent="object" index={0} count={1} />
    </FieldRow>
  );
}

/** A map: one row per key (rename / remove), plus "add" with the schema's suggested keys. */
function MapEditor({ schema, value, path }: { schema: Schema; value: Value | undefined; path: Path }) {
  const { edit } = useData();
  const obj = isObject(value) ? value : {};
  const valueSchema = schema.additionalProperties || undefined;
  const [newKey, setNewKey] = useState('');
  const suggestions = suggestKeys({ ...schema, properties: undefined }, value);
  const add = (key: string, v?: Value) => {
    const k = key.trim();
    if (!k || k in obj) return;
    edit([{ op: 'set', path: [...path, k], value: v ?? initialValue(valueSchema) }]);
    setNewKey('');
  };
  const keyTitle = schema.keyTitle ?? 'Name';
  return (
    <div className="space-y-1.5" data-testid="map-editor">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="rounded border border-border/70 p-1.5" data-testid="map-row" data-key={k}>
          <div className="flex min-w-0 items-center gap-1">
            <KeyInput value={k} onRename={(to) => to !== k && !(to in obj) && edit([{ op: 'rename', path: [...path, k], to }])} label={keyTitle} />
            <button type="button" className="h-[36px] w-[32px] shrink-0 text-muted hover:text-red-300 sm:h-[28px]" onClick={() => edit([{ op: 'delete', path: [...path, k] }])} aria-label={`Remove ${k}`} data-testid="map-remove">
              <Trash2 size={12} className="mx-auto" />
            </button>
          </div>
          <div className="mt-1">{valueSchema ? <SchemaField name={k} label="" schema={valueSchema} value={v} path={[...path, k]} required /> : <TreeNode name={k} value={v} path={[...path, k]} parent="object" index={0} count={1} />}</div>
        </div>
      ))}
      <div className="flex min-w-0 gap-1">
        <input className={ctl} placeholder={`Add ${keyTitle.toLowerCase()}…`} value={newKey} list={suggestions.length ? `keys-${pathKey(path)}` : undefined} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(newKey, suggestions.find((s) => s.key === newKey.trim())?.value)} data-testid="map-new-key" />
        <button type="button" className={cx(ctl, 'w-auto shrink-0 px-3')} onClick={() => add(newKey, suggestions.find((s) => s.key === newKey.trim())?.value)} data-testid="map-add">
          <Plus size={12} />
        </button>
      </div>
      {suggestions.length > 0 && (
        <>
          <datalist id={`keys-${pathKey(path)}`}>
            {suggestions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.description}
              </option>
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1">
            {suggestions.slice(0, 8).map((s) => (
              <button key={s.key} type="button" title={s.description} onClick={() => add(s.key, s.value)} className="rounded-full border border-border px-2 py-1 text-[11px] text-muted hover:text-text sm:py-0.5" data-testid="map-suggestion" data-key={s.key}>
                + {s.key}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function KeyInput({ value, onRename, label }: { value: string; onRename: (to: string) => void; label?: string }) {
  const [v, setV] = useState(value);
  return <input className={cx(ctl, 'font-mono')} aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => (v.trim() ? onRename(v.trim()) : setV(value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid="key-input" />;
}

/** A list of objects (or mixed values): each item a card with move / duplicate / delete. */
function ListEditor({ schema, value, path }: { schema: Schema; value: Value | undefined; path: Path }) {
  const { edit } = useData();
  const arr = Array.isArray(value) ? value : [];
  const items = schema.items;
  const itemTitle = items?.title ?? 'item';
  return (
    <div className="space-y-1.5" data-testid="list-editor">
      {arr.map((v, i) => (
        <div key={i} className="rounded border border-border/70 p-1.5" data-testid="list-item">
          <div className="mb-1 flex items-center gap-1 text-[11px] text-muted">
            <span className="flex-1">
              {itemTitle} {i + 1}
            </span>
            <ItemActions path={[...path, i]} index={i} count={arr.length} onDuplicate={() => edit([{ op: 'insert', path, index: i + 1, value: v }])} />
          </div>
          {items ? <SchemaField name={String(i)} label="" schema={items} value={v} path={[...path, i]} required /> : <TreeNode name={String(i)} value={v} path={[...path, i]} parent="array" index={i} count={arr.length} />}
        </div>
      ))}
      <button type="button" className={cx(ctl, 'flex items-center justify-center gap-1 text-muted hover:text-text')} onClick={() => edit([{ op: 'insert', path, value: initialValue(items) }])} data-testid="list-add">
        <Plus size={12} /> Add {itemTitle.toLowerCase()}
      </button>
    </div>
  );
}

function ItemActions({ path, index, count, onDuplicate }: { path: Path; index: number; count: number; onDuplicate: () => void }) {
  const { edit } = useData();
  const b = 'h-[32px] w-[32px] sm:h-[24px] sm:w-[24px] rounded text-muted hover:text-text disabled:opacity-30';
  return (
    <span className="flex items-center">
      <button type="button" className={b} disabled={index === 0} onClick={() => edit([{ op: 'move', path, to: index - 1 }])} aria-label="Move up" data-testid="item-up">
        <ArrowUp size={12} className="mx-auto" />
      </button>
      <button type="button" className={b} disabled={index === count - 1} onClick={() => edit([{ op: 'move', path, to: index + 1 }])} aria-label="Move down" data-testid="item-down">
        <ArrowDown size={12} className="mx-auto" />
      </button>
      <button type="button" className={b} onClick={onDuplicate} aria-label="Duplicate" data-testid="item-duplicate">
        <Copy size={12} className="mx-auto" />
      </button>
      <button type="button" className={cx(b, 'hover:text-red-300')} onClick={() => edit([{ op: 'delete', path }])} aria-label="Delete" data-testid="item-delete">
        <Trash2 size={12} className="mx-auto" />
      </button>
    </span>
  );
}

// --- generic tree --------------------------------------------------------------------------------

export function DataTree({ value }: { value: Value | undefined }) {
  const { edit } = useData();
  if (value === undefined)
    return (
      <div className="space-y-2 text-[12px] text-muted">
        <p>The file is empty.</p>
        <button type="button" className={cx(ctl, 'w-auto px-3')} onClick={() => edit([{ op: 'set', path: [], value: {} }])}>
          Start with a group of fields
        </button>
      </div>
    );
  return (
    <div data-testid="data-tree">
      <ChildRows value={value} path={[]} depth={0} />
    </div>
  );
}

function ChildRows({ value, path, depth }: { value: Value; path: Path; depth: number }) {
  const { edit } = useData();
  const entries: [string | number, Value][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : isObject(value) ? Object.entries(value) : [];
  const addChild = () => {
    if (Array.isArray(value)) edit([{ op: 'insert', path, value: '' }]);
    else if (isObject(value)) {
      let k = 'newField';
      for (let i = 2; k in value; i++) k = `newField${i}`;
      edit([{ op: 'set', path: [...path, k], value: '' }]);
    }
  };
  return (
    <div className={cx(depth > 0 && 'ml-3 border-l border-border/60 pl-2')}>
      {entries.map(([k, v], i) => (
        <TreeNode key={String(k)} name={String(k)} value={v} path={[...path, k]} parent={Array.isArray(value) ? 'array' : 'object'} index={i} count={entries.length} depth={depth} />
      ))}
      <button type="button" className="my-1 flex h-[32px] items-center gap-1 px-1 text-[11.5px] text-muted hover:text-text sm:h-[24px]" onClick={addChild} data-testid="tree-add">
        <Plus size={12} /> {Array.isArray(value) ? 'Add item' : 'Add field'}
      </button>
    </div>
  );
}

export function TreeNode({ name, value, path, parent, index, count, depth = 0 }: { name: string; value: Value; path: Path; parent: 'object' | 'array'; index: number; count: number; depth?: number }) {
  const { edit, root } = useData();
  const [open, setOpen] = useState(depth < 2);
  const [menu, setMenu] = useState(false);
  const { error, warning } = issueFor(path);
  const t = typeOf(value);
  const container = t === 'object' || t === 'array';
  const set = (v: Value) => edit([{ op: 'set', path, value: v }], `tree:${pathKey(path)}`);
  const duplicate = () => {
    const parentPath = path.slice(0, -1);
    if (parent === 'array') edit([{ op: 'insert', path: parentPath, index: index + 1, value }]);
    else {
      const siblings = getIn(root, parentPath) as Record<string, Value>;
      let k = `${name}Copy`;
      for (let i = 2; siblings && k in siblings; i++) k = `${name}Copy${i}`;
      edit([{ op: 'set', path: [...parentPath, k], value }]);
    }
  };
  const summary = t === 'array' ? `${(value as Value[]).length} item(s)` : t === 'object' ? `${Object.keys(value as object).length} field(s)` : '';
  return (
    <div data-testid="tree-node" data-path={pathKey(path)}>
      <div className="flex min-w-0 items-center gap-1 py-0.5">
        {container ? (
          <button type="button" className="h-[32px] w-6 shrink-0 text-muted sm:h-[24px]" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'} data-testid="tree-toggle">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <div className="w-24 shrink-0 sm:w-32">{parent === 'object' ? <KeyInput value={name} onRename={(to) => to !== name && edit([{ op: 'rename', path, to }])} /> : <span className="px-1 font-mono text-[11.5px] text-muted">{index}</span>}</div>
        <select className={cx(ctl, 'w-[5.5rem] shrink-0 px-1 text-[11px]')} value={t} onChange={(e) => set(convert(value, e.target.value as ValueType))} aria-label="Type" data-testid="tree-type">
          {(Object.keys(TYPE_LABEL) as ValueType[]).map((x) => (
            <option key={x} value={x}>
              {TYPE_LABEL[x]}
            </option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          {t === 'string' && <TextControl value={value as string} onChange={(v) => set(v)} testId="tree-value" />}
          {t === 'number' && <NumberControl value={value as number} onChange={(v) => set(v ?? 0)} testId="tree-value" />}
          {t === 'boolean' && <ToggleControl value={value as boolean} onChange={(v) => set(v)} testId="tree-value" />}
          {t === 'null' && <span className="px-1 text-[11.5px] text-[#7d8696]">empty</span>}
          {container && <span className="px-1 text-[11.5px] text-[#7d8696]">{summary}</span>}
        </div>
        <button type="button" className="h-[32px] w-[32px] shrink-0 rounded text-muted hover:text-text sm:h-[24px] sm:w-[24px]" onClick={() => setMenu((m) => !m)} aria-label="More" data-testid="tree-menu">
          <MoreHorizontal size={13} className="mx-auto" />
        </button>
      </div>
      {(error || warning) && <div className={cx('ml-7 text-[11px]', error ? 'text-red-300' : 'text-amber-200')}>{error ?? warning}</div>}
      {menu && (
        <div className="mb-1 ml-7 flex flex-wrap gap-1">
          <ItemActions path={path} index={index} count={count} onDuplicate={duplicate} />
          {t !== 'object' && (
            <button type="button" className="rounded border border-border px-2 text-[11px] text-muted hover:text-text" onClick={() => set(emptyOf('object'))}>
              Make a group
            </button>
          )}
        </div>
      )}
      {container && open && <ChildRows value={value} path={path} depth={depth + 1} />}
    </div>
  );
}
