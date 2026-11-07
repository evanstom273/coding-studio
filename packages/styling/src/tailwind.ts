/**
 * StyleSpec ⇄ Tailwind classes. Uses Tailwind's own scale where a value is on it (p-4, text-lg,
 * rounded-xl, indigo-600) and arbitrary values otherwise (p-[13px]). Reading keeps every class it
 * doesn't model, in order, so nothing the user wrote is lost.
 */
import { PALETTE } from './palette';
import { BREAKPOINTS, clean, STATES, type Box, type Decls, type GradientDir, type StyleSpec } from './model';

const FONT_SIZES: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
const WEIGHTS: Record<string, number> = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
const RADII: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, '2xl': 16, '3xl': 24, '4xl': 32 };
const LEADING: Record<string, number> = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };
const TRACKING: Record<string, number> = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };
const CONTAINERS: Record<string, number> = { '3xs': 256, '2xs': 288, xs: 320, sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896, '5xl': 1024, '6xl': 1152, '7xl': 1280 };
const JUSTIFY = ['start', 'center', 'end', 'between', 'around', 'evenly'] as const;
const ITEMS = ['start', 'center', 'end', 'stretch', 'baseline'] as const;
const DISPLAY: Record<string, Decls['display']> = { block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', hidden: 'none' };
const SHADOWS = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'inner', 'none'] as const;

const inv = <T,>(o: Record<string, T>) => (v: T) => Object.entries(o).find(([, x]) => x === v)?.[0];
const spacing = (px: number) => (px === 1 ? 'px' : Number.isInteger((px / 4) * 2) ? String(px / 4) : `[${px}px]`);
const neg = (px: number, f: (abs: number) => string) => (px < 0 ? `-${f(-px)}` : f(px));
const arb = (v: string) => `[${v.replace(/\s+/g, '_')}]`;

function color(c: string) {
  return PALETTE[c] !== undefined || /^(black|white|transparent|current)$/.test(c) ? c : arb(c);
}

