/**
 * Language adapter SDK. A language backend is one object implementing `LanguageAdapter`; the
 * editor, compiler pipeline, persistence and MCP server only ever talk to this interface.
 *
 * See docs/LANGUAGE_ADAPTERS.md for a walkthrough of implementing a new language.
 */
import type { Compatibility, TypeRef, TypeUniverse } from '@cs/type-system';
import type { Diagnostic, FunctionDecl, JsonValue, ScriptDoc, ParamDecl, VariableDecl } from '@cs/graph-core';
import type { BinaryOp, IRExpr, IRModule, IRStmt } from '@cs/intermediate-representation';
import type { LanguageCapabilities, NodeRegistry, PropSchema } from '@cs/node-registry';

export type { LanguageCapabilities, CapabilityKey } from '@cs/node-registry';
export { CAPABILITY_KEYS } from '@cs/node-registry';

export interface LanguageTypes {
  universe: TypeUniverse;
  /**
   * Normalise user/AI-supplied spellings to canonical form ("String" → "string",
   * "Array[int]" → "array<int>"). Return undefined when not recognised (canonical parsing is
   * tried afterwards).
   */
  normalize?(text: string): string | undefined;
  /** Spelling in source code. */
  format(t: TypeRef): string;
  compatibility(from: TypeRef, to: TypeRef): Compatibility;
  /** Result type of a binary operator, or undefined when the language doesn't support it. */
  operatorResult(op: BinaryOp, left: TypeRef, right: TypeRef): TypeRef | undefined;
  /** Field names for struct-like value types, used to build literals from JSON ({x, y} → Vector2(x, y)). */
  structFields(name: string): { name: string; type: TypeRef }[] | undefined;
  /** Type names offered in pickers (canonical spellings). */
  pickerTypes(): string[];
  /**
   * Named types this adapter doesn't know (classes from libraries) are accepted rather than
   * reported as unknown: the language's own compiler checks them.
   */
  openTypes?: boolean;
  /** Language-specific restrictions on a type (e.g. nullable primitives). Returns an error message. */
  check?(t: TypeRef): string | undefined;
}

export interface IdentifierRules {
  isValid(name: string): boolean;
  reserved: ReadonlySet<string>;
  /** Human-readable description of the rules, shown in diagnostics. */
  description: string;
}

/** A host-runtime callback the language/framework calls (GDScript `_ready`, `_process`…). */
export interface EventTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  params: Omit<ParamDecl, 'id'>[];
  returnType: string;
  /** Only meaningful when the script derives from this class (informational). */
  baseClass?: string;
}

export interface ScriptTemplate {
  id: string;
  name: string;
  description: string;
  settings: Record<string, JsonValue>;
  /** Events created with the script. */
  events: string[];
  /** Ordinary functions created with the script (languages without lifecycle events). */
  functions?: { name: string; params?: { name: string; type: string }[]; returnType?: string; exported?: boolean; async?: boolean; description?: string }[];
}

export interface CompilationContext {
  script: ScriptDoc;
  languageVersion: string;
  settings: CompilerSettings;
}

export interface CompilerSettings {
  indent: 'tab' | 'spaces';
  indentSize: number;
  /** Emit a header comment noting that the file is generated. */
  header: boolean;
  /** Emit node descriptions / variable descriptions as comments. */
  comments: boolean;
}

export const DEFAULT_COMPILER_SETTINGS: CompilerSettings = { indent: 'tab', indentSize: 4, header: true, comments: true };

export interface SourceMapEntry {
  /** 1-based line in the generated file. */
  line: number;
  scriptId: string;
  graphId?: string;
  nodeId?: string;
}

export interface GeneratedFile {
  /** Relative path including extension, forward slashes. */
  path: string;
  content: string;
  sourceMap: SourceMapEntry[];
}

/**
 * Program entry points. A project can name one function as where the program starts; each
 * language decides what that means for its runtime (call it at module load, render it, call it
 * from a lifecycle callback…) and which hosts it can target. Languages that compile to a classic
 * `main` (Java, C#…) implement the same interface by generating that method.
 */
export interface EntryHost {
  id: string;
  label: string;
  description: string;
}

export interface EntryRequest {
  script: ScriptDoc;
  fn: FunctionDecl;
  /** One of `hosts[].id`. */
  host: string;
  /** The function returns a promise / is a coroutine. */
  isAsync: boolean;
}

export interface EntryResult {
  /** The entry script's module, adjusted (e.g. a lifecycle callback calls the function). */
  module: IRModule;
  /** Extra files: a launcher module, a scene… */
  files?: GeneratedFile[];
  diagnostics?: Omit<Diagnostic, 'scriptId'>[];
  /** How to run it in the chosen host (shown to the user, returned to MCP). */
  instructions?: string[];
}

