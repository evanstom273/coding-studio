/**
 * Debounced autosave (800 ms after the last change) and immediate save on Ctrl+S / page hide.
 * Quota or storage errors surface in the save indicator rather than being swallowed.
 */
import { useEffect } from 'react';
import { saveProject } from '@web/db/projects';
import { useEditor } from '@web/store/editor';

let timer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;

export async function saveNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (saving) await saving;
  const s = useEditor.getState();
  if (!s.project || s.saveState === 'saved') return;
  const snapshot = s.project;
  const version = s.version;
  s.setSaveState('saving');
  saving = saveProject({ ...snapshot, editor: { activeScriptId: s.activeScriptId, activeFunctionId: s.activeFunctionId } })
    .then(() => {
      if (useEditor.getState().version === version) useEditor.getState().setSaveState('saved');
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
      if (s.project && s.project !== prev.project && s.saveState === 'dirty') schedule();
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
