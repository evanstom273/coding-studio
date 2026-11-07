/**
 * The node graph canvas (React Flow). Rendering is derived from the project document; all
 * changes are dispatched as edit operations, never written into React Flow's state directly
 * (apart from transient drag positions).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type FinalConnectionState,
  type Node as RFNode,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
} from '@xyflow/react';
import type { Diagnostic, FunctionDecl, GraphNode, ScriptDoc } from '@cs/graph-core';
import { checkConnection, makeNodeContext, nodeInfo, type NodeInfo } from '@cs/compiler-core';
import { toolchainFor } from '@web/lib/toolchain';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { useCompile } from '@web/compile/store';
import { BlueprintNode } from './BlueprintNode';
import { FrameNode } from './FrameNode';
import { RerouteNode } from './RerouteNode';
import { useTsCheck } from '@web/lib/tsCheckStore';
import { AddNodeMenu, opsForEntry, type PendingConnection } from './AddNodeMenu';
import { portColor, type BPNodeData } from './model';
import { NodeContextMenu } from './NodeContextMenu';
import { DND_MIME, type DragNodePayload } from '@web/lib/dnd';
import { useCompact, useTouch } from '@web/hooks/useLayout';
import { Plus } from 'lucide-react';

const nodeTypes: NodeTypes = { bp: BlueprintNode, frame: FrameNode, reroute: RerouteNode };

type FlowNode = RFNode<BPNodeData>;

/** Cache of node data objects so unchanged nodes keep referential identity (memoised render). */
const dataCache = new WeakMap<GraphNode, { sig: string; data: BPNodeData }>();

function buildNodes(script: ScriptDoc, fn: FunctionDecl, language: string, selected: Set<string>, diags: Map<string, Diagnostic>): { nodes: FlowNode[]; infos: Map<string, NodeInfo> } {
  const tc = toolchainFor(language);
  const ctx = makeNodeContext(tc, script, fn);
  const connected = new Map<string, string[]>();
  for (const e of fn.graph.edges) {
    (connected.get(e.from.node) ?? connected.set(e.from.node, []).get(e.from.node)!).push(`out:${e.from.port}`);
    (connected.get(e.to.node) ?? connected.set(e.to.node, []).get(e.to.node)!).push(`in:${e.to.port}`);
  }
  const infos = new Map<string, NodeInfo>();
  const nodes = fn.graph.nodes.map((n): FlowNode => {
    const info = nodeInfo(tc, ctx, n);
    infos.set(n.id, info);
    const conn = (connected.get(n.id) ?? []).sort();
    const d = diags.get(n.id);
    const diag = d ? { severity: d.severity, message: d.message } : undefined;
    const sig = JSON.stringify([info.title, info.ports, conn, diag]);
    let cached = dataCache.get(n);
    if (!cached || cached.sig !== sig) {
      cached = { sig, data: { info, connected: conn, diag, language } };
      dataCache.set(n, cached);
    }
    const isFrame = info.def?.flavor === 'annotation';
    const isReroute = n.type === 'core.reroute' || n.type === 'core.reroute_exec';
    return {
      id: n.id,
      type: isFrame ? 'frame' : isReroute ? 'reroute' : 'bp',
      position: n.position,
      data: cached.data,
      selected: selected.has(n.id),
      deletable: n.type !== 'core.entry',
      ...(isFrame ? { style: { width: n.size?.width ?? 360, height: n.size?.height ?? 220 }, zIndex: -1 } : {}),
    };
  });
  return { nodes, infos };
}

function buildEdges(fn: FunctionDecl, infos: Map<string, NodeInfo>, selected: Set<string>): RFEdge[] {
  return fn.graph.edges.map((e) => {
    const port = infos.get(e.from.node)?.ports.find((p) => p.id === e.from.port);
    const exec = port?.kind === 'exec';
    const color = port ? portColor(port.kind, port.type) : '#ef4444';
    return {
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.port,
      target: e.to.node,
      targetHandle: e.to.port,
      selected: selected.has(e.id),
      style: { stroke: color, strokeWidth: exec ? 3 : 2, ...(port ? {} : { strokeDasharray: '4 3' }) },
      className: exec ? 'exec-edge' : 'data-edge',
      data: { exec },
    };
  });
}

