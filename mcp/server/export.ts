/**
 * Safe file writing for export_script / export_project. The MCP server is the only part that
 * touches the filesystem, and only here:
 *  - output_dir must be absolute, must not be a system directory, and (if
 *    CODING_STUDIO_EXPORT_ROOTS is set) must lie inside one of those roots;
 *  - file paths must be relative, stay inside output_dir (also after resolving symlinks), and
 *    have an allowed extension;
 *  - existing files are never overwritten unless overwrite=true AND the user approves in the
 *    editor; on conflict without approval nothing at all is written.
 */
import { ExportError } from './errors';
export { ExportError };
import { existsSync, mkdirSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';


const SYSTEM_DIRS = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/sbin', '/sys', '/usr', '/var', '/System', '/Library', '/private', 'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
export const ALLOWED_EXTENSIONS = ['.gd', '.vproj.json'];

export function parseRoots(env: string | undefined): string[] {
  return (env ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
}

function inside(root: string, p: string) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface ExportPlan {
  root: string;
  targets: { path: string; full: string; exists: boolean }[];
}

export function planExport(outputDir: string, files: Record<string, string>, roots: string[]): ExportPlan {
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)) throw new ExportError('E_INVALID_DESTINATION', 'output_dir must be an absolute path (e.g. your Godot project folder).');
  const root = resolve(outputDir);
  if (SYSTEM_DIRS.some((d) => resolve(d) === root) || root.split(sep).length <= 2) throw new ExportError('E_INVALID_DESTINATION', `Refusing to export into ${root}: choose a project folder, not a system or top-level directory.`);
  if (roots.length && !roots.some((r) => inside(r, root))) throw new ExportError('E_INVALID_DESTINATION', `output_dir must be inside one of CODING_STUDIO_EXPORT_ROOTS: ${roots.join(', ')}`);
  const paths = Object.keys(files);
  if (!paths.length) throw new ExportError('E_NOTHING_TO_EXPORT', 'No files to export.');
  const targets = paths.map((p) => {
    if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) throw new ExportError('E_INVALID_PATH', `Refusing unsafe path "${p}".`);
    if (!ALLOWED_EXTENSIONS.some((ext) => p.endsWith(ext))) throw new ExportError('E_INVALID_PATH', `Refusing to write "${p}": only ${ALLOWED_EXTENSIONS.join(', ')} files are exported.`);
    const full = resolve(root, p);
    if (!inside(root, full)) throw new ExportError('E_INVALID_PATH', `Refusing to write outside output_dir: ${p}`);
    return { path: p, full, exists: existsSync(full) };
  });
  // Symlinks must not lead outside the destination.
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    for (const t of targets) {
      let probe = dirname(t.full);
      while (!existsSync(probe)) probe = dirname(probe);
      if (!inside(realRoot, realpathSync(probe))) throw new ExportError('E_INVALID_PATH', `Refusing to write ${t.path}: a symbolic link points outside output_dir.`);
      if (t.exists && lstatSync(t.full).isSymbolicLink()) throw new ExportError('E_INVALID_PATH', `Refusing to overwrite symbolic link ${t.path}.`);
    }
  }
  return { root, targets };
}

export function writePlan(plan: ExportPlan, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const t of plan.targets) {
    mkdirSync(dirname(t.full), { recursive: true });
    writeFileSync(t.full, files[t.path], 'utf8');
    written.push(t.path);
  }
  return written;
}
