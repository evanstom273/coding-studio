/**
 * Structured, language-neutral intermediate representation. The compiler lowers graphs into this
 * tree; language backends print it. Every statement can carry the graph node it came from so
 * generated lines map back to the editor.
 */
import type { TypeRef } from '@cs/type-system';
import type { JsonValue } from '@cs/graph-core';

export interface SourceRef {
  scriptId?: string;
  graphId?: string;
  nodeId?: string;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
export type UnaryOp = 'not' | 'neg';

/**
 * Language-neutral built-in operations. Backends map each one to their own spelling (or report
 * E_UNSUPPORTED when they can't). Keeping these symbolic is what lets one graph target several
 * languages.
 */
export type BuiltinOp =
  | 'print'
  | 'to_string'
  | 'to_int'
  | 'to_float'
  | 'to_bool'
  | 'abs'
  | 'min'
  | 'max'
  | 'clamp'
  | 'pow'
  | 'sqrt'
  | 'floor'
  | 'ceil'
  | 'round'
  | 'lerp'
  | 'sin'
  | 'cos'
  | 'random_float'
  | 'random_int_range'
  | 'str_length'
  | 'str_upper'
  | 'str_lower'
  | 'str_contains'
  | 'str_substring'
  | 'str_concat'
  | 'array_length'
  | 'array_append'
  | 'array_contains'
  | 'array_remove_at'
  | 'array_clear'
  | 'map_has'
  | 'map_get'
  | 'map_set'
  | 'map_keys'
  | 'map_size'
  | 'map_erase';

export type IRExpr =
  | { k: 'lit'; value: JsonValue; type: TypeRef }
  /** Local variable, parameter, member field or constant by its final identifier. */
  | { k: 'ref'; name: string }
  | { k: 'self' }
  | { k: 'null' }
  | { k: 'bin'; op: BinaryOp; left: IRExpr; right: IRExpr }
  | { k: 'un'; op: UnaryOp; operand: IRExpr }
  /** Call of a function or method by name. `target` absent → function in the current scope/module. */
  | { k: 'call'; name: string; target?: IRExpr; args: IRExpr[] }
  /** `type`: operand type for generic numeric built-ins (lets backends pick typed variants). */
  | { k: 'builtin'; op: BuiltinOp; args: IRExpr[]; type?: TypeRef }
  | { k: 'prop'; target: IRExpr; name: string }
  | { k: 'index'; target: IRExpr; index: IRExpr }
  /** Construct a value/object of a named type with positional arguments. */
  | { k: 'new'; type: TypeRef; args: IRExpr[]; /** The class as an expression (an imported binding), when not a plain type name. */ callee?: IRExpr }
  | { k: 'array'; items: IRExpr[]; element?: TypeRef }
  | { k: 'map'; entries: { key: IRExpr; value: IRExpr }[] }
  | { k: 'ternary'; cond: IRExpr; then: IRExpr; else: IRExpr }
  /** Checked cast to a named type; yields null when the value is not an instance. */
  | { k: 'cast'; expr: IRExpr; type: TypeRef }
  | { k: 'instanceof'; expr: IRExpr; type: TypeRef }
  /** Reference to a member enum value. */
  | { k: 'enum'; enumName: string; member: string }
  /** Wait for an async value (TypeScript `await`). */
  | { k: 'await'; expr: IRExpr }
  /** String with embedded values (TypeScript template literal). */
  | { k: 'template'; parts: (string | IRExpr)[] }
  /** Object literal with fixed keys. */
  | { k: 'object'; entries: { key: string; value: IRExpr }[] }
  /** A binding imported from another module; the backend's import manager writes the import. */
  | { k: 'import'; module: string; name: string; kind: 'named' | 'default' | 'namespace' }
  /** Call the value of an expression (an imported function, a callback): callee(args). */
  | { k: 'invoke'; callee: IRExpr; args: IRExpr[] }
  /** An inline function (closure): (params) => { body } */
  | { k: 'lambda'; params: IRParam[]; returnType: TypeRef; body: IRStmt[]; isAsync?: boolean; src?: SourceRef }
  /** A JSX element: <tag attr={…}>children</tag>. `tag` is an HTML tag name or a component expression. */
  | { k: 'jsx'; tag: string | IRExpr; attrs: { name: string; value: IRExpr }[]; children: IRExpr[] }
  /** A function of this module used as a value (callbacks). */
  | { k: 'func_ref'; name: string }
  /** Property access that yields undefined instead of failing on null (`a?.b`). */
  | { k: 'optional_prop'; target: IRExpr; name: string }
  /**
   * Language-specific construct produced by a language node pack. Only the backend whose id is
   * `lang` may print it; others report it as unsupported. `op` names the construct; `args` are
   * child expressions and `data` holds constant parameters.
   */
  | { k: 'lang'; lang: string; op: string; args: IRExpr[]; data?: Record<string, JsonValue> };

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type IRStmt = (
  | { k: 'var'; name: string; type?: TypeRef; init?: IRExpr; constant?: boolean }
  | { k: 'assign'; target: IRExpr; value: IRExpr; op?: '+' | '-' | '*' | '/' }
  | { k: 'expr'; expr: IRExpr }
  | { k: 'if'; cond: IRExpr; then: IRStmt[]; else?: IRStmt[] }
  | { k: 'while'; cond: IRExpr; body: IRStmt[] }
  /** Counted loop: for name in [from, to) step step. */
  | { k: 'for_range'; var: string; from: IRExpr; to: IRExpr; step?: IRExpr; body: IRStmt[] }
  | { k: 'for_each'; var: string; iterable: IRExpr; body: IRStmt[]; elementType?: TypeRef }
  | { k: 'match'; subject: IRExpr; arms: { values: IRExpr[]; body: IRStmt[] }[]; default?: IRStmt[] }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'return'; value?: IRExpr }
  | { k: 'comment'; text: string }
  /** try { body } catch (catchVar) { handler } finally { finally } */
  | { k: 'try'; body: IRStmt[]; catchVar?: string; handler?: IRStmt[]; finally?: IRStmt[] }
  | { k: 'throw'; value: IRExpr }
  /** const [a, b] = init (array destructuring, e.g. React's useState). */
  | { k: 'var_tuple'; names: string[]; init: IRExpr; constant?: boolean }
  /** Language-specific statement (see IRExpr 'lang'). */
  | { k: 'lang'; lang: string; op: string; args: IRExpr[]; data?: Record<string, JsonValue> }
) & { src?: SourceRef };

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface IRParam {
  name: string;
  type: TypeRef;
  default?: IRExpr;
}

