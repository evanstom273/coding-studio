import { useEffect } from 'react';
import { useEditor } from '@web/store/editor';
import { copySelection, deleteSelection, duplicateSelection, frameSelection, toggleCollapse } from '@web/lib/commands';

export function NodeContextMenu({ x, y, nodeId, onClose }: { x: number; y: number; nodeId: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const s = useEditor.getState();
  const isEntry = s.project?.scripts.flatMap((sc) => sc.functions).find((f) => f.id === s.activeFunctionId)?.graph.nodes.find((n) => n.id === nodeId)?.type === 'core.entry';
  const item = (label: string, kbd: string, fn: () => void, disabled = false) => (
    <button
      disabled={disabled}
      onClick={() => {
        fn();
        onClose();
      }}
      className="flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[12px] hover:bg-accent/20 disabled:opacity-40"
    >
      <span>{label}</span>
      <span className="text-[10.5px] text-muted">{kbd}</span>
    </button>
  );
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="absolute min-w-[200px] rounded-md border border-border bg-panel py-1 shadow-2xl" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
        {item('Duplicate', 'Ctrl+D', duplicateSelection, isEntry)}
        {item('Copy', 'Ctrl+C', copySelection, isEntry)}
        {item('Collapse / expand', 'H', toggleCollapse)}
        {item('Wrap in comment frame', 'C', frameSelection)}
        <div className="my-1 border-t border-border" />
        {item('Delete', 'Del', () => void deleteSelection(), isEntry)}
      </div>
    </div>
  );
}
