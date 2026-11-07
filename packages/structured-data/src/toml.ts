/**
 * TOML: line-level edits so comments and layout survive (mods.toml files are full of comments).
 * Each edit is applied to the text directly when it maps onto `key = value` lines and table
 * headers; the result is re-parsed and compared with the expected value, and only if that fails
 * does it fall back to re-serialising the whole document.
 */
import { parse, stringify, TomlError } from 'smol-toml';
import { applyToValue, canonical, getIn, isObject, type Edit, type Path, type Value } from './model';

export function parseToml(text: string): { value?: Value; errors: { message: string; line: number }[] } {
  try {
    return { value: text.trim() ? (parse(text) as unknown as Value) : undefined, errors: [] };
  } catch (e) {
    return { errors: [{ message: (e instanceof Error ? e.message : String(e)).split('\n')[0], line: e instanceof TomlError ? e.line : 1 }] };
  }
}

const BARE = /^[A-Za-z0-9_-]+$/;
const keyText = (k: string) => (BARE.test(k) ? k : JSON.stringify(k));

/** Inline TOML for a value (`"x"`, `1`, `["a", "b"]`, `{ a = 1 }`). */
export function tomlInline(v: Value): string {
  if (v === null) return '""';
  if (Array.isArray(v)) return `[${v.map(tomlInline).join(', ')}]`;
  if (isObject(v)) return `{ ${Object.entries(v).map(([k, x]) => `${keyText(k)} = ${tomlInline(x)}`).join(', ')} }`;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

interface Line {
  text: string;
  /** [table path] for headers; key for key lines */
  header?: { path: Path; array: boolean };
  key?: string;
}

function splitHeaderPath(inner: string): string[] {
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(\.|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) && m[0]) out.push(m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].replace(/^'|'$/g, ''));
  return out;
}