export interface IRFunction {
  k: 'function';
  name: string;
  params: IRParam[];
  returnType: TypeRef;
  body: IRStmt[];
  isStatic?: boolean;
  isAsync?: boolean;
  exported?: boolean;
  /** A React component: parameters are props (destructured from one object). */
  component?: boolean;
  doc?: string;
  /** Lifecycle event id when this function is a host callback (GDScript "_ready"). */
  event?: string;
  src?: SourceRef;
}

export interface IRField {
  k: 'field';
  name: string;
  type: TypeRef;
  init?: IRExpr;
  constant?: boolean;
  exported?: boolean;
  doc?: string;
  attributes?: Record<string, JsonValue>;
  src?: SourceRef;
}

export interface IRSignal {
  k: 'signal';
  name: string;
  params: IRParam[];
  doc?: string;
  src?: SourceRef;
}

export interface IREnum {
  k: 'enum';
  name: string;
  members: { name: string; value?: number }[];
  src?: SourceRef;
}

export interface IRInterface {
  k: 'interface';
  name: string;
  fields: { name: string; type: TypeRef; optional?: boolean; doc?: string }[];
  exported?: boolean;
  doc?: string;
  src?: SourceRef;
}

export type IRMember = IRFunction | IRField | IRSignal | IREnum | IRInterface;

export interface IRModule {
  /** Script id in the project. */
  scriptId: string;
  name: string;
  /** Output path without extension. */
  path: string;
  doc?: string;
  /** Adapter-validated script settings (GDScript: extends/class_name/tool). */
  settings: Record<string, JsonValue>;
  imports: { path: string; alias?: string }[];
  members: IRMember[];
}

