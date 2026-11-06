/**
 * Node registry: the single source of truth for node types. A definition declares its ports
 * (possibly depending on its props and the surrounding program), its editable properties, which
 * languages/capabilities it needs, and how it lowers to the intermediate representation.
 *
 * The compiler never special-cases node types (apart from the function entry) — adding a node is
 * registering a definition.
 */
import type { TypeRef } from '@cs/type-system';
import type { FunctionDecl, GraphNode, JsonValue, ScriptDoc, SignalDecl, VariableDecl } from '@cs/graph-core';
import type { BinaryOp, IRExpr, IRStmt, SourceRef } from '@cs/intermediate-representation';

// ---------------------------------------------------------------------------
// Capabilities (declared here so node definitions can require them; adapters fill them in)
// ---------------------------------------------------------------------------

export const CAPABILITY_KEYS = [
  'classes',
  'inheritance',
  'interfaces',
  'generics',
  'exceptions',
  'async',
  'coroutines',
  'lifecycleEvents',
  'signals',
  'properties',
  'pointers',
  'manualMemory',
  'modules',
  'imports',
  'typeInference',
  'operatorOverloading',
  'templates',
  'memberVariables',
  'exportedVariables',
  'enums',
  'match',
  'nullable',
  'dynamicTyping',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type LanguageCapabilities = Record<CapabilityKey, boolean>;

// ---------------------------------------------------------------------------
// Ports and properties
// ---------------------------------------------------------------------------

export type PortKind = 'exec' | 'data';
export type PortDirection = 'in' | 'out';

export interface PortSpec {
  id: string;
  name: string;
  direction: PortDirection;
  kind: PortKind;
  /** Data ports only. */
  type?: TypeRef;
  /** Data inputs: value used when neither connected nor given inline. */
  default?: JsonValue;
  /** Data inputs: must be connected or have an inline value. */
  required?: boolean;
  /** Data inputs that can only be supplied by a connection (no inline editor), e.g. objects. */
  connectionOnly?: boolean;
  /** Exec outputs that start a nested region (loop bodies) instead of continuing the flow. */
  region?: 'body';
  description?: string;
}

export type PropKind =
  | 'string'
  | 'text'
  | 'int'
  | 'number'
  | 'boolean'
  | 'select'
  | 'type'
  | 'variable'
  | 'function'
  | 'signal'
  | 'enum'
  | 'string_list';

export interface PropSchema {
  key: string;
  label: string;
  kind: PropKind;
  default: JsonValue;
  description?: string;
  /** For 'select'. */
  options?: { value: string; label: string }[];
  /** For 'type': restrict the choices (canonical type strings). Omit = any type. */
  typeOptions?: string[];
  /** For 'variable': which scopes are selectable. */
  variableScopes?: ('member' | 'local' | 'param')[];
  min?: number;
  max?: number;
}

// ---------------------------------------------------------------------------
// Program context visible to nodes
// ---------------------------------------------------------------------------

export interface ResolvedVariable {
  id: string;
  name: string;
  type: TypeRef;
  scope: 'member' | 'local' | 'param';
  constant: boolean;
  decl: VariableDecl | { id: string; name: string; type: string };
}

export interface NodeContext {
  language: string;
  capabilities: LanguageCapabilities;
  script: ScriptDoc;
  fn: FunctionDecl;
  /** Parse a canonical type string; returns `any` (and the compiler reports) when invalid. */
  type(text: string | undefined): TypeRef;
  variable(id: unknown): ResolvedVariable | undefined;
  /** All variables visible from the current function. */
  variables(): ResolvedVariable[];
  func(id: unknown): FunctionDecl | undefined;
  signal(id: unknown): SignalDecl | undefined;
  /** Type of `self` (the script's base class), when the language has classes. */
  selfType(): TypeRef | undefined;
  /** Result type of a binary operator in the target language (undefined = unsupported). */
  operatorResult(op: BinaryOp, left: TypeRef, right: TypeRef): TypeRef | undefined;
  /** Whether class `child` is `ancestor` or derives from it. */
  isSubclass(child: string, ancestor: string): boolean;
  /** Spell a type in the target language (for titles and messages). */
  formatType(t: TypeRef): string;
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

export interface LowerContext {
  readonly node: GraphNode;
  readonly ctx: NodeContext;
  readonly src: SourceRef;
  /** Expression for a data input: the connected value, the inline literal, or the port default. */
  input(port: string): IRExpr;
  /** Type flowing into a data input (connected source type, else the port type). */
  inputType(port: string): TypeRef | undefined;
  isConnected(port: string): boolean;
  /** Whether a data output of this node is connected to anything. */
  isOutputUsed(port: string): boolean;
  /**
   * Compile the execution chain that starts at one of this node's exec outputs.
   * `bindings` makes this node's data outputs available inside that chain (loop variables).
   * `region: 'loop'` starts a fresh region (loop bodies may not merge with the outer flow).
   */
  body(execOut: string, opts?: { bindings?: Record<string, IRExpr>; region?: 'loop' | 'branch' }): IRStmt[];
  /**
   * Make a data output available to later nodes. When the output is used, a local variable is
   * declared and later reads refer to it; when unused, `expr` is emitted as a plain statement if
   * `sideEffect` is true, otherwise dropped.
   */
  bind(port: string, expr: IRExpr, opts?: { type?: TypeRef; nameHint?: string; sideEffect?: boolean }): IRStmt[];
  /** A fresh local identifier based on `hint`. */
  uniqueName(hint: string): string;
  /** Current loop nesting depth (for break/continue validation). */
  readonly loopDepth: number;
  error(code: string, message: string, opts?: { port?: string; suggestion?: string }): void;
  warn(code: string, message: string, opts?: { port?: string; suggestion?: string }): void;
}

export interface ExecLowering {
  stmts: IRStmt[];
  /**
   * How flow continues after this node:
   *  - a port id: continue with the chain connected to that exec output
   *  - 'join': continue at the point where this node's branches merge again (if/switch/sequence)
   *  - undefined: flow ends here (return, break, continue)
   */
  next?: string | 'join';
}

export type NodeFlavor =
  /** Function entry (one per graph, created automatically). */
  | 'entry'
  /** Has exec ports; runs as a statement. */
  | 'exec'
  /** No exec ports; evaluated as an expression where its outputs are used. */
  | 'pure'
  /** Ignored by the compiler (comment frames). */
  | 'annotation';

export interface NodeDefinition {
  type: string;
  title: string;
  category: string;
  description: string;
  keywords?: string[];
  flavor: NodeFlavor;
  props: PropSchema[];
  /** Capabilities the target language must support. */
  requires?: CapabilityKey[];
  /** Restrict to specific language ids (language-specific node packs). */
  languages?: string[];
  /** Hidden from the palette (entry nodes). */
  internal?: boolean;
  /** Pure nodes that build a new object each time they are evaluated (Make Array/Map/Object). */
  allocates?: boolean;
  /** Ready-made configurations shown as their own palette entries (e.g. Call → fetch, JSON.parse). */
  presets?: { title: string; description?: string; category?: string; keywords?: string[]; props: Record<string, JsonValue> }[];
  /** Dynamic title (e.g. "Set speed"). */
  displayTitle?(node: GraphNode, ctx: NodeContext): string;
  ports(node: GraphNode, ctx: NodeContext): PortSpec[];
  /** Extra semantic checks beyond port/prop validation. */
  check?(node: GraphNode, ctx: NodeContext, report: (code: string, message: string, opts?: { port?: string; severity?: 'error' | 'warning'; suggestion?: string }) => void): void;
  /** Pure nodes: expression for one of the data outputs. */
  lowerExpr?(port: string, lc: LowerContext): IRExpr;
  /** Exec nodes. */
  lowerExec?(lc: LowerContext): ExecLowering;
}

export interface NodeSummary {
  type: string;
  title: string;
  category: string;
  description: string;
  flavor: NodeFlavor;
  keywords: string[];
  languages?: string[];
  requires?: CapabilityKey[];
}

export class NodeRegistry {
  private defs = new Map<string, NodeDefinition>();

  register(def: NodeDefinition) {
    if (this.defs.has(def.type)) throw new Error(`Node type "${def.type}" is already registered`);
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(def.type)) throw new Error(`Invalid node type id "${def.type}"`);
    this.defs.set(def.type, def);
  }

  registerAll(defs: NodeDefinition[]) {
    for (const d of defs) this.register(d);
  }

  get(type: string): NodeDefinition | undefined {
    return this.defs.get(type);
  }

  all(): NodeDefinition[] {
    return [...this.defs.values()];
  }

  /** Whether a definition can be used with a language. */
  static isAvailable(def: NodeDefinition, language: string, caps: LanguageCapabilities): boolean {
    if (def.languages && !def.languages.includes(language)) return false;
    return (def.requires ?? []).every((c) => caps[c]);
  }

  available(language: string, caps: LanguageCapabilities): NodeDefinition[] {
    return this.all().filter((d) => !d.internal && NodeRegistry.isAvailable(d, language, caps));
  }

  search(query: string, language: string, caps: LanguageCapabilities): NodeDefinition[] {
    const q = query.trim().toLowerCase();
    const list = this.available(language, caps);
    if (!q) return list;
    const words = q.split(/\s+/);
    const score = (d: NodeDefinition) => {
      const hay = `${d.title} ${d.type} ${d.category} ${(d.keywords ?? []).join(' ')} ${d.description}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return -1;
      const t = d.title.toLowerCase();
      return (t === q ? 100 : 0) + (t.startsWith(q) ? 50 : 0) + (t.includes(q) ? 20 : 0) + ((d.keywords ?? []).some((k) => k.toLowerCase() === q) ? 30 : 0);
    };
    return list
      .map((d) => ({ d, s: score(d) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.d.title.localeCompare(b.d.title))
      .map((x) => x.d);
  }

  summary(def: NodeDefinition): NodeSummary {
    return { type: def.type, title: def.title, category: def.category, description: def.description, flavor: def.flavor, keywords: def.keywords ?? [], languages: def.languages, requires: def.requires };
  }
}

/** Default prop values for a new node of this type. */
export function defaultProps(def: NodeDefinition): Record<string, JsonValue> {
  return Object.fromEntries(def.props.map((p) => [p.key, structuredClone(p.default)]));
}

// Port helpers used by node packs
export const exec = {
  in: (id = 'exec', name = ''): PortSpec => ({ id, name, direction: 'in', kind: 'exec' }),
  out: (id = 'then', name = '', region?: 'body'): PortSpec => ({ id, name, direction: 'out', kind: 'exec', ...(region ? { region } : {}) }),
};
export const data = {
  in: (id: string, name: string, type: TypeRef, extra: Partial<PortSpec> = {}): PortSpec => ({ id, name, direction: 'in', kind: 'data', type, ...extra }),
  out: (id: string, name: string, type: TypeRef, extra: Partial<PortSpec> = {}): PortSpec => ({ id, name, direction: 'out', kind: 'data', type, ...extra }),
};
