/**
 * StyleSpec ⇄ CSS. `toCss` writes a rule set (base, :hover…, @media) for a selector;
 * `declsFromCss` reads declarations back, returning the ones it doesn't model so they're kept.
 */
import { cssColor } from './palette';
import { BREAKPOINT_PX, clean, splitVariant, type Box, type Decls, type GradientDir, type StyleSpec } from './model';

const SHADOW: Record<string, string> = {
  xs: '0 1px 1px 0 rgb(0 0 0 / 0.05)',
  sm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
  none: 'none',
};
const FAMILY: Record<string, string> = { sans: 'ui-sans-serif, system-ui, sans-serif', serif: 'ui-serif, Georgia, serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const EASE: Record<string, string> = { linear: 'linear', in: 'cubic-bezier(0.4, 0, 1, 1)', out: 'cubic-bezier(0, 0, 0.2, 1)', 'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)' };
const GRAD_DIR: Record<GradientDir, string> = { t: 'to top', tr: 'to top right', r: 'to right', br: 'to bottom right', b: 'to bottom', bl: 'to bottom left', l: 'to left', tl: 'to top left' };
const TRANSITION_PROPS: Record<string, string> = { all: 'all', colors: 'color, background-color, border-color, text-decoration-color, fill, stroke', opacity: 'opacity', transform: 'transform, translate, scale, rotate', none: 'none' };
const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

const px = (n: number | 'auto') => (n === 'auto' ? 'auto' : n === 0 ? '0' : `${n}px`);
const boxDecls = (prop: string, b: Box | undefined, out: [string, string][]) => {
  if (!b) return;
  const { top: t, right: r, bottom: bo, left: l } = b;
  if (t !== undefined && r !== undefined && bo !== undefined && l !== undefined) out.push([prop, t === r && t === bo && t === l ? px(t) : t === bo && r === l ? `${px(t)} ${px(r)}` : `${px(t)} ${px(r)} ${px(bo)} ${px(l)}`]);
  else for (const [s, v] of [['top', t], ['right', r], ['bottom', bo], ['left', l]] as const) if (v !== undefined) out.push([`${prop}-${s}`, px(v)]);
};

