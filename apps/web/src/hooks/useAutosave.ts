/**
 * Debounced autosave (800 ms after the last change) and immediate save on Ctrl+S / page hide.
 * Only files that changed since the last save are written. Quota or storage errors surface in
 * the save indicator rather than being swallowed.
 */
import { useEffect } from 'react';
import type { Workspace } from '@cs/workspace';
import { saveWorkspace } from '@web/db/projects';
import { useEditor } from '@web/store/editor';

let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
/** The snapshot last written to IndexedDB (per open workspace). */
let lastSaved: Workspace | null = null;

/** Paths whose record differs between two snapshots (records are shared when unchanged). */
export function changedBetween(a: Workspace | null, b: Workspace): string[] {
  if (!a || a.meta.id !== b.meta.id) return [...b.files.keys()];
  const out: string[] = [];
  for (const [p, r] of b.files) if (a.files.get(p) !== r) out.push(p);
  for (const p of a.files.keys()) if (!b.files.has(p)) out.push(p);
  return out;
}

/** Call when a workspace is opened or written by someone else (sync), so it isn't re-saved. */
export function markSaved(ws: Workspace | null) {
  lastSaved = ws;
}

export async function saveNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (saving) await saving;
  const s = useEditor.getState();
  if (!s.workspace || s.saveState === 'saved') return;
  const ws: Workspace = { meta: { ...s.workspace.meta, editor: { ...s.workspace.meta.editor, activeScriptId: s.activeScriptId, activeFunctionId: s.activeFunctionId } }, files: s.workspace.files };
  const version = s.version;
  const paths = lastSaved?.meta.id === ws.meta.id ? changedBetween(lastSaved, ws) : undefined;
  s.setSaveState('saving');
  saving = saveWorkspace(ws, paths)
    .then(() => {
      lastSaved = s.workspace;
      if (useEditor.getState().version === version && useEditor.getState().workspace === s.workspace) useEditor.getState().setSaveState('saved');
      else useEditor.getState().setSaveState('dirty');
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? (e.name === 'QuotaExceededError' ? 'Browser storage is full' : e.message) : String(e);
      useEditor.getState().setSaveState('error', msg);
    })
    .finally(() => {
      saving = null;
    });
  await saving;
  if (useEditor.getState().saveState === 'dirty') schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), 800);
}

export function useAutosave() {
  useEffect(() => {
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.workspace && s.workspace !== prev.workspace && s.workspace.meta.id !== prev.workspace?.meta.id && s.saveState === 'saved') lastSaved = s.workspace;
      if (s.workspace && s.workspace !== prev.workspace && s.saveState === 'dirty') schedule();
    });
    const onHide = () => {
      if (document.visibilityState === 'hidden') void saveNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onHide);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onHide);
    };
  }, []);
}
