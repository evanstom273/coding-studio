/** Java .properties (gradle.properties): a flat map of strings, edited line by line so comments stay. */
import { applyToValue, type Edit, type Value } from './model';

const LINE = /^(\s*)([^#!\s=:][^=:]*?)\s*([=:])\s*(.*)$/;

export function parseProperties(text: string): { value?: Value; errors: { message: string; line: number }[] } {
  if (!text.trim()) return { errors: [] };
  const o: Record<string, Value> = {};
  for (const l of text.split('\n')) {
    const m = LINE.exec(l);
    if (m) o[m[2].trim()] = m[4].replace(/\r$/, '');
  }
  return { value: o, errors: [] };
}

export function editProperties(text: string, edits: Edit[]): string {
  const lines = text ? text.split('\n') : [];
  for (const e of edits) {
    const key = String(e.path[0] ?? '');
    const at = lines.findIndex((l) => LINE.exec(l)?.[2].trim() === key);
    if (e.op === 'set' && e.path.length === 1) {
      const v = e.value === null ? '' : typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value);
      if (at >= 0) {
        const m = LINE.exec(lines[at])!;
        lines[at] = `${m[1]}${m[2].trim()}${m[3] === ':' ? ': ' : '='}${v}`;
      } else {
        if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${v}`);
        else lines.push(`${key}=${v}`);
      }
    } else if (e.op === 'delete' && at >= 0) lines.splice(at, 1);
    else if (e.op === 'rename' && at >= 0) lines[at] = lines[at].replace(LINE, (_m, sp: string, _k: string, sep: string, v: string) => `${sp}${e.to}${sep === ':' ? ': ' : '='}${v}`);
    else if (e.op === 'move' && at >= 0) {
      const keyLines = lines.map((l, i) => (LINE.test(l) ? i : -1)).filter((i) => i >= 0);
      const target = keyLines[Math.max(0, Math.min(e.to, keyLines.length - 1))];
      const [l] = lines.splice(at, 1);
      lines.splice(target, 0, l);
    } else if (e.op !== 'set') void applyToValue({}, [e]);
  }
  return lines.join('\n');
}
