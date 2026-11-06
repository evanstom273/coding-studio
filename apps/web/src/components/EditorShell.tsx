import { lazy, Suspense, useEffect, useState } from 'react';
import { loadProject } from '@web/db/projects';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { startCompileLoop, compileNow } from '@web/compile/store';
import { saveNow, useAutosave } from '@web/hooks/useAutosave';
import { useShortcuts } from '@web/hooks/useShortcuts';
import { useCompact } from '@web/hooks/useLayout';
import { navigate } from '@web/lib/router';
import { toast } from '@web/store/toasts';
import { Toolbar } from './panels/Toolbar';
import { LeftSidebar } from './panels/LeftSidebar';
import { Inspector } from './panels/Inspector';
import { BottomPanel } from './panels/BottomPanel';
import { StatusBar } from './panels/StatusBar';
import { CommandPalette } from './CommandPalette';
import { Splitter } from './ui/primitives';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { ExportDialog } from './dialogs/ExportDialog';
import { BackupsDialog } from './dialogs/BackupsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { ShortcutsDialog } from './dialogs/ShortcutsDialog';
import { McpDialog } from './dialogs/McpDialog';
import { NewProjectDialog } from './dialogs/NewProjectDialog';

const GraphCanvas = lazy(() => import('./canvas/GraphCanvas'));

export default function EditorShell({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const [error, setError] = useState<string | null>(null);
  const ui = useUI();
  const compact = useCompact();
  useAutosave();
  useShortcuts();

  useEffect(() => startCompileLoop(), []);

  useEffect(() => {
    let cancelled = false;
    const cur = useEditor.getState().project;
    if (cur?.id === projectId) return;
    setError(null);
    void (async () => {
      await saveNow();
      try {
        const l = await loadProject(projectId);
        if (cancelled) return;
        if (!l) {
          setError('This project does not exist in this browser.');
          return;
        }
        useEditor.getState().open(l.project, l.issues);
        compileNow(l.project);
        if (l.migratedFrom !== undefined) toast('info', `Project upgraded from schema ${l.migratedFrom}; it is saved in the new format on the next change.`);
        if (l.issues.length) toast('warning', `${l.issues.length} problem(s) were repaired while loading: ${l.issues[0]}`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (project) document.title = `${project.name} — Coding Studio`;
  }, [project]);

  useEffect(
    () => () => {
      void saveNow().then(() => useEditor.getState().close());
    },
    [],
  );

  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-err">{error}</div>
        <button className="text-accent hover:underline" onClick={() => navigate({ name: 'dashboard' })}>
          Back to projects
        </button>
      </div>
    );
  if (!project || project.id !== projectId) return <div className="flex h-full items-center justify-center text-muted">Opening project…</div>;

  const closeDialog = () => ui.set({ dialog: null });
  const bottom = (
    <div style={{ height: ui.bottomOpen ? (compact ? Math.min(ui.bottomHeight, Math.round(window.innerHeight * 0.4)) : ui.bottomHeight) : 33 }} className="shrink-0">
      <ErrorBoundary label="Bottom panel">
        <BottomPanel />
      </ErrorBoundary>
    </div>
  );
  const canvas = (
    <div className="min-h-0 flex-1">
      <ErrorBoundary label="Graph canvas">
        <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Loading canvas…</div>}>
          <GraphCanvas />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
  return (
    <div className="flex h-full w-full flex-col" data-testid="editor" data-layout={compact ? 'compact' : 'wide'}>
      <Toolbar />
      {compact ? (
        // Phones / narrow screens: the canvas gets the whole width; side panels are drawers.
        <div className="relative flex min-h-0 flex-1 flex-col">
          {canvas}
          {ui.bottomOpen && <Splitter vertical onDrag={(d) => ui.set({ bottomHeight: Math.max(120, Math.min(window.innerHeight * 0.7, useUI.getState().bottomHeight - d)) })} />}
          {bottom}
          {ui.drawer && <div className="absolute inset-0 z-30 bg-black/50" onClick={() => ui.set({ drawer: null })} data-testid="drawer-backdrop" />}
          <div className={`absolute bottom-0 left-0 top-0 z-30 w-[min(340px,88vw)] border-r border-border shadow-2xl transition-transform duration-200 ${ui.drawer === 'left' ? 'translate-x-0' : '-translate-x-full'}`} aria-hidden={ui.drawer !== 'left'} data-testid="drawer-left">
            {ui.drawer === 'left' && (
              <ErrorBoundary label="Sidebar">
                <LeftSidebar />
              </ErrorBoundary>
            )}
          </div>
          <div className={`absolute bottom-0 right-0 top-0 z-30 w-[min(360px,90vw)] border-l border-border shadow-2xl transition-transform duration-200 ${ui.drawer === 'right' ? 'translate-x-0' : 'translate-x-full'}`} aria-hidden={ui.drawer !== 'right'} data-testid="drawer-right">
            {ui.drawer === 'right' && (
              <ErrorBoundary label="Inspector">
                <Inspector />
              </ErrorBoundary>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div style={{ width: ui.leftWidth }} className="shrink-0">
            <ErrorBoundary label="Sidebar">
              <LeftSidebar />
            </ErrorBoundary>
          </div>
          <Splitter onDrag={(d) => ui.set({ leftWidth: Math.max(200, Math.min(520, useUI.getState().leftWidth + d)) })} />
          <div className="flex min-w-0 flex-1 flex-col">
            {canvas}
            {ui.bottomOpen && <Splitter vertical onDrag={(d) => ui.set({ bottomHeight: Math.max(120, Math.min(window.innerHeight * 0.7, useUI.getState().bottomHeight - d)) })} />}
            {bottom}
          </div>
          <Splitter onDrag={(d) => ui.set({ rightWidth: Math.max(240, Math.min(560, useUI.getState().rightWidth - d)) })} />
          <div style={{ width: ui.rightWidth }} className="shrink-0">
            <ErrorBoundary label="Inspector">
              <Inspector />
            </ErrorBoundary>
          </div>
        </div>
      )}
      <StatusBar />
      <CommandPalette />
      {ui.dialog === 'export' && <ExportDialog onClose={closeDialog} />}
      {ui.dialog === 'backups' && <BackupsDialog onClose={closeDialog} />}
      {ui.dialog === 'settings' && <SettingsDialog onClose={closeDialog} />}
      {ui.dialog === 'shortcuts' && <ShortcutsDialog onClose={closeDialog} />}
      {ui.dialog === 'mcp' && <McpDialog onClose={closeDialog} />}
      {ui.dialog === 'new-project' && <NewProjectDialog onClose={closeDialog} />}
    </div>
  );
}
