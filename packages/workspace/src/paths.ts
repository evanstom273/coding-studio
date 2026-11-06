/** Workspace paths: relative, forward slashes, no "." / ".." segments, no leading slash. */
export class PathError extends Error {}

const BAD_SEGMENT = /[\u0000-\u001f<>:"|?*\\]/;

export function normalizePath(input: string): string {
  if (typeof input !== 'string') throw new PathError('Path must be a string');
  const parts: string[] = [];
  for (const seg of input.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new PathError(`Path "${input}" must not contain ".."`);
    if (BAD_SEGMENT.test(seg)) throw new PathError(`Path "${input}" contains an invalid character`);
    if (seg.length > 255) throw new PathError(`Path segment too long in "${input}"`);
    parts.push(seg);
  }
  return parts.join('/');
}

/** Normalise and require a non-empty path (files). */
export function filePath(input: string): string {
  const p = normalizePath(input);
  if (!p) throw new PathError('Path is empty');
  return p;
}

export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export function extname(p: string): string {
  const b = basename(p);
  if (b.endsWith('.vgraph')) return '.vgraph';
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
export const joinPath = (...parts: string[]) => normalizePath(parts.filter(Boolean).join('/'));
/** Is `p` the directory `dir` itself or inside it? ('' = root contains everything) */
export const isWithin = (p: string, dir: string) => dir === '' || p === dir || p.startsWith(`${dir}/`);
/** All ancestor directories of a path, outermost first ("a/b/c.ts" → ["a", "a/b"]). */
export function ancestors(p: string): string[] {
  const out: string[] = [];
  let d = dirname(p);
  while (d) {
    out.unshift(d);
    d = dirname(d);
  }
  return out;
}
