import { Dialog } from '../ui/primitives';

export const SHORTCUTS: [string, string][] = [
  ['Tab / right-click canvas', 'Add node'],
  ['Drag a pin onto empty canvas', 'Add a compatible, connected node'],
  ['Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y)', 'Undo / redo'],
  ['Ctrl+S', 'Save'],
  ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copy / cut / paste nodes'],
  ['Ctrl+D', 'Duplicate selection'],
  ['Delete / Backspace', 'Delete selection'],
  ['Ctrl+A', 'Select all nodes'],
  ['H', 'Collapse / expand selected nodes'],
  ['C', 'Wrap selection in a comment frame'],
  ['F', 'Zoom to fit'],
  ['Ctrl+K / Ctrl+P', 'Command palette'],
  ['Ctrl+B', 'Validate (show errors)'],
  ['Shift+drag / drag on canvas', 'Box select'],
  ['Middle-drag / Space+drag', 'Pan'],
  ['Mouse wheel', 'Zoom'],
  ['Alt+drop a variable', 'Create a Set node instead of Get'],
  ['Double-click a Call node', 'Open that function'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={520}>
      <table className="w-full text-[12.5px]">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k} className="border-b border-border/40">
              <td className="py-1 pr-4 font-mono text-[11.5px] text-accent">{k}</td>
              <td className="py-1">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
