/**
 * Graph → IR lowering for one function.
 *
 * Control flow is structured from the execution graph:
 *  - chains are followed through each node's chosen exec output;
 *  - branching nodes (Branch, Switch, Sequence) compile each outgoing chain until the branches'
 *    immediate post-dominator (where they merge), then continue from there;
 *  - loop bodies are separate regions that must not flow back into the outer chain;
 *  - exec cycles are rejected before lowering (see analyze.ts).
 *
 * Data inputs are pulled lazily: pure nodes are inlined as expressions; values produced by exec
 * nodes are stored in locals and are only visible in the scope (block) where they were computed —
 * reading them anywhere else is a diagnostic rather than silently wrong code.
 */
import { EXIT, GraphIndex, immediatePostDominators, type Diagnostic, type FunctionDecl, type ScriptDoc } from '@cs/graph-core';
import type { IRExpr, IRFunction, IRStmt } from '@cs/intermediate-representation';
import type { ExecLowering, LowerContext, NodeContext, PortSpec } from '@cs/node-registry';
import { T, type TypeRef } from '@cs/type-system';
import { literalExpr, type NodeInfo, type Toolchain } from './context';

export interface LowerInput {
  tc: Toolchain;
  script: ScriptDoc;
  fn: FunctionDecl;
  ctx: NodeContext;
  infos: Map<string, NodeInfo>;
  index: GraphIndex;
  entryId: string;
  /** Identifiers already taken in this function (members, params, locals, reserved words). */
  takenNames: Set<string>;
  report: (d: Diagnostic) => void;
}

export function lowerFunction(inp: LowerInput): IRFunction {
  return new FunctionLowerer(inp).run();
}

class FunctionLowerer {
  private scopes: Map<string, IRExpr>[] = [new Map()];
  private loopDepth = 0;
  private emitted = new Map<string, number>();
  private evaluating = new Set<string>();
  private ipdom: Map<string, string>;
  private readonly execNodes: string[];

  constructor(private readonly inp: LowerInput) {
    const { infos } = inp;
    this.execNodes = [...infos.values()].filter((i) => i.def && (i.def.flavor === 'exec' || i.def.flavor === 'entry')).map((i) => i.node.id);
    this.ipdom = immediatePostDominators(this.execNodes, (n) => this.flowSuccessors(n));
  }

  /** Successors for merge analysis: exec outputs except loop-body regions. */
  private flowSuccessors(n: string): string[] {
    const info = this.inp.infos.get(n);
    if (!info) return [];
    const out: string[] = [];
    for (const p of info.ports) {
      if (p.kind !== 'exec' || p.direction !== 'out' || p.region === 'body') continue;
      const edges = this.inp.index.from(n, p.id);
      // An unconnected exec output ends the flow: it leads to the virtual exit, not nowhere.
      if (!edges.length && !out.includes(EXIT)) out.push(EXIT);
      for (const e of edges) if (!out.includes(e.to.node)) out.push(e.to.node);
    }
    return out;
  }

  run(): IRFunction {
    const { fn, ctx, tc } = this.inp;
    const body: IRStmt[] = [];
    for (const local of fn.locals) {
      const type = ctx.type(local.type);
      body.push({ k: 'var', name: local.name, type, ...(local.default !== undefined ? { init: literalExpr(tc.adapter, local.default, type) } : {}), src: { graphId: fn.graph.id } });
    }
    const first = this.inp.index.from(this.inp.entryId, 'then')[0]?.to.node;
    body.push(...this.chain(first, new Set()));
    return {
      k: 'function',
      name: fn.name,
      params: fn.params.map((p) => {
        const type = ctx.type(p.type);
        return { name: p.name, type, ...(p.default !== undefined ? { default: literalExpr(tc.adapter, p.default, type) } : {}) };
      }),
      returnType: ctx.type(fn.returnType),
      body,
      ...(fn.description ? { doc: fn.description } : {}),
      ...(fn.kind === 'event' && fn.event ? { event: fn.event } : {}),
      src: { scriptId: this.inp.script.id, graphId: fn.graph.id, nodeId: this.inp.entryId },
    };
  }

