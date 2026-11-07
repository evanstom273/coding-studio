/**
 * The visual styling panel, shared by React elements (→ Tailwind classes), CSS files (→ rules)
 * and HTML elements. Pick a state (normal / hover / focus / pressed / disabled) and a screen size,
 * then set layout, spacing, size, text, background, border, effects, position and motion with
 * controls. Values inherited from a wider variant show as placeholders; a live preview shows it.
 */
import { useState, type ReactNode } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowRight, ChevronDown, ChevronRight, Link2, Unlink } from 'lucide-react';
import { BREAKPOINTS, displayColor, effective, FAMILIES, PALETTE, SHADES, splitVariant, STATES, toStyleObject, variantOf, type Box, type Breakpoint, type Decls, type GradientDir, type State, type StyleSpec } from '@cs/styling';
import { cx } from '../ui/primitives';
import { ColorControl, ctl, NumberControl, SegmentedControl, SelectControl, ToggleControl } from './controls';

const STATE_LABEL: Record<State | '', string> = { '': 'Normal', hover: 'Hover', focus: 'Focus', active: 'Pressed', disabled: 'Disabled' };
const BP_LABEL: Record<Breakpoint | '', string> = { '': 'All screens', sm: '≥ 640 (large phone)', md: '≥ 768 (tablet)', lg: '≥ 1024 (laptop)', xl: '≥ 1280 (desktop)', '2xl': '≥ 1536 (wide)' };