export interface IRProgram {
  modules: IRModule[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const ir = {
  lit: (value: JsonValue, type: TypeRef): IRExpr => ({ k: 'lit', value, type }),
  ref: (name: string): IRExpr => ({ k: 'ref', name }),
  call: (name: string, args: IRExpr[], target?: IRExpr): IRExpr => (target ? { k: 'call', name, args, target } : { k: 'call', name, args }),
  builtin: (op: BuiltinOp, ...args: IRExpr[]): IRExpr => ({ k: 'builtin', op, args }),
  bin: (op: BinaryOp, left: IRExpr, right: IRExpr): IRExpr => ({ k: 'bin', op, left, right }),
};

/** Walk all statements, including nested blocks. */
export function walkStmts(stmts: IRStmt[], fn: (s: IRStmt) => void) {
  for (const s of stmts) {
    fn(s);
    switch (s.k) {
      case 'if':
        walkStmts(s.then, fn);
        if (s.else) walkStmts(s.else, fn);
        break;
      case 'while':
      case 'for_range':
      case 'for_each':
        walkStmts(s.body, fn);
        break;
      case 'match':
        for (const a of s.arms) walkStmts(a.body, fn);
        if (s.default) walkStmts(s.default, fn);
        break;
      case 'try':
        walkStmts(s.body, fn);
        if (s.handler) walkStmts(s.handler, fn);
        if (s.finally) walkStmts(s.finally, fn);
        break;
    }
  }
}

/** Walk all expressions inside an expression tree. */
export function walkExpr(e: IRExpr, fn: (e: IRExpr) => void) {
  fn(e);
  switch (e.k) {
    case 'bin':
      walkExpr(e.left, fn);
      walkExpr(e.right, fn);
      break;
    case 'un':
      walkExpr(e.operand, fn);
      break;
    case 'call':
      if (e.target) walkExpr(e.target, fn);
      e.args.forEach((a) => walkExpr(a, fn));
      break;
    case 'builtin':
    case 'new':
    case 'lang':
      e.args.forEach((a) => walkExpr(a, fn));
      break;
    case 'prop':
      walkExpr(e.target, fn);
      break;
    case 'index':
      walkExpr(e.target, fn);
      walkExpr(e.index, fn);
      break;
    case 'array':
      e.items.forEach((a) => walkExpr(a, fn));
      break;
    case 'map':
      e.entries.forEach((x) => {
        walkExpr(x.key, fn);
        walkExpr(x.value, fn);
      });
      break;
    case 'ternary':
      walkExpr(e.cond, fn);
      walkExpr(e.then, fn);
      walkExpr(e.else, fn);
      break;
    case 'cast':
    case 'instanceof':
    case 'await':
      walkExpr(e.expr, fn);
      break;
    case 'optional_prop':
      walkExpr(e.target, fn);
      break;
    case 'jsx':
      if (typeof e.tag !== 'string') walkExpr(e.tag, fn);
      e.attrs.forEach((a) => walkExpr(a.value, fn));
      e.children.forEach((c) => walkExpr(c, fn));
      break;
    case 'invoke':
      walkExpr(e.callee, fn);
      e.args.forEach((a) => walkExpr(a, fn));
      break;
    case 'template':
      e.parts.forEach((p) => typeof p !== 'string' && walkExpr(p, fn));
      break;
    case 'object':
      e.entries.forEach((x) => walkExpr(x.value, fn));
      break;
  }
}

/** Expressions directly owned by a statement (not nested blocks). */
export function stmtExprs(s: IRStmt): IRExpr[] {
  switch (s.k) {
    case 'var':
      return s.init ? [s.init] : [];
    case 'assign':
      return [s.target, s.value];
    case 'expr':
      return [s.expr];
    case 'if':
    case 'while':
      return [s.cond];
    case 'for_range':
      return [s.from, s.to, ...(s.step ? [s.step] : [])];
    case 'for_each':
      return [s.iterable];
    case 'match':
      return [s.subject, ...s.arms.flatMap((a) => a.values)];
    case 'return':
      return s.value ? [s.value] : [];
    case 'throw':
      return [s.value];
    case 'var_tuple':
      return [s.init];
    case 'lang':
      return s.args;
    default:
      return [];
  }
}

/** True when every path through the block ends in a return (used for missing-return checks). */
export function alwaysReturns(stmts: IRStmt[]): boolean {
  for (const s of stmts) {
    if (s.k === 'return' || s.k === 'throw') return true;
    if (s.k === 'try' && (s.finally && alwaysReturns(s.finally) ? true : alwaysReturns(s.body) && (!s.handler || alwaysReturns(s.handler)))) return true;
    if (s.k === 'if' && s.else && alwaysReturns(s.then) && alwaysReturns(s.else)) return true;
    if (s.k === 'match' && s.default && s.arms.every((a) => alwaysReturns(a.body)) && alwaysReturns(s.default)) return true;
  }
  return false;
}
