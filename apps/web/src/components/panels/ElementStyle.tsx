/**
 * Style for a React element node (ts.element) or a Classes node (ts.classes): the visual style
 * editor writes Tailwind classes into its className, keeping any class it doesn't model.
 */
import { useMemo } from 'react';
import type { FunctionDecl, GraphNode } from '@cs/graph-core';
import { fromTailwind, mergeClasses, type StyleSpec } from '@cs/styling';
import { useEditor } from '@web/store/editor';
import { StyleEditor } from '../fields/StyleEditor';
import { AnimationEditor } from '../fields/AnimationEditor';
import type { AnimationSpec } from '@cs/styling';

const tailwindVersion = (pkg: string | undefined) => pkg?.match(/"tailwindcss"\s*:\s*"[\^~]?(\d+)/)?.[1];

/** Where an element's classes live: its className input, or a Classes node wired into it. */
function classSource(node: GraphNode, fn: FunctionDecl): { kind: 'input'; node: GraphNode } | { kind: 'classes'; node: GraphNode } | { kind: 'wired' } {
  if (node.type === 'ts.classes') return { kind: 'classes', node };
  const edge = fn.graph.edges.find((e) => e.to.node === node.id && e.to.port === 'attr_className');
  if (!edge) return { kind: 'input', node };
  const src = fn.graph.nodes.find((n) => n.id === edge.from.node);
  return src?.type === 'ts.classes' ? { kind: 'classes', node: src } : { kind: 'wired' };
}

export function ElementStyle({ node, fn }: { node: GraphNode; fn: FunctionDecl }) {
  const pkg = useEditor((s) => s.workspace?.files.get('package.json')?.text);
  const tw = tailwindVersion(pkg);
  const src = classSource(node, fn);
  const current = src.kind === 'classes' ? String(src.node.props.classes ?? '') : src.kind === 'input' ? String(node.inputs?.attr_className ?? '') : '';
  const parsed = useMemo(() => fromTailwind(current), [current]);
  if (src.kind === 'wired') return <p className="text-[11.5px] text-muted">This element's className comes from a wire, so it's styled where that value is made.</p>;
  const write = (spec: StyleSpec, mergeKey?: string) => {
    const classes = mergeClasses(spec, parsed.other, { v3: tw === '3' });
    const st = useEditor.getState();
    const key = mergeKey ? `style:${src.node.id}:${mergeKey}` : undefined;
    if (src.kind === 'classes') st.tryDispatch([{ op: 'update_node', graph: fn.id, node: src.node.id, props: { classes } }], 'Style', { mergeKey: key });
    else {
      const attrs = Array.isArray(node.props.attributes) ? (node.props.attributes as string[]) : [];
      st.tryDispatch([{ op: 'update_node', graph: fn.id, node: node.id, ...(attrs.includes('className') ? {} : { props: { attributes: [...attrs, 'className'] } }), inputs: { attr_className: classes } }], 'Style', { mergeKey: key });
    }
  };
  const tag = String(node.props.tag ?? 'div');
  return (
    <div className="mt-3" data-testid="element-style">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Style</div>
      {!tw && <p className="mb-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200">Styles are written as Tailwind classes, but this project's package.json doesn't list tailwindcss. Add it (Packages tab: tailwindcss and @tailwindcss/vite) so they apply when it's built. The Preview applies them either way.</p>}
      <StyleEditor key={src.node.id} spec={parsed.spec} onChange={write} previewText={tag === 'button' ? 'Button' : tag === 'img' ? 'Image' : 'Text'} />
      {parsed.other.length > 0 && (
        <div className="mt-2 text-[11px] text-[#7d8696]" data-testid="style-other-classes">
          Also kept as written: <span className="font-mono">{parsed.other.join(' ')}</span>
        </div>
      )}
      <div className="mt-1 break-all font-mono text-[10.5px] text-[#7d8696]" data-testid="style-classes">
        {current || '(no classes)'}
      </div>
    </div>
  );
}

/** Animations on a React element node (ts.element props.animations). */
export function ElementAnimations({ node, fn }: { node: GraphNode; fn: FunctionDecl }) {
  const list = Array.isArray(node.props.animations) ? (node.props.animations as unknown as AnimationSpec[]) : [];
  return (
    <div className="mt-3" data-testid="element-animations">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Animations</div>
      <AnimationEditor
        value={list}
        onChange={(v, mergeKey) => useEditor.getState().tryDispatch([{ op: 'update_node', graph: fn.id, node: node.id, props: { animations: v as never } }], 'Animation', { mergeKey: mergeKey ? `anim:${node.id}:${mergeKey}` : undefined })}
        previewText={String(node.props.tag ?? 'div') === 'button' ? 'Button' : 'Text'}
      />
    </div>
  );
}