// Settings handed to React Flow must keep the same identity between renders: it copies changed
// ones into its store, and a new array/object each render can loop (seen on phone layouts).
const MULTI_SELECT_KEYS = ['Shift', 'Control', 'Meta'];
const PAN_BUTTONS = [1, 2];
const SNAP_GRID: [number, number] = [16, 16];
const EDGE_OPTIONS = { type: 'default' };
const CONNECTION_LINE = { stroke: '#cbd5e1', strokeWidth: 2 };
const PRO_OPTIONS = { hideAttribution: false };

function Canvas() {
  const project = useEditor((s) => s.project)!;
  const activeScriptId = useEditor((s) => s.activeScriptId);
  const activeFunctionId = useEditor((s) => s.activeFunctionId);
  const selection = useEditor((s) => s.selection);
  const focusRequest = useEditor((s) => s.focusRequest);
  const compiled = useCompile((s) => s.diagnostics);
  const tsNodes = useTsCheck((s) => s.nodes);
  const diagnostics = useMemo(() => (tsNodes.length ? [...compiled, ...tsNodes] : compiled), [compiled, tsNodes]);
  const { snapToGrid, showMinimap } = useUI();
  const touch = useTouch();
  const compact = useCompact();
  const rf = useReactFlow();
  const script = project.scripts.find((s) => s.id === activeScriptId);
  const fn = script?.functions.find((f) => f.id === activeFunctionId);

  const diagMap = useMemo(() => {
    const m = new Map<string, Diagnostic>();
    const rank = { error: 0, warning: 1, info: 2 };
    for (const d of diagnostics) if (d.nodeId && d.functionId === fn?.id && (!m.has(d.nodeId) || rank[d.severity] < rank[m.get(d.nodeId)!.severity])) m.set(d.nodeId, d);
    return m;
  }, [diagnostics, fn?.id]);

  const selNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const selEdges = useMemo(() => new Set(selection.edges), [selection.edges]);
  const derived = useMemo(() => (script && fn ? buildNodes(script, fn, project.language, selNodes, diagMap) : { nodes: [], infos: new Map<string, NodeInfo>() }), [script, fn, project.language, selNodes, diagMap]);
  const edges = useMemo(() => (fn ? buildEdges(fn, derived.infos, selEdges) : []), [fn, derived.infos, selEdges]);
  // React Flow keeps its own copy of the nodes (drag positions, measured sizes). When the project
  // changes, replace that copy in the same render (not in an effect): rendering once with a stale
  // copy made React Flow report the old selection back, and the selection flipped forever.
  const [nodes, setNodes] = useState<FlowNode[]>(derived.nodes);
  const [synced, setSynced] = useState(derived.nodes);
  if (synced !== derived.nodes) {
    setSynced(derived.nodes);
    setNodes(derived.nodes);
  }

  const [menu, setMenu] = useState<null | { screen: { x: number; y: number }; flow: { x: number; y: number }; pending?: PendingConnection }>(null);
  const [nodeMenu, setNodeMenu] = useState<null | { x: number; y: number; nodeId: string }>(null);
  const connectingFrom = useRef<PendingConnection | null>(null);

  // Restore / fit the viewport when switching graphs.
  const lastGraph = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!fn || lastGraph.current === fn.id) return;
    lastGraph.current = fn.id;
    const vp = fn.graph.viewport;
    requestAnimationFrame(() => {
      if (vp) void rf.setViewport(vp);
      else void rf.fitView({ padding: 0.15, maxZoom: 1, minZoom: 0.6 });
    });
  }, [fn, rf]);

  // Centre on a node requested by the diagnostics panel / code view.
  useEffect(() => {
    if (!focusRequest || !fn) return;
    const n = fn.graph.nodes.find((x) => x.id === focusRequest.nodeId);
    if (n) requestAnimationFrame(() => void rf.setCenter(n.position.x + 100, n.position.y + 40, { zoom: Math.max(rf.getZoom(), 0.9), duration: 300 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.seq]);

  // The editor owns the selection. React Flow's clicks / box-selects arrive as "select" changes and
  // become editor selections; React Flow then just shows what the editor says. (Letting both keep
  // a selection made them report each other's old state back forever on phone layouts.)
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const sel = changes.filter((c) => c.type === 'select');
    const rest = changes.filter((c) => c.type !== 'select');
    if (rest.length) setNodes((nds) => applyNodeChanges(rest, nds));
    if (sel.length) {
      const st = useEditor.getState();
      const next = new Set(st.selection.nodes);
      for (const c of sel) {
        if (c.type !== 'select') continue;
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      st.select([...next], st.selection.edges);
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const sel = changes.filter((c) => c.type === 'select');
    if (!sel.length) return;
    const st = useEditor.getState();
    const next = new Set(st.selection.edges);
    for (const c of sel) {
        if (c.type !== 'select') continue;
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
    st.select(st.selection.nodes, [...next]);
  }, []);

  const onNodeDragStop = useCallback((_e: unknown, _n: RFNode, dragged: RFNode[]) => {
    const g = useEditor.getState();
    const f = g.project?.scripts.flatMap((s) => s.functions).find((x) => x.id === g.activeFunctionId);
    const moved = dragged.filter((d) => {
      const orig = f?.graph.nodes.find((x) => x.id === d.id);
      return orig && (orig.position.x !== d.position.x || orig.position.y !== d.position.y);
    });
    if (!moved.length) return;
    g.tryDispatch([{ op: 'move_nodes', nodes: moved.map((d) => d.id), positions: Object.fromEntries(moved.map((d) => [d.id, { x: Math.round(d.position.x), y: Math.round(d.position.y) }])) }], moved.length > 1 ? `Move ${moved.length} nodes` : 'Move node');
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      if (c.source === c.target) return false;
      const a = derived.infos.get(c.source)?.ports.find((p) => p.id === c.sourceHandle && p.direction === 'out');
      const b = derived.infos.get(c.target)?.ports.find((p) => p.id === c.targetHandle && p.direction === 'in');
      if (!a || !b) return false;
      return checkConnection(toolchainFor(project.language), a, b).severity !== 'error';
    },
    [derived.infos, project.language],
  );

  const onConnect = useCallback((c: Connection) => {
    connectingFrom.current = null;
    if (!c.sourceHandle || !c.targetHandle) return;
    useEditor.getState().tryDispatch([{ op: 'connect', from: { node: c.source, port: c.sourceHandle }, to: { node: c.target, port: c.targetHandle } }], 'Connect');
  }, []);

  const onConnectStart = useCallback((_e: unknown, p: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }) => {
    connectingFrom.current = p.nodeId && p.handleId && p.handleType ? { nodeId: p.nodeId, portId: p.handleId, handleType: p.handleType } : null;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const pending = connectingFrom.current;
      connectingFrom.current = null;
      if (!pending || state.isValid || state.toHandle) return;
      const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
      // Dropped a wire on empty canvas: offer compatible nodes (Blueprint-style).
      if ((event.target as Element | null)?.closest('.react-flow__node')) return;
      setMenu({ screen: { x: pt.clientX, y: pt.clientY }, flow: rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }), pending });
    },
    [rf],
  );

  const openMenuAt = useCallback(
    (x: number, y: number) => {
      setNodeMenu(null);
      setMenu({ screen: { x, y }, flow: rf.screenToFlowPosition({ x, y }) });
    },
    [rf],
  );

  // Keyboard shortcut (Tab / A) and toolbar "Add node" open the menu at the canvas centre.
  useEffect(() => {
    const open = () => {
      const el = document.querySelector('.react-flow');
      const r = el?.getBoundingClientRect();
      if (r) openMenuAt(r.left + r.width / 2 - 150, r.top + r.height / 3);
    };
    // Double-click in the node library: add at the centre of the visible canvas.
    const addType = (ev: Event) => {
      const e = (ev as CustomEvent<{ type: string; props?: Record<string, never>; newClosure?: boolean }>).detail;
      const el = document.querySelector('.react-flow');
      const r = el?.getBoundingClientRect();
      if (!r) return;
      const pos = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const st = useEditor.getState();
      const sc = st.project?.scripts.find((x) => x.id === st.activeScriptId);
      const f = sc?.functions.find((x) => x.id === st.activeFunctionId);
      if (!sc || !f) return;
      const res = st.tryDispatch(opsForEntry(e, f, sc, pos), 'Add node');
      if (res) useEditor.getState().select([res.created.n]);
    };
    const fit = () => void rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1.2 });
    window.addEventListener('cs:add-node', open);
    window.addEventListener('cs:add-node-type', addType);
    window.addEventListener('cs:fit', fit);
    return () => {
      window.removeEventListener('cs:fit', fit);
      window.removeEventListener('cs:add-node', open);
      window.removeEventListener('cs:add-node-type', addType);
    };
  }, [openMenuAt, rf]);

  const vpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!script || !fn) {
    return <div className="flex h-full items-center justify-center text-muted">Select or create a function to edit its graph.</div>;
  }

  return (
    <div
      className="relative h-full w-full"
      data-testid="graph-canvas"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(DND_MIME);
        if (!raw) return;
        e.preventDefault();
        const payload = JSON.parse(raw) as DragNodePayload;
        // Alt-drop of a variable creates a Set node (Blueprint convention).
        const type = payload.type === 'core.get_var' && e.altKey ? 'core.set_var' : payload.type;
        const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const r = useEditor.getState().tryDispatch([{ op: 'add_node', ref: 'n', type, position: { x: Math.round(pos.x), y: Math.round(pos.y) }, ...(payload.props ? { props: payload.props } : {}) }], 'Add node');
        if (r) useEditor.getState().select([r.created.n]);
      }}
    >
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          openMenuAt(e.clientX, e.clientY);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (!selNodes.has(n.id)) useEditor.getState().select([n.id]);
          setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: n.id });
        }}
        onNodeDoubleClick={(_e, n) => {
          const node = fn.graph.nodes.find((x) => x.id === n.id);
          // Call Function / Inline Function / Function as Value: double-click opens that function's graph.
          const target = node && ['core.call_function', 'ts.closure', 'ts.function_ref'].includes(node.type) ? script.functions.find((f) => f.id === node.props.function) : undefined;
          if (target) useEditor.getState().setActive(script.id, target.id);
          // Narrow screens: double-tap a node to see its properties.
          else if (compact) useUI.getState().set({ drawer: 'right' });
        }}
        onMoveEnd={(_e, vp) => {
          if (vpTimer.current) clearTimeout(vpTimer.current);
          vpTimer.current = setTimeout(() => useEditor.getState().setViewportSilently(fn.id, { x: Math.round(vp.x), y: Math.round(vp.y), zoom: Math.round(vp.zoom * 1000) / 1000 }), 400);
        }}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        // Touch: one finger pans, pinch zooms. Mouse: drag box-selects, middle/right-drag pans.
        panOnDrag={touch ? true : PAN_BUTTONS}
        selectionOnDrag={!touch}
        panActivationKeyCode="Space"
        snapToGrid={snapToGrid}
        snapGrid={SNAP_GRID}
        minZoom={0.1}
        maxZoom={2.5}
        connectionRadius={touch ? 44 : 24}
        defaultEdgeOptions={EDGE_OPTIONS}
        connectionLineStyle={CONNECTION_LINE}
        proOptions={PRO_OPTIONS}
        colorMode="dark"
        elevateEdgesOnSelect
      >
        <Background variant={BackgroundVariant.Lines} gap={16} color="#1b2029" />
        <Background id="major" variant={BackgroundVariant.Lines} gap={128} color="#232a35" />
        <Controls showInteractive={false} position="bottom-left" />
        {(touch || compact) && (
          <button
            aria-label="Add node"
            data-testid="fab-add-node"
            className="absolute bottom-8 right-4 z-10 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-xl active:bg-accent-2"
            onClick={() => {
              const r = document.querySelector('.react-flow')?.getBoundingClientRect();
              if (r) openMenuAt(Math.max(8, r.left + r.width / 2 - 160), r.top + 24);
            }}
          >
            <Plus size={22} />
          </button>
        )}
        {showMinimap && !compact && <MiniMap pannable zoomable position="bottom-right" nodeColor="#3b4352" maskColor="rgba(10,12,16,0.7)" />}
      </ReactFlow>
      {fn.graph.nodes.length <= 1 && (
        <div className="pointer-events-none absolute left-1/2 top-6 w-max max-w-[calc(100%-32px)] -translate-x-1/2 rounded-md border border-border bg-panel/90 px-3 py-2 text-center text-[12px] text-muted">
          {touch ? 'Tap + to add a node, then drag from the Entry’s ▶ pin to connect it.' : 'Right-click the canvas (or press Tab) to add a node, then drag from the Entry’s ▶ pin to connect it.'}
        </div>
      )}
      {menu && <AddNodeMenu {...menu} onClose={() => setMenu(null)} />}
      {nodeMenu && <NodeContextMenu {...nodeMenu} onClose={() => setNodeMenu(null)} />}
    </div>
  );
}

export default function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