/** CSS declarations for one variant. */
export function declsToCss(d: Decls): [string, string][] {
  const o: [string, string][] = [];
  if (d.display) o.push(['display', d.display]);
  if (d.flexDirection) o.push(['flex-direction', d.flexDirection]);
  if (d.flexWrap) o.push(['flex-wrap', d.flexWrap]);
  if (d.justifyContent) o.push(['justify-content', JUSTIFY[d.justifyContent]]);
  if (d.alignItems) o.push(['align-items', ALIGN[d.alignItems]]);
  if (d.gap !== undefined) o.push(['gap', px(d.gap)]);
  if (d.gridCols) o.push(['grid-template-columns', `repeat(${d.gridCols}, minmax(0, 1fr))`]);
  if (d.flexGrow) o.push(['flex-grow', '1']);
  boxDecls('padding', d.padding, o);
  boxDecls('margin', d.margin, o);
  for (const [k, p] of [['width', 'width'], ['height', 'height'], ['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']] as const) if (d[k]) o.push([p, d[k]!]);
  if (d.fontFamily) o.push(['font-family', FAMILY[d.fontFamily] ?? d.fontFamily]);
  if (d.fontSize !== undefined) o.push(['font-size', px(d.fontSize)]);
  if (d.fontWeight !== undefined) o.push(['font-weight', String(d.fontWeight)]);
  if (d.lineHeight !== undefined) o.push(['line-height', String(d.lineHeight)]);
  if (d.letterSpacing !== undefined) o.push(['letter-spacing', `${d.letterSpacing}em`]);
  if (d.textAlign) o.push(['text-align', d.textAlign]);
  if (d.italic) o.push(['font-style', 'italic']);
  if (d.underline) o.push(['text-decoration-line', 'underline']);
  if (d.uppercase) o.push(['text-transform', 'uppercase']);
  if (d.color) o.push(['color', cssColor(d.color)]);
  if (d.backgroundColor) o.push(['background-color', cssColor(d.backgroundColor)]);
  if (d.gradient) o.push(['background-image', `linear-gradient(${GRAD_DIR[d.gradient.dir]}, ${[d.gradient.from, d.gradient.via, d.gradient.to].filter(Boolean).map((c) => cssColor(c!)).join(', ')})`]);
  if (d.borderWidth !== undefined) o.push(['border-width', px(d.borderWidth)]);
  if (d.borderStyle) o.push(['border-style', d.borderStyle]);
  else if (d.borderWidth) o.push(['border-style', 'solid']);
  if (d.borderColor) o.push(['border-color', cssColor(d.borderColor)]);
  if (d.borderRadius !== undefined) o.push(['border-radius', d.borderRadius === 'full' ? '9999px' : px(d.borderRadius)]);
  if (d.shadow) o.push(['box-shadow', SHADOW[d.shadow]]);
  if (d.opacity !== undefined) o.push(['opacity', String(d.opacity / 100)]);
  if (d.position) o.push(['position', d.position]);
  if (d.inset) for (const [s, v] of Object.entries(d.inset)) if (v !== undefined) o.push([s, px(v)]);
  if (d.zIndex !== undefined) o.push(['z-index', String(d.zIndex)]);
  if (d.translateX !== undefined || d.translateY !== undefined) o.push(['translate', `${px(d.translateX ?? 0)} ${px(d.translateY ?? 0)}`]);
  if (d.rotate !== undefined) o.push(['rotate', `${d.rotate}deg`]);
  if (d.scale !== undefined) o.push(['scale', String(d.scale / 100)]);
  if (d.transition) o.push(['transition-property', TRANSITION_PROPS[d.transition]]);
  if (d.transition && d.transition !== 'none') o.push(['transition-duration', `${d.duration ?? 150}ms`], ['transition-timing-function', EASE[d.easing ?? 'in-out']]);
  else {
    if (d.duration !== undefined) o.push(['transition-duration', `${d.duration}ms`]);
    if (d.easing) o.push(['transition-timing-function', EASE[d.easing]]);
  }
  if (d.cursor) o.push(['cursor', d.cursor]);
  if (d.overflow) o.push(['overflow', d.overflow]);
  return o;
}

const STATE_SEL: Record<string, string> = { hover: ':hover', focus: ':focus-visible', active: ':active', disabled: ':disabled' };

/** A full stylesheet fragment for `selector` (base rule, state rules, media queries). */
export function toCss(spec: StyleSpec, selector: string): string {
  const parts: string[] = [];
  const rule = (sel: string, d: Decls, indent = '') => {
    const decls = declsToCss(d);
    if (!decls.length) return '';
    return `${indent}${sel} {\n${decls.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}`;
  };
  const byBp = new Map<string, [string, Decls][]>();
  for (const [v, d] of Object.entries(clean(spec))) {
    const { bp, state } = splitVariant(v);
    byBp.set(bp, [...(byBp.get(bp) ?? []), [state ? `${selector}${STATE_SEL[state]}` : selector, d]]);
  }
  for (const [sel, d] of byBp.get('') ?? []) parts.push(rule(sel, d));
  for (const [bp, rules] of [...byBp].filter(([b]) => b).sort(([a], [b]) => BREAKPOINT_PX[a as 'sm'] - BREAKPOINT_PX[b as 'sm'])) parts.push(`@media (min-width: ${BREAKPOINT_PX[bp as 'sm']}px) {\n${rules.map(([s, d]) => rule(s, d, '  ')).filter(Boolean).join('\n')}\n}`);
  return parts.filter(Boolean).join('\n\n');
}

/** React `style` object for a set of declarations (for live previews). */
export function toStyleObject(d: Decls): Record<string, string> {
  return Object.fromEntries(declsToCss(d).map(([k, v]) => [k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), v]));
}

// --- reading ---------------------------------------------------------------------------------------

