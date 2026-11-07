/**
 * Visual animations: keyframes on a timeline (position, rotation, scale, opacity, colours), with
 * timing, looping and direction. Shared by every surface; turned into CSS @keyframes + the
 * `animation` shorthand, or into Web Animations API keyframes for animations started from code
 * (e.g. on click). Presets give a starting point for common motions.
 */
import { cssColor } from './palette';

export interface KeyframeProps {
  /** px */
  x?: number;
  y?: number;
  /** degrees */
  rotate?: number;
  /** percent (100 = normal size) */
  scale?: number;
  /** 0–100 */
  opacity?: number;
  color?: string;
  backgroundColor?: string;
}

export interface Keyframe {
  /** Position on the timeline, 0–100 % */
  at: number;
  props: KeyframeProps;
}

export type Easing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'bounce' | 'spring';
export type Trigger = 'load' | 'hover' | 'focus' | 'click' | 'change';

export interface AnimationSpec {
  /** Shown in the editor; also part of the generated @keyframes name. */
  name: string;
  trigger: Trigger;
  keyframes: Keyframe[];
  /** ms */
  duration: number;
  delay?: number;
  easing?: Easing;
  /** Times to play; 0 = forever */
  iterations?: number;
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
}

export const EASING_CSS: Record<Easing, string> = {
  linear: 'linear',
  ease: 'ease',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  spring: 'cubic-bezier(0.5, 1.8, 0.3, 0.8)',
};

export const PROP_LABEL: Record<keyof KeyframeProps, string> = { x: 'Move X', y: 'Move Y', rotate: 'Rotate', scale: 'Scale', opacity: 'Opacity', color: 'Text colour', backgroundColor: 'Background' };

const base = (o: Partial<AnimationSpec> & Pick<AnimationSpec, 'name' | 'keyframes'>): AnimationSpec => ({ trigger: 'load', duration: 600, easing: 'ease-out', iterations: 1, direction: 'normal', ...o });

/** Starting points for common motions. */
export const PRESETS: AnimationSpec[] = [
  base({ name: 'Bounce', easing: 'ease-out', keyframes: [{ at: 0, props: { y: 0 } }, { at: 30, props: { y: -16 } }, { at: 55, props: { y: 0 } }, { at: 75, props: { y: -6 } }, { at: 100, props: { y: 0 } }] }),
  base({ name: 'Pop', duration: 300, easing: 'bounce', keyframes: [{ at: 0, props: { scale: 100 } }, { at: 50, props: { scale: 125 } }, { at: 100, props: { scale: 100 } }] }),
  base({ name: 'Pulse', duration: 1200, easing: 'ease-in-out', iterations: 0, keyframes: [{ at: 0, props: { scale: 100, opacity: 100 } }, { at: 50, props: { scale: 105, opacity: 75 } }, { at: 100, props: { scale: 100, opacity: 100 } }] }),
  base({ name: 'Shake', duration: 400, easing: 'linear', keyframes: [{ at: 0, props: { x: 0 } }, { at: 20, props: { x: -8 } }, { at: 40, props: { x: 8 } }, { at: 60, props: { x: -6 } }, { at: 80, props: { x: 6 } }, { at: 100, props: { x: 0 } }] }),
  base({ name: 'Fade in', duration: 500, keyframes: [{ at: 0, props: { opacity: 0 } }, { at: 100, props: { opacity: 100 } }] }),
  base({ name: 'Slide in up', duration: 500, keyframes: [{ at: 0, props: { y: 24, opacity: 0 } }, { at: 100, props: { y: 0, opacity: 100 } }] }),
  base({ name: 'Slide in left', duration: 500, keyframes: [{ at: 0, props: { x: -32, opacity: 0 } }, { at: 100, props: { x: 0, opacity: 100 } }] }),
  base({ name: 'Spin', duration: 1000, easing: 'linear', iterations: 0, keyframes: [{ at: 0, props: { rotate: 0 } }, { at: 100, props: { rotate: 360 } }] }),
  base({ name: 'Wiggle', duration: 500, easing: 'ease-in-out', keyframes: [{ at: 0, props: { rotate: 0 } }, { at: 25, props: { rotate: -8 } }, { at: 75, props: { rotate: 8 } }, { at: 100, props: { rotate: 0 } }] }),
  base({ name: 'Flash colour', duration: 600, keyframes: [{ at: 0, props: { backgroundColor: 'amber-300' } }, { at: 100, props: {} }] }),
];