export interface EntryPointSupport {
  hosts: EntryHost[];
  /** Best host for this function when the user hasn't chosen one. */
  defaultHost(script: ScriptDoc, fn: FunctionDecl): string;
  apply(module: IRModule, req: EntryRequest, ctx: CompilationContext): EntryResult;
}

export interface LanguageAdapter {
  id: string;
  name: string;
  extensions: string[];
  versions: { id: string; label: string }[];
  defaultVersion: string;
  capabilities: LanguageCapabilities;
  types: LanguageTypes;
  identifiers: IdentifierRules;
  /** Language-specific script settings (GDScript: extends, class_name, @tool). */
  scriptSettings: PropSchema[];
  events: EventTemplate[];
  templates: ScriptTemplate[];
  /** Register this language's node pack (core nodes are registered separately). */
  registerNodes(registry: NodeRegistry): void;
  /** Validate script settings and language-specific attributes before lowering. */
  validateScript?(script: ScriptDoc, report: (d: Omit<Diagnostic, 'scriptId'>) => void): void;
  /** How a function's local variable is declared, when the language has special kinds (React state). */
  declareLocal?(local: VariableDecl, type: TypeRef, init: IRExpr | undefined, fn: FunctionDecl): IRStmt | undefined;
  /** Build a literal expression for a JSON value of a type (fallback: compiler-core's generic rules). */
  literal?(value: JsonValue, type: TypeRef): IRExpr | undefined;
  /** Final language-specific checks on the IR (unsupported constructs, naming conflicts…). */
  /** Where programs start (see EntryPointSupport). Languages without it report the entry as unsupported. */
  entryPoint?: EntryPointSupport;
  validate(module: IRModule, ctx: CompilationContext): Diagnostic[];
  generate(module: IRModule, ctx: CompilationContext): GeneratedFile[];
}

export class LanguageRegistry {
  private adapters = new Map<string, LanguageAdapter>();
  register(a: LanguageAdapter) {
    if (this.adapters.has(a.id)) throw new Error(`Language "${a.id}" is already registered`);
    this.adapters.set(a.id, a);
  }
  get(id: string): LanguageAdapter | undefined {
    return this.adapters.get(id);
  }
  all(): LanguageAdapter[] {
    return [...this.adapters.values()];
  }
}

export function allCapabilities(value: boolean): LanguageCapabilities {
  return {
    classes: value,
    inheritance: value,
    interfaces: value,
    generics: value,
    exceptions: value,
    async: value,
    coroutines: value,
    lifecycleEvents: value,
    signals: value,
    properties: value,
    pointers: value,
    manualMemory: value,
    modules: value,
    imports: value,
    typeInference: value,
    operatorOverloading: value,
    templates: value,
    memberVariables: value,
    exportedVariables: value,
    enums: value,
    match: value,
    nullable: value,
    dynamicTyping: value,
    closures: value,
  };
}

/** Line-oriented code writer with indentation and source-map tracking, shared by backends. */
export class CodeWriter {
  private lines: string[] = [];
  private map: SourceMapEntry[] = [];
  private depth = 0;
  constructor(
    private readonly indentUnit: string,
    private readonly scriptId: string,
  ) {}
  indent() {
    this.depth++;
  }
  dedent() {
    this.depth = Math.max(0, this.depth - 1);
  }
  line(text = '', src?: { graphId?: string; nodeId?: string }) {
    // Multi-line text (e.g. an inline function inside an expression): indent every line.
    if (text.includes('\n')) {
      const [first, ...rest] = text.split('\n');
      this.line(first, src);
      for (const r of rest) this.lines.push(r ? this.indentUnit.repeat(this.depth) + r : '');
      return;
    }
    this.lines.push(text ? this.indentUnit.repeat(this.depth) + text : '');
    if (src?.nodeId || src?.graphId) this.map.push({ line: this.lines.length, scriptId: this.scriptId, graphId: src.graphId, nodeId: src.nodeId });
  }
  /** Ensure exactly `n` blank lines precede the next line (not at file start). */
  blank(n = 1) {
    if (!this.lines.length) return;
    let have = 0;
    for (let i = this.lines.length - 1; i >= 0 && this.lines[i] === ''; i--) have++;
    for (; have < n; have++) this.lines.push('');
  }
  get lineCount() {
    return this.lines.length;
  }
  result(): { content: string; sourceMap: SourceMapEntry[] } {
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    return { content: this.lines.join('\n') + '\n', sourceMap: this.map };
  }
}
