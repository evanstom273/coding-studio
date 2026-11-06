/**
 * Generic graph algorithms on node/edge indices. Pure functions, no knowledge of node semantics.
 */
import type { Edge, Graph, GraphNode } from './model';

export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  /** "nodeId|portId" → edges leaving that output port */
  private readonly out = new Map<string, Edge[]>();
  /** "nodeId|portId" → edges entering that input port */
  private readonly into = new Map<string, Edge[]>();
  readonly edges: Edge[];

  constructor(readonly graph: Graph) {
    for (const n of graph.nodes) this.nodes.set(n.id, n);
    this.edges = graph.edges;
    for (const e of graph.edges) {
      push(this.out, `${e.from.node}|${e.from.port}`, e);
      push(this.into, `${e.to.node}|${e.to.port}`, e);
    }
  }

  from(node: string, port: string): Edge[] {
    return this.out.get(`${node}|${port}`) ?? [];
  }

  to(node: string, port: string): Edge[] {
    return this.into.get(`${node}|${port}`) ?? [];
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Nodes reachable from `start` following `succ`, in BFS order (start included). */
export function reachable(start: string, succ: (n: string) => string[]): string[] {
  const seen = new Set([start]);
  const order = [start];
  for (let i = 0; i < order.length; i++) {
    for (const s of succ(order[i])) {
      if (!seen.has(s)) {
        seen.add(s);
        order.push(s);
      }
    }
  }
  return order;
}

/**
 * Find cycles reachable from `roots`. Returns one representative cycle (list of node ids) per
 * strongly connected component that contains a cycle.
 */
export function findCycles(nodes: Iterable<string>, succ: (n: string) => string[]): string[][] {
  // Tarjan's SCC, iterative to survive large graphs.
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  for (const root of nodes) {
    if (idx.has(root)) continue;
    const work: { n: string; it: number; succs: string[] }[] = [{ n: root, it: 0, succs: succ(root) }];
    idx.set(root, index);
    low.set(root, index++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      if (top.it < top.succs.length) {
        const w = top.succs[top.it++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          onStack.add(w);
          work.push({ n: w, it: 0, succs: succ(w) });
        } else if (onStack.has(w)) {
          low.set(top.n, Math.min(low.get(top.n)!, idx.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].n;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.n)!));
        }
        if (low.get(top.n) === idx.get(top.n)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.n);
          if (comp.length > 1 || succ(top.n).includes(top.n)) cycles.push(comp.reverse());
        }
      }
    }
  }
  return cycles;
}

/**
 * Immediate post-dominators of an acyclic control-flow graph. A virtual exit node (EXIT) is the
 * successor of every node without successors. Returns node → ipdom (EXIT when none).
 */
export const EXIT = '\u0000exit';

export function immediatePostDominators(nodes: string[], succ: (n: string) => string[]): Map<string, string> {
  // Reverse post-order on the reversed graph == post-order on the original from the exit side.
  // For an acyclic graph a simple fixed-point iteration over sets converges quickly.
  const all = [...nodes, EXIT];
  const succOf = (n: string) => {
    if (n === EXIT) return [];
    const s = succ(n);
    return s.length ? s : [EXIT];
  };
  const pdom = new Map<string, Set<string>>();
  for (const n of all) pdom.set(n, n === EXIT ? new Set([EXIT]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      const ss = succOf(n);
      let inter: Set<string> | null = null;
      for (const s of ss) {
        const ps = pdom.get(s) ?? new Set([s, EXIT]);
        if (!inter) inter = new Set(ps);
        else for (const x of inter) if (!ps.has(x)) inter.delete(x);
      }
      const next = new Set(inter ?? []);
      next.add(n);
      const cur = pdom.get(n)!;
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
        pdom.set(n, next);
        changed = true;
      }
    }
  }
  const ipdom = new Map<string, string>();
  for (const n of nodes) {
    const strict = [...pdom.get(n)!].filter((x) => x !== n);
    // The immediate post-dominator is the strict post-dominator that every other strict
    // post-dominator also post-dominates (the "closest" one).
    const best = strict.find((c) => strict.every((o) => o === c || (pdom.get(c)?.has(o) ?? o === EXIT)));
    ipdom.set(n, best ?? EXIT);
  }
  return ipdom;
}

/** Deterministic topological order (Kahn, ties broken by the given order). Returns null on cycles. */
export function topoSort(nodes: string[], succ: (n: string) => string[]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const s of succ(n)) if (indeg.has(s)) indeg.set(s, indeg.get(s)! + 1);
  const ready = nodes.filter((n) => indeg.get(n) === 0);
  const out: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    out.push(n);
    for (const s of succ(n)) {
      if (!indeg.has(s)) continue;
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) ready.push(s);
    }
  }
  return out.length === nodes.length ? out : null;
}
