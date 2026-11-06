/**
 * Editor state: the open workspace (files), the Project view derived from its graph files,
 * active script/graph, selection and history.
 *
 * Every graph change goes through `dispatch(ops)` → applyProjectOps (the same EditOp engine MCP
 * uses), which rewrites only the `.vgraph` files it touched. File-level changes go through
 * `applyFiles(ops)` (WorkspaceOps). Undo history holds workspace snapshots, which share every
 * unchanged file record, so it stays cheap.
 */
import { create } from 'zustand';
import type { FunctionDecl, ScriptDoc } from '@cs/graph-core';
import { OpError, type ApplyResult, type EditOp, type Project } from '@cs/project-format';
import { applyProjectOps, applyWorkspaceOps, deriveProject, graphPathFor, makeRecord, projectToWorkspace, serializeGraph, workspaceRevision, type Workspace, type WorkspaceApplyResult, type WorkspaceOp } from '@cs/workspace';
import { toolchainFor } from '@web/lib/toolchain';
import { emptyHistory, pushHistory, redoHistory, undoHistory, type HistoryState } from './history';
import { toast } from './toasts';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
type Source = 'user' | 'mcp' | 'system';

export interface DispatchOptions {
  mergeKey?: string;
  source?: Source;
  /** Script/graph used when ops omit them (defaults to the active ones). */
  defaults?: { scriptId?: string; functionId?: string };
}

interface EditorState {
  workspace: Workspace | null;
  /** Derived from `workspace` (graph files + codingstudio.json). */
  project: Project | null;
  loadIssues: string[];
  activeScriptId?: string;
  activeFunctionId?: string;
  selection: { nodes: string[]; edges: string[] };
  history: HistoryState<Workspace>;
  saveState: SaveState;
  saveError?: string;
  /** Bumped whenever the document changes (for effects). */
  version: number;
  /** Node to centre on in the canvas (set by diagnostics clicks). */
  focusRequest?: { nodeId: string; seq: number };

