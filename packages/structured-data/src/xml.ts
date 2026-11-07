/**
 * XML (pom.xml, AndroidManifest, .csproj…): a small parser that keeps every node's position, so
 * edits splice only the affected element or attribute and comments/formatting elsewhere survive.
 *
 * The editors see a projection: an element with only text is a string; otherwise an object whose
 * keys are "@attribute", child element names (an array when a name repeats) and "#text".
 */
import { applyToValue, canonical, isObject, type Edit, type Path, type Value } from './model';

export interface XmlElement {
  name: string;
  attrs: { name: string; value: string; start: number; end: number }[];
  children: XmlElement[];
  text: string;
  start: number;
  /** end of the start tag */
  openEnd: number;
  /** start of the end tag (= openEnd for self-closing) */
  closeStart: number;
  end: number;
  selfClosing: boolean;
}

export class XmlError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

const unescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase()] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeXml(s).replace(/"/g, '&quot;');

export function parseXmlTree(text: string): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const fail = (m: string): never => {
    throw new XmlError(m, i);
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (stack.length) stack[stack.length - 1].text += unescape(text.slice(i));
      break;
    }
    if (lt > i && stack.length) stack[stack.length - 1].text += unescape(text.slice(i, lt));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i);
      if (e < 0) fail('Unclosed comment');
      i = e + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i);
      if (e < 0) fail('Unclosed CDATA');
      if (stack.length) stack[stack.length - 1].text += text.slice(i + 9, e);
      i = e + 3;
    } else if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i);
      if (e < 0) fail('Unclosed processing instruction');
      i = e + 2;
    } else if (text.startsWith('<!', i)) {
      const e = text.indexOf('>', i);
      if (e < 0) fail('Unclosed declaration');
      i = e + 1;
    } else if (text.startsWith('</', i)) {
      const m = /^<\/([^\s>]+)\s*>/.exec(text.slice(i, i + 300));
      if (!m) fail('Malformed end tag');
      const el = stack.pop();
      if (!el || el.name !== m![1]) fail(`Unexpected </${m![1]}>${el ? ` (expected </${el.name}>)` : ''}`);
      el!.closeStart = i;
      el!.end = i + m![0].length;
      i = el!.end;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 300));
      if (!m) fail('Malformed tag');
      const el: XmlElement = { name: m![1], attrs: [], children: [], text: '', start: i, openEnd: 0, closeStart: 0, end: 0, selfClosing: false };
      let j = i + m![0].length;
      const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?>)/y;
      for (;;) {
        attrRe.lastIndex = j;
        const a = attrRe.exec(text);
        if (!a) fail(`Malformed attributes in <${el.name}>`);
        if (a![5]) {
          el.selfClosing = a![5] === '/>';
          j = attrRe.lastIndex;
          break;
        }
        const start = a!.index + a![0].length - a![0].trimStart().length;
        el.attrs.push({ name: a![1], value: unescape(a![3] ?? a![4] ?? ''), start, end: attrRe.lastIndex });
        j = attrRe.lastIndex;
      }
      el.openEnd = j;
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) fail('More than one root element');
      else root = el;
      if (el.selfClosing) {
        el.closeStart = j;
        el.end = j;
      } else stack.push(el);
      i = j;
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].name}> is never closed`, text.length);
  if (!root) throw new XmlError('No root element', 0);
  return root;
}

export function project(el: XmlElement): Value {
  if (!el.attrs.length && !el.children.length) return el.text.trim();
  const o: { [k: string]: Value } = {};
  for (const a of el.attrs) o[`@${a.name}`] = a.value;
  const groups = new Map<string, XmlElement[]>();
  for (const c of el.children) groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
  for (const [n, cs] of groups) o[n] = cs.length > 1 ? cs.map(project) : project(cs[0]);
  if (el.text.trim() && el.children.length) o['#text'] = el.text.trim();
  else if (el.text.trim()) o['#text'] = el.text.trim();
  return o;
}

export function parseXml(text: string): { value?: Value; errors: { message: string; line: number }[] } {
  if (!text.trim()) return { errors: [] };
  try {
    const root = parseXmlTree(text);
    return { value: { [root.name]: project(root) }, errors: [] };
  } catch (e) {
    const off = e instanceof XmlError ? e.offset : 0;
    return { errors: [{ message: e instanceof Error ? e.message : String(e), line: text.slice(0, off).split('\n').length }] };
  }
}

/** XML text for a projected value. */
export function toXml(name: string, v: Value, indent = '', step = '  '): string {
  if (Array.isArray(v)) return v.map((x) => toXml(name, x, indent, step)).join('\n');
  if (!isObject(v)) return `${indent}<${name}>${escapeXml(v === null ? '' : String(v))}</${name}>`;
  const attrs = Object.entries(v).filter(([k]) => k.startsWith('@')).map(([k, x]) => ` ${k.slice(1)}="${escapeAttr(String(x ?? ''))}"`).join('');
  const kids = Object.entries(v).filter(([k]) => !k.startsWith('@') && k !== '#text');
  const text = v['#text'];
  if (!kids.length) return text === undefined ? `${indent}<${name}${attrs}/>` : `${indent}<${name}${attrs}>${escapeXml(String(text))}</${name}>`;
  return `${indent}<${name}${attrs}>\n${kids.map(([k, x]) => toXml(k, x, indent + step, step)).join('\n')}\n${indent}</${name}>`;
}

function locate(root: XmlElement, path: Path): { el?: XmlElement; parent?: XmlElement; name?: string; index?: number } {
  if (path[0] !== root.name) return {};
  let el: XmlElement = root;
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg !== 'string' || seg.startsWith('@') || seg === '#text') return { parent: el, name: String(seg) };
    const next = path[i + 1];
    const same = el.children.filter((c) => c.name === seg);
    const idx = typeof next === 'number' ? next : 0;
    if (typeof next === 'number') i++;
    const found = same[idx];
    if (!found) return i === path.length - 1 ? { parent: el, name: seg, index: idx } : {};
    el = found;
  }
  return { el };
}

const lineIndent = (text: string, at: number) => /[ \t]*$/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1, at))?.[0] ?? '';
const stepOf = (text: string) => /\n([ \t]+)</.exec(text)?.[1] ?? '  ';

function appendChild(text: string, parent: XmlElement, xml: string): string {
  const step = stepOf(text);
  const ind = lineIndent(text, parent.start);
  if (parent.selfClosing) {
    const open = text.slice(parent.start, parent.end).replace(/\s*\/>$/, '>');
    return `${text.slice(0, parent.start)}${open}\n${xml}\n${ind}</${parent.name}>${text.slice(parent.end)}`;
  }
  if (!parent.children.length && !parent.text.trim()) return `${text.slice(0, parent.openEnd)}\n${xml}\n${ind}${text.slice(parent.closeStart)}`;
  const last = parent.children[parent.children.length - 1];
  const at = last ? last.end : parent.closeStart;
  void step;
  return `${text.slice(0, at)}\n${xml}${text.slice(at)}`;
}

function removeRange(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf('\n', start - 1);
  const before = text.slice(lineStart + 1, start);
  if (/^[ \t]*$/.test(before) && lineStart >= 0) return text.slice(0, lineStart) + text.slice(end);
  return text.slice(0, start) + text.slice(end);
}

function tryEdit(text: string, e: Edit): string | null {
  const root = parseXmlTree(text);
  const step = stepOf(text);
  if (e.op === 'set') {
    const loc = locate(root, e.path);
    const last = e.path[e.path.length - 1];
    const scalar = e.value === null || typeof e.value !== 'object';
    if (loc.el) {
      if (scalar && !loc.el.children.length) {
        if (loc.el.selfClosing) return `${text.slice(0, loc.el.start)}${text.slice(loc.el.start, loc.el.end).replace(/\s*\/>$/, '>')}${escapeXml(String(e.value ?? ''))}</${loc.el.name}>${text.slice(loc.el.end)}`;
        return text.slice(0, loc.el.openEnd) + escapeXml(String(e.value ?? '')) + text.slice(loc.el.closeStart);
      }
      const ind = lineIndent(text, loc.el.start);
      return text.slice(0, loc.el.start) + toXml(loc.el.name, e.value, ind, step).trimStart() + text.slice(loc.el.end);
    }
    if (loc.parent && typeof last === 'string' && last.startsWith('@') && scalar) {
      const a = loc.parent.attrs.find((x) => x.name === last.slice(1));
      const attr = `${last.slice(1)}="${escapeAttr(String(e.value ?? ''))}"`;
      if (a) return text.slice(0, a.start) + attr + text.slice(a.end);
      const at = loc.parent.start + 1 + loc.parent.name.length;
      return `${text.slice(0, at)} ${attr}${text.slice(at)}`;
    }
    if (loc.parent && loc.name && !loc.name.startsWith('@') && loc.name !== '#text') {
      const ind = lineIndent(text, loc.parent.start) + step;
      return appendChild(text, loc.parent, toXml(loc.name, e.value, ind, step));
    }
    return null;
  }
  if (e.op === 'delete') {
    const loc = locate(root, e.path);
    const last = e.path[e.path.length - 1];
    if (loc.el && loc.el !== root) return removeRange(text, loc.el.start, loc.el.end);
    if (loc.parent && typeof last === 'string' && last.startsWith('@')) {
      const a = loc.parent.attrs.find((x) => x.name === last.slice(1));
      if (!a) return null;
      return text.slice(0, a.start).replace(/\s+$/, '') + text.slice(a.end);
    }
    return null;
  }
  if (e.op === 'insert') {
    // path ends at a repeated child name, e.g. [project, dependencies, dependency]
    const name = e.path[e.path.length - 1];
    const parentLoc = locate(root, e.path.slice(0, -1));
    if (typeof name !== 'string' || !parentLoc.el) return null;
    const same = parentLoc.el.children.filter((c) => c.name === name);
    const idx = e.index ?? same.length;
    const ind = same[0] ? lineIndent(text, same[0].start) : lineIndent(text, parentLoc.el.start) + step;
    const xml = toXml(name, e.value, ind, step);
    if (same.length && idx < same.length) {
      const before = same[idx];
      return `${text.slice(0, before.start)}${xml.trimStart()}\n${lineIndent(text, before.start)}${text.slice(before.start)}`;
    }
    if (same.length) return `${text.slice(0, same[same.length - 1].end)}\n${xml}${text.slice(same[same.length - 1].end)}`;
    return appendChild(text, parentLoc.el, xml);
  }
  if (e.op === 'rename') {
    const loc = locate(root, e.path);
    const last = e.path[e.path.length - 1];
    if (loc.el && /^[A-Za-z_][\w.:-]*$/.test(e.to)) {
      const el = loc.el;
      const close = el.selfClosing ? '' : `</${e.to}>`;
      return text.slice(0, el.start + 1) + e.to + text.slice(el.start + 1 + el.name.length, el.closeStart) + (el.selfClosing ? '' : close) + text.slice(el.end);
    }
    if (loc.parent && typeof last === 'string' && last.startsWith('@') && e.to.startsWith('@')) {
      const a = loc.parent.attrs.find((x) => x.name === last.slice(1));
      if (!a) return null;
      return text.slice(0, a.start) + e.to.slice(1) + text.slice(a.start + a.name.length);
    }
    return null;
  }
  return null;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function editXml(text: string, edits: Edit[]): string {
  let out = text;
  // XML has no numbers or booleans: everything is text.
  const str = (v: Value): Value => (v === null ? '' : Array.isArray(v) ? v.map(str) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : String(v));
  for (const raw of edits) {
    const e = 'value' in raw ? ({ ...raw, value: str(raw.value) } as Edit) : raw;
    const before = parseXml(out).value ?? {};
    const want = applyToValue(before, [e]);
    let attempt: string | null = null;
    try {
      attempt = out.trim() ? tryEdit(out, e) : null;
    } catch {
      attempt = null;
    }
    if (attempt !== null && equal(parseXml(attempt).value, want)) out = attempt;
    else {
      const [name, v] = Object.entries(want as Record<string, Value>)[0] ?? ['root', {}];
      const decl = /^<\?xml[^>]*\?>\s*/.exec(out)?.[0] ?? '';
      out = `${decl}${toXml(name, v)}\n`;
    }
  }
  return out;
}
