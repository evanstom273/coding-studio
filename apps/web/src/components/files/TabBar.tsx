/** Open files as tabs. Middle-click or × closes; right-click for "close others". */
import { useState } from 'react';
import { Lock, X } from 'lucide-react';
import { GRAPH_EXT } from '@cs/workspace';
import { useEditor } from '@web/store/editor';
import { DIFF_PREFIX, GEN_PREFIX, isDiffTab, isGenTab } from '@web/lib/fileTypes';
import { cx } from '../ui/primitives';
import { ContextMenu, iconFor } from './FileExplorer';
import { flushTextEdits } from './FileView';

export function TabBar() {
  const tabs = useEditor((s) => s.tabs);
  const active = useEditor((s) => s.activeTab);
  const scripts = useEditor((s) => s.project?.scripts);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  if (!tabs.length) return null;
  const label = (id: string) => {
    if (isGenTab(id)) return id.slice(GEN_PREFIX.length).split('/').pop()!;
    if (isDiffTab(id)) return `${id.slice(DIFF_PREFIX.length).split('/').pop()} (changes)`;
    if (id.endsWith(GRAPH_EXT)) return scripts?.find((s) => `${s.path}${GRAPH_EXT}` === id)?.name ?? id.split('/').pop()!;
    return id.split('/').pop()!;
  };
  const go = (id: string) => {
    flushTextEdits();
    useEditor.getState().openTab(id);
  };
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel [scrollbar-width:thin]" role="tablist" data-testid="tab-bar">
      {tabs.map((id) => (
        <div
          key={id}
          role="tab"
          aria-selected={id === active}
          title={isGenTab(id) ? `${id.slice(GEN_PREFIX.length)} (generated, read-only)` : id}
          data-testid="tab"
          data-tab={id}
          className={cx('group flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pl-2.5 pr-1 text-[12px]', id === active ? 'bg-[#12151b] text-text shadow-[inset_0_2px_0_var(--color-accent,#5b8cff)]' : 'text-muted hover:text-text')}
          onClick={() => go(id)}
          onAuxClick={(e) => e.button === 1 && useEditor.getState().closeTab(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id });
          }}
        >
          {iconFor(isGenTab(id) ? id.slice(GEN_PREFIX.length) : isDiffTab(id) ? id.slice(DIFF_PREFIX.length) : id, 12)}
          <span className="truncate">{label(id)}</span>
          {isGenTab(id) && <Lock size={10} className="shrink-0 text-muted" />}
          <button
            aria-label={`Close ${label(id)}`}
            data-testid="close-tab"
            className={cx('rounded p-0.5 hover:bg-panel-2', id === active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
            onClick={(e) => {
              e.stopPropagation();
              flushTextEdits();
              useEditor.getState().closeTab(id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Close', run: () => useEditor.getState().closeTab(menu.id) },
            { label: 'Close others', run: () => useEditor.getState().closeOtherTabs(menu.id) },
          ]}
        />
      )}
    </div>
  );
}
