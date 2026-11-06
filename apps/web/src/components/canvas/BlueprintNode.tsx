import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { AlertTriangle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import type { PortSpec } from '@cs/node-registry';
import { useEditor } from '@web/store/editor';
import { headerColor, portColor, type BPNodeData } from './model';
import { InlineInput } from './InlineInput';
import { cx } from '../ui/primitives';

function Pin({ port, connected, side }: { port: PortSpec; connected: boolean; side: 'in' | 'out' }) {
  const color = portColor(port.kind, port.type);
  const style =
    port.kind === 'exec'
      ? { width: 11, height: 13, borderRadius: 0, background: connected ? color : '#1a1e26', border: 'none', clipPath: 'polygon(0 0, 55% 0, 100% 50%, 55% 100%, 0 100%)', boxShadow: connected ? undefined : `inset 0 0 0 2px ${color}` }
      : { width: 11, height: 11, borderRadius: 999, background: connected ? color : '#1a1e26', border: `2px solid ${color}` };
  return <Handle type={side === 'in' ? 'target' : 'source'} position={side === 'in' ? Position.Left : Position.Right} id={port.id} style={{ ...style, [side === 'in' ? 'left' : 'right']: -6 }} title={port.type ? `${port.name || port.id}: ${port.kind === 'exec' ? 'exec' : JSON.stringify(port.type.kind === 'named' ? port.type.name : port.type.kind)}${port.description ? ` — ${port.description}` : ''}` : port.name} data-testid={`pin-${side}-${port.id}`} />;
}

function BlueprintNodeImpl({ id, data }: NodeProps<Node<BPNodeData>>) {
  const { info, connected, diag } = data;
  const node = info.node;
  const collapsed = !!node.collapsed;
  const inputs = info.ports.filter((p) => p.direction === 'in');
  const outputs = info.ports.filter((p) => p.direction === 'out');
  const rows = Math.max(inputs.length, outputs.length);
  const isConn = (p: PortSpec) => connected.includes(`${p.direction}:${p.id}`);
  const pure = info.def?.flavor === 'pure';
  return (
    <div
      className={cx('bp-node rounded-md border bg-[#1b1f27]/95 shadow-lg', diag?.severity === 'error' ? 'border-red-500' : diag?.severity === 'warning' ? 'border-amber-400/80' : 'border-[#0b0d11]')}
      style={{ minWidth: pure ? 120 : 170 }}
      data-testid="graph-node"
      data-node-type={node.type}
      data-node-id={id}
    >
      <div className={cx('flex items-center gap-1.5 rounded-t-[5px] px-2 py-1 text-[12px] font-semibold text-white', collapsed && 'rounded-b-[5px]')} style={{ background: `linear-gradient(90deg, ${headerColor(info)}, ${headerColor(info)}aa)` }}>
        <button
          className="nodrag -ml-1 text-white/60 hover:text-white"
          aria-label={collapsed ? 'Expand node' : 'Collapse node'}
          onClick={() => useEditor.getState().tryDispatch([{ op: 'update_node', node: id, collapsed: !collapsed }], collapsed ? 'Expand node' : 'Collapse node')}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="truncate" data-testid="node-title">
          {info.title}
        </span>
        {diag && (diag.severity === 'error' ? <XCircle size={13} className="ml-auto shrink-0 text-red-300" aria-label={diag.message} /> : diag.severity === 'warning' ? <AlertTriangle size={13} className="ml-auto shrink-0 text-amber-300" aria-label={diag.message} /> : null)}
      </div>
      {collapsed ? (
        // Keep every handle mounted (edges need them) but stacked invisibly on the header.
        <div className="relative h-0">
          {inputs.map((p) => (
            <div key={p.id} className="absolute left-0 top-[-12px] h-0 w-0 opacity-60">
              <Pin port={p} connected={isConn(p)} side="in" />
            </div>
          ))}
          {outputs.map((p) => (
            <div key={p.id} className="absolute right-0 top-[-12px] h-0 w-0 opacity-60">
              <Pin port={p} connected={isConn(p)} side="out" />
            </div>
          ))}
        </div>
      ) : (
        <div className="py-1">
          {Array.from({ length: rows }, (_, i) => {
            const a = inputs[i];
            const b = outputs[i];
            return (
              <div key={i} className="relative flex min-h-[22px] items-center justify-between gap-3">
                <div className="relative flex min-h-[22px] items-center gap-1.5 pl-3">
                  {a && (
                    <>
                      <Pin port={a} connected={isConn(a)} side="in" />
                      {(a.name || a.kind === 'data') && <span className="whitespace-nowrap text-[11px] text-[#c3c9d4]">{a.name}</span>}
                      {a.kind === 'data' && !isConn(a) && <InlineInput nodeId={id} port={a} value={node.inputs[a.id]} language={data.language} />}
                    </>
                  )}
                </div>
                <div className="relative flex min-h-[22px] items-center gap-1.5 pr-3">
                  {b && (
                    <>
                      {b.name && <span className="whitespace-nowrap text-[11px] text-[#c3c9d4]">{b.name}</span>}
                      <Pin port={b} connected={isConn(b)} side="out" />
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {diag && diag.severity !== 'info' && <div className={cx('mx-2 mb-1 mt-0.5 max-w-[260px] rounded px-1.5 py-0.5 text-[10.5px] leading-snug', diag.severity === 'error' ? 'bg-red-500/15 text-red-200' : 'bg-amber-400/10 text-amber-200')}>{diag.message}</div>}
        </div>
      )}
    </div>
  );
}

export const BlueprintNode = memo(BlueprintNodeImpl);
