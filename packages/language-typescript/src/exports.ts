/**
 * A light scan of a TypeScript/JavaScript file's exported functions, for the node palette
 * ("call formatDate from src/utils.ts"). Not a parser: it handles the common forms
 *   export [async] function name(params): Ret
 *   export const name = [async] (params): Ret => …
 * and falls back to `any` for types it can't map.
 */
import { parseType } from '@cs/type-system';
import { normalize } from './types';

export interface ExportedFunction {
  name: string;
  params: { name: string; type: string; optional?: boolean }[];
  returnType: string;
  async: boolean;
  /** `export default function` (imported without braces). */
  isDefault?: boolean;
}

function canonical(tsText: string | undefined, fallback = 'any'): string {
  if (!tsText) return fallback;
  const t = tsText.trim();
  const n = normalize(t) ?? t;
  const simple: Record<string, string> = { string: 'string', any: 'any', void: 'void', bool: 'bool', float: 'float', int: 'int' };
  if (simple[n]) return simple[n];
  try {
    parseType(n);
    return n;
  } catch {
    return fallback;
  }
}

/** Index of the bracket that closes the one at `open`. */
function matching(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '<': '>', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < s.length && s[i] !== q; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c in pairs && !(c === '<' && stack.length && stack[stack.length - 1] !== '>')) stack.push(pairs[c]);
    else if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{<'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function params(text: string): ExportedFunction['params'] {
  return splitTop(text)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p, i) => {
      const noDefault = p.split('=')[0].trim();
      const m = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)(\?)?\s*(?::\s*([\s\S]+))?$/.exec(noDefault);
      if (!m) return { name: `arg${i}`, type: 'any' };
      return { name: m[1], type: canonical(m[3]), ...(m[2] || p.includes('=') ? { optional: true } : {}) };
    });
}

export function scanExports(source: string): ExportedFunction[] {
  // Drop comments so commented-out exports don't show up.
  const s = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: ExportedFunction[] = [];
  const re = /export\s+(default\s+)?(?:(async)\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(<)?|export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?(?:<[^>]*>\s*)?\(/g;
  for (const m of s.matchAll(re)) {
    let i = m.index! + m[0].length;
    const name = m[3] ?? m[5];
    const isAsync = !!(m[2] || m[6]);
    if (m[4]) {
      const end = matching(s, i - 1);
      if (end < 0) continue;
      i = end + 1;
    }
    const open = m[5] ? i - 1 : s.indexOf('(', i);
    if (open < 0) continue;
    const close = matching(s, open);
    if (close < 0) continue;
    const after = s.slice(close + 1);
    const ret = /^\s*:\s*([^{=]+?)\s*(?:\{|=>)/.exec(after);
    let returnType = canonical(ret?.[1], 'any');
    const promised = /^Promise<([\s\S]+)>$/.exec(ret?.[1]?.trim() ?? '');
    if (isAsync || promised) returnType = canonical(promised?.[1], isAsync && !ret ? 'any' : returnType);
    out.push({ name, params: params(s.slice(open + 1, close)), returnType: ret || isAsync ? returnType : 'any', async: isAsync || !!promised, ...(m[1] ? { isDefault: true } : {}) });
  }
  return out;
}
