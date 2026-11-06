import { memo } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { useEditor } from '@web/store/editor';
import type { BPNodeData } from './model';

const COLORS: Record<string, string> = { slate: '148,163,184', blue: '96,165,250', green: '74,222,128', amber: '251,191,36', red: '248,113,113', violet: '167,139,250' };

function FrameNodeImpl({ id, data, selected }: NodeProps<Node<BPNodeData>>) {
  const n = data.info.node;
  const rgb = COLORS[String(n.props.color)] ?? COLORS.slate;
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={60}
        lineStyle={{ borderColor: `rgb(${rgb})` }}
        onResizeEnd={(_e, p) => useEditor.getState().tryDispatch([{ op: 'update_node', node: id, position: { x: p.x, y: p.y }, size: { width: p.width, height: p.height } }], 'Resize frame')}
      />
      <div data-testid="graph-frame" className="h-full w-full rounded-md border" style={{ background: `rgba(${rgb},0.07)`, borderColor: `rgba(${rgb},0.45)` }}>
        <div className="rounded-t-md px-2 py-1 text-[13px] font-semibold" style={{ background: `rgba(${rgb},0.25)`, color: `rgb(${rgb})` }}>
          {String(n.props.title ?? 'Comment')}
        </div>
      </div>
    </>
  );
}
export const FrameNode = memo(FrameNodeImpl);
