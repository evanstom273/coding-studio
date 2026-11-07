/**
 * Shared value controls used by every visual editor (config files, styles, animations, HTML
 * attributes): text, number (with unit), yes/no, choice, colour, and a list of short strings.
 * Sized for fingers on touch screens (h-[36px]) and compact with a mouse.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Minus, Plus, X } from 'lucide-react';
import { cx } from '../ui/primitives';

export const ctl = 'w-full min-w-0 rounded border border-border bg-[#0f1218] px-2 h-[36px] sm:h-[28px] text-[13px] sm:text-[12px] text-text placeholder:text-[#5b6372] focus:border-accent focus:outline-none';

/** Label + description + error around a control. */
export function FieldRow({ label, description, error, warning, children, required, inline, testId }: { label?: ReactNode; description?: ReactNode; error?: string; warning?: string; children: ReactNode; required?: boolean; inline?: boolean; testId?: string }) {
  return (
    <div className={cx('min-w-0', inline ? 'flex items-center gap-2' : 'space-y-1')} data-testid={testId}>
      {label !== undefined && (
        <div className={cx('text-[11.5px] text-muted', inline && 'w-28 shrink-0')}>
          {label}
          {required && <span className="text-red-300"> *</span>}
        </div>
      )}
      <div className="min-w-0 flex-1">
        {children}
        {error && <div className="mt-0.5 text-[11px] text-red-300" data-testid="field-error">{error}</div>}
        {!error && warning && <div className="mt-0.5 text-[11px] text-amber-200" data-testid="field-warning">{warning}</div>}
        {description && !inline && <div className="mt-0.5 text-[10.5px] leading-snug text-[#7d8696]">{description}</div>}
      </div>
    </div>
  );
}

/** Text that writes as you type (callers merge the keystrokes into one undo step). */
export function TextControl({ value, onChange, placeholder, multiline, mono, testId, list }: { value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean; testId?: string; list?: string }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  const props = {
    value: v,
    placeholder,
    'data-testid': testId,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      setV(value);
    },
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value);
      onChange(e.target.value);
    },
  };
  return multiline ? <textarea {...props} rows={3} className={cx(ctl, 'h-auto py-1.5 sm:h-auto', mono && 'font-mono')} /> : <input {...props} list={list} className={cx(ctl, mono && 'font-mono')} />;
}

/** A number: typed (committed on blur / Enter, so "1." is fine while typing) or stepped. */
export function NumberControl({ value, onChange, min, max, step = 1, unit, units, onUnit, placeholder, testId }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; unit?: string; units?: string[]; onUnit?: (u: string) => void; placeholder?: string; testId?: string }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const commit = (t: string) => {
    if (!t.trim()) return onChange(undefined);
    const n = Number(t);
    if (Number.isFinite(n)) onChange(clamp(n));
    else setText(value === undefined ? '' : String(value));
  };
  const bump = (d: number) => onChange(clamp(Math.round(((value ?? 0) + d) * 1000) / 1000));
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" className="h-[36px] w-[32px] shrink-0 rounded border border-border text-muted hover:text-text sm:h-[28px] sm:w-[24px]" onClick={() => bump(-step)} aria-label="Less">
        <Minus size={12} className="mx-auto" />
      </button>
      <input inputMode="decimal" className={cx(ctl, 'text-center')} value={text} placeholder={placeholder} data-testid={testId} onChange={(e) => setText(e.target.value)} onBlur={() => commit(text)} onKeyDown={(e) => e.key === 'Enter' && commit(text)} />
      <button type="button" className="h-[36px] w-[32px] shrink-0 rounded border border-border text-muted hover:text-text sm:h-[28px] sm:w-[24px]" onClick={() => bump(step)} aria-label="More">
        <Plus size={12} className="mx-auto" />
      </button>
      {units && onUnit ? (
        <select className={cx(ctl, 'w-16 shrink-0 px-1')} value={unit} onChange={(e) => onUnit(e.target.value)}>
          {units.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      ) : (
        unit && <span className="shrink-0 text-[11px] text-muted">{unit}</span>
      )}
    </div>
  );
}

export function ToggleControl({ value, onChange, label, testId }: { value: boolean; onChange: (v: boolean) => void; label?: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)} className="flex h-[36px] items-center gap-2 text-[12px] sm:h-[28px]" data-testid={testId}>
      <span className={cx('relative h-5 w-[36px] rounded-full transition-colors', value ? 'bg-accent' : 'bg-[#2a303c]')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', value ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label && <span className="text-text">{label}</span>}
    </button>
  );
}