  open(ws: Workspace, issues?: string[]): void;
  close(): void;
  dispatch(ops: EditOp[], label: string, opts?: DispatchOptions): ApplyResult;
  tryDispatch(ops: EditOp[], label: string, opts?: DispatchOptions): ApplyResult | null;
  /** File-level operations (write, move, delete…) as one undoable step. */
  applyFiles(ops: WorkspaceOp[], label: string, opts?: Omit<DispatchOptions, 'defaults'>): WorkspaceApplyResult;
  /** Replace the whole workspace as one undoable step (backup restore, sync, import). */
  replaceWorkspace(ws: Workspace, label: string, source?: Source): void;
  /** Same, from a schema-1 Project document. */
  replaceProject(p: Project, label: string, source?: Source): void;
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

function view(ws: Workspace) {
  const d = deriveProject(ws);
  return { project: d.project, issues: d.issues.map((i) => `${i.path}: ${i.message}`) };
}

export const useEditor = create<EditorState>()((set, get) => {
  /** Install a new workspace snapshot (with or without a history entry). */
  const commit = (next: Workspace, entry?: { label: string; source: Source; mergeKey?: string }) => {
    const cur = get().workspace;
    const v = view(next);
    set((s) => ({
      workspace: next,
      project: v.project,
      loadIssues: v.issues,
      history: entry && cur ? pushHistory(s.history, { before: cur, after: next, ...entry }) : s.history,
      saveState: 'dirty',
      version: s.version + 1,
      ...fixActive(v.project, s.activeScriptId, s.activeFunctionId),
    }));
    return v.project;
  };

  return {
    workspace: null,
    project: null,
    loadIssues: [],
    selection: { nodes: [], edges: [] },
    history: emptyHistory(),
    saveState: 'saved',
    version: 0,

    open(ws, issues = []) {
      const v = view(ws);
      const e = ws.meta.editor;
      set({ workspace: ws, project: v.project, loadIssues: [...issues, ...v.issues.filter((i) => !issues.includes(i))], history: emptyHistory(), selection: { nodes: [], edges: [] }, saveState: 'saved', saveError: undefined, version: get().version + 1, ...fixActive(v.project, e?.activeScriptId, e?.activeFunctionId) });
    },
    close() {
      set({ workspace: null, project: null, history: emptyHistory(), selection: { nodes: [], edges: [] }, activeScriptId: undefined, activeFunctionId: undefined });
    },

    dispatch(ops, label, opts = {}) {
      const { workspace, project, activeScriptId, activeFunctionId } = get();
      if (!workspace || !project) throw new OpError('No project is open');
      const tc = toolchainFor(project.language);
      const r = applyProjectOps(workspace, ops, tc, opts.defaults ?? { scriptId: activeScriptId, functionId: activeFunctionId });
      if (r.workspace === workspace) return r.result;
      r.result.project = commit(r.workspace, { label, source: opts.source ?? 'user', mergeKey: opts.mergeKey });
      for (const w of r.result.warnings) toast('warning', w);
      return r.result;
    },

    tryDispatch(ops, label, opts) {
      try {
        return get().dispatch(ops, label, opts);
      } catch (e) {
        toast('error', e instanceof Error ? e.message.replace(/^Operation \d+ \([a-z_]+\): /, '') : String(e));
        return null;
      }
    },

    applyFiles(ops, label, opts = {}) {
      const { workspace, project } = get();
      if (!workspace || !project) throw new OpError('No project is open');
      const r = applyWorkspaceOps(workspace, ops, toolchainFor(project.language));
      if (r.workspace !== workspace) commit(r.workspace, { label, source: opts.source ?? 'user', mergeKey: opts.mergeKey });
      for (const w of r.warnings) toast('warning', w);
      return r;
    },

    replaceWorkspace(ws, label, source = 'user') {
      const cur = get().workspace;
      if (!cur) return get().open(ws);
      const next: Workspace = { meta: { ...ws.meta, id: cur.meta.id, createdAt: cur.meta.createdAt, editor: cur.meta.editor, updatedAt: Date.now() }, files: ws.files };
      if (workspaceRevision(next) === workspaceRevision(cur)) return;
      commit(next, { label, source });
    },
    replaceProject(p, label, source = 'user') {
      get().replaceWorkspace(projectToWorkspace(p), label, source);
    },

    undo() {
      const r = undoHistory(get().history);
      if (!r) return null;
      set({ history: r.history });
      commit(r.state);
      return r.entry.label;
    },
    redo() {
      const r = redoHistory(get().history);
      if (!r) return null;
      set({ history: r.history });
      commit(r.state);
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
      const { workspace: ws, project: p } = get();
      if (!ws || !p) return;
      const script = p.scripts.find((s) => s.functions.some((f) => f.id === functionId));
      if (!script) return;
      const nextScript: ScriptDoc = { ...script, functions: script.functions.map((f) => (f.id === functionId ? { ...f, graph: { ...f.graph, viewport } } : f)) };
      const path = graphPathFor(script.path);
      const files = new Map(ws.files);
      files.set(path, makeRecord(path, serializeGraph(nextScript, p.language), Date.now(), 'graph'));
      // Not a content change for the user: no history entry and no version bump (avoids recompiling).
      const next = { meta: ws.meta, files };
      set({ workspace: next, project: { ...p, scripts: p.scripts.map((s) => (s === script ? nextScript : s)) }, saveState: get().saveState === 'saved' ? 'dirty' : get().saveState });
    },
  };
});

export function useActiveScript(): ScriptDoc | undefined {
  return useEditor((s) => s.project?.scripts.find((x) => x.id === s.activeScriptId));
}

export function useActiveFunction(): FunctionDecl | undefined {
  return useEditor((s) => s.project?.scripts.find((x) => x.id === s.activeScriptId)?.functions.find((f) => f.id === s.activeFunctionId));
}

/** Content revision of the open project (all files). */
export function currentRevision(): string | null {
  const w = useEditor.getState().workspace;
  return w ? workspaceRevision(w) : null;
}
