import { Play, PanelLeft, PanelRight, ArrowLeft, CheckCircle2, Cloud, CloudOff, Code2, Command, Download, FolderOpen, History, Keyboard, Loader2, Plus, Redo2, Save, Settings, ShieldCheck, Undo2, FilePlus2 } from 'lucide-react';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { navigate } from '@web/lib/router';
import * as cmd from '@web/lib/commands';
import { McpIndicator } from './McpIndicator';
import { useCompact } from '@web/hooks/useLayout';
import { IconButton } from '../ui/primitives';

function SaveIndicator() {
  const { saveState, saveError } = useEditor();
  const map = {
    saved: [<CheckCircle2 key="s" size={13} className="text-ok" />, 'Saved'],
    dirty: [<Cloud key="d" size={13} className="text-muted" />, 'Unsaved changes'],
    saving: [<Loader2 key="g" size={13} className="animate-spin text-muted" />, 'Saving…'],
    error: [<CloudOff key="e" size={13} className="text-err" />, `Save failed: ${saveError}`],
  } as const;
  const [icon, text] = map[saveState];
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted" title={text} data-testid="save-state" data-state={saveState}>
      {icon}
      <span className="hidden xl:inline">{saveState === 'error' ? 'Save failed' : text}</span>
    </span>
  );
}

export function Toolbar() {
  const project = useEditor((s) => s.project)!;
  const canUndo = useEditor((s) => s.history.past.length > 0);
  const canRedo = useEditor((s) => s.history.future.length > 0);
  const undoLabel = useEditor((s) => s.history.past[s.history.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.history.future[0]?.label);
  const setUI = useUI((s) => s.set);
  const drawer = useUI((s) => s.drawer);
  const compact = useCompact();
  const activeScriptId = useEditor((x) => x.activeScriptId);
  const activeFunctionId = useEditor((x) => x.activeFunctionId);
  const script = project.scripts.find((s) => s.id === activeScriptId);
  const fn = script?.functions.find((f) => f.id === activeFunctionId);
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
      <IconButton label="Back to projects" onClick={() => navigate({ name: 'dashboard' })}>
        <ArrowLeft size={16} />
      </IconButton>
      {compact && (
        <IconButton label="Project and nodes" active={drawer === 'left'} onClick={() => setUI({ drawer: drawer === 'left' ? null : 'left' })} data-testid="open-left-drawer">
          <PanelLeft size={16} />
        </IconButton>
      )}
      {/* Middle section scrolls sideways on narrow screens; navigation and drawers stay pinned. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
      <div className={`mr-2 flex min-w-0 flex-col leading-tight ${compact ? 'min-w-[96px] max-w-[38vw] shrink' : ''}`}>
        <span className="truncate text-[13px] font-semibold" data-testid="project-title">
          {project.name}
        </span>
        <span className="truncate text-[11px] text-muted" data-testid="breadcrumb">
          {script?.name ?? '—'} › {fn?.name ?? '—'}
        </span>
      </div>
      <SaveIndicator />
      <div className="mx-2 h-5 w-px shrink-0 bg-border" />
      {!compact && (<>
      <IconButton label="New project" onClick={() => {
          navigate({ name: 'dashboard' });
          setUI({ dialog: 'new-project' });
        }}>
        <FilePlus2 size={15} />
      </IconButton>
      <IconButton label="Open project" onClick={() => navigate({ name: 'dashboard' })}>
        <FolderOpen size={15} />
      </IconButton>
      </>)}
      <IconButton label="Save (Ctrl+S)" onClick={() => void cmd.save()} data-testid="save">
        <Save size={15} />
      </IconButton>
      <IconButton label={canUndo ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo'} disabled={!canUndo} onClick={cmd.undo} data-testid="undo">
        <Undo2 size={15} />
      </IconButton>
      <IconButton label={canRedo ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Redo'} disabled={!canRedo} onClick={cmd.redo} data-testid="redo">
        <Redo2 size={15} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-border" />
      <IconButton label="Add node (Tab)" onClick={cmd.addNode} data-testid="toolbar-add-node">
        <Plus size={15} /> <span className="hidden text-[12px] lg:inline">Add Node</span>
      </IconButton>
      <IconButton label="Validate (Ctrl+B)" onClick={cmd.validate} data-testid="validate">
        <ShieldCheck size={15} /> <span className="hidden text-[12px] lg:inline">Validate</span>
      </IconButton>
      <IconButton label="Generate code" onClick={cmd.generate} data-testid="generate">
        <Code2 size={15} /> <span className="hidden text-[12px] lg:inline">Generate</span>
      </IconButton>
      {project.language !== 'gdscript' && (
        <IconButton label="Preview the app" onClick={() => useEditor.getState().openTab('preview:app')} data-testid="open-preview">
          <Play size={15} /> <span className="hidden text-[12px] lg:inline">Preview</span>
        </IconButton>
      )}
      <IconButton label="Export" onClick={() => setUI({ dialog: 'export' })} data-testid="export">
        <Download size={15} /> <span className="hidden text-[12px] lg:inline">Export</span>
      </IconButton>
      <div className="min-w-2 flex-1" />
      {!compact && (
        <IconButton label="Command palette (Ctrl+K)" onClick={() => setUI({ commandPalette: true })}>
          <Command size={15} />
        </IconButton>
      )}
      <IconButton label="Backups" onClick={() => setUI({ dialog: 'backups' })} data-testid="backups">
        <History size={15} />
      </IconButton>
      {!compact && (
        <IconButton label="Keyboard shortcuts" onClick={() => setUI({ dialog: 'shortcuts' })}>
          <Keyboard size={15} />
        </IconButton>
      )}
      <IconButton label="Settings" onClick={() => setUI({ dialog: 'settings' })}>
        <Settings size={15} />
      </IconButton>
      </div>
      <McpIndicator compact={compact} />
      {compact && (
        <IconButton label="Inspector" active={drawer === 'right'} onClick={() => setUI({ drawer: drawer === 'right' ? null : 'right' })} data-testid="open-right-drawer">
          <PanelRight size={16} />
        </IconButton>
      )}
    </header>
  );
}