function lengthToken(v: string, kind: 'w' | 'h' | 'max-w' | 'min-w' | 'max-h' | 'min-h'): string {
  if (v === '100%') return 'full';
  if (v === 'auto') return 'auto';
  if (v === 'fit-content') return 'fit';
  if (v === 'min-content') return 'min';
  if (v === 'max-content') return 'max';
  if (v === '100vw' && kind.endsWith('w')) return 'screen';
  if (v === '100vh' && kind.endsWith('h')) return 'screen';
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
  if (pct) {
    const frac = { 50: '1/2', 25: '1/4', 75: '3/4', 20: '1/5', 40: '2/5', 60: '3/5', 80: '4/5' }[Number(pct[1])];
    if (frac && (kind === 'w' || kind === 'h')) return frac;
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
  if (px) {
    const n = Number(px[1]);
    if (kind === 'max-w') {
      const c = inv(CONTAINERS)(n);
      if (c) return c;
    }
    return spacing(n);
  }
  return arb(v);
}

function box(prefix: string, b: Box | undefined, out: string[]) {
  if (!b) return;
  const t = b.top, r = b.right, bo = b.bottom, l = b.left;
  const tok = (v: number | 'auto') => (v === 'auto' ? 'auto' : neg(v, spacing));
  const n = (v: number | 'auto', p: string) => (v !== 'auto' && v < 0 ? `-${p}-${spacing(-v)}` : `${p}-${tok(v)}`);
  if (t !== undefined && t === r && t === bo && t === l) return out.push(n(t, prefix));
  if (t !== undefined && t === bo) out.push(n(t, `${prefix}y`));
  else {
    if (t !== undefined) out.push(n(t, `${prefix}t`));
    if (bo !== undefined) out.push(n(bo, `${prefix}b`));
  }
  if (l !== undefined && l === r) out.push(n(l, `${prefix}x`));
  else {
    if (l !== undefined) out.push(n(l, `${prefix}l`));
    if (r !== undefined) out.push(n(r, `${prefix}r`));
  }
}

/** Classes for one variant's declarations (without the variant prefix). */
export function declsToClasses(d: Decls, opts: { v3?: boolean } = {}): string[] {
  const o: string[] = [];
  if (d.display) o.push(d.display === 'none' ? 'hidden' : d.display);
  if (d.flexDirection) o.push({ row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' }[d.flexDirection]);
  if (d.flexWrap) o.push(d.flexWrap === 'wrap' ? 'flex-wrap' : 'flex-nowrap');
  if (d.justifyContent) o.push(`justify-${d.justifyContent}`);
  if (d.alignItems) o.push(`items-${d.alignItems}`);
  if (d.gap !== undefined) o.push(`gap-${spacing(d.gap)}`);
  if (d.gridCols) o.push(`grid-cols-${d.gridCols}`);
  if (d.flexGrow) o.push('grow');
  box('p', d.padding, o);
  box('m', d.margin, o);
  if (d.width) o.push(`w-${lengthToken(d.width, 'w')}`);
  if (d.height) o.push(`h-${lengthToken(d.height, 'h')}`);
  if (d.minWidth) o.push(`min-w-${lengthToken(d.minWidth, 'min-w')}`);
  if (d.maxWidth) o.push(`max-w-${lengthToken(d.maxWidth, 'max-w')}`);
  if (d.minHeight) o.push(`min-h-${lengthToken(d.minHeight, 'min-h')}`);
  if (d.maxHeight) o.push(`max-h-${lengthToken(d.maxHeight, 'max-h')}`);
  if (d.fontFamily) o.push(['sans', 'serif', 'mono'].includes(d.fontFamily) ? `font-${d.fontFamily}` : `font-${arb(d.fontFamily)}`);
  if (d.fontSize !== undefined) o.push(`text-${inv(FONT_SIZES)(d.fontSize) ?? `[${d.fontSize}px]`}`);
  if (d.fontWeight !== undefined) o.push(`font-${inv(WEIGHTS)(d.fontWeight) ?? `[${d.fontWeight}]`}`);
  if (d.lineHeight !== undefined) o.push(`leading-${inv(LEADING)(d.lineHeight) ?? `[${d.lineHeight}]`}`);
  if (d.letterSpacing !== undefined) o.push(`tracking-${inv(TRACKING)(d.letterSpacing) ?? `[${d.letterSpacing}em]`}`);
  if (d.textAlign) o.push(`text-${d.textAlign}`);
  if (d.italic) o.push('italic');
  if (d.underline) o.push('underline');
  if (d.uppercase) o.push('uppercase');
  if (d.color) o.push(`text-${color(d.color)}`);
  if (d.backgroundColor) o.push(`bg-${color(d.backgroundColor)}`);
  if (d.gradient) {
    o.push(`${opts.v3 ? 'bg-gradient-to' : 'bg-linear-to'}-${d.gradient.dir}`, `from-${color(d.gradient.from)}`);
    if (d.gradient.via) o.push(`via-${color(d.gradient.via)}`);
    o.push(`to-${color(d.gradient.to)}`);
  }
  if (d.borderWidth !== undefined) o.push(d.borderWidth === 1 ? 'border' : `border-${[0, 2, 4, 8].includes(d.borderWidth) ? d.borderWidth : `[${d.borderWidth}px]`}`);
  if (d.borderStyle) o.push(`border-${d.borderStyle}`);
  if (d.borderColor) o.push(`border-${color(d.borderColor)}`);
  if (d.borderRadius !== undefined) o.push(d.borderRadius === 'full' ? 'rounded-full' : `rounded-${inv(RADII)(d.borderRadius) ?? `[${d.borderRadius}px]`}`);
  if (d.shadow) o.push(d.shadow === 'none' ? 'shadow-none' : `shadow-${d.shadow}`);
  if (d.opacity !== undefined) o.push(`opacity-${d.opacity}`);
  if (d.position) o.push(d.position);
  if (d.inset) {
    const { top, right, bottom, left } = d.inset;
    for (const [k, v] of [['top', top], ['right', right], ['bottom', bottom], ['left', left]] as const) if (v !== undefined) o.push(v === 'auto' ? `${k}-auto` : neg(v, (a) => `${k}-${spacing(a)}`));
  }
  if (d.zIndex !== undefined) o.push(`z-${[0, 10, 20, 30, 40, 50].includes(d.zIndex) ? d.zIndex : `[${d.zIndex}]`}`);
  if (d.translateX !== undefined) o.push(neg(d.translateX, (a) => `translate-x-${spacing(a)}`));
  if (d.translateY !== undefined) o.push(neg(d.translateY, (a) => `translate-y-${spacing(a)}`));
  if (d.rotate !== undefined) o.push(neg(d.rotate, (a) => `rotate-${[0, 1, 2, 3, 6, 12, 45, 90, 180].includes(a) ? a : `[${a}deg]`}`));
  if (d.scale !== undefined) o.push(`scale-${[0, 50, 75, 90, 95, 100, 105, 110, 125, 150].includes(d.scale) ? d.scale : `[${d.scale / 100}]`}`);
  if (d.transition) o.push(d.transition === 'all' ? 'transition-all' : d.transition === 'none' ? 'transition-none' : `transition-${d.transition}`);
  if (d.duration !== undefined) o.push(`duration-${d.duration}`);
  if (d.easing) o.push(`ease-${d.easing}`);
  if (d.cursor) o.push(`cursor-${d.cursor}`);
  if (d.overflow) o.push(`overflow-${d.overflow}`);
  return o;
}

/** All classes for a spec, variants prefixed (md:p-4, hover:bg-indigo-500, md:hover:…). */
export function toTailwind(spec: StyleSpec, opts: { v3?: boolean } = {}): string[] {
  const out: string[] = [];
  const order = (v: string) => {
    const parts = v ? v.split(':') : [];
    const bp = parts.find((p) => (BREAKPOINTS as readonly string[]).includes(p));
    const st = parts.find((p) => (STATES as readonly string[]).includes(p));
    return (bp ? BREAKPOINTS.indexOf(bp as never) + 1 : 0) * 10 + (st ? STATES.indexOf(st as never) + 1 : 0);
  };
  for (const v of Object.keys(spec).sort((a, b) => order(a) - order(b))) for (const c of declsToClasses(spec[v], opts)) out.push(v ? `${v}:${c}` : c);
  return out;
}

// --- reading ---------------------------------------------------------------------------------------

const ARB = /^\[(.+)\]$/;
const unarb = (t: string) => ARB.exec(t)?.[1].replace(/_/g, ' ');
const spacingPx = (t: string): number | undefined => {
  if (t === 'px') return 1;
  if (t === '0') return 0;
  const a = unarb(t);
  if (a) {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(a);
    return m ? Number(m[1]) : undefined;
  }
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) * 4 : undefined;
};
const colorTok = (t: string) => (PALETTE[t] !== undefined ? t : unarb(t) && /^(#|rgb|hsl|oklch|var\()/.test(unarb(t)!) ? unarb(t) : undefined);

function lengthFrom(t: string, kind: string): string | undefined {
  if (t === 'full') return '100%';
  if (t === 'auto') return 'auto';
  if (t === 'fit') return 'fit-content';
  if (t === 'min') return 'min-content';
  if (t === 'max') return 'max-content';
  if (t === 'screen') return kind.endsWith('w') ? '100vw' : '100vh';
  const f = /^(\d+)\/(\d+)$/.exec(t);
  if (f) return `${(Number(f[1]) / Number(f[2])) * 100}%`;
  if (kind === 'max-w' && CONTAINERS[t]) return `${CONTAINERS[t]}px`;
  const a = unarb(t);
  if (a) return a;
  const px = spacingPx(t);
  return px === undefined ? undefined : `${px}px`;
}

/** Apply one class (without variant) to declarations; false if it isn't something we model. */
function readClass(c: string, d: Decls): boolean {
  const negative = c.startsWith('-');
  const cls = negative ? c.slice(1) : c;
  const sgn = (n: number | undefined) => (n === undefined ? undefined : negative ? -n : n);
  let m: RegExpExecArray | null;
  if (!negative && DISPLAY[cls] !== undefined) return ((d.display = DISPLAY[cls]), true);
  if ((m = /^flex-(row|col|row-reverse|col-reverse)$/.exec(cls))) return ((d.flexDirection = m[1].replace('col', 'column') as Decls['flexDirection']), true);
  if (cls === 'flex-wrap' || cls === 'flex-nowrap') return ((d.flexWrap = cls === 'flex-wrap' ? 'wrap' : 'nowrap'), true);
  if ((m = /^justify-(.+)$/.exec(cls)) && (JUSTIFY as readonly string[]).includes(m[1])) return ((d.justifyContent = m[1] as Decls['justifyContent']), true);
  if ((m = /^items-(.+)$/.exec(cls)) && (ITEMS as readonly string[]).includes(m[1])) return ((d.alignItems = m[1] as Decls['alignItems']), true);
  if ((m = /^gap-(.+)$/.exec(cls)) && spacingPx(m[1]) !== undefined) return ((d.gap = spacingPx(m[1])), true);
  if ((m = /^grid-cols-(\d+)$/.exec(cls))) return ((d.gridCols = Number(m[1])), true);
  if (cls === 'grow') return ((d.flexGrow = true), true);
  if ((m = /^([pm])([trblxy]?)-(.+)$/.exec(cls))) {
    const v = m[3] === 'auto' ? 'auto' : sgn(spacingPx(m[3]));
    if (v === undefined || (m[1] === 'p' && (v === 'auto' || negative))) return false;
    const key = m[1] === 'p' ? 'padding' : 'margin';
    const b: Box = { ...(d[key] ?? {}) };
    const sides = { '': ['top', 'right', 'bottom', 'left'], x: ['left', 'right'], y: ['top', 'bottom'], t: ['top'], r: ['right'], b: ['bottom'], l: ['left'] }[m[2]] as (keyof Box)[];
    for (const s of sides) b[s] = v;
    d[key] = b;
    return true;
  }
  if ((m = /^(w|h|min-w|max-w|min-h|max-h)-(.+)$/.exec(cls)) && !negative) {
    const v = lengthFrom(m[2], m[1]);
    if (v === undefined) return false;
    const key = ({ w: 'width', h: 'height', 'min-w': 'minWidth', 'max-w': 'maxWidth', 'min-h': 'minHeight', 'max-h': 'maxHeight' } as const)[m[1] as 'w'];
    d[key] = v;
    return true;
  }
  if ((m = /^font-(sans|serif|mono)$/.exec(cls))) return ((d.fontFamily = m[1]), true);
  if ((m = /^font-(.+)$/.exec(cls))) {
    if (WEIGHTS[m[1]]) return ((d.fontWeight = WEIGHTS[m[1]]), true);
    const a = unarb(m[1]);
    if (a && /^\d+$/.test(a)) return ((d.fontWeight = Number(a)), true);
    if (a) return ((d.fontFamily = a), true);
    return false;
  }
  if ((m = /^text-(left|center|right|justify)$/.exec(cls))) return ((d.textAlign = m[1] as Decls['textAlign']), true);
  if ((m = /^text-(.+)$/.exec(cls))) {
    if (FONT_SIZES[m[1]]) return ((d.fontSize = FONT_SIZES[m[1]]), true);
    const a = unarb(m[1]);
    if (a && /^\d+(\.\d+)?px$/.test(a)) return ((d.fontSize = parseFloat(a)), true);
    const col = colorTok(m[1]);
    if (col) return ((d.color = col), true);
    return false;
  }
  if ((m = /^leading-(.+)$/.exec(cls))) {
    const v = LEADING[m[1]] ?? (unarb(m[1]) && /^\d+(\.\d+)?$/.test(unarb(m[1])!) ? Number(unarb(m[1])) : undefined);
    return v === undefined ? false : ((d.lineHeight = v), true);
  }
  if ((m = /^tracking-(.+)$/.exec(cls))) {
    const v = TRACKING[m[1]] ?? (unarb(m[1])?.endsWith('em') ? parseFloat(unarb(m[1])!) : undefined);
    return v === undefined ? false : ((d.letterSpacing = v), true);
  }
  if (cls === 'italic' || cls === 'underline' || cls === 'uppercase') return ((d[cls] = true), true);
  if ((m = /^bg-(?:linear|gradient)-to-(t|tr|r|br|b|bl|l|tl)$/.exec(cls))) return ((d.gradient = { from: '', to: '', ...(d.gradient ?? {}), dir: m[1] as GradientDir }), true);
  if ((m = /^(from|via|to)-(.+)$/.exec(cls)) && colorTok(m[2])) {
    d.gradient = { dir: 'r', from: '', to: '', ...(d.gradient ?? {}), [m[1]]: colorTok(m[2]) };
    return true;
  }
  if ((m = /^bg-(.+)$/.exec(cls)) && colorTok(m[1])) return ((d.backgroundColor = colorTok(m[1])), true);
  if (cls === 'border') return ((d.borderWidth = 1), true);
  if ((m = /^border-(\d+)$/.exec(cls))) return ((d.borderWidth = Number(m[1])), true);
  if ((m = /^border-\[(\d+(?:\.\d+)?)px\]$/.exec(cls))) return ((d.borderWidth = Number(m[1])), true);
  if ((m = /^border-(solid|dashed|dotted|none)$/.exec(cls))) return ((d.borderStyle = m[1] as Decls['borderStyle']), true);
  if ((m = /^border-(.+)$/.exec(cls)) && colorTok(m[1])) return ((d.borderColor = colorTok(m[1])), true);
  if (cls === 'rounded') return ((d.borderRadius = 4), true);
  if (cls === 'rounded-full') return ((d.borderRadius = 'full'), true);
  if ((m = /^rounded-(.+)$/.exec(cls))) {
    const v = RADII[m[1]] ?? (unarb(m[1]) ? parseFloat(unarb(m[1])!) : undefined);
    return v === undefined || Number.isNaN(v) ? false : ((d.borderRadius = v), true);
  }
  if (cls === 'shadow') return ((d.shadow = 'sm'), true);
  if ((m = /^shadow-(.+)$/.exec(cls)) && (SHADOWS as readonly string[]).includes(m[1])) return ((d.shadow = m[1] as Decls['shadow']), true);
  if ((m = /^opacity-(\d+)$/.exec(cls))) return ((d.opacity = Number(m[1])), true);
  if (/^(static|relative|absolute|fixed|sticky)$/.test(cls) && !negative) return ((d.position = cls as Decls['position']), true);
  if ((m = /^(top|right|bottom|left|inset)-(.+)$/.exec(cls))) {
    const v = m[2] === 'auto' ? 'auto' : sgn(spacingPx(m[2]));
    if (v === undefined) return false;
    const sides = m[1] === 'inset' ? (['top', 'right', 'bottom', 'left'] as const) : ([m[1]] as (keyof Box)[]);
    d.inset = { ...(d.inset ?? {}) };
    for (const s of sides) d.inset[s] = v;
    return true;
  }
  if ((m = /^z-(\d+)$/.exec(cls))) return ((d.zIndex = Number(m[1])), true);
  if ((m = /^translate-([xy])-(.+)$/.exec(cls))) {
    const v = sgn(spacingPx(m[2]));
    if (v === undefined) return false;
    if (m[1] === 'x') d.translateX = v;
    else d.translateY = v;
    return true;
  }
  if ((m = /^rotate-(.+)$/.exec(cls))) {
    const a = unarb(m[1]);
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) : a?.endsWith('deg') ? parseFloat(a) : undefined;
    return v === undefined ? false : ((d.rotate = sgn(v)), true);
  }
  if ((m = /^scale-(.+)$/.exec(cls)) && !negative) {
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) : unarb(m[1]) ? Math.round(parseFloat(unarb(m[1])!) * 100) : undefined;
    return v === undefined || Number.isNaN(v) ? false : ((d.scale = v), true);
  }
  if (cls === 'transition') return ((d.transition = 'all'), true);
  if ((m = /^transition-(all|colors|opacity|transform|none)$/.exec(cls))) return ((d.transition = m[1] as Decls['transition']), true);
  if ((m = /^duration-(\d+)$/.exec(cls))) return ((d.duration = Number(m[1])), true);
  if ((m = /^ease-(linear|in|out|in-out)$/.exec(cls))) return ((d.easing = m[1] as Decls['easing']), true);
  if ((m = /^cursor-(auto|pointer|default|not-allowed|grab|text)$/.exec(cls))) return ((d.cursor = m[1] as Decls['cursor']), true);
  if ((m = /^overflow-(visible|hidden|auto|scroll)$/.exec(cls))) return ((d.overflow = m[1] as Decls['overflow']), true);
  return false;
}

export interface ParsedClasses {
  spec: StyleSpec;
  /** Classes we don't model, kept in order and written back unchanged. */
  other: string[];
}

export function fromTailwind(className: string): ParsedClasses {
  const spec: StyleSpec = {};
  const other: string[] = [];
  for (const c of className.split(/\s+/).filter(Boolean)) {
    const parts = c.split(':');
    const base = parts.pop()!;
    const okVariant = parts.every((p) => (BREAKPOINTS as readonly string[]).includes(p) || (STATES as readonly string[]).includes(p)) && parts.filter((p) => (BREAKPOINTS as readonly string[]).includes(p)).length <= 1 && parts.filter((p) => (STATES as readonly string[]).includes(p)).length <= 1;
    // Normalise variant order to bp:state.
    const v = okVariant ? [parts.find((p) => (BREAKPOINTS as readonly string[]).includes(p)), parts.find((p) => (STATES as readonly string[]).includes(p))].filter(Boolean).join(':') : '';
    const d: Decls = { ...(spec[v] ?? {}) };
    if (okVariant && readClass(base, d)) spec[v] = d;
    else other.push(c);
  }
  // A gradient needs its colours; incomplete ones go back to "other" untouched.
  for (const d of Object.values(spec)) if (d.gradient && (!d.gradient.from || !d.gradient.to)) delete d.gradient;
  return { spec: clean(spec), other };
}

/** The className after editing: generated classes, then the ones we didn't model (unchanged). */
export function mergeClasses(spec: StyleSpec, other: string[], opts: { v3?: boolean } = {}) {
  return [...toTailwind(clean(spec), opts), ...other].join(' ');
}
