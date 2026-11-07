/**
 * TypeScript / JavaScript printer for the IR. One printer, two output modes: `ts` (typed) and
 * `js` (same code without type annotations). Imports referenced anywhere in the module are
 * collected by the import manager and written at the top.
 */
import { stmtExprs, walkExpr, walkStmts, type IRExpr, type IRFunction, type IRModule, type IRStmt } from '@cs/intermediate-representation';
import { CodeWriter, type CompilationContext } from '@cs/language-sdk';
import type { TypeRef } from '@cs/type-system';
import { tsType } from './types';

export type OutputMode = 'ts' | 'js';

const P = { seq: 1, assign: 2, ternary: 4, nullish: 5, or: 6, and: 7, eq: 10, rel: 11, add: 13, mul: 14, unary: 15, postfix: 17, member: 18, primary: 20 };
const BIN: Record<string, [string, number]> = {
  or: ['||', P.or],
  and: ['&&', P.and],
  '==': ['===', P.eq],
  '!=': ['!==', P.eq],
  '<': ['<', P.rel],
  '<=': ['<=', P.rel],
  '>': ['>', P.rel],
  '>=': ['>=', P.rel],
  '+': ['+', P.add],
  '-': ['-', P.add],
  '*': ['*', P.mul],
  '/': ['/', P.mul],
  '%': ['%', P.mul],
};

