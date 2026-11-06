import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { create } from 'zustand';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'default' | 'primary' | 'danger' | 'ghost';
export function Button({ variant = 'default', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded px-2.5 h-7 text-[12px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-2',
        variant === 'danger' && 'bg-red-600/90 text-white hover:bg-red-600',
        variant === 'default' && 'bg-panel-2 border border-border text-text hover:bg-[#252b37]',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-panel-2',
        className,
      )}
    />
  );
}

export function IconButton({ label, children, active, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...p}
      className={cx('inline-flex shrink-0 items-center justify-center rounded h-7 min-w-7 px-1.5 gap-1 text-muted hover:text-text hover:bg-panel-2 disabled:opacity-35 disabled:pointer-events-none', active && 'text-text bg-panel-2', className)}
    >
      {children}
    </button>
  );
}

export function Dialog({ title, onClose, children, footer, width = 520 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([aria-label="Close"])')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[85vh] flex-col rounded-lg border border-border bg-panel shadow-2xl" style={{ width: `min(${width}px, 94vw)` }}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="overflow-auto px-4 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-2.5 block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded border border-border bg-[#0f1218] px-2 h-7 text-[12px] text-text placeholder:text-[#5b6372] focus:border-accent focus:outline-none';

export function Splitter({ onDrag, vertical }: { onDrag: (delta: number) => void; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      className={cx('shrink-0 bg-border/60 hover:bg-accent transition-colors', vertical ? 'h-[3px] cursor-row-resize' : 'w-[3px] cursor-col-resize')}
      onPointerDown={(e) => {
        e.preventDefault();
        let last = vertical ? e.clientY : e.clientX;
        const move = (ev: PointerEvent) => {
          const cur = vertical ? ev.clientY : ev.clientX;
          onDrag(cur - last);
          last = cur;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

// --- confirmation dialogs ----------------------------------------------------

interface ConfirmReq {
  title: string;
  message: ReactNode;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
const useConfirmStore = create<{ req: ConfirmReq | null }>()(() => ({ req: null }));

export function confirmDialog(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.setState({ req: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req);
  if (!req) return null;
  const done = (ok: boolean) => {
    useConfirmStore.setState({ req: null });
    req.resolve(ok);
  };
  return (
    <Dialog
      title={req.title}
      onClose={() => done(false)}
      width={440}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)} data-testid="confirm-ok">
            {req.confirm}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-[#c9ced8]">{req.message}</div>
    </Dialog>
  );
}
