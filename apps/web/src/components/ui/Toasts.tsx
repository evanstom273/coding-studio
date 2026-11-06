import { CheckCircle2, Info, TriangleAlert, XCircle } from 'lucide-react';
import { useToasts } from '@web/store/toasts';
import { cx } from './primitives';

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[60] flex w-[360px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx('pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-left text-[12px] shadow-xl bg-panel', t.kind === 'error' ? 'border-red-500/50' : t.kind === 'warning' ? 'border-amber-500/40' : 'border-border')}
        >
          {t.kind === 'error' ? <XCircle size={15} className="mt-0.5 shrink-0 text-err" /> : t.kind === 'warning' ? <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" /> : t.kind === 'success' ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" /> : <Info size={15} className="mt-0.5 shrink-0 text-accent" />}
          <span className="break-words">{t.text}</span>
        </button>
      ))}
    </div>
  );
}