const num = (v: string) => {
  const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(v.trim());
  return m ? Number(m[1]) : v.trim() === 'auto' ? ('auto' as const) : undefined;
};
const RJUST = Object.fromEntries(Object.entries(JUSTIFY).map(([k, v]) => [v, k]));
const RALIGN = Object.fromEntries(Object.entries(ALIGN).map(([k, v]) => [v, k]));
const RSHADOW = Object.fromEntries(Object.entries(SHADOW).map(([k, v]) => [v.replace(/\s+/g, ' '), k]));
const RFAMILY = Object.fromEntries(Object.entries(FAMILY).map(([k, v]) => [v, k]));
const REASE = Object.fromEntries(Object.entries(EASE).map(([k, v]) => [v.replace(/\s+/g, ''), k]));
const RDIR = Object.fromEntries(Object.entries(GRAD_DIR).map(([k, v]) => [v, k]));
const unvar = (c: string) => /^var\(--color-([a-z]+-\d+|black|white)(,.*)?\)$/.exec(c.trim())?.[1] ?? c.trim();

function boxFrom(v: string): Box | undefined {
  const p = v.trim().split(/\s+/).map(num);
  if (p.some((x) => x === undefined) || !p.length || p.length > 4) return undefined;
  const [t, r = t, b = t, l = r] = p as (number | 'auto')[];
  return { top: t, right: r, bottom: b, left: l };
}

