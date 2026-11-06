/** UI-only preferences, persisted to localStorage. Never written into project documents. */
import { create } from 'zustand';

export type BottomTab = 'code' | 'errors' | 'warnings' | 'mcp' | 'info';
export type LeftTab = 'files' | 'project' | 'nodes' | 'search' | 'git';
export type DialogId = null | 'new-project' | 'export' | 'settings' | 'mcp' | 'backups' | 'shortcuts' | 'add-script';

interface UIState {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  leftTab: LeftTab;
  snapToGrid: boolean;
  showMinimap: boolean;
  dialog: DialogId;
  commandPalette: boolean;
  /** What the inspector shows when no node is selected. */
  /** Compact layout: which side drawer is open (not persisted). */
  drawer: null | 'left' | 'right';
  inspect: { kind: 'project' | 'script' | 'function' | 'variable' | 'signal' | 'enum'; id?: string } | null;
  set(p: Partial<Omit<UIState, 'set'>>): void;
}

const KEY = 'coding-studio:ui';
const PERSIST: (keyof UIState)[] = ['leftWidth', 'rightWidth', 'bottomHeight', 'bottomOpen', 'bottomTab', 'leftTab', 'snapToGrid', 'showMinimap'];

function load(): Partial<UIState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export const useUI = create<UIState>()((set, get) => ({
  leftWidth: 280,
  rightWidth: 320,
  bottomHeight: 260,
  bottomOpen: true,
  bottomTab: 'code',
  leftTab: 'nodes',
  snapToGrid: true,
  showMinimap: true,
  dialog: null,
  commandPalette: false,
  inspect: null,
  drawer: null,
  ...load(),
  set(p) {
    set(p);
    try {
      const s = get();
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, s[k]]))));
    } catch {
      /* storage unavailable */
    }
  },
}));