export function SelectControl<T extends string | number>({ value, options, onChange, labels, allowEmpty, testId }: { value: T | undefined; options: readonly T[]; onChange: (v: T | undefined) => void; labels?: Record<string, string> | string[]; allowEmpty?: string; testId?: string }) {
  const label = (o: T, i: number) => (Array.isArray(labels) ? labels[i] : labels?.[String(o)]) ?? String(o);
  return (
    <div className="relative">
      <select
        className={cx(ctl, 'appearance-none pr-7')}
        value={value === undefined ? '' : String(value)}
        data-testid={testId}
        onChange={(e) => {
          const o = options.find((x) => String(x) === e.target.value);
          onChange(o);
        }}
      >
        {(allowEmpty !== undefined || value === undefined) && <option value="">{allowEmpty ?? '—'}</option>}
        {value !== undefined && !options.includes(value) && <option value={String(value)}>{String(value)}</option>}
        {options.map((o, i) => (
          <option key={String(o)} value={String(o)}>
            {label(o, i)}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted" />
    </div>
  );
}

/** Segmented buttons for a few short choices (alignment, direction…). */
export function SegmentedControl<T extends string>({ value, options, onChange, testId }: { value: T | undefined; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T | undefined) => void; testId?: string }) {
  return (
    <div className="flex min-w-0 overflow-hidden rounded border border-border" data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title ?? o.value} onClick={() => onChange(value === o.value ? undefined : o.value)} className={cx('flex h-[36px] min-w-0 flex-1 items-center justify-center px-1 text-[11.5px] sm:h-[28px]', value === o.value ? 'bg-accent/80 text-white' : 'text-muted hover:bg-panel-2 hover:text-text')} data-value={o.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SWATCHES = ['#000000', '#ffffff', '#64748b', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', 'transparent'];

/** Colour: swatch (the system picker), text (any CSS colour), quick swatches and opacity. */
export function ColorControl({ value, onChange, testId, swatches = SWATCHES, display = (c) => c, palette }: { value: string | undefined; onChange: (v: string | undefined) => void; testId?: string; swatches?: string[]; display?: (c: string) => string; palette?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = value ? display(value) : undefined;
  const hex = toHex(shown);
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-1">
        <label className="relative h-[36px] w-[36px] shrink-0 cursor-pointer overflow-hidden rounded border border-border sm:h-[28px] sm:w-[28px]" style={{ background: shown ?? 'transparent' }} title="Pick a colour">
          {!value && <span className="absolute inset-0 bg-[repeating-conic-gradient(#1b1f27_0%_25%,#12151b_0%_50%)] bg-[length:8px_8px]" />}
          <input type="color" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={hex ?? '#000000'} onChange={(e) => onChange(e.target.value)} data-testid={testId ? `${testId}-picker` : undefined} />
        </label>
        <input className={cx(ctl, 'font-mono')} value={value ?? ''} placeholder="none" onChange={(e) => onChange(e.target.value || undefined)} data-testid={testId ? `${testId}-text` : undefined} />
        <button type="button" className="h-[36px] w-[32px] shrink-0 rounded text-muted hover:text-text sm:h-[28px]" onClick={() => setOpen((o) => !o)} aria-label="Swatches">
          <ChevronDown size={13} className="mx-auto" />
        </button>
        {value !== undefined && (
          <button type="button" className="h-[36px] w-[32px] shrink-0 rounded text-muted hover:text-text sm:h-[28px]" onClick={() => onChange(undefined)} aria-label="Clear colour">
            <X size={13} className="mx-auto" />
          </button>
        )}
      </div>
      {open && palette}
      {open && !palette && (
        <div className="grid grid-cols-8 gap-1">
          {swatches.map((c) => (
            <button key={c} type="button" title={c} onClick={() => (onChange(c), setOpen(false))} className="h-[32px] rounded border border-border sm:h-[24px]" style={{ background: c === 'transparent' ? 'repeating-conic-gradient(#1b1f27 0% 25%, #12151b 0% 50%) 0 0/8px 8px' : c }} data-testid="swatch" data-color={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/** #rrggbb for a CSS colour, when the browser can work it out. */
export function toHex(c: string | undefined): string | undefined {
  if (!c) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`.toLowerCase();
  if (typeof document === 'undefined') return undefined;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  const s = String(ctx.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(s) ? s : undefined;
}

/** Short strings as removable chips plus an input (keywords, classes, authors…). */
export function TagsControl({ value, onChange, placeholder, testId, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; testId?: string; suggestions?: string[] }) {
  const [t, setT] = useState('');
  const add = () => {
    const x = t.trim();
    if (x && !value.includes(x)) onChange([...value, x]);
    setT('');
  };
  const listId = suggestions?.length ? `tags-${testId ?? 'x'}` : undefined;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 rounded border border-border bg-[#0f1218] p-1" data-testid={testId}>
      {value.map((v, i) => (
        <span key={`${v}-${i}`} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-1 font-mono text-[11.5px] sm:py-0.5">
          {v}
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${v}`} className="text-muted hover:text-text">
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="h-[32px] min-w-[6rem] flex-1 bg-transparent px-1 text-[12px] text-text outline-none sm:h-[24px]"
        value={t}
        placeholder={placeholder ?? 'Add…'}
        list={listId}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !t && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        data-testid={testId ? `${testId}-input` : undefined}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
