/**
 * IR → GDScript 2.0 (Godot 4) source. Follows the official GDScript style guide: member order
 * (signals, enums, constants, exported vars, vars, @onready vars, built-in callbacks, functions),
 * tabs, two blank lines between functions, snake_case kept as written by the user.
 */
import { stmtExprs, walkExpr, walkStmts, type IRExpr, type IRField, type IRFunction, type IRModule, type IRStmt } from '@cs/intermediate-representation';
import { CodeWriter, type CompilationContext, type GeneratedFile } from '@cs/language-sdk';
import type { TypeRef } from '@cs/type-system';
import { gdType, universe } from './types';
import { LANG } from './nodes';

// Higher binds tighter (GDScript operator precedence table).
const PREC = {
  primary: 20,
  await: 19,
  is: 18,
  neg: 16,
  mul: 15,
  add: 14,
  cmp: 12,
  not: 10,
  and: 9,
  or: 8,
  ternary: 7,
  as: 6,
  lowest: 0,
} as const;

const BIN_PREC: Record<string, number> = {
  '*': PREC.mul,
  '/': PREC.mul,
  '%': PREC.mul,
  '+': PREC.add,
  '-': PREC.add,
  '==': PREC.cmp,
  '!=': PREC.cmp,
  '<': PREC.cmp,
  '<=': PREC.cmp,
  '>': PREC.cmp,
  '>=': PREC.cmp,
  and: PREC.and,
  or: PREC.or,
};

export const EVENT_ORDER = ['_init', '_enter_tree', '_ready', '_process', '_physics_process', '_input', '_unhandled_input', '_unhandled_key_input', '_exit_tree', '_notification', '_draw'];