  private chain(start: string | undefined, stops: Set<string>): IRStmt[] {
    const out: IRStmt[] = [];
    let cur = start;
    const visitedHere = new Set<string>();
    while (cur && !stops.has(cur)) {
      if (visitedHere.has(cur)) break; // defensive: cycles are rejected earlier
      visitedHere.add(cur);
      const info = this.inp.infos.get(cur);
      if (!info?.def || info.def.flavor !== 'exec' || !info.def.lowerExec) break;
      const count = (this.emitted.get(cur) ?? 0) + 1;
      this.emitted.set(cur, count);
      if (count === 2) {
        this.diag('warning', 'W_DUPLICATED_FLOW', `"${info.title}" is reached from several paths that do not merge cleanly, so its code is generated more than once.`, cur, undefined, 'Restructure the flow so the paths join at one node, or move the shared part into a function.');
      }
      let res: ExecLowering;
      try {
        res = info.def.lowerExec(this.lc(cur, stops));
      } catch (e) {
        this.diag('error', 'E_NODE_LOWERING', `Could not compile "${info.title}": ${e instanceof Error ? e.message : String(e)}`, cur);
        break;
      }
      for (const s of res.stmts) out.push(s.src ? s : { ...s, src: { graphId: this.inp.fn.graph.id, nodeId: cur } });
      if (!res.next) break;
      if (res.next === 'join') {
        const ip = this.ipdom.get(cur);
        cur = ip && ip !== EXIT ? ip : undefined;
      } else {
        cur = this.inp.index.from(cur, res.next)[0]?.to.node;
      }
    }
    return out;
  }

