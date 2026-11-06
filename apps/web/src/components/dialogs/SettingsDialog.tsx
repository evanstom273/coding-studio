import { useUI } from '@web/store/ui';
import { Dialog } from '../ui/primitives';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ui = useUI();
  return (
    <Dialog title="Settings" onClose={onClose} width={440}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Editor</h3>
      <label className="mb-2 flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={ui.snapToGrid} onChange={(e) => ui.set({ snapToGrid: e.target.checked })} /> Snap nodes to the grid
      </label>
      <label className="mb-4 flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" checked={ui.showMinimap} onChange={(e) => ui.set({ showMinimap: e.target.checked })} /> Show minimap
      </label>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Code generation</h3>
      <p className="text-[12px] text-muted">
        Target version, indentation and comments are stored with the project.{' '}
        <button
          className="text-accent hover:underline"
          onClick={() => {
            ui.set({ inspect: { kind: 'project' }, dialog: null });
          }}
        >
          Open project settings
        </button>
      </p>
    </Dialog>
  );
}
