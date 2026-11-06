import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { navigate } from '@web/lib/router';
import * as cmd from '@web/lib/commands';

interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUI((s) => s.commandPalette);
  const setUI = useUI((s) => s.set);
  const project = useEditor((s) => s.project);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'add', title: 'Add node…', hint: 'Tab', run: cmd.addNode },
      { id: 'validate', title: 'Validate project', hint: 'Ctrl+B', run: cmd.validate },
      { id: 'generate', title: 'Generate code', run: cmd.generate },
      { id: 'save', title: 'Save', hint: 'Ctrl+S', run: () => void cmd.save() },
      { id: 'undo', title: 'Undo', hint: 'Ctrl+Z', run: cmd.undo },
      { id: 'redo', title: 'Redo', hint: 'Ctrl+Shift+Z', run: cmd.redo },
      { id: 'export', title: 'Export…', run: () => setUI({ dialog: 'export' }) },
      { id: 'backups', title: 'Backups…', run: () => setUI({ dialog: 'backups' }) },
      { id: 'mcp', title: 'Claude Code (MCP) setup…', run: () => setUI({ dialog: 'mcp' }) },
      { id: 'settings', title: 'Settings…', run: () => setUI({ dialog: 'settings' }) },
      { id: 'shortcuts', title: 'Keyboard shortcuts', run: () => setUI({ dialog: 'shortcuts' }) },
      { id: 'project-settings', title: 'Project settings', run: () => setUI({ inspect: { kind: 'project' } }) },
      { id: 'fit', title: 'Zoom to fit', hint: 'F', run: () => window.dispatchEvent(new Event('cs:fit')) },
      { id: 'minimap', title: 'Toggle minimap', run: () => setUI({ showMinimap: !useUI.getState().showMinimap }) },
      { id: 'frame', title: 'Wrap selection in comment frame', hint: 'C', run: cmd.frameSelection },
      { id: 'projects', title: 'Go to project list', run: () => navigate({ name: 'dashboard' }) },
    ];
    for (const s of project?.scripts ?? []) for (const f of s.functions) list.push({ id: `fn:${f.id}`, title: `Open ${s.name} › ${f.name}`, run: () => useEditor.getState().setActive(s.id, f.id) });
    return list;
  }, [project, setUI]);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => c.title.toLowerCase().includes(w)));
  }, [commands, q]);

  if (!open) return null;
  const run = (c: Command) => {
    setUI({ commandPalette: false });
    c.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]" onMouseDown={() => setUI({ commandPalette: false })}>
      <div className="h-fit w-[520px] rounded-lg border border-border bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={input}
          data-testid="command-input"
          className="w-full rounded-t-lg border-b border-border bg-transparent px-3 py-2.5 text-[13px] focus:outline-none"
          placeholder="Type a command or function name…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setUI({ commandPalette: false });
            if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1));
            if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
            if (e.key === 'Enter' && results[active]) run(results[active]);
          }}
        />
        <div className="max-h-[50vh] overflow-auto py-1">
          {results.map((c, i) => (
            <button key={c.id} onMouseEnter={() => setActive(i)} onClick={() => run(c)} className={`flex w-full px-3 py-1.5 text-left text-[12.5px] ${i === active ? 'bg-accent/20' : ''}`}>
              {c.title}
              {c.hint && <span className="ml-auto font-mono text-[11px] text-muted">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
