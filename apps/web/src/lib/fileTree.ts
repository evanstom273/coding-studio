/**
 * The explorer's tree, built from the workspace's file paths. Pure functions, so the explorer
 * can render a flat, virtualised list of only the visible rows.
 */
export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

const cmp = (a: TreeNode, b: TreeNode) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

/** `.gitkeep` markers make folders exist but aren't shown. */
export function buildTree(paths: Iterable<string>): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  const dirFor = (path: string): TreeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const i = path.lastIndexOf('/');
    const parent = dirFor(i === -1 ? '' : path.slice(0, i));
    const node: TreeNode = { name: path.slice(i + 1), path, dir: true, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    const parent = dirFor(i === -1 ? '' : p.slice(0, i));
    const name = p.slice(i + 1);
    if (name === '.gitkeep') continue;
    parent.children.push({ name, path: p, dir: false, children: [] });
  }
  const sort = (n: TreeNode) => {
    n.children.sort(cmp);
    n.children.forEach((c) => c.dir && sort(c));
  };
  sort(root);
  return root;
}

export interface Row {
  node: TreeNode;
  depth: number;
}

/** Visible rows, depth-first, descending only into expanded folders. */
export function visibleRows(root: TreeNode, expanded: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const walk = (n: TreeNode, depth: number) => {
    for (const c of n.children) {
      out.push({ node: c, depth });
      if (c.dir && expanded.has(c.path)) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Remap a path after a move/rename of `from` → `to` (file or folder). */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}
