/**
 * Editor state: the open project, active script/graph, selection and history.
 * Every change goes through `dispatch(ops)` → applyOps (the same function MCP uses), so
 * validation, undo and autosave are identical for mouse and AI edits.
 */
import { create } from 'zustand';
import type { FunctionDecl, ScriptDoc } from '@cs/graph-core';
import { applyOps, OpError, projectRevision, type ApplyResult, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor } from '@web/lib/toolchain';
import { emptyHistory, pushHistory, redoHistory, undoHistory, type HistoryState } from './history';
import { toast } from './toasts';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface DispatchOptions {
  mergeKey?: string;
  source?: 'user' | 'mcp' | 'system';
  /** Script/graph used when ops omit them (defaults to the active ones). */
  defaults?: { scriptId?: string; functionId?: string };
}

interface EditorState {
  project: Project | null;
  loadIssues: string[];
  activeScriptId?: string;
  activeFunctionId?: string;
  selection: { nodes: string[]; edges: string[] };
  history: HistoryState<Project>;
  saveState: SaveState;
  saveError?: string;
  /** Bumped whenever the document changes (for effects). */
  version: number;
  /** Node to centre on in the canvas (set by diagnostics clicks). */
  focusRequest?: { nodeId: string; seq: number };

  open(p: Project, issues?: string[]): void;
  close(): void;
  dispatch(ops: EditOp[], label: string, opts?: DispatchOptions): ApplyResult;
  tryDispatch(ops: EditOp[], label: string, opts?: DispatchOptions): ApplyResult | null;
  /** Replace the whole document as one undoable step (backup restore, import into open project). */
  replaceProject(p: Project, label: string, source?: 'user' | 'mcp' | 'system'): void;
  undo(): string | null;
  redo(): string | null;
  setActive(scriptId?: string, functionId?: string): void;
  select(nodes: string[], edges?: string[]): void;
  focusNode(functionId: string, nodeId: string, scriptId?: string): void;
  setSaveState(s: SaveState, error?: string): void;
  /** Persist a graph's viewport without creating an undo step. */
  setViewportSilently(functionId: string, viewport: { x: number; y: number; zoom: number }): void;
}

function fixActive(p: Project, scriptId?: string, functionId?: string) {
  const s = p.scripts.find((x) => x.id === scriptId) ?? p.scripts[0];
  const f = s?.functions.find((x) => x.id === functionId) ?? s?.functions[0];
  return { activeScriptId: s?.id, activeFunctionId: f?.id };
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  loadIssues: [],
  selection: { nodes: [], edges: [] },
  history: emptyHistory(),
  saveState: 'saved',
  version: 0,

  open(p, issues = []) {
    set({ project: p, loadIssues: issues, history: emptyHistory(), selection: { nodes: [], edges: [] }, saveState: 'saved', saveError: undefined, version: get().version + 1, ...fixActive(p, p.editor?.activeScriptId, p.editor?.activeFunctionId) });
  },
  close() {
    set({ project: null, history: emptyHistory(), selection: { nodes: [], edges: [] }, activeScriptId: undefined, activeFunctionId: undefined });
  },

  dispatch(ops, label, opts = {}) {
    const { project, activeScriptId, activeFunctionId } = get();
    if (!project) throw new OpError('No project is open');
    const tc = toolchainFor(project.language);
    const res = applyOps(project, ops, tc, opts.defaults ?? { scriptId: activeScriptId, functionId: activeFunctionId });
    if (res.project === project) return res;
    const next = { ...res.project, updatedAt: Date.now() };
    res.project = next;
    set((s) => ({
      project: next,
      history: pushHistory(s.history, { before: project, after: next, label, source: opts.source ?? 'user', mergeKey: opts.mergeKey }),
      saveState: 'dirty',
      version: s.version + 1,
      ...fixActive(next, s.activeScriptId, s.activeFunctionId),
    }));
    for (const w of res.warnings) toast('warning', w);
    return res;
  },

  tryDispatch(ops, label, opts) {
    try {
      return get().dispatch(ops, label, opts);
    } catch (e) {
      toast('error', e instanceof Error ? e.message.replace(/^Operation \d+ \([a-z_]+\): /, '') : String(e));
      return null;
    }
  },

  replaceProject(p, label, source = 'user') {
    const cur = get().project;
    if (!cur) return get().open(p);
    const next = { ...p, id: cur.id, updatedAt: Date.now() };
    set((s) => ({ project: next, history: pushHistory(s.history, { before: cur, after: next, label, source }), saveState: 'dirty', version: s.version + 1, ...fixActive(next, s.activeScriptId, s.activeFunctionId) }));
  },

  undo() {
    const r = undoHistory(get().history);
    if (!r) return null;
    set((s) => ({ project: r.state, history: r.history, saveState: 'dirty', version: s.version + 1, ...fixActive(r.state, s.activeScriptId, s.activeFunctionId) }));
    return r.entry.label;
  },
  redo() {
    const r = redoHistory(get().history);
    if (!r) return null;
    set((s) => ({ project: r.state, history: r.history, saveState: 'dirty', version: s.version + 1, ...fixActive(r.state, s.activeScriptId, s.activeFunctionId) }));
    return r.entry.label;
  },

  setActive(scriptId, functionId) {
    const p = get().project;
    if (!p) return;
    set({ ...fixActive(p, scriptId, functionId), selection: { nodes: [], edges: [] } });
  },
  select(nodes, edges = []) {
    const cur = get().selection;
    if (cur.nodes.join() === nodes.join() && cur.edges.join() === edges.join()) return;
    set({ selection: { nodes, edges } });
  },
  focusNode(functionId, nodeId, scriptId) {
    const p = get().project;
    if (!p) return;
    const s = scriptId ?? p.scripts.find((x) => x.functions.some((f) => f.id === functionId))?.id;
    set({ ...fixActive(p, s, functionId), selection: { nodes: [nodeId], edges: [] }, focusRequest: { nodeId, seq: Date.now() } });
  },
  setSaveState(saveState, saveError) {
    set({ saveState, saveError });
  },
  setViewportSilently(functionId, viewport) {
    const p = get().project;
    if (!p) return;
    const scripts = p.scripts.map((s) => (s.functions.some((f) => f.id === functionId) ? { ...s, functions: s.functions.map((f) => (f.id === functionId ? { ...f, graph: { ...f.graph, viewport } } : f)) } : s));
    // Not a content change: no history entry and no version bump (avoids recompiling).
    set({ project: { ...p, scripts }, saveState: get().saveState === 'saved' ? 'dirty' : get().saveState });
  },
}));

export function useActiveScript(): ScriptDoc | undefined {
  return useEditor((s) => s.project?.scripts.find((x) => x.id === s.activeScriptId));
}

export function useActiveFunction(): FunctionDecl | undefined {
  return useEditor((s) => s.project?.scripts.find((x) => x.id === s.activeScriptId)?.functions.find((f) => f.id === s.activeFunctionId));
}

export function currentRevision(): string | null {
  const p = useEditor.getState().project;
  return p ? projectRevision(p) : null;
}