  private lookup(key: string): IRExpr | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(key);
      if (v) return v;
    }
    return undefined;
  }

  uniqueName(hint: string): string {
    let base = hint.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'value';
    if (!this.inp.tc.adapter.identifiers.isValid(base)) base = `v_${base}`;
    let name = base;
    for (let i = 2; this.inp.takenNames.has(name) || this.inp.tc.adapter.identifiers.reserved.has(name); i++) name = `${base}_${i}`;
    this.inp.takenNames.add(name);
    return name;
  }

  private diag(severity: Diagnostic['severity'], code: string, message: string, nodeId?: string, portId?: string, suggestion?: string) {
    this.inp.report({ severity, code, message, scriptId: this.inp.script.id, functionId: this.inp.fn.id, graphId: this.inp.fn.graph.id, ...(nodeId ? { nodeId } : {}), ...(portId ? { portId } : {}), ...(suggestion ? { suggestion } : {}) });
  }

  private port(nodeId: string, portId: string): PortSpec | undefined {
    return this.inp.infos.get(nodeId)?.ports.find((p) => p.id === portId);
  }

  /** Value flowing out of (node, port). `consumer` is used for error attribution. */
  private valueOf(nodeId: string, portId: string, consumer: { node: string; port: string }): IRExpr {
    const info = this.inp.infos.get(nodeId);
    if (!info?.def) return { k: 'null' };
    switch (info.def.flavor) {
      case 'entry': {
        const p = this.inp.fn.params.find((x) => x.id === portId);
        return p ? { k: 'ref', name: p.name } : { k: 'null' };
      }
      case 'pure': {
        const key = `${nodeId}|${portId}`;
        if (this.evaluating.has(key) || !info.def.lowerExpr) {
          this.diag('error', 'E_DATA_CYCLE', `"${info.title}" depends on its own output.`, nodeId);
          return { k: 'null' };
        }
        this.evaluating.add(key);
        try {
          return info.def.lowerExpr(portId, this.lc(nodeId, new Set()));
        } catch (e) {
          this.diag('error', 'E_NODE_LOWERING', `Could not compile "${info.title}": ${e instanceof Error ? e.message : String(e)}`, nodeId);
          return { k: 'null' };
        } finally {
          this.evaluating.delete(key);
        }
      }
      case 'exec': {
        const v = this.lookup(`${nodeId}|${portId}`);
        if (v) return v;
        const consumerInfo = this.inp.infos.get(consumer.node);
        this.diag(
          'error',
          'E_VALUE_NOT_AVAILABLE',
          `"${consumerInfo?.title ?? consumer.node}" reads "${this.port(nodeId, portId)?.name || portId}" from "${info.title}", but on this execution path that value has not been computed yet (or was computed inside another branch or loop).`,
          consumer.node,
          consumer.port,
          `Make sure "${info.title}" runs before "${consumerInfo?.title ?? 'this node'}" on the same path, or store the value in a variable.`,
        );
        return { k: 'null' };
      }
      default:
        return { k: 'null' };
    }
  }

  private lc(nodeId: string, stops: Set<string>): LowerContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- needed for the loopDepth getter below
    const self = this;
    const info = this.inp.infos.get(nodeId)!;
    const node = info.node;
    const { index, tc } = this.inp;
    return {
      node,
      ctx: this.inp.ctx,
      src: { graphId: this.inp.fn.graph.id, nodeId },
      get loopDepth() {
        return self.loopDepth;
      },
      input(portId: string): IRExpr {
        const spec = info.ports.find((p) => p.id === portId);
        const edge = index.to(nodeId, portId)[0];
        if (edge) return self.valueOf(edge.from.node, edge.from.port, { node: nodeId, port: portId });
        if (!spec) return { k: 'null' };
        const inline = spec.connectionOnly ? undefined : node.inputs[portId];
        if (inline !== undefined) return literalExpr(tc.adapter, inline, spec.type);
        if (spec.required) {
          self.diag('error', 'E_MISSING_INPUT', `"${info.title}" needs a value for "${spec.name || portId}".`, nodeId, portId, spec.connectionOnly ? 'Connect a wire to this input.' : 'Connect a wire or type a value into this input.');
          return { k: 'null' };
        }
        if (spec.default !== undefined) return literalExpr(tc.adapter, spec.default, spec.type);
        return { k: 'null' };
      },
      inputType(portId: string): TypeRef | undefined {
        const edge = index.to(nodeId, portId)[0];
        if (edge) return self.port(edge.from.node, edge.from.port)?.type;
        return info.ports.find((p) => p.id === portId)?.type;
      },
      isConnected: (portId) => index.to(nodeId, portId).length > 0 || index.from(nodeId, portId).length > 0,
      isOutputUsed: (portId) => index.from(nodeId, portId).length > 0,
      body(execOut, opts = {}) {
        const target = index.from(nodeId, execOut)[0]?.to.node;
        if (!target) return [];
        let nextStops: Set<string>;
        if (opts.region === 'loop') {
          nextStops = new Set();
          self.loopDepth++;
        } else {
          nextStops = new Set(stops);
          const ip = self.ipdom.get(nodeId);
          if (ip && ip !== EXIT) nextStops.add(ip);
        }
        const scope = new Map<string, IRExpr>();
        for (const [p, e] of Object.entries(opts.bindings ?? {})) scope.set(`${nodeId}|${p}`, e);
        self.scopes.push(scope);
        try {
          return self.chain(target, nextStops);
        } finally {
          self.scopes.pop();
          if (opts.region === 'loop') self.loopDepth--;
        }
      },
      bind(portId, expr, opts = {}) {
        if (index.from(nodeId, portId).length === 0) return opts.sideEffect ? [{ k: 'expr', expr }] : [];
        const name = self.uniqueName(opts.nameHint ?? (info.ports.find((p) => p.id === portId)?.name || portId).toLowerCase());
        self.scopes[self.scopes.length - 1].set(`${nodeId}|${portId}`, { k: 'ref', name });
        const type = opts.type ?? info.ports.find((p) => p.id === portId)?.type;
        return [{ k: 'var', name, ...(type && type.kind !== 'any' ? { type } : {}), init: expr }];
      },
      uniqueName: (hint) => self.uniqueName(hint),
      error: (code, message, o) => self.diag('error', code, message, nodeId, o?.port, o?.suggestion),
      warn: (code, message, o) => self.diag('warning', code, message, nodeId, o?.port, o?.suggestion),
    };
  }
}

export { T };