export function StyleEditor({ spec, onChange, previewText = 'Preview', testId = 'style-editor', extra }: { spec: StyleSpec; onChange: (spec: StyleSpec, mergeKey?: string) => void; previewText?: ReactNode; testId?: string; extra?: ReactNode }) {
  const [bp, setBp] = useState<Breakpoint | ''>('');
  const [state, setState] = useState<State | ''>('');
  const variant = variantOf(bp, state);
  const d: Decls = spec[variant] ?? {};
  // What applies before this variant (for placeholders).
  const parentVariant = state ? variantOf(bp, '') : bp ? BREAKPOINTS[BREAKPOINTS.indexOf(bp) - 1] ?? '' : null;
  const inherited: Decls = parentVariant === null ? {} : effective(spec, parentVariant);
  const set = <K extends keyof Decls>(k: K, v: Decls[K], merge = false) => {
    const next: Decls = { ...d, [k]: v };
    if (v === undefined) delete next[k];
    onChange({ ...spec, [variant]: next }, merge ? `${variant}:${String(k)}` : undefined);
  };
  const look = effective(spec, variant);
  const count = (keys: (keyof Decls)[]) => keys.filter((k) => d[k] !== undefined).length;
  const variantsUsed = Object.keys(spec).filter((v) => v && Object.keys(spec[v] ?? {}).length);

  return (
    <div className="space-y-2 text-[12px]" data-testid={testId}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1" data-testid="style-states">
          {(['', ...STATES] as const).map((s) => (
            <button key={s} type="button" onClick={() => setState(s)} className={cx('h-[32px] rounded-full border px-2.5 text-[11.5px] sm:h-[24px]', state === s ? 'border-accent bg-accent/20 text-text' : 'border-border text-muted', variantsUsed.some((v) => splitVariant(v).state === s && s) && state !== s && 'border-accent/50')} data-state={s || 'normal'}>
              {STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <SelectControl value={bp} options={['', ...BREAKPOINTS] as (Breakpoint | '')[]} labels={BP_LABEL as Record<string, string>} onChange={(v) => setBp((v ?? '') as Breakpoint | '')} testId="style-breakpoint" />
        {variant && <div className="text-[11px] text-[#7d8696]">Editing {[STATE_LABEL[state], bp && `on screens ${BP_LABEL[bp]}`].filter((x) => x && x !== 'Normal').join(' ')}. Empty fields use the normal style.</div>}
      </div>

      <div className="flex min-h-[64px] items-center justify-center overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#1b1f27_0%_25%,#12151b_0%_50%)] bg-[length:12px_12px] p-3" data-testid="style-preview">
        <div style={{ color: '#111', background: '#fff', ...toStyleObject(look), position: look.position === 'fixed' || look.position === 'sticky' ? 'relative' : (toStyleObject(look).position as never) }}>{previewText}</div>
      </div>
      {extra}

      <Section title="Layout" n={count(['display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap', 'gridCols', 'flexGrow', 'overflow'])} open>
        <Field label="Display">
          <SegmentedControl value={d.display} onChange={(v) => set('display', v)} testId="style-display" options={[{ value: 'block', label: 'Block' }, { value: 'flex', label: 'Row/Col' }, { value: 'grid', label: 'Grid' }, { value: 'inline-block', label: 'Inline' }, { value: 'none', label: 'Hidden' }]} />
        </Field>
        {(look.display === 'flex' || look.display === 'inline-flex') && (
          <>
            <Field label="Direction">
              <SegmentedControl value={d.flexDirection} onChange={(v) => set('flexDirection', v)} options={[{ value: 'row', label: <ArrowRight size={13} />, title: 'Side by side' }, { value: 'column', label: <ArrowDown size={13} />, title: 'Stacked' }, { value: 'row-reverse', label: '←', title: 'Side by side, reversed' }, { value: 'column-reverse', label: '↑', title: 'Stacked, reversed' }]} />
            </Field>
            <Field label="Spread">
              <SelectControl value={d.justifyContent} options={['start', 'center', 'end', 'between', 'around', 'evenly'] as const} labels={{ start: 'At the start', center: 'Centred', end: 'At the end', between: 'Space between', around: 'Space around', evenly: 'Even space' }} allowEmpty="(default)" onChange={(v) => set('justifyContent', v)} testId="style-justify" />
            </Field>
            <Field label="Align">
              <SelectControl value={d.alignItems} options={['start', 'center', 'end', 'stretch', 'baseline'] as const} labels={{ start: 'Top / left', center: 'Centred', end: 'Bottom / right', stretch: 'Stretch', baseline: 'Text baseline' }} allowEmpty="(default)" onChange={(v) => set('alignItems', v)} testId="style-align" />
            </Field>
            <Field label="Wrap">
              <ToggleControl value={d.flexWrap === 'wrap'} onChange={(v) => set('flexWrap', v ? 'wrap' : undefined)} />
            </Field>
          </>
        )}
        {look.display === 'grid' && (
          <Field label="Columns">
            <NumberControl value={d.gridCols} min={1} max={12} placeholder={inherited.gridCols?.toString()} onChange={(v) => set('gridCols', v)} />
          </Field>
        )}
        {(look.display === 'flex' || look.display === 'grid' || look.display === 'inline-flex') && (
          <Field label="Gap">
            <NumberControl value={d.gap} min={0} step={4} unit="px" placeholder={inherited.gap?.toString()} onChange={(v) => set('gap', v)} testId="style-gap" />
          </Field>
        )}
        <Field label="Fill space">
          <ToggleControl value={!!d.flexGrow} onChange={(v) => set('flexGrow', v || undefined)} />
        </Field>
        <Field label="Overflow">
          <SelectControl value={d.overflow} options={['visible', 'hidden', 'auto', 'scroll'] as const} labels={{ visible: 'Show', hidden: 'Clip', auto: 'Scroll if needed', scroll: 'Always scroll' }} allowEmpty="(default)" onChange={(v) => set('overflow', v)} />
        </Field>
      </Section>

      <Section title="Spacing" n={count(['padding', 'margin'])} open>
        <BoxControl label="Padding (inside)" value={d.padding} inherited={inherited.padding} onChange={(v) => set('padding', v, true)} testId="style-padding" />
        <BoxControl label="Margin (outside)" value={d.margin} inherited={inherited.margin} onChange={(v) => set('margin', v, true)} allowAuto allowNegative testId="style-margin" />
      </Section>

      <Section title="Size" n={count(['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'])}>
        {(['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).map((k) => (
          <Field key={k} label={{ width: 'Width', height: 'Height', minWidth: 'Min width', maxWidth: 'Max width', minHeight: 'Min height', maxHeight: 'Max height' }[k]}>
            <LengthControl value={d[k]} placeholder={inherited[k]} onChange={(v) => set(k, v, true)} testId={`style-${k}`} />
          </Field>
        ))}
      </Section>

      <Section title="Text" n={count(['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'italic', 'underline', 'uppercase'])}>
        <Field label="Colour">
          <PaletteColor value={d.color} onChange={(v) => set('color', v, true)} testId="style-color" />
        </Field>
        <Field label="Font">
          <SelectControl value={d.fontFamily} options={['sans', 'serif', 'mono']} labels={{ sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' }} allowEmpty="(default)" onChange={(v) => set('fontFamily', v)} />
        </Field>
        <Field label="Size">
          <NumberControl value={d.fontSize} min={6} step={2} unit="px" placeholder={inherited.fontSize?.toString() ?? '16'} onChange={(v) => set('fontSize', v)} testId="style-fontSize" />
        </Field>
        <Field label="Weight">
          <SelectControl value={d.fontWeight} options={[100, 200, 300, 400, 500, 600, 700, 800, 900]} labels={{ 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' }} allowEmpty="(default)" onChange={(v) => set('fontWeight', v)} testId="style-fontWeight" />
        </Field>
        <Field label="Align">
          <SegmentedControl value={d.textAlign} onChange={(v) => set('textAlign', v)} options={[{ value: 'left', label: <AlignLeft size={13} /> }, { value: 'center', label: <AlignCenter size={13} /> }, { value: 'right', label: <AlignRight size={13} /> }, { value: 'justify', label: <AlignJustify size={13} /> }]} />
        </Field>
        <Field label="Line height">
          <NumberControl value={d.lineHeight} min={0.5} step={0.125} placeholder={inherited.lineHeight?.toString()} onChange={(v) => set('lineHeight', v)} />
        </Field>
        <Field label="Letter spacing">
          <NumberControl value={d.letterSpacing} step={0.025} unit="em" onChange={(v) => set('letterSpacing', v)} />
        </Field>
        <div className="flex flex-wrap gap-3">
          <ToggleControl label="Italic" value={!!d.italic} onChange={(v) => set('italic', v || undefined)} />
          <ToggleControl label="Underline" value={!!d.underline} onChange={(v) => set('underline', v || undefined)} />
          <ToggleControl label="Capitals" value={!!d.uppercase} onChange={(v) => set('uppercase', v || undefined)} />
        </div>
      </Section>

      <Section title="Background" n={count(['backgroundColor', 'gradient'])}>
        <Field label="Colour">
          <PaletteColor value={d.backgroundColor} onChange={(v) => set('backgroundColor', v, true)} testId="style-backgroundColor" />
        </Field>
        <Field label="Gradient">
          <ToggleControl value={!!d.gradient} onChange={(v) => set('gradient', v ? { dir: 'r', from: 'indigo-500', to: 'pink-500' } : undefined)} testId="style-gradient" />
        </Field>
        {d.gradient && (
          <>
            <Field label="Direction">
              <SelectControl value={d.gradient.dir} options={['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl'] as GradientDir[]} labels={{ t: '↑ Up', tr: '↗', r: '→ Right', br: '↘', b: '↓ Down', bl: '↙', l: '← Left', tl: '↖' }} onChange={(v) => set('gradient', { ...d.gradient!, dir: v ?? 'r' })} />
            </Field>
            <Field label="From">
              <PaletteColor value={d.gradient.from} onChange={(v) => set('gradient', { ...d.gradient!, from: v ?? 'white' }, true)} />
            </Field>
            <Field label="Via">
              <PaletteColor value={d.gradient.via} onChange={(v) => set('gradient', { ...d.gradient!, via: v }, true)} />
            </Field>
            <Field label="To">
              <PaletteColor value={d.gradient.to} onChange={(v) => set('gradient', { ...d.gradient!, to: v ?? 'white' }, true)} />
            </Field>
          </>
        )}
      </Section>

      <Section title="Border" n={count(['borderWidth', 'borderStyle', 'borderColor', 'borderRadius'])}>
        <Field label="Width">
          <NumberControl value={d.borderWidth} min={0} unit="px" placeholder={inherited.borderWidth?.toString()} onChange={(v) => set('borderWidth', v)} testId="style-borderWidth" />
        </Field>
        <Field label="Style">
          <SegmentedControl value={d.borderStyle} onChange={(v) => set('borderStyle', v)} options={[{ value: 'solid', label: '—' }, { value: 'dashed', label: '- -' }, { value: 'dotted', label: '···' }, { value: 'none', label: 'None' }]} />
        </Field>
        <Field label="Colour">
          <PaletteColor value={d.borderColor} onChange={(v) => set('borderColor', v, true)} />
        </Field>
        <Field label="Corners">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <NumberControl value={typeof d.borderRadius === 'number' ? d.borderRadius : undefined} min={0} step={2} unit="px" placeholder={d.borderRadius === 'full' ? 'round' : inherited.borderRadius?.toString()} onChange={(v) => set('borderRadius', v)} testId="style-borderRadius" />
            </div>
            <ToggleControl label="Round" value={d.borderRadius === 'full'} onChange={(v) => set('borderRadius', v ? 'full' : undefined)} testId="style-rounded-full" />
          </div>
        </Field>
      </Section>

      <Section title="Effects" n={count(['shadow', 'opacity', 'cursor'])}>
        <Field label="Shadow">
          <SegmentedControl value={d.shadow} onChange={(v) => set('shadow', v)} testId="style-shadow" options={[{ value: 'none', label: 'None' }, { value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }, { value: 'xl', label: 'XL' }, { value: '2xl', label: '2XL' }]} />
        </Field>
        <Field label="Opacity">
          <div className="flex items-center gap-2">
            <input type="range" min={0} max={100} step={5} value={d.opacity ?? inherited.opacity ?? 100} onChange={(e) => set('opacity', Number(e.target.value) === 100 && inherited.opacity === undefined ? undefined : Number(e.target.value), true)} className="h-[32px] flex-1 accent-[var(--color-accent)]" data-testid="style-opacity" />
            <span className="w-10 text-right text-muted">{d.opacity ?? inherited.opacity ?? 100}%</span>
          </div>
        </Field>
        <Field label="Pointer">
          <SelectControl value={d.cursor} options={['pointer', 'default', 'text', 'grab', 'not-allowed', 'auto'] as const} labels={{ pointer: 'Hand (clickable)', default: 'Arrow', text: 'Text', grab: 'Grab', 'not-allowed': 'Not allowed', auto: 'Automatic' }} allowEmpty="(default)" onChange={(v) => set('cursor', v)} />
        </Field>
      </Section>

      <Section title="Position" n={count(['position', 'inset', 'zIndex'])}>
        <Field label="Position">
          <SelectControl value={d.position} options={['static', 'relative', 'absolute', 'fixed', 'sticky'] as const} labels={{ static: 'Normal flow', relative: 'Relative (offset, holds absolute children)', absolute: 'Absolute (inside the nearest relative parent)', fixed: 'Fixed to the screen', sticky: 'Sticky when scrolling' }} allowEmpty="(default)" onChange={(v) => set('position', v)} />
        </Field>
        {look.position && look.position !== 'static' && <BoxControl label="Offsets" value={d.inset} inherited={inherited.inset} onChange={(v) => set('inset', v, true)} allowNegative allowAuto labels={['Top', 'Right', 'Bottom', 'Left']} />}
        <Field label="Layer (z)">
          <NumberControl value={d.zIndex} step={10} onChange={(v) => set('zIndex', v)} />
        </Field>
      </Section>

      <Section title="Transform & motion" n={count(['translateX', 'translateY', 'rotate', 'scale', 'transition', 'duration', 'easing'])}>
        <Field label="Move X">
          <NumberControl value={d.translateX} step={4} unit="px" onChange={(v) => set('translateX', v)} />
        </Field>
        <Field label="Move Y">
          <NumberControl value={d.translateY} step={4} unit="px" onChange={(v) => set('translateY', v)} />
        </Field>
        <Field label="Rotate">
          <NumberControl value={d.rotate} step={15} unit="°" onChange={(v) => set('rotate', v)} />
        </Field>
        <Field label="Scale">
          <NumberControl value={d.scale} min={0} step={5} unit="%" placeholder="100" onChange={(v) => set('scale', v)} testId="style-scale" />
        </Field>
        <Field label="Animate changes">
          <SelectControl value={d.transition} options={['all', 'colors', 'opacity', 'transform', 'none'] as const} labels={{ all: 'Everything', colors: 'Colours', opacity: 'Fading', transform: 'Movement / size', none: 'Nothing' }} allowEmpty="(default)" onChange={(v) => set('transition', v)} testId="style-transition" />
        </Field>
        <Field label="Duration">
          <NumberControl value={d.duration} min={0} step={50} unit="ms" placeholder="150" onChange={(v) => set('duration', v)} />
        </Field>
        <Field label="Easing">
          <SelectControl value={d.easing} options={['linear', 'in', 'out', 'in-out'] as const} labels={{ linear: 'Steady', in: 'Speed up', out: 'Slow down', 'in-out': 'Smooth' }} allowEmpty="(default)" onChange={(v) => set('easing', v)} />
        </Field>
      </Section>
    </div>
  );
}

function Section({ title, n, open: defaultOpen = false, children }: { title: string; n: number; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen || n > 0);
  return (
    <section className="rounded border border-border" data-testid="style-section" data-title={title}>
      <button type="button" className="flex h-[36px] w-full items-center gap-1 px-2 text-left font-semibold sm:h-[28px]" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {title}
        {n > 0 && <span className="ml-auto rounded-full bg-accent/25 px-1.5 text-[10.5px] font-normal">{n}</span>}
      </button>
      {open && <div className="space-y-2 px-2 pb-2">{children}</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <span className="text-[11.5px] text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A colour from the Tailwind palette (by name) or any CSS colour. */
export function PaletteColor({ value, onChange, testId }: { value: string | undefined; onChange: (v: string | undefined) => void; testId?: string }) {
  return (
    <ColorControl
      value={value}
      onChange={onChange}
      testId={testId}
      display={(c) => displayColor(c) ?? c}
      palette={
        <div className="max-h-64 space-y-0.5 overflow-auto rounded border border-border p-1" data-testid="palette">
          <div className="flex gap-0.5">
            {['black', 'white', 'transparent'].map((c) => (
              <button key={c} type="button" title={c} onClick={() => onChange(c)} className="h-[28px] flex-1 rounded border border-border text-[10px] text-muted" style={{ background: c === 'transparent' ? undefined : PALETTE[c] }} data-color={c}>
                {c === 'transparent' ? 'none' : ''}
              </button>
            ))}
          </div>
          {FAMILIES.map((f) => (
            <div key={f} className="flex gap-0.5">
              {SHADES.map((sh) => (
                <button key={sh} type="button" title={`${f}-${sh}`} onClick={() => onChange(`${f}-${sh}`)} className={cx('h-[24px] flex-1 rounded-sm', value === `${f}-${sh}` && 'ring-2 ring-white')} style={{ background: PALETTE[`${f}-${sh}`] }} data-color={`${f}-${sh}`} />
              ))}
            </div>
          ))}
        </div>
      }
    />
  );
}

/** Four sides (top, right, bottom, left), linked by default. */
function BoxControl({ label, value, inherited, onChange, allowAuto, allowNegative, labels = ['Top', 'Right', 'Bottom', 'Left'], testId }: { label: string; value: Box | undefined; inherited?: Box; onChange: (v: Box | undefined) => void; allowAuto?: boolean; allowNegative?: boolean; labels?: string[]; testId?: string }) {
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const same = !value || sides.every((s) => value[s] === value.top);
  const [linked, setLinked] = useState(same);
  const num = (v: number | 'auto' | undefined) => (typeof v === 'number' ? v : undefined);
  const setSide = (s: (typeof sides)[number], v: number | undefined) => {
    const next: Box = linked ? { top: v, right: v, bottom: v, left: v } : { ...(value ?? {}), [s]: v };
    onChange(sides.some((x) => next[x] !== undefined) ? next : undefined);
  };
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-muted">{label}</span>
        <div className="flex items-center gap-1">
          {allowAuto && (
            <button type="button" className="rounded border border-border px-1.5 text-[10.5px] text-muted hover:text-text" onClick={() => onChange({ ...(value ?? {}), left: 'auto', right: 'auto' })} title="Centre horizontally">
              centre
            </button>
          )}
          <button type="button" className="flex h-[28px] items-center gap-1 rounded px-1 text-[11px] text-muted hover:text-text" onClick={() => setLinked((l) => !l)} data-testid={testId ? `${testId}-link` : undefined}>
            {linked ? <Link2 size={12} /> : <Unlink size={12} />} {linked ? 'All sides' : 'Each side'}
          </button>
        </div>
      </div>
      {linked ? (
        <NumberControl value={num(value?.top)} min={allowNegative ? undefined : 0} step={4} unit="px" placeholder={num(inherited?.top)?.toString()} onChange={(v) => setSide('top', v)} testId={testId ? `${testId}-all` : undefined} />
      ) : (
        <div className="grid grid-cols-2 gap-1">
          {sides.map((s, i) => (
            <div key={s}>
              <div className="text-[10.5px] text-[#7d8696]">{labels[i]}</div>
              {value?.[s] === 'auto' ? (
                <button type="button" className={cx(ctl, 'text-left text-muted')} onClick={() => setSide(s, undefined)}>
                  auto ✕
                </button>
              ) : (
                <NumberControl value={num(value?.[s])} min={allowNegative ? undefined : 0} step={4} unit="px" placeholder={num(inherited?.[s])?.toString()} onChange={(v) => setSide(s, v)} testId={testId ? `${testId}-${s}` : undefined} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LENGTH_UNITS = ['px', '%', 'vw', 'vh', 'rem'];
/** A CSS length: a number with a unit, or a keyword (auto, fit content, full). */
function LengthControl({ value, onChange, placeholder, testId }: { value: string | undefined; onChange: (v: string | undefined) => void; placeholder?: string; testId?: string }) {
  const m = value ? /^(-?\d+(?:\.\d+)?)(px|%|vw|vh|rem)$/.exec(value) : null;
  const keyword = value && !m ? value : undefined;
  const [unit, setUnit] = useState(m?.[2] ?? 'px');
  if (keyword)
    return (
      <div className="flex items-center gap-1">
        <span className={cx(ctl, 'flex items-center')}>{{ auto: 'Automatic', 'fit-content': 'Fit content', '100%': 'Full' }[keyword] ?? keyword}</span>
        <button type="button" className="h-[36px] px-2 text-muted hover:text-text sm:h-[28px]" onClick={() => onChange(undefined)} aria-label="Clear">
          ✕
        </button>
      </div>
    );
  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        <NumberControl value={m ? Number(m[1]) : undefined} min={0} step={unit === 'px' ? 8 : 5} placeholder={placeholder} onChange={(n) => onChange(n === undefined ? undefined : `${n}${unit}`)} units={LENGTH_UNITS} unit={unit} onUnit={(u) => (setUnit(u), m && onChange(`${m[1]}${u}`))} testId={testId} />
      </div>
      <select className={cx(ctl, 'w-[4.5rem] shrink-0 px-1')} value="" onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Preset">
        <option value="">…</option>
        <option value="100%">Full</option>
        <option value="auto">Auto</option>
        <option value="fit-content">Fit</option>
      </select>
    </div>
  );
}