function scan(text: string): Line[] {
  const lines = text.split('\n');
  const counts = new Map<string, number>();
  let multiline = false;
  return lines.map((t) => {
    if (multiline) {
      if (/"""|'''/.test(t)) multiline = false;
      return { text: t };
    }
    const h = /^\s*(\[\[?)([^\]]+)\]\]?\s*(#.*)?$/.exec(t);
    if (h) {
      const names = splitHeaderPath(h[2]);
      const array = h[1] === '[[';
      if (array) {
        const id = names.join('\u0000');
        const n = counts.get(id) ?? 0;
        counts.set(id, n + 1);
        return { text: t, header: { path: [...names, n], array } };
      }
      return { text: t, header: { path: names, array } };
    }
    const k = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(t);
    if (k) {
      if (/^("""|''')/.test(k[2]) && !/("""|''')[^]*("""|''')/.test(k[2])) multiline = true;
      return { text: t, key: k[1].startsWith('"') ? JSON.parse(k[1]) : k[1] };
    }
    return { text: t };
  });
}

/** Line indexes [start, end) of the table at `path` ([] = top level). */
function section(lines: Line[], path: Path): [number, number] | null {
  const same = (a: Path, b: Path) => a.length === b.length && a.every((s, i) => String(s) === String(b[i]));
  let start = 0;
  if (path.length) {
    const i = lines.findIndex((l) => l.header && same(l.header.path, path));
    if (i < 0) return null;
    start = i + 1;
  }
  let end = start;
  while (end < lines.length && !lines[end].header) end++;
  return [start, end];
}

function tryEdit(text: string, e: Edit, root: Value): string | null {
  const lines = scan(text);
  const join = (ls: Line[]) => ls.map((l) => l.text).join('\n');
  if (e.op === 'set' || e.op === 'delete') {
    const parent = e.path.slice(0, -1);
    const key = e.path[e.path.length - 1];
    // Whole table / array-of-tables element.
    if (e.op === 'delete') {
      const h = lines.findIndex((l) => l.header && l.header.path.length === e.path.length && l.header.path.every((s, i) => String(s) === String(e.path[i])));
      if (h >= 0) {
        let end = h + 1;
        while (end < lines.length && !lines[end].header) end++;
        while (h > 0 && end < lines.length && lines[end - 1].text.trim() === '' && end - 1 > h) end--;
        return join([...lines.slice(0, h), ...lines.slice(end)]);
      }
    }
    if (typeof key !== 'string') return null;
    const sec = section(lines, parent);
    if (!sec) {
      if (e.op === 'delete') return null;
      // A new table: append it at the end, unless the parent is an inline value.
      if (getIn(root, parent) !== undefined || parent.some((s) => typeof s === 'number')) return null;
      if (isObject(e.value) || (Array.isArray(e.value) && e.value.every(isObject) && e.value.length)) return null;
      const sep = text.endsWith('\n') || !text ? '' : '\n';
      return `${text}${sep}\n[${parent.map((s) => keyText(String(s))).join('.')}]\n${keyText(key)} = ${tomlInline(e.value)}\n`;
    }
    const at = lines.slice(sec[0], sec[1]).findIndex((l) => l.key === key);
    if (e.op === 'delete') return at < 0 ? null : join(lines.filter((_, i) => i !== sec[0] + at));
    if (isObject(e.value) && Object.values(e.value).some((v) => isObject(v) || Array.isArray(v))) return null;
    if (at >= 0) {
      const l = lines[sec[0] + at];
      const m = /^(\s*(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*)(.*?)(\s+#.*)?$/.exec(l.text);
      if (!m) return null;
      l.text = `${m[1]}${tomlInline(e.value)}${m[3] ?? ''}`;
      return join(lines);
    }
    // New key: after the last key line of the section.
    let insertAt = sec[0];
    for (let i = sec[0]; i < sec[1]; i++) if (lines[i].key) insertAt = i + 1;
    if (insertAt === sec[0] && sec[0] > 0) insertAt = sec[0];
    const out = [...lines];
    out.splice(insertAt, 0, { text: `${keyText(key)} = ${tomlInline(e.value)}` });
    return join(out);
  }
  if (e.op === 'rename') {
    const sec = section(lines, e.path.slice(0, -1));
    const key = e.path[e.path.length - 1];
    if (!sec || typeof key !== 'string') return null;
    const at = lines.slice(sec[0], sec[1]).findIndex((l) => l.key === key);
    if (at < 0) return null;
    const l = lines[sec[0] + at];
    l.text = l.text.replace(/^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)/, (_m, sp: string) => `${sp}${keyText(e.to)}`);
    return join(lines);
  }
  if (e.op === 'insert') {
    const arr = getIn(root, e.path);
    // Array of tables: add a [[header]] block at the end of the last one.
    if (Array.isArray(arr) && isObject(e.value) && (e.index === undefined || e.index === arr.length) && arr.length && arr.every(isObject)) {
      const blocks = lines.map((l, i) => (l.header?.array && l.header.path.length === e.path.length + 1 && e.path.every((s, j) => String(s) === String(l.header!.path[j])) ? i : -1)).filter((i) => i >= 0);
      if (!blocks.length || Object.values(e.value).some((v) => isObject(v))) return null;
      let end = blocks[blocks.length - 1] + 1;
      while (end < lines.length && !lines[end].header) end++;
      const block = [{ text: `[[${e.path.map((s) => keyText(String(s))).join('.')}]]` }, ...Object.entries(e.value).map(([k, v]) => ({ text: `${keyText(k)} = ${tomlInline(v)}` })), { text: '' }];
      const out = [...lines];
      out.splice(end, 0, ...block);
      return join(out);
    }
    return null;
  }
  return null;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function editToml(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of edits) {
    const before = (parseToml(out).value ?? {}) as Value;
    const want = applyToValue(before, [e]);
    const attempt = tryEdit(out, e, before);
    if (attempt !== null && equal(parseToml(attempt).value ?? {}, want)) out = attempt;
    else out = stringify(want as Record<string, unknown>);
  }
  return out;
}