export const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Import specifier for another script, relative to this one ("src/game/Player" → "./Player"). */
function relModule(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? '../'.repeat(up) : './'}${b.slice(i).join('/')}`;
}

/** Collects imports and hands out local names (renaming on clashes). */
export class ImportManager {
  private named = new Map<string, Map<string, string>>(); // module → imported name → local name
  private defaults = new Map<string, string>(); // module → local
  private namespaces = new Map<string, string>(); // module → local
  private sideEffects = new Set<string>(); // import './x.css';
  constructor(private readonly taken: Set<string>) {}

  /** `import 'module';` (a stylesheet, for its effect only). */
  sideEffect(module: string) {
    this.sideEffects.add(module);
  }

  private local(want: string) {
    let n = IDENT.test(want) ? want : want.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
    for (let i = 2; this.taken.has(n); i++) n = `${want}${i}`;
    this.taken.add(n);
    return n;
  }

  use(e: Extract<IRExpr, { k: 'import' }>): string {
    if (e.kind === 'default') return this.defaults.get(e.module) ?? (this.defaults.set(e.module, this.local(e.name)), this.defaults.get(e.module)!);
    if (e.kind === 'namespace') return this.namespaces.get(e.module) ?? (this.namespaces.set(e.module, this.local(e.name)), this.namespaces.get(e.module)!);
    const m = this.named.get(e.module) ?? this.named.set(e.module, new Map()).get(e.module)!;
    return m.get(e.name) ?? (m.set(e.name, this.local(e.name)), m.get(e.name)!);
  }

  lines(): string[] {
    const mods = [...new Set([...this.defaults.keys(), ...this.namespaces.keys(), ...this.named.keys()])].sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b));
    const out: string[] = [];
    for (const m of mods) {
      const q = JSON.stringify(m).replace(/^"|"$/g, "'");
      if (this.namespaces.has(m)) out.push(`import * as ${this.namespaces.get(m)} from ${q};`);
      const parts: string[] = [];
      if (this.defaults.has(m)) parts.push(this.defaults.get(m)!);
      const named = this.named.get(m);
      if (named?.size) parts.push(`{ ${[...named].map(([n, l]) => (n === l ? n : `${n} as ${l}`)).join(', ')} }`);
      if (parts.length) out.push(`import ${parts.join(', ')} from ${q};`);
    }
    for (const m of [...this.sideEffects].sort()) out.push(`import ${JSON.stringify(m).replace(/^"|"$/g, "'")};`);
    return out;
  }
}

function str(s: string) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
}

function numLit(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
  return String(v);
}

export class TSPrinter {
  readonly imports: ImportManager;
  private matchCounter = 0;
  private unit = '\t';
  /** React state in the function being printed: name → setter. */
  private states = new Map<string, string>();
  /** Class scripts: members reached through `this`, and the names local to the method being printed. */
  private readonly isClass: boolean;
  private classFields = new Set<string>();
  private classMethods = new Set<string>();
  private scope = new Set<string>();
  /** Names of enums in this module (JS mode prints them as frozen objects). */
  constructor(
    private readonly module: IRModule,
    private readonly mode: OutputMode,
  ) {
    const taken = new Set<string>(module.members.map((m) => m.name));
    for (const m of module.members) if (m.k === 'function') m.params.forEach((p) => taken.add(p.name));
    this.isClass = module.settings.kind === 'class';
    if (this.isClass) {
      taken.add(module.name);
      for (const m of module.members) {
        if (m.k === 'field') this.classFields.add(m.name);
        if (m.k === 'function') this.classMethods.add(m.name);
      }
    }
    this.imports = new ImportManager(taken);
  }

  /** Every name a function declares (params, locals, inline-function params): they shadow class members. */
  private scopeOf(f: IRFunction): Set<string> {
    const out = new Set<string>(f.params.map((p) => p.name));
    const visit = (stmts: IRStmt[]) =>
      walkStmts(stmts, (st) => {
        if (st.k === 'var') out.add(st.name);
        if (st.k === 'var_tuple') st.names.forEach((n) => out.add(n));
        if (st.k === 'for_each' || st.k === 'for_range') out.add((st as { var: string }).var);
        for (const e of stmtExprs(st))
          walkExpr(e, (x) => {
            if (x.k === 'lambda') {
              x.params.forEach((p) => out.add(p.name));
              visit(x.body);
            }
          });
      });
    visit(f.body);
    return out;
  }

  private ann(t: TypeRef | undefined): string {
    return this.mode === 'ts' && t && t.kind !== 'any' ? `: ${tsType(t)}` : '';
  }

  expr(e: IRExpr, min = 0): string {
    const [s, p] = this.exprP(e);
    return p < min ? `(${s})` : s;
  }

  private exprP(e: IRExpr): [string, number] {
    switch (e.k) {
      case 'lit': {
        const v = e.value;
        if (v === null) return ['null', P.primary];
        if (typeof v === 'boolean') return [String(v), P.primary];
        if (typeof v === 'number') {
          const s = numLit(e.type.kind === 'int' ? Math.trunc(v) : v);
          return [s, s.startsWith('-') ? P.unary : P.primary];
        }
        if (typeof v === 'string') return [str(v), P.primary];
        return [JSON.stringify(v), P.primary];
      }
      case 'ref':
        if (this.isClass && (this.classFields.has(e.name) || this.classMethods.has(e.name)) && !this.scope.has(e.name)) return [`this.${e.name}`, P.member];
        return [e.name, P.primary];
      case 'self':
        return ['this', P.primary];
      case 'null':
        return ['null', P.primary];
      case 'bin': {
        const [op, p] = BIN[e.op];
        return [`${this.expr(e.left, p)} ${op} ${this.expr(e.right, p + 1)}`, p];
      }
      case 'un':
        return [e.op === 'not' ? `!${this.expr(e.operand, P.unary)}` : `-${this.expr(e.operand, P.unary)}`, P.unary];
      case 'call':
        if (!e.target && this.isClass && this.classMethods.has(e.name) && !this.scope.has(e.name)) return [`this.${e.name}(${e.args.map((a) => this.expr(a, P.assign)).join(', ')})`, P.member];
        return [`${e.target ? `${this.expr(e.target, P.member)}.` : ''}${e.name}(${e.args.map((a) => this.expr(a, P.assign)).join(', ')})`, P.member];
      case 'builtin':
        return this.builtin(e.op, e.args);
      case 'prop':
        return [`${this.expr(e.target, P.member)}.${e.name}`, P.member];
      case 'optional_prop':
        return [`${this.expr(e.target, P.member)}?.${e.name}`, P.member];
      case 'index':
        return [`${this.expr(e.target, P.member)}[${this.expr(e.index)}]`, P.member];
      case 'new':
        if (e.callee) return [`new ${this.expr(e.callee, P.member)}(${e.args.map((a) => this.expr(a, P.assign)).join(', ')})`, P.member];
        return [`new ${this.mode === 'ts' ? tsType({ ...e.type, nullable: false }) : e.type.kind === 'named' ? e.type.name : 'Object'}(${e.args.map((a) => this.expr(a, P.assign)).join(', ')})`, P.member];
      case 'array':
        return [`[${e.items.map((a) => this.expr(a, P.assign)).join(', ')}]`, P.primary];
      case 'map':
        return [e.entries.length ? `new Map([${e.entries.map((x) => `[${this.expr(x.key, P.assign)}, ${this.expr(x.value, P.assign)}]`).join(', ')}])` : 'new Map()', P.member];
      case 'ternary':
        return [`${this.expr(e.cond, P.ternary + 1)} ? ${this.expr(e.then, P.assign)} : ${this.expr(e.else, P.assign)}`, P.ternary];
      case 'cast':
        return this.mode === 'ts' ? [`${this.expr(e.expr, P.rel + 1)} as ${tsType(e.type)}`, P.rel] : this.exprP(e.expr);
      case 'instanceof':
        if (e.type.kind === 'string') return [`typeof ${this.expr(e.expr, P.unary)} === 'string'`, P.eq];
        if (e.type.kind === 'int' || e.type.kind === 'float') return [`typeof ${this.expr(e.expr, P.unary)} === 'number'`, P.eq];
        if (e.type.kind === 'bool') return [`typeof ${this.expr(e.expr, P.unary)} === 'boolean'`, P.eq];
        if (e.type.kind === 'array') return [`Array.isArray(${this.expr(e.expr)})`, P.member];
        return [`${this.expr(e.expr, P.rel + 1)} instanceof ${e.type.kind === 'named' ? e.type.name : e.type.kind === 'map' ? 'Map' : 'Object'}`, P.rel];
      case 'enum':
        return [`${e.enumName}.${e.member}`, P.member];
      case 'await':
        return [`await ${this.expr(e.expr, P.unary)}`, P.unary];
      case 'template': {
        const body = e.parts.map((p) => (typeof p === 'string' ? p.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') : `\${${this.expr(p)}}`)).join('');
        return [`\`${body}\``, P.primary];
      }
      case 'object':
        if (!e.entries.length) return ['{}', P.primary];
        return [`{ ${e.entries.map((x) => (x.value.k === 'ref' && x.value.name === x.key ? x.key : `${IDENT.test(x.key) ? x.key : str(x.key)}: ${this.expr(x.value, P.assign)}`)).join(', ')} }`, P.primary];
      case 'import':
        return [this.imports.use(e), P.primary];
      case 'func_ref':
        return [e.name, P.primary];
      case 'lambda': {
        const params = e.params.map((p) => `${p.name}${this.ann(p.type) || (this.mode === 'ts' ? ': any' : '')}`).join(', ');
        const ret = this.mode === 'ts' ? `: ${e.isAsync ? `Promise<${tsType(e.returnType)}>` : tsType(e.returnType)}` : '';
        const w = new CodeWriter(this.unit, this.module.scriptId);
        w.indent();
        for (const s of e.body) this.stmt(w, s, e.src?.graphId);
        const inner = w.result().content.replace(/\n$/, '');
        return [`${e.isAsync ? 'async ' : ''}(${params})${ret} => {${e.body.length ? `\n${inner}\n` : ''}}`, P.assign];
      }
      case 'jsx':
        return [this.jsx(e), P.primary];
      case 'invoke':
        return [`${this.expr(e.callee, P.member)}(${e.args.map((a) => this.expr(a, P.assign)).join(', ')})`, P.member];
      case 'lang':
        if (e.lang === 'typescript' && e.op === 'nullish') return [`${this.expr(e.args[0], P.nullish + 1)} ?? ${this.expr(e.args[1], P.nullish + 1)}`, P.nullish];
        throw new Error(`TypeScript can't express "${e.lang}.${e.op}"`);
    }
  }

  private builtin(op: string, a: IRExpr[]): [string, number] {
    const x = (i: number, min = P.assign) => this.expr(a[i], min);
    const m = (i: number) => this.expr(a[i], P.member);
    const call = (s: string): [string, number] => [s, P.member];
    switch (op) {
      case 'print':
        return call(`console.log(${a.map((_, i) => x(i)).join(', ')})`);
      case 'to_string':
        return call(`String(${x(0)})`);
      case 'to_int':
        return call(`Math.trunc(Number(${x(0)}))`);
      case 'to_float':
        return call(`Number(${x(0)})`);
      case 'to_bool':
        return call(`Boolean(${x(0)})`);
      case 'abs':
      case 'min':
      case 'max':
      case 'pow':
      case 'sqrt':
      case 'floor':
      case 'ceil':
      case 'round':
      case 'sin':
      case 'cos':
        return call(`Math.${op}(${a.map((_, i) => x(i)).join(', ')})`);
      case 'clamp':
        return call(`Math.min(Math.max(${x(0)}, ${x(1)}), ${x(2)})`);
      case 'lerp':
        return [`${x(0, P.add)} + (${x(1, P.add)} - ${x(0, P.add + 1)}) * ${x(2, P.mul + 1)}`, P.add];
      case 'random_float':
        return call('Math.random()');
      case 'random_int_range':
        return [`Math.floor(Math.random() * (${x(1, P.add)} - ${x(0, P.add + 1)} + 1)) + ${x(0, P.add + 1)}`, P.add];
      case 'str_length':
      case 'array_length':
        return [`${m(0)}.length`, P.member];
      case 'str_upper':
        return call(`${m(0)}.toUpperCase()`);
      case 'str_lower':
        return call(`${m(0)}.toLowerCase()`);
      case 'str_contains':
      case 'array_contains':
        return call(`${m(0)}.includes(${x(1)})`);
      case 'str_substring':
        return call(a.length > 2 ? `${m(0)}.slice(${x(1)}, ${x(1, P.add)} + ${x(2, P.add + 1)})` : `${m(0)}.slice(${x(1)})`);
      case 'str_concat':
        return [a.map((_, i) => x(i, i === 0 ? P.add : P.add + 1)).join(' + '), P.add];
      case 'array_append':
        return call(`${m(0)}.push(${x(1)})`);
      case 'array_remove_at':
        return call(`${m(0)}.splice(${x(1)}, 1)`);
      case 'array_clear':
        return call(`${m(0)}.splice(0)`);
      case 'map_has':
        return call(`${m(0)}.has(${x(1)})`);
      case 'map_get':
        return a.length > 2 ? [`${m(0)}.get(${x(1)}) ?? ${x(2, P.nullish + 1)}`, P.nullish] : call(`${m(0)}.get(${x(1)})`);
      case 'map_set':
        return call(`${m(0)}.set(${x(1)}, ${x(2)})`);
      case 'map_keys':
        return [`[...${m(0)}.keys()]`, P.primary];
      case 'map_size':
        return [`${m(0)}.size`, P.member];
      case 'map_erase':
        return call(`${m(0)}.delete(${x(1)})`);
    }
    throw new Error(`TypeScript: built-in "${op}" is not supported`);
  }

  block(w: CodeWriter, body: IRStmt[], graphId?: string) {
    w.indent();
    for (const s of body) this.stmt(w, s, graphId);
    w.dedent();
  }

  stmt(w: CodeWriter, s: IRStmt, graphId?: string) {
    const src = { graphId: s.src?.graphId ?? graphId, nodeId: s.src?.nodeId };
    switch (s.k) {
      case 'var':
        w.line(`${s.constant ? 'const' : 'let'} ${s.name}${s.init && s.init.k === 'lit' && s.type?.kind !== 'map' && s.type?.kind !== 'array' ? '' : this.ann(s.type)}${s.init ? ` = ${this.expr(s.init, P.assign)}` : ''};`, src);
        break;
      case 'assign': {
        const setter = s.target.k === 'ref' ? this.states.get(s.target.name) : undefined;
        if (setter) {
          const v = s.op ? { k: 'bin' as const, op: s.op, left: s.target, right: s.value } : s.value;
          w.line(`${setter}(${this.expr(v, P.assign)});`, src);
          break;
        }
        w.line(`${this.expr(s.target, P.member)} ${s.op ?? ''}= ${this.expr(s.value, P.assign)};`, src);
        break;
      }
      case 'expr':
        w.line(`${this.expr(s.expr)};`, src);
        break;
      case 'if': {
        w.line(`if (${this.expr(s.cond)}) {`, src);
        this.block(w, s.then, graphId);
        let els = s.else;
        while (els && els.length === 1 && els[0].k === 'if') {
          const e = els[0];
          w.line(`} else if (${this.expr(e.cond)}) {`, { graphId: e.src?.graphId ?? graphId, nodeId: e.src?.nodeId });
          this.block(w, e.then, graphId);
          els = e.else;
        }
        if (els?.length) {
          w.line('} else {');
          this.block(w, els, graphId);
        }
        w.line('}');
        break;
      }
      case 'while':
        w.line(`while (${this.expr(s.cond)}) {`, src);
        this.block(w, s.body, graphId);
        w.line('}');
        break;
      case 'for_range': {
        // Counting down needs ">"; only knowable for literal / negated steps (as in GDScript's range).
        const neg = !!s.step && ((s.step.k === 'lit' && typeof s.step.value === 'number' && s.step.value < 0) || (s.step.k === 'un' && s.step.op === 'neg'));
        const step = !s.step || (s.step.k === 'lit' && s.step.value === 1) ? `${s.var}++` : `${s.var} += ${this.expr(s.step, P.assign)}`;
        w.line(`for (let ${s.var} = ${this.expr(s.from, P.assign)}; ${s.var} ${neg ? '>' : '<'} ${this.expr(s.to, P.rel + 1)}; ${step}) {`, src);
        this.block(w, s.body, graphId);
        w.line('}');
        break;
      }
      case 'for_each':
        w.line(`for (const ${s.var} of ${this.expr(s.iterable, P.assign)}) {`, src);
        this.block(w, s.body, graphId);
        w.line('}');
        break;
      case 'match': {
        // if / else-if rather than switch: `break` inside a match arm must still leave the loop.
        let subject = s.subject;
        if (s.subject.k !== 'ref' && s.subject.k !== 'lit') {
          const name = `match${this.matchCounter++ || ''}`;
          w.line(`const ${name} = ${this.expr(s.subject, P.assign)};`, src);
          subject = { k: 'ref', name };
        }
        const cond = (vals: IRExpr[]) => vals.map((v) => `${this.expr(subject, P.eq + 1)} === ${this.expr(v, P.eq + 1)}`).join(' || ');
        s.arms.forEach((arm, i) => {
          w.line(`${i ? '} else ' : ''}if (${cond(arm.values)}) {`, i ? undefined : src);
          this.block(w, arm.body, graphId);
        });
        if (s.default?.length) {
          w.line(s.arms.length ? '} else {' : '{');
          this.block(w, s.default, graphId);
        }
        if (s.arms.length || s.default?.length) w.line('}');
        break;
      }
      case 'break':
        w.line('break;', src);
        break;
      case 'continue':
        w.line('continue;', src);
        break;
      case 'return': {
        const v = s.value ? this.expr(s.value) : '';
        // Multi-line JSX is returned in parentheses, as people write it.
        w.line(!s.value ? 'return;' : v.includes('\n') ? `return (\n${this.unit}${v.split('\n').join(`\n${this.unit}`)}\n);` : `return ${v};`, src);
        break;
      }
      case 'comment':
        for (const line of s.text.split('\n')) w.line(`// ${line}`.trimEnd(), src);
        break;
      case 'try':
        w.line('try {', src);
        this.block(w, s.body, graphId);
        if (s.handler || !s.finally) {
          // `any`, so graphs can read .message and friends from whatever was thrown.
          w.line(s.catchVar ? `} catch (${s.catchVar}${this.mode === 'ts' ? ': any' : ''}) {` : '} catch {');
          this.block(w, s.handler ?? [], graphId);
        }
        if (s.finally) {
          w.line('} finally {');
          this.block(w, s.finally, graphId);
        }
        w.line('}');
        break;
      case 'throw':
        w.line(`throw ${this.expr(s.value)};`, src);
        break;
      case 'var_tuple':
        w.line(`${s.constant ? 'const' : 'let'} [${s.names.join(', ')}] = ${this.expr(s.init, P.assign)};`, src);
        break;
      case 'lang':
        throw new Error(`TypeScript can't express "${s.lang}.${s.op}"`);
    }
  }

  fn(w: CodeWriter, f: IRFunction, comments: boolean) {
    const src = { graphId: f.src?.graphId, nodeId: f.src?.nodeId };
    if (comments && f.doc) this.doc(w, f.doc);
    // Components: one destructured props object; the return type (JSX) is inferred.
    const ret = f.component ? '' : this.mode === 'ts' ? `: ${f.isAsync ? `Promise<${tsType(f.returnType)}>` : tsType(f.returnType)}` : '';
    const params = f.component
      ? f.params.length
        ? `{ ${f.params.map((p) => `${p.name}${p.default ? ` = ${this.expr(p.default, P.assign)}` : ''}`).join(', ')} }${this.mode === 'ts' ? `: { ${f.params.map((p) => `${p.name}${p.default ? '?' : ''}: ${tsType(p.type)}`).join('; ')} }` : ''}`
        : ''
      : f.params.map((p) => `${p.name}${this.ann(p.type) || (this.mode === 'ts' ? ': any' : '')}${p.default ? ` = ${this.expr(p.default, P.assign)}` : ''}`).join(', ');
    const scopeBefore = this.scope;
    if (this.isClass) this.scope = this.scopeOf(f);
    if (this.isClass) w.line(f.name === 'constructor' ? `constructor(${params}) {` : `${f.isAsync ? 'async ' : ''}${f.name}(${params})${ret} {`, src);
    else w.line(`${f.exported ? 'export ' : ''}${f.isAsync ? 'async ' : ''}function ${f.name}(${params})${ret} {`, src);
    const before = this.states;
    this.states = new Map(before);
    for (const s of f.body) if (s.k === 'var_tuple' && s.init.k === 'invoke' && s.init.callee.k === 'import' && s.init.callee.name === 'useState' && s.names.length === 2) this.states.set(s.names[0], s.names[1]);
    this.block(w, f.body, f.src?.graphId);
    this.states = before;
    this.scope = scopeBefore;
    w.line('}');
  }

  /** JSX text: one line when short, else children on their own lines. */
  private jsx(e: Extract<IRExpr, { k: 'jsx' }>): string {
    const tag = typeof e.tag === 'string' ? e.tag : this.expr(e.tag, P.member);
    const attrs = e.attrs
      .map((a) => {
        if (a.value.k === 'lit' && typeof a.value.value === 'string' && !/["\n{}]/.test(a.value.value)) return `${a.name}="${a.value.value}"`;
        if (a.value.k === 'lit' && a.value.value === true) return a.name;
        return `${a.name}={${this.expr(a.value, P.assign)}}`;
      })
      .join(' ');
    const open = `<${tag}${attrs ? ` ${attrs}` : ''}`;
    const kids = e.children.map((c) => {
      if (c.k === 'lit' && typeof c.value === 'string') return /[{}<>]/.test(c.value) || c.value !== c.value.trim() || !c.value ? `{${str(c.value)}}` : c.value;
      if (c.k === 'jsx') return this.jsx(c);
      return `{${this.expr(c, P.assign)}}`;
    });
    if (!kids.length) return `${open} />`;
    const one = `${open}>${kids.join('')}</${tag}>`;
    if (one.length <= 80 && !kids.some((k) => k.includes('\n')) && kids.length <= 2) return one;
    return `${open}>\n${kids.map((k) => `${this.unit}${k.split('\n').join(`\n${this.unit}`)}`).join('\n')}\n</${tag}>`;
  }

  /** CSS the module's elements need (animations): written next to it and imported. */
  css(): string {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of this.module.members) {
      if (m.k !== 'function') continue;
      walkStmts(m.body, (st) =>
        stmtExprs(st).forEach((x) =>
          walkExpr(x, (y) => {
            if (y.k === 'jsx' && y.css)
              for (const c of y.css) {
                if (seen.has(c)) continue;
                seen.add(c);
                out.push(c);
              }
          }),
        ),
      );
    }
    return out.join('\n\n');
  }

  /** Whether the module contains JSX (written to .tsx / .jsx). */
  usesJsx(): boolean {
    let found = false;
    for (const m of this.module.members) {
      if (m.k !== 'function') continue;
      if (m.component) found = true;
      walkStmts(m.body, (s) => stmtExprs(s).forEach((x) => walkExpr(x, (y) => void (y.k === 'jsx' && (found = true)))));
    }
    return found;
  }

  doc(w: CodeWriter, text: string) {
    const lines = text.split('\n');
    if (lines.length === 1) w.line(`/** ${lines[0]} */`);
    else {
      w.line('/**');
      lines.forEach((l) => w.line(` * ${l}`.trimEnd()));
      w.line(' */');
    }
  }

  render(ctx: CompilationContext, header: string): ReturnType<CodeWriter['result']> {
    const unit = ctx.settings.indent === 'tab' ? '\t' : ' '.repeat(ctx.settings.indentSize);
    this.unit = unit;
    if (this.css()) this.imports.sideEffect(`./${this.module.path.split('/').pop()}.anim.css`);
    // Print the body first, so the import manager knows every import before the header is written.
    const body = new CodeWriter(unit, this.module.scriptId);
    const { members } = this.module;
    const comments = ctx.settings.comments;
    for (const m of members) {
      if (m.k === 'enum') {
        body.blank();
        if (comments) body.line(`// ${m.name}`);
        if (this.mode === 'ts') {
          body.line(`export enum ${m.name} {`);
          body.indent();
          m.members.forEach((x) => body.line(`${x.name}${x.value !== undefined ? ` = ${x.value}` : ''},`));
          body.dedent();
          body.line('}');
        } else {
          let next = 0;
          const entries = m.members.map((x) => {
            const v = x.value ?? next;
            next = v + 1;
            return `${x.name}: ${v}`;
          });
          body.line(`export const ${m.name} = Object.freeze({ ${entries.join(', ')} });`);
        }
      }
    }
    for (const m of members) {
      if (m.k !== 'interface') continue;
      body.blank();
      if (this.mode === 'js') {
        if (comments) body.line(`// type ${m.name}: { ${m.fields.map((f) => `${f.name}${f.optional ? '?' : ''}`).join(', ')} }`);
        continue;
      }
      if (comments && m.doc) this.doc(body, m.doc);
      body.line(`${m.exported ? 'export ' : ''}interface ${m.name} {`, m.src);
      body.indent();
      for (const f of m.fields) {
        if (comments && f.doc) this.doc(body, f.doc);
        body.line(`${IDENT.test(f.name) ? f.name : str(f.name)}${f.optional ? '?' : ''}: ${tsType(f.type)};`);
      }
      body.dedent();
      body.line('}');
    }
    if (this.isClass) {
      this.classBody(body, comments);
      return this.finish(ctx, header, body);
    }
    const fields = members.filter((m) => m.k === 'field');
    if (fields.length) body.blank();
    for (const f of fields) {
      if (f.k !== 'field') continue;
      if (comments && f.doc) this.doc(body, f.doc);
      const init = f.init ? ` = ${this.expr(f.init, P.assign)}` : '';
      body.line(`${f.exported ? 'export ' : ''}${f.constant ? 'const' : 'let'} ${f.name}${this.ann(f.type)}${init};`, f.src);
    }
    for (const m of members) {
      if (m.k !== 'function') continue;
      body.blank();
      this.fn(body, m, comments);
    }
    return this.finish(ctx, header, body);
  }

  /** class Name extends Base { fields; constructor; methods } */
  private classBody(body: CodeWriter, comments: boolean) {
    const st = this.module.settings;
    const ext = typeof st.extends === 'string' ? st.extends.trim() : '';
    const from = typeof st.extendsFrom === 'string' ? st.extendsFrom.trim() : '';
    let base = ext;
    if (ext && from) {
      const [root, ...rest] = ext.split('.');
      // A package: Phaser.Scene → import * as Phaser from 'phaser'; Enemy → import { Enemy } from 'pkg'.
      // A script path (src/Enemy): import { Enemy } from './Enemy'.
      const isScript = from.startsWith('.') || from.startsWith('src/') || from.includes('/') && !from.startsWith('@');
      const module = isScript ? relModule(this.module.path, from.replace(/\.(tsx?|vgraph)$/, '')) : from;
      const local = this.imports.use(rest.length ? { k: 'import', kind: 'namespace', module, name: root } : { k: 'import', kind: 'named', module, name: root });
      base = [local, ...rest].join('.');
    }
    body.blank();
    if (comments && this.module.doc) this.doc(body, this.module.doc);
    body.line(`export class ${this.module.name}${base ? ` extends ${base}` : ''} {`);
    body.indent();
    const fields = this.module.members.filter((m) => m.k === 'field');
    for (const f of fields) {
      if (f.k !== 'field') continue;
      if (comments && f.doc) this.doc(body, f.doc);
      const init = f.init ? ` = ${this.expr(f.init, P.assign)}` : '';
      // Without a starting value a typed field is filled in later (e.g. in create()): `!` says so.
      const bang = !f.init && this.mode === 'ts' && f.type && f.type.kind !== 'any' ? '!' : '';
      // Class fields need a type under strict TypeScript (untyped = implicit any error).
      const ann = this.ann(f.type) || (this.mode === 'ts' ? ': any' : '');
      body.line(`${f.constant ? 'readonly ' : ''}${f.name}${bang}${ann}${init};`, f.src);
    }
    const fns = this.module.members.filter((m): m is IRFunction => m.k === 'function');
    for (const m of [...fns.filter((x) => x.name === 'constructor'), ...fns.filter((x) => x.name !== 'constructor')]) {
      body.blank();
      this.fn(body, m, comments);
    }
    body.dedent();
    body.line('}');
  }

  private finish(ctx: CompilationContext, header: string, body: CodeWriter): ReturnType<CodeWriter['result']> {
    const b = body.result();
    // Header + imports, then the body shifted by that many lines in the source map.
    const head: string[] = [];
    if (ctx.settings.header) head.push(...header.split('\n').map((l) => `// ${l}`));
    if (this.module.doc && ctx.settings.comments && !this.isClass) head.push(...this.module.doc.split('\n').map((l) => `// ${l}`));
    const imports = this.imports.lines();
    if (imports.length) {
      if (head.length) head.push('');
      head.push(...imports);
    }
    if (head.length && b.content.trim()) head.push('');
    const offset = head.length;
    return { content: `${head.join('\n')}${head.length ? '\n' : ''}${b.content}`, sourceMap: b.sourceMap.map((e) => ({ ...e, line: e.line + offset })) };
  }
}

export type { TypeRef };