/** Read CSS declarations into the model; returns what it couldn't read (kept as is). */
export function declsFromCss(decls: [string, string][]): { decls: Decls; other: [string, string][] } {
  const d: Decls = {};
  const other: [string, string][] = [];
  for (const [rawProp, rawVal] of decls) {
    const p = rawProp.trim().toLowerCase();
    const v = rawVal.trim();
    const n = num(v);
    let ok = true;
    const side = /^(padding|margin)-(top|right|bottom|left)$/.exec(p);
    if (p === 'display' && ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'].includes(v)) d.display = v as Decls['display'];
    else if (p === 'flex-direction' && ['row', 'column', 'row-reverse', 'column-reverse'].includes(v)) d.flexDirection = v as Decls['flexDirection'];
    else if (p === 'flex-wrap' && (v === 'wrap' || v === 'nowrap')) d.flexWrap = v;
    else if (p === 'justify-content' && RJUST[v]) d.justifyContent = RJUST[v] as Decls['justifyContent'];
    else if (p === 'align-items' && RALIGN[v]) d.alignItems = RALIGN[v] as Decls['alignItems'];
    else if (p === 'gap' && typeof n === 'number') d.gap = n;
    else if (p === 'grid-template-columns' && /^repeat\((\d+),\s*minmax\(0,\s*1fr\)\)$/.test(v)) d.gridCols = Number(/\d+/.exec(v)![0]);
    else if (p === 'flex-grow' && v === '1') d.flexGrow = true;
    else if ((p === 'padding' || p === 'margin') && boxFrom(v) && !(p === 'padding' && v.includes('auto'))) d[p] = boxFrom(v);
    else if (side && n !== undefined) d[side[1] as 'padding'] = { ...(d[side[1] as 'padding'] ?? {}), [side[2]]: n };
    else if (['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'].includes(p)) d[p.replace(/-([a-z])/, (_m, c: string) => c.toUpperCase()) as 'width'] = v === '0' ? '0px' : v;
    else if (p === 'font-family') d.fontFamily = RFAMILY[v] ?? v;
    else if (p === 'font-size' && typeof n === 'number') d.fontSize = n;
    else if (p === 'font-weight' && /^\d+$/.test(v)) d.fontWeight = Number(v);
    else if (p === 'font-weight' && (v === 'bold' || v === 'normal')) d.fontWeight = v === 'bold' ? 700 : 400;
    else if (p === 'line-height' && /^\d+(\.\d+)?$/.test(v)) d.lineHeight = Number(v);
    else if (p === 'letter-spacing' && /^-?\d+(\.\d+)?em$/.test(v)) d.letterSpacing = parseFloat(v);
    else if (p === 'text-align' && ['left', 'center', 'right', 'justify'].includes(v)) d.textAlign = v as Decls['textAlign'];
    else if (p === 'font-style' && v === 'italic') d.italic = true;
    else if ((p === 'text-decoration-line' || p === 'text-decoration') && v === 'underline') d.underline = true;
    else if (p === 'text-transform' && v === 'uppercase') d.uppercase = true;
    else if (p === 'color') d.color = unvar(v);
    else if (p === 'background-color' || (p === 'background' && !/gradient|url\(/.test(v) && !v.includes(' '))) d.backgroundColor = unvar(v);
    else if ((p === 'background-image' || p === 'background') && /^linear-gradient\((.+)\)$/.test(v)) {
      const inner = /^linear-gradient\((.+)\)$/.exec(v)![1];
      const parts = inner.split(/,(?![^(]*\))/).map((x) => x.trim());
      const dir = RDIR[parts[0]];
      const cols = dir ? parts.slice(1) : parts;
      if (cols.length >= 2 && cols.length <= 3 && cols.every((c) => !/\s\d+%$/.test(c))) d.gradient = { dir: (dir ?? 'b') as GradientDir, from: unvar(cols[0]), ...(cols.length === 3 ? { via: unvar(cols[1]) } : {}), to: unvar(cols[cols.length - 1]) };
      else ok = false;
    } else if (p === 'border-width' && typeof n === 'number') d.borderWidth = n;
    else if (p === 'border-style' && ['solid', 'dashed', 'dotted', 'none'].includes(v)) d.borderStyle = v as Decls['borderStyle'];
    else if (p === 'border-color') d.borderColor = unvar(v);
    else if (p === 'border' && /^(\d+)px (solid|dashed|dotted) (.+)$/.test(v)) {
      const m = /^(\d+)px (solid|dashed|dotted) (.+)$/.exec(v)!;
      Object.assign(d, { borderWidth: Number(m[1]), borderStyle: m[2], borderColor: unvar(m[3]) });
    } else if (p === 'border-radius' && (v === '9999px' || v === '50%')) d.borderRadius = 'full';
    else if (p === 'border-radius' && typeof n === 'number') d.borderRadius = n;
    else if (p === 'box-shadow' && RSHADOW[v.replace(/\s+/g, ' ')]) d.shadow = RSHADOW[v.replace(/\s+/g, ' ')] as Decls['shadow'];
    else if (p === 'opacity' && /^\d*(\.\d+)?$/.test(v)) d.opacity = Math.round(Number(v) * 100);
    else if (p === 'position' && ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(v)) d.position = v as Decls['position'];
    else if (['top', 'right', 'bottom', 'left'].includes(p) && n !== undefined) d.inset = { ...(d.inset ?? {}), [p]: n };
    else if (p === 'z-index' && /^-?\d+$/.test(v)) d.zIndex = Number(v);
    else if (p === 'translate' && /^-?\d+(\.\d+)?px( -?\d+(\.\d+)?px)?$/.test(v)) {
      const [x, y] = v.split(' ').map(parseFloat);
      d.translateX = x;
      if (y !== undefined) d.translateY = y;
    } else if (p === 'rotate' && /^-?\d+(\.\d+)?deg$/.test(v)) d.rotate = parseFloat(v);
    else if (p === 'scale' && /^\d+(\.\d+)?$/.test(v)) d.scale = Math.round(Number(v) * 100);
    else if (p === 'transition-property') {
      const k = Object.entries(TRANSITION_PROPS).find(([, x]) => x === v)?.[0];
      if (k) d.transition = k as Decls['transition'];
      else ok = false;
    } else if (p === 'transition-duration' && /^\d+ms$/.test(v)) d.duration = parseInt(v, 10);
    else if (p === 'transition-duration' && /^\d*(\.\d+)?s$/.test(v)) d.duration = Math.round(parseFloat(v) * 1000);
    else if (p === 'transition-timing-function' && REASE[v.replace(/\s+/g, '')]) d.easing = REASE[v.replace(/\s+/g, '')] as Decls['easing'];
    else if (p === 'cursor' && ['auto', 'pointer', 'default', 'not-allowed', 'grab', 'text'].includes(v)) d.cursor = v as Decls['cursor'];
    else if (p === 'overflow' && ['visible', 'hidden', 'auto', 'scroll'].includes(v)) d.overflow = v as Decls['overflow'];
    else ok = false;
    if (!ok) other.push([rawProp, rawVal]);
  }
  return { decls: d, other };
}
