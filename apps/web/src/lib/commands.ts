import type { Edge, GraphNode } from '@cs/graph-core';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { useUI } from '@web/store/ui';
import { compileNow } from '@web/compile/store';
import { saveNow } from '@web/hooks/useAutosave';
import { createBackup } from '@web/db/projects';

const CLIP_KEY = 'coding-studio-clipboard';
let clipboard: { nodes: GraphNode[]; edges: Edge[] } | null = null;

function activeGraph() {
  const s = useEditor.getState();
  return s.project?.scripts.find((x) => x.id === s.activeScriptId)?.functions.find((f) => f.id === s.activeFunctionId);
}

export async function deleteSelection() {
  const s = useEditor.getState();
  const f = activeGraph();
  if (!f) return;
  const nodes = s.selection.nodes.filter((id) => f.graph.nodes.some((n) => n.id === id && n.type !== 'core.entry'));
  const edges = s.selection.edges.filter((id) => f.graph.edges.some((e) => e.id === id && !nodes.includes(e.from.node) && !nodes.includes(e.to.node)));
  if (!nodes.length && !edges.length) return;
  if (nodes.length >= 8 && s.workspace) await createBackup(s.workspace, `Before deleting ${nodes.length} nodes`);
  const ops = [...(nodes.length ? [{ op: 'delete_nodes' as const, nodes }] : []), ...(edges.length ? [{ op: 'disconnect' as const, edges }] : [])];
  if (s.tryDispatch(ops, nodes.length ? `Delete ${nodes.length} node(s)` : 'Delete connection')) s.select([]);
}

export function copySelection(): boolean {
  const s = useEditor.getState();
  const f = activeGraph();
  if (!f || !s.selection.nodes.length) return false;
  const ids = new Set(s.selection.nodes);
  const nodes = f.graph.nodes.filter((n) => ids.has(n.id) && n.type !== 'core.entry');
  if (!nodes.length) return false;
  clipboard = { nodes: structuredClone(nodes), edges: f.graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)) };
  try {
    sessionStorage.setItem(CLIP_KEY, JSON.stringify(clipboard));
    void navigator.clipboard?.writeText(JSON.stringify({ codingStudioNodes: clipboard })).catch(() => undefined);
  } catch {
    /* ignore */
  }
  return true;
}

export function cutSelection() {
  if (copySelection()) void deleteSelection();
}

export function paste(at?: { x: number; y: number }) {
  if (!clipboard) {
    try {
      clipboard = JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? 'null');
    } catch {
      clipboard = null;
    }
  }
  if (!clipboard?.nodes.length) return;
  const minX = Math.min(...clipboard.nodes.map((n) => n.position.x));
  const minY = Math.min(...clipboard.nodes.map((n) => n.position.y));
  const offset = at ? { x: at.x - minX, y: at.y - minY } : { x: 48, y: 48 };
  const r = useEditor.getState().tryDispatch([{ op: 'paste_nodes', ref: 'p', nodes: clipboard.nodes, edges: clipboard.edges, offset }], `Paste ${clipboard.nodes.length} node(s)`);
  if (r) useEditor.getState().select(Object.entries(r.created).filter(([k]) => k.startsWith('p.')).map(([, v]) => v));
}

export function duplicateSelection() {
  const s = useEditor.getState();
  const f = activeGraph();
  const nodes = s.selection.nodes.filter((id) => f?.graph.nodes.some((n) => n.id === id && n.type !== 'core.entry'));
  if (!nodes.length) return;
  const r = s.tryDispatch([{ op: 'duplicate_nodes', ref: 'd', nodes, offset: { x: 48, y: 48 } }], 'Duplicate');
  if (r) s.select(Object.entries(r.created).filter(([k]) => k.startsWith('d.')).map(([, v]) => v));
}

export function selectAll() {
  const f = activeGraph();
  if (f) useEditor.getState().select(f.graph.nodes.map((n) => n.id));
}

export function toggleCollapse() {
  const s = useEditor.getState();
  const f = activeGraph();
  const nodes = f?.graph.nodes.filter((n) => s.selection.nodes.includes(n.id)) ?? [];
  if (!nodes.length) return;
  const collapse = !nodes.every((n) => n.collapsed);
  s.tryDispatch(nodes.map((n) => ({ op: 'update_node' as const, node: n.id, collapsed: collapse })), collapse ? 'Collapse' : 'Expand');
}

export function frameSelection() {
  const s = useEditor.getState();
  const f = activeGraph();
  const nodes = f?.graph.nodes.filter((n) => s.selection.nodes.includes(n.id)) ?? [];
  if (!nodes.length) return;
  const x = Math.min(...nodes.map((n) => n.position.x)) - 32;
  const y = Math.min(...nodes.map((n) => n.position.y)) - 56;
  const w = Math.max(...nodes.map((n) => n.position.x)) - x + 260;
  const h = Math.max(...nodes.map((n) => n.position.y)) - y + 160;
  s.tryDispatch([{ op: 'add_node', ref: 'fr', type: 'core.frame', position: { x, y } }, { op: 'update_node', node: '$fr', size: { width: w, height: h } }], 'Add comment frame');
}

export function undo() {
  const l = useEditor.getState().undo();
  if (l) toast('info', `Undo: ${l}`);
}
export function redo() {
  const l = useEditor.getState().redo();
  if (l) toast('info', `Redo: ${l}`);
}

export async function save() {
  await saveNow();
  if (useEditor.getState().saveState === 'saved') toast('success', 'Saved');
}

export function validate() {
  const p = useEditor.getState().project;
  if (!p) return;
  const r = compileNow(p);
  const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = r.diagnostics.filter((d) => d.severity === 'warning').length;
  useUI.getState().set({ bottomOpen: true, bottomTab: errors ? 'errors' : warnings ? 'warnings' : useUI.getState().bottomTab });
  toast(errors ? 'error' : 'success', errors ? `${errors} error(s), ${warnings} warning(s)` : `No errors${warnings ? `, ${warnings} warning(s)` : ''}`);
}

export function generate() {
  const p = useEditor.getState().project;
  if (!p) return;
  compileNow(p);
  useUI.getState().set({ bottomOpen: true, bottomTab: 'code' });
}

export function addNode() {
  window.dispatchEvent(new Event('cs:add-node'));
}
