/**
 * The style model shared by every visual styling surface (React elements with Tailwind, CSS
 * files, HTML elements). It's a small set of design properties per variant (base, :hover,
 * breakpoints…) that turns into Tailwind classes or CSS, and is read back from them; anything it
 * doesn't model is kept separately and written back untouched.
 */
export type Box = { top?: number | 'auto'; right?: number | 'auto'; bottom?: number | 'auto'; left?: number | 'auto' };
export type GradientDir = 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l' | 'tl';

export interface Decls {
  // layout
  display?: 'block' | 'inline' | 'inline-block' | 'flex' | 'inline-flex' | 'grid' | 'none';
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  flexWrap?: 'wrap' | 'nowrap';
  justifyContent?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
  alignItems?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  gap?: number;
  gridCols?: number;
  flexGrow?: boolean;
  // spacing (px)
  padding?: Box;
  margin?: Box;
  // size (CSS length strings: "120px", "50%", "100%", "auto", "100vw", "fit-content")
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  // typography
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  italic?: boolean;
  underline?: boolean;
  uppercase?: boolean;
  // background
  backgroundColor?: string;
  gradient?: { dir: GradientDir; from: string; via?: string; to: string };
  // border
  borderWidth?: number;
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'none';
  borderColor?: string;
  borderRadius?: number | 'full';
  // effects
  shadow?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'inner';
  opacity?: number;
  // position
  position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  inset?: Box;
  zIndex?: number;
  // transform & motion
  translateX?: number;
  translateY?: number;
  rotate?: number;
  scale?: number;
  transition?: 'all' | 'colors' | 'opacity' | 'transform' | 'none';
  duration?: number;
  easing?: 'linear' | 'in' | 'out' | 'in-out';
  cursor?: 'auto' | 'pointer' | 'default' | 'not-allowed' | 'grab' | 'text';
  overflow?: 'visible' | 'hidden' | 'auto' | 'scroll';
}

export const STATES = ['hover', 'focus', 'active', 'disabled'] as const;
export const BREAKPOINTS = ['sm', 'md', 'lg', 'xl', '2xl'] as const;
export type State = (typeof STATES)[number];
export type Breakpoint = (typeof BREAKPOINTS)[number];
/** '' = always; 'hover'; 'md'; 'md:hover' */
export type Variant = string;
export type StyleSpec = Record<Variant, Decls>;

export const BREAKPOINT_PX: Record<Breakpoint, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

export const variantOf = (bp: Breakpoint | '', state: State | '') => [bp, state].filter(Boolean).join(':');
export function splitVariant(v: Variant): { bp: Breakpoint | ''; state: State | '' } {
  const parts = v.split(':');
  return { bp: (parts.find((p) => (BREAKPOINTS as readonly string[]).includes(p)) ?? '') as Breakpoint | '', state: (parts.find((p) => (STATES as readonly string[]).includes(p)) ?? '') as State | '' };
}

/** Remove empty values so specs compare and serialise cleanly. */
export function clean(spec: StyleSpec): StyleSpec {
  const out: StyleSpec = {};
  for (const [v, d] of Object.entries(spec)) {
    const c: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(d)) {
      if (x === undefined || x === '' || (typeof x === 'number' && Number.isNaN(x))) continue;
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        const inner = Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined && y !== ''));
        if (!Object.keys(inner).length) continue;
        c[k] = inner;
      } else c[k] = x;
    }
    if (Object.keys(c).length) out[v] = c as Decls;
  }
  return out;
}

/** The style an element shows in `variant`: base, then breakpoint, then state (as CSS would). */
export function effective(spec: StyleSpec, variant: Variant): Decls {
  const { bp, state } = splitVariant(variant);
  const order = ['', ...(bp ? BREAKPOINTS.slice(0, BREAKPOINTS.indexOf(bp) + 1) : [])];
  let out: Decls = {};
  for (const b of order) out = { ...out, ...(spec[b] ?? {}) };
  if (state) for (const b of order) out = { ...out, ...(spec[variantOf(b as Breakpoint | '', state)] ?? {}) };
  return out;
}
