/**
 * Visual animation editor: an element's animations, each with a trigger, timing, and keyframes on
 * a timeline (drag the markers; tap one to edit what changes there). A preview plays it with the
 * same keyframes the generated code uses. Touch-friendly; shared by every surface with animations.
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { PRESETS, PROP_LABEL, waapi, type AnimationSpec, type Keyframe, type KeyframeProps, type Trigger } from '@cs/styling';
import { cx } from '../ui/primitives';
import { ctl, FieldRow, NumberControl, SegmentedControl, SelectControl, ToggleControl } from './controls';
import { PaletteColor } from './StyleEditor';

const TRIGGERS: { value: Trigger; label: string; title: string }[] = [
  { value: 'load', label: 'Appears', title: 'When it first appears' },
  { value: 'hover', label: 'Hover', title: 'While the pointer is over it' },
  { value: 'focus', label: 'Focus', title: 'When it gets keyboard focus' },
  { value: 'click', label: 'Click', title: 'Each time it is clicked or tapped' },
  { value: 'change', label: 'Value changes', title: 'Each time a value you wire in changes (e.g. a counter)' },
];

const NUM_PROPS: { key: 'x' | 'y' | 'rotate' | 'scale' | 'opacity'; unit: string; step: number; min?: number; max?: number }[] = [
  { key: 'x', unit: 'px', step: 4 },
  { key: 'y', unit: 'px', step: 4 },
  { key: 'rotate', unit: '°', step: 15 },
  { key: 'scale', unit: '%', step: 5, min: 0 },
  { key: 'opacity', unit: '%', step: 10, min: 0, max: 100 },
];

export function AnimationEditor({ value, onChange, previewText = 'Preview' }: { value: AnimationSpec[]; onChange: (v: AnimationSpec[], mergeKey?: string) => void; previewText?: string }) {
  const [sel, setSel] = useState(0);
  const [adding, setAdding] = useState(value.length === 0);
  const cur = value[sel];
  const update = (patch: Partial<AnimationSpec>, mergeKey?: string) => onChange(value.map((a, i) => (i === sel ? { ...a, ...patch } : a)), mergeKey ? `${sel}:${mergeKey}` : undefined);
  return (
    <div className="space-y-2 text-[12px]" data-testid="animation-editor">
      <div className="flex flex-wrap gap-1">
        {value.map((a, i) => (
          <button key={i} type="button" onClick={() => (setSel(i), setAdding(false))} className={cx('flex h-[32px] items-center gap-1 rounded-full border px-2.5 text-[11.5px] sm:h-[26px]', i === sel && !adding ? 'border-accent bg-accent/20' : 'border-border text-muted')} data-testid="animation-chip">
            {a.name} <span className="text-[10px] text-[#7d8696]">· {TRIGGERS.find((t) => t.value === a.trigger)?.label}</span>
          </button>
        ))}
        <button type="button" onClick={() => setAdding((x) => !x)} className="flex h-[32px] items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-muted hover:text-text sm:h-[26px]" data-testid="animation-add">
          <Plus size={12} /> Add
        </button>
      </div>
      {adding && (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3" data-testid="animation-presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="h-[36px] rounded border border-border text-[11.5px] hover:border-accent sm:h-[30px]"
              data-testid="animation-preset"
              data-preset={p.name}
              onClick={() => {
                onChange([...value, structuredClone(p)]);
                setSel(value.length);
                setAdding(false);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
      {cur && !adding && <OneAnimation key={sel} a={cur} update={update} remove={() => (onChange(value.filter((_, i) => i !== sel)), setSel(Math.max(0, sel - 1)))} previewText={previewText} />}
    </div>
  );
}

function OneAnimation({ a, update, remove, previewText }: { a: AnimationSpec; update: (p: Partial<AnimationSpec>, mergeKey?: string) => void; remove: () => void; previewText: string }) {
  const [kf, setKf] = useState(0);
  const frames = a.keyframes;
  const k = frames[kf] ?? frames[0];
  const setFrames = (next: Keyframe[], mergeKey?: string) => update({ keyframes: next }, mergeKey);
  const setProp = <P extends keyof KeyframeProps>(p: P, v: KeyframeProps[P]) => {
    const props = { ...k.props, [p]: v };
    if (v === undefined) delete props[p];
    setFrames(frames.map((f, i) => (i === kf ? { ...f, props } : f)), `kf${kf}:${p}`);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <input className={ctl} value={a.name} onChange={(e) => update({ name: e.target.value }, 'name')} aria-label="Animation name" data-testid="animation-name" />
        <button type="button" className="h-[36px] w-[36px] shrink-0 text-muted hover:text-red-300 sm:h-[28px]" onClick={remove} aria-label="Delete animation" data-testid="animation-delete">
          <Trash2 size={13} className="mx-auto" />
        </button>
      </div>
      <FieldRow label="Plays">
        <SegmentedControl value={a.trigger} onChange={(v) => v && update({ trigger: v })} options={TRIGGERS.map((t) => ({ value: t.value, label: t.label, title: t.title }))} testId="animation-trigger" />
      </FieldRow>
      {a.trigger === 'change' && <p className="rounded bg-accent/10 px-2 py-1 text-[11px] text-[#c9ced8]">Wire the value to watch (e.g. the counter) into this element's “Replay {a.name} when this changes” pin.</p>}
      <Preview a={a} text={previewText} />
      <Timeline frames={frames} selected={kf} onSelect={setKf} onChange={setFrames} />
      <div className="rounded border border-border p-2" data-testid="keyframe-editor">
        <div className="mb-1 flex items-center text-[11px] text-muted">
          At {Math.round(k.at)}%
          {frames.length > 2 && (
            <button type="button" className="ml-auto text-muted hover:text-red-300" onClick={() => (setFrames(frames.filter((_, i) => i !== kf)), setKf(0))} data-testid="keyframe-delete">
              Remove keyframe
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {NUM_PROPS.map((p) => (
            <div key={p.key} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
              <span className="text-[11.5px] text-muted">{PROP_LABEL[p.key]}</span>
              <NumberControl value={k.props[p.key]} step={p.step} min={p.min} max={p.max} unit={p.unit} placeholder="—" onChange={(v) => setProp(p.key, v)} testId={`kf-${p.key}`} />
            </div>
          ))}
          {(['color', 'backgroundColor'] as const).map((p) => (
            <div key={p} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
              <span className="text-[11.5px] text-muted">{PROP_LABEL[p]}</span>
              <PaletteColor value={k.props[p]} onChange={(v) => setProp(p, v)} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Duration">
          <NumberControl value={a.duration} min={50} step={100} unit="ms" onChange={(v) => update({ duration: v ?? 600 }, 'duration')} testId="animation-duration" />
        </FieldRow>
        <FieldRow label="Delay">
          <NumberControl value={a.delay ?? 0} min={0} step={100} unit="ms" onChange={(v) => update({ delay: v ?? 0 }, 'delay')} />
        </FieldRow>
        <FieldRow label="Easing">
          <SelectControl value={a.easing ?? 'ease'} options={['ease-out', 'ease-in', 'ease-in-out', 'ease', 'linear', 'bounce', 'spring'] as const} labels={{ 'ease-out': 'Slow down', 'ease-in': 'Speed up', 'ease-in-out': 'Smooth', ease: 'Natural', linear: 'Steady', bounce: 'Overshoot', spring: 'Springy' }} onChange={(v) => update({ easing: v })} />
        </FieldRow>
        <FieldRow label="Direction">
          <SelectControl value={a.direction ?? 'normal'} options={['normal', 'reverse', 'alternate', 'alternate-reverse'] as const} labels={{ normal: 'Forwards', reverse: 'Backwards', alternate: 'There and back', 'alternate-reverse': 'Back and there' }} onChange={(v) => update({ direction: v })} />
        </FieldRow>
        <FieldRow label="Repeat">
          <div className="flex items-center gap-2">
            <div className="flex-1">{a.iterations !== 0 && <NumberControl value={a.iterations ?? 1} min={1} onChange={(v) => update({ iterations: v ?? 1 }, 'iterations')} />}</div>
            <ToggleControl label="Forever" value={a.iterations === 0} onChange={(v) => update({ iterations: v ? 0 : 1 })} testId="animation-forever" />
          </div>
        </FieldRow>
      </div>
    </div>
  );
}

/** Keyframe markers on a 0–100 % track: drag to move, tap to select, tap the track to add one. */
function Timeline({ frames, selected, onSelect, onChange }: { frames: Keyframe[]; selected: number; onSelect: (i: number) => void; onChange: (f: Keyframe[], mergeKey?: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const pct = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div className="select-none" data-testid="timeline">
      <div className="mb-0.5 flex justify-between text-[10px] text-[#7d8696]">
        <span>start</span>
        <span>end</span>
      </div>
      <div
        ref={track}
        className="relative h-[40px] touch-none rounded bg-[#0f1218]"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const at = pct(e.clientX);
          const near = [...frames].sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
          const next = [...frames, { at, props: { ...(near?.props ?? {}) } }];
          onChange(next);
          onSelect(next.length - 1);
        }}
        data-testid="timeline-track"
      >
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-px bg-border" />
        {frames.map((f, i) => (
          <button
            key={i}
            type="button"
            className={cx('absolute top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-sm border-2', i === selected ? 'border-white bg-accent' : 'border-accent bg-[#1b2030]')}
            style={{ left: `calc(8px + (100% - 16px) * ${f.at / 100})` }}
            aria-label={`Keyframe at ${f.at}%`}
            data-testid="keyframe"
            data-at={f.at}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(i);
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const move = (ev: PointerEvent) => onChange(frames.map((x, j) => (j === i ? { ...x, at: pct(ev.clientX) } : x)), `drag${i}`);
              const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
              };
              el.addEventListener('pointermove', move);
              el.addEventListener('pointerup', up);
            }}
          />
        ))}
      </div>
      <div className="mt-0.5 text-[10.5px] text-[#7d8696]">Tap the track to add a keyframe; drag the diamonds to change timing.</div>
    </div>
  );
}

function Preview({ a, text }: { a: AnimationSpec; text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  const [playing, setPlaying] = useState(false);
  const play = () => {
    anim.current?.cancel();
    const w = waapi(a);
    const el = box.current;
    if (!el || typeof el.animate !== 'function') return;
    anim.current = el.animate(w.keyframes as never, w.options as KeyframeAnimationOptions);
    setPlaying(true);
    anim.current.onfinish = () => setPlaying(false);
  };
  // Replay whenever the animation changes, so edits show at once.
  useEffect(() => {
    play();
    return () => anim.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(a)]);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-[72px] flex-1 items-center justify-center overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#1b1f27_0%_25%,#12151b_0%_50%)] bg-[length:12px_12px]" data-testid="animation-preview">
        <div ref={box} className="rounded bg-white px-3 py-1.5 text-[13px] font-semibold text-slate-900">
          {text}
        </div>
      </div>
      <button type="button" className="flex h-[40px] w-[40px] items-center justify-center rounded-full bg-accent text-white" onClick={() => (playing ? (anim.current?.cancel(), setPlaying(false)) : play())} aria-label={playing ? 'Stop' : 'Play'} data-testid="animation-play">
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
    </div>
  );
}
