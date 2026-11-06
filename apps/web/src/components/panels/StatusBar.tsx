import { languages } from '@web/lib/toolchain';
import { useCompile } from '@web/compile/store';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';

export function StatusBar() {
  const { diagnostics, ms, running } = useCompile();
  const sel = useEditor((s) => s.selection.nodes.length);
  const project = useEditor((s) => s.project)!;
  const setUI = useUI((s) => s.set);
  const e = diagnostics.filter((d) => d.severity === 'error').length;
  const w = diagnostics.filter((d) => d.severity === 'warning').length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted">
      <button onClick={() => setUI({ bottomOpen: true, bottomTab: 'errors' })} className={e ? 'text-red-300' : ''} data-testid="status-errors">
        {e} error{e === 1 ? '' : 's'}
      </button>
      <button onClick={() => setUI({ bottomOpen: true, bottomTab: 'warnings' })} className={w ? 'text-amber-200' : ''}>
        {w} warning{w === 1 ? '' : 's'}
      </button>
      <span>{running ? 'compiling…' : `compiled in ${Math.round(ms)} ms`}</span>
      {sel > 0 && <span>{sel} selected</span>}
      <span className="ml-auto">
        {(() => {
          const a = languages.get(project.language);
          return `${a?.name ?? project.language} · ${a?.versions.find((v) => v.id === project.languageVersion)?.label ?? project.languageVersion}`;
        })()}
      </span>
    </footer>
  );
}