function formatFloat(n: number): string {
  if (Number.isNaN(n)) return 'NAN';
  if (!Number.isFinite(n)) return n > 0 ? 'INF' : '-INF';
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

function annot(t: TypeRef | undefined): string {
  if (!t || t.kind === 'any') return '';
  return `: ${gdType(t)}`;
}

export class GDScriptPrinter {
  constructor(private readonly mod: IRModule) {}

  expr(e: IRExpr, min: number = PREC.lowest): string {
    const [s, p] = this.exprP(e);
    return p < min ? `(${s})` : s;
  }

  /** Expression as the target of `.member` / `[i]` / call. */
  private primary(e: IRExpr): string {
    return this.expr(e, PREC.primary);
  }

  private exprP(e: IRExpr): [string, number] {
    switch (e.k) {
      case 'lit': {
        const v = e.value;
        if (v === null) return ['null', PREC.primary];
        if (typeof v === 'boolean') return [v ? 'true' : 'false', PREC.primary];
        if (typeof v === 'number') {
          const s = e.type.kind === 'float' ? formatFloat(v) : String(Math.trunc(v));
          return [s, s.startsWith('-') ? PREC.neg : PREC.primary];
        }
        if (typeof v === 'string') return [JSON.stringify(v), PREC.primary];
        return [JSON.stringify(v), PREC.primary];
      }
      case 'null':
        return ['null', PREC.primary];
      case 'ref':
        return [e.name, PREC.primary];
      case 'self':
        return ['self', PREC.primary];
      case 'enum':
        return [`${e.enumName}.${e.member}`, PREC.primary];
      case 'bin': {
        const p = BIN_PREC[e.op];
        const op = e.op;
        // Comparisons are not chained in GDScript the way Python does; parenthesise nested ones.
        const rightMin = p === PREC.cmp ? p + 1 : p + 1;
        const leftMin = p === PREC.cmp ? p + 1 : p;
        return [`${this.expr(e.left, leftMin)} ${op} ${this.expr(e.right, rightMin)}`, p];
      }
      case 'un':
        if (e.op === 'not') return [`not ${this.expr(e.operand, PREC.not)}`, PREC.not];
        return [`-${this.expr(e.operand, PREC.neg + 1)}`, PREC.neg];
      case 'call': {
        const args = e.args.map((a) => this.expr(a)).join(', ');
        if (!e.target || e.target.k === 'self') return [`${e.name}(${args})`, PREC.primary];
        return [`${this.primary(e.target)}.${e.name}(${args})`, PREC.primary];
      }
      case 'prop':
        if (e.target.k === 'self') return [`self.${e.name}`, PREC.primary];
        return [`${this.primary(e.target)}.${e.name}`, PREC.primary];
      case 'index':
        return [`${this.primary(e.target)}[${this.expr(e.index)}]`, PREC.primary];
      case 'new': {
        const args = e.args.map((a) => this.expr(a)).join(', ');
        // Engine classes are constructed with .new(); built-in value types with a call.
        if (e.type.kind === 'named' && universe.isReferenceType(e.type.name)) return [`${e.type.name}.new(${args})`, PREC.primary];
        return [`${gdType(e.type)}(${args})`, PREC.primary];
      }
      case 'array':
        return [`[${e.items.map((a) => this.expr(a)).join(', ')}]`, PREC.primary];
      case 'map':
        return [e.entries.length ? `{${e.entries.map((x) => `${this.expr(x.key)}: ${this.expr(x.value)}`).join(', ')}}` : '{}', PREC.primary];
      case 'ternary':
        return [`${this.expr(e.then, PREC.ternary + 1)} if ${this.expr(e.cond, PREC.ternary + 1)} else ${this.expr(e.else, PREC.ternary)}`, PREC.ternary];
      case 'cast':
        return [`${this.expr(e.expr, PREC.as + 1)} as ${gdType(e.type)}`, PREC.as];
      case 'instanceof':
        return [`${this.expr(e.expr, PREC.is + 1)} is ${gdType(e.type)}`, PREC.is];
      case 'builtin':
        return this.builtin(e.op, e.args, e.type);
      case 'lang':
        return this.langExpr(e);
      default:
        // await / template / object / import / func_ref / optional_prop come from other languages' node packs.
        throw new Error(`GDScript can't express "${e.k}"`);
    }
  }

  private builtin(op: string, a: IRExpr[], type?: TypeRef): [string, number] {
    const args = () => a.map((x) => this.expr(x)).join(', ');
    const call = (name: string): [string, number] => [`${name}(${args()})`, PREC.primary];
    const method = (name: string, rest = a.slice(1)): [string, number] => [`${this.primary(a[0])}.${name}(${rest.map((x) => this.expr(x)).join(', ')})`, PREC.primary];
    switch (op) {
      case 'print':
        return call('print');
      case 'to_string':
        return call('str');
      case 'to_int':
        return call('int');
      case 'to_float':
        return call('float');
      case 'to_bool':
        return call('bool');
      case 'abs':
      case 'min':
      case 'max':
      case 'clamp':
        // Typed variants (absf/mini/clampf…) return float/int instead of Variant.
        return call(type?.kind === 'float' ? `${op}f` : type?.kind === 'int' ? `${op}i` : op);
      case 'floor':
      case 'ceil':
      case 'round':
      case 'lerp':
        return call(type?.kind === 'float' ? `${op}f` : op);
      case 'pow':
      case 'sqrt':
      case 'sin':
      case 'cos':
        return call(op);
      case 'random_float':
        return call('randf');
      case 'random_int_range':
        return call('randi_range');
      case 'str_length':
        return method('length');
      case 'str_upper':
        return method('to_upper');
      case 'str_lower':
        return method('to_lower');
      case 'str_contains':
        return method('contains');
      case 'str_substring':
        return method('substr');
      case 'str_concat':
        return [a.map((x, i) => this.expr(x, i === 0 ? PREC.add : PREC.add + 1)).join(' + '), PREC.add];
      case 'array_length':
      case 'map_size':
        return method('size');
      case 'array_append':
        return method('append');
      case 'array_contains':
      case 'map_has':
        return method('has');
      case 'array_remove_at':
        return method('remove_at');
      case 'array_clear':
        return method('clear');
      case 'map_get':
        return method('get');
      case 'map_set':
        return [`${this.primary(a[0])}[${this.expr(a[1])}] = ${this.expr(a[2])}`, 0];
      case 'map_keys':
        return method('keys');
      case 'map_erase':
        return method('erase');
      default:
        throw new Error(`GDScript backend has no mapping for built-in "${op}"`);
    }
  }

  private langExpr(e: Extract<IRExpr, { k: 'lang' }>): [string, number] {
    if (e.lang !== LANG) throw new Error(`Construct "${e.op}" belongs to language "${e.lang}"`);
    const d = e.data ?? {};
    switch (e.op) {
      case 'get_node': {
        const path = String(d.path ?? '');
        const ty = String(d.type ?? 'Node');
        const ref = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(path) ? `$${path}` : `$${JSON.stringify(path)}`;
        return ty === 'Node' ? [ref, PREC.primary] : [`${ref} as ${ty}`, PREC.as];
      }
      case 'preload':
        return [`preload(${JSON.stringify(String(d.path ?? ''))})`, PREC.primary];
      case 'load': {
        const ty = String(d.type ?? 'Resource');
        const s = `load(${this.expr(e.args[0])})`;
        return ty === 'Resource' ? [s, PREC.primary] : [`${s} as ${ty}`, PREC.as];
      }
      case 'instantiate': {
        const ty = String(d.type ?? 'Node');
        const s = `${this.primary(e.args[0])}.instantiate()`;
        return ty === 'Node' ? [s, PREC.primary] : [`${s} as ${ty}`, PREC.as];
      }
      case 'constant':
        return [String(d.name), PREC.primary];
      default:
        throw new Error(`Unknown GDScript construct "${e.op}"`);
    }
  }

  // --- statements ---------------------------------------------------------------

  block(w: CodeWriter, stmts: IRStmt[], graphId?: string) {
    w.indent();
    const printable = stmts.filter((s) => !(s.k === 'comment' && !s.text));
    if (!printable.length || printable.every((s) => s.k === 'comment')) {
      for (const s of printable) this.stmt(w, s, graphId);
      w.line('pass');
    } else {
      for (const s of printable) this.stmt(w, s, graphId);
    }
    w.dedent();
  }

  stmt(w: CodeWriter, s: IRStmt, graphId?: string) {
    const src = { graphId: s.src?.graphId ?? graphId, nodeId: s.src?.nodeId };
    switch (s.k) {
      case 'var': {
        const kw = s.constant ? 'const' : 'var';
        w.line(`${kw} ${s.name}${annot(s.type)}${s.init ? ` = ${this.expr(s.init)}` : ''}`, src);
        break;
      }
      case 'assign':
        w.line(`${this.expr(s.target, PREC.primary)} ${s.op ?? ''}= ${this.expr(s.value)}`, src);
        break;
      case 'expr':
        w.line(this.expr(s.expr), src);
        break;
      case 'if': {
        w.line(`if ${this.expr(s.cond)}:`, src);
        this.block(w, s.then, graphId);
        let els = s.else;
        while (els && els.length === 1 && els[0].k === 'if') {
          const inner = els[0];
          w.line(`elif ${this.expr(inner.cond)}:`, { graphId: inner.src?.graphId ?? graphId, nodeId: inner.src?.nodeId });
          this.block(w, inner.then, graphId);
          els = inner.else;
        }
        if (els && els.length) {
          w.line('else:', src);
          this.block(w, els, graphId);
        }
        break;
      }
      case 'while':
        w.line(`while ${this.expr(s.cond)}:`, src);
        this.block(w, s.body, graphId);
        break;
      case 'for_range': {
        const fromZero = s.from.k === 'lit' && s.from.value === 0 && !s.step;
        const range = fromZero ? `range(${this.expr(s.to)})` : `range(${this.expr(s.from)}, ${this.expr(s.to)}${s.step ? `, ${this.expr(s.step)}` : ''})`;
        w.line(`for ${s.var} in ${range}:`, src);
        this.block(w, s.body, graphId);
        break;
      }
      case 'for_each':
        w.line(`for ${s.var} in ${this.expr(s.iterable)}:`, src);
        this.block(w, s.body, graphId);
        break;
      case 'match':
        w.line(`match ${this.expr(s.subject)}:`, src);
        w.indent();
        for (const arm of s.arms) {
          w.line(`${arm.values.map((v) => this.expr(v)).join(', ')}:`, src);
          this.block(w, arm.body, graphId);
        }
        if (s.default) {
          w.line('_:', src);
          this.block(w, s.default, graphId);
        }
        w.dedent();
        break;
      case 'break':
        w.line('break', src);
        break;
      case 'continue':
        w.line('continue', src);
        break;
      case 'return':
        w.line(s.value ? `return ${this.expr(s.value)}` : 'return', src);
        break;
      case 'comment':
        for (const line of s.text.split('\n')) w.line(`# ${line}`.trimEnd(), src);
        break;
      case 'lang':
        this.langStmt(w, s, src);
        break;
      default:
        throw new Error(`GDScript can't express "${s.k}"`);
    }
  }

  private langStmt(w: CodeWriter, s: Extract<IRStmt, { k: 'lang' }>, src: { graphId?: string; nodeId?: string }) {
    if (s.lang !== LANG) throw new Error(`Construct "${s.op}" belongs to language "${s.lang}"`);
    const d = s.data ?? {};
    switch (s.op) {
      case 'emit':
        w.line(`${String(d.signal)}.emit(${s.args.map((a) => this.expr(a)).join(', ')})`, src);
        return;
      case 'connect': {
        const target = s.args[0] ? `${this.primary(s.args[0])}.` : '';
        w.line(`${target}connect(${JSON.stringify(String(d.signal))}, ${String(d.method)})`, src);
        return;
      }
      case 'await_timer':
        w.line(`await get_tree().create_timer(${this.expr(s.args[0])}).timeout`, src);
        return;
      case 'await_signal': {
        const target = s.args[0] ? `${this.primary(s.args[0])}.` : '';
        w.line(`await ${target}${String(d.signal)}`, src);
        return;
      }
      default:
        throw new Error(`Unknown GDScript statement "${s.op}"`);
    }
  }

  // --- members ------------------------------------------------------------------

  field(w: CodeWriter, f: IRField) {
    if (f.doc) for (const l of f.doc.split('\n')) w.line(`## ${l}`.trimEnd());
    const onready = typeof f.attributes?.onreadyPath === 'string' && f.attributes.onreadyPath ? String(f.attributes.onreadyPath) : undefined;
    if (f.constant) {
      w.line(`const ${f.name}${annot(f.type)} = ${f.init ? this.expr(f.init) : 'null'}`);
      return;
    }
    const prefix = f.exported ? '@export ' : onready ? '@onready ' : '';
    let init = f.init ? ` = ${this.expr(f.init)}` : '';
    if (onready) {
      const ref = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(onready) ? `$${onready}` : `$${JSON.stringify(onready)}`;
      init = ` = ${ref}`;
    }
    w.line(`${prefix}var ${f.name}${annot(f.type)}${init}`);
  }

  func(w: CodeWriter, f: IRFunction) {
    if (f.doc) for (const l of f.doc.split('\n')) w.line(`## ${l}`.trimEnd());
    // Engine callbacks can't rename their parameters in the graph; prefix unused ones with "_"
    // like Godot's own templates do, which also silences UNUSED_PARAMETER warnings.
    const used = f.event ? usedNames(f.body) : undefined;
    const pname = (n: string) => (used && !used.has(n) && !n.startsWith('_') ? `_${n}` : n);
    const params = f.params.map((p) => `${pname(p.name)}${annot(p.type)}${p.default ? ` = ${this.expr(p.default)}` : ''}`).join(', ');
    const ret = f.returnType.kind === 'any' ? '' : ` -> ${f.returnType.kind === 'void' ? 'void' : gdType(f.returnType)}`;
    w.line(`func ${f.name}(${params})${ret}:`, { graphId: f.src?.graphId, nodeId: f.src?.nodeId });
    this.block(w, f.body, f.src?.graphId);
  }

  render(ctx: CompilationContext, header: string): { content: string; sourceMap: GeneratedFile['sourceMap'] } {
    const m = this.mod;
    const unit = ctx.settings.indent === 'tab' ? '\t' : ' '.repeat(ctx.settings.indentSize);
    const w = new CodeWriter(unit, m.scriptId);
    const s = m.settings;
    if (ctx.settings.header) {
      for (const l of header.split('\n')) w.line(`# ${l}`.trimEnd());
    }
    if (s.tool === true) w.line('@tool');
    if (typeof s.class_name === 'string' && s.class_name) w.line(`class_name ${s.class_name}`);
    const ext = typeof s.extends === 'string' && s.extends.trim() ? s.extends.trim() : '';
    if (ext) w.line(`extends ${ext.startsWith('res://') ? JSON.stringify(ext) : ext}`);
    if (m.doc && ctx.settings.comments) for (const l of m.doc.split('\n')) w.line(`## ${l}`.trimEnd());

    const signals = m.members.filter((x) => x.k === 'signal');
    const enums = m.members.filter((x) => x.k === 'enum');
    const fields = m.members.filter((x): x is IRField => x.k === 'field');
    const consts = fields.filter((f) => f.constant);
    const exported = fields.filter((f) => !f.constant && f.exported);
    const onready = fields.filter((f) => !f.constant && !f.exported && typeof f.attributes?.onreadyPath === 'string' && f.attributes.onreadyPath);
    const plain = fields.filter((f) => !consts.includes(f) && !exported.includes(f) && !onready.includes(f));
    const fns = m.members.filter((x): x is IRFunction => x.k === 'function');
    const events = fns.filter((f) => f.event).sort((a, b) => order(a.name) - order(b.name));
    const others = fns.filter((f) => !f.event);

    const section = (n: number) => (w.lineCount ? w.blank(n) : undefined);
    if (signals.length) {
      section(1);
      for (const sg of signals) {
        if (sg.doc && ctx.settings.comments) w.line(`## ${sg.doc}`);
        w.line(sg.params.length ? `signal ${sg.name}(${sg.params.map((p) => `${p.name}${annot(p.type)}`).join(', ')})` : `signal ${sg.name}`);
      }
    }
    if (enums.length) {
      section(1);
      for (const e of enums) w.line(`enum ${e.name} { ${e.members.map((x) => (x.value !== undefined ? `${x.name} = ${x.value}` : x.name)).join(', ')} }`);
    }
    for (const group of [consts, exported, plain, onready]) {
      if (!group.length) continue;
      section(1);
      for (const f of group) this.field(w, ctx.settings.comments ? f : { ...f, doc: undefined });
    }
    for (const f of [...events, ...others]) {
      section(2);
      this.func(w, ctx.settings.comments ? f : { ...f, doc: undefined });
    }
    if (!w.lineCount) w.line('extends RefCounted');
    return w.result();
  }
}

function usedNames(body: IRStmt[]): Set<string> {
  const out = new Set<string>();
  const visit = (e: IRExpr) => walkExpr(e, (x) => x.k === 'ref' && out.add(x.name));
  walkStmts(body, (s) => stmtExprs(s).forEach(visit));
  return out;
}

function order(name: string) {
  const i = EVENT_ORDER.indexOf(name);
  return i === -1 ? EVENT_ORDER.length : i;
}
