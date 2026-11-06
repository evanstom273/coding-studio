import { useEffect } from 'react';
import * as cmd from '@web/lib/commands';
import { useUI } from '@web/store/ui';

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !!t.closest('.monaco-editor');
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 's') {
        e.preventDefault();
        void cmd.save();
        return;
      }
      if (mod && (k === 'k' || k === 'p')) {
        e.preventDefault();
        useUI.getState().set({ commandPalette: true });
        return;
      }
      if (typing(e) || useUI.getState().dialog || useUI.getState().commandPalette) return;
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) cmd.redo();
        else cmd.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        cmd.redo();
      } else if (mod && k === 'c') cmd.copySelection();
      else if (mod && k === 'x') cmd.cutSelection();
      else if (mod && k === 'v') cmd.paste();
      else if (mod && k === 'd') {
        e.preventDefault();
        cmd.duplicateSelection();
      } else if (mod && k === 'a') {
        e.preventDefault();
        cmd.selectAll();
      } else if (mod && k === 'b') {
        e.preventDefault();
        cmd.validate();
      } else if (!mod && (k === 'delete' || k === 'backspace')) {
        e.preventDefault();
        void cmd.deleteSelection();
      } else if (!mod && k === 'tab') {
        e.preventDefault();
        cmd.addNode();
      } else if (!mod && !e.altKey && k === 'h') cmd.toggleCollapse();
      else if (!mod && !e.altKey && k === 'c') cmd.frameSelection();
      else if (!mod && !e.altKey && k === 'f') window.dispatchEvent(new Event('cs:fit'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