/** CSS declarations for one keyframe. */
export function keyframeDecls(p: KeyframeProps): [string, string][] {
  const out: [string, string][] = [];
  if (p.x !== undefined || p.y !== undefined) out.push(['translate', `${p.x ?? 0}px ${p.y ?? 0}px`]);
  if (p.rotate !== undefined) out.push(['rotate', `${p.rotate}deg`]);
  if (p.scale !== undefined) out.push(['scale', String(p.scale / 100)]);
  if (p.opacity !== undefined) out.push(['opacity', String(p.opacity / 100)]);
  if (p.color) out.push(['color', cssColor(p.color)]);
  if (p.backgroundColor) out.push(['background-color', cssColor(p.backgroundColor)]);
  return out;
}

const sorted = (spec: AnimationSpec) => [...spec.keyframes].sort((a, b) => a.at - b.at);

/** A safe @keyframes name. */
export const animationName = (spec: AnimationSpec, id: string) => `cs-${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'anim'}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-');

export function keyframesCss(name: string, spec: AnimationSpec): string {
  const frames = sorted(spec)
    .map((k) => {
      const d = keyframeDecls(k.props);
      return `  ${Math.round(k.at * 100) / 100}% {${d.length ? ` ${d.map(([p, v]) => `${p}: ${v};`).join(' ')} ` : ' '}}`;
    })
    .join('\n');
  return `@keyframes ${name} {\n${frames}\n}`;
}

/** The `animation` shorthand value. */
export function animationValue(name: string, spec: AnimationSpec): string {
  return [name, `${spec.duration}ms`, EASING_CSS[spec.easing ?? 'ease'], `${spec.delay ?? 0}ms`, spec.iterations === 0 ? 'infinite' : String(spec.iterations ?? 1), spec.direction ?? 'normal', 'both'].join(' ');
}

/** Web Animations API form (element.animate(keyframes, options)), for animations started from code. */
export function waapi(spec: AnimationSpec): { keyframes: Record<string, string | number>[]; options: Record<string, string | number> } {
  const keyframes = sorted(spec).map((k) => ({ offset: Math.max(0, Math.min(1, k.at / 100)), ...Object.fromEntries(keyframeDecls(k.props).map(([p, v]) => [p === 'background-color' ? 'backgroundColor' : p, v])) }));
  return { keyframes, options: { duration: spec.duration, delay: spec.delay ?? 0, easing: EASING_CSS[spec.easing ?? 'ease'], iterations: spec.iterations === 0 ? Infinity : (spec.iterations ?? 1), direction: spec.direction ?? 'normal', fill: 'both' } };
}

/** Problems with an animation, in plain words (empty = fine). */
export function checkAnimation(spec: unknown): string[] {
  const s = spec as AnimationSpec;
  const out: string[] = [];
  if (!s || typeof s !== 'object') return ['not an animation'];
  if (!['load', 'hover', 'focus', 'click', 'change'].includes(s.trigger)) out.push(`"${String(s.trigger)}" isn't a trigger (load, hover, focus, click, change)`);
  if (!Array.isArray(s.keyframes) || s.keyframes.length < 2) out.push('needs at least two keyframes');
  else if (s.keyframes.some((k) => typeof k?.at !== 'number' || k.at < 0 || k.at > 100)) out.push('keyframe positions must be 0–100 %');
  if (typeof s.duration !== 'number' || s.duration <= 0) out.push('duration must be more than 0 ms');
  return out;
}
