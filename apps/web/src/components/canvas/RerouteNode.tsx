import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { BPNodeData } from './model';
import { portColor } from './model';

function RerouteNodeImpl({ data }: NodeProps<Node<BPNodeData>>) {
  const exec = data.info.node.type === 'core.reroute_exec';
  const c = portColor(exec ? 'exec' : 'data', undefined);
  const inId = exec ? 'exec' : 'in';
  const outId = exec ? 'then' : 'out';
  return (
    <div className="bp-node relative h-3.5 w-5 rounded-full" style={{ background: c }} data-testid="graph-node" data-node-type={data.info.node.type}>
      <Handle type="target" position={Position.Left} id={inId} style={{ width: 8, height: 8, background: c, left: -2 }} />
      <Handle type="source" position={Position.Right} id={outId} style={{ width: 8, height: 8, background: c, right: -2 }} />
    </div>
  );
}
export const RerouteNode = memo(RerouteNodeImpl);
