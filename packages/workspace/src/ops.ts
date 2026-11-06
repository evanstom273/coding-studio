/**
 * Workspace operations: THE way a workspace changes (editor, Monaco, MCP, sync, imports).
 *
 * - Atomic: a batch either fully applies or throws `WorkspaceOpError` and nothing changes.
 * - Optimistic concurrency per file: `expectedHash` (null = must not exist) makes a write fail if
 *   the file changed since the caller read it, without blocking edits to other files.
 * - Graph edits (`op: 'graph'`) reuse the existing EditOp engine through the project bridge.
 */
import type { JsonValue } from '@cs/graph-core';
import type { Toolchain } from '@cs/compiler-core';
import { OpError, type EditOp, type OpDefaults } from '@cs/project-format';
import { CONFIG_PATH, GRAPH_EXT, kindForPath, looksBinary, makeRecord, parseConfig, parseGraph, scriptPathFor, serializeConfig, serializeGraph, type FileKind, type FileRecord, type Workspace, type WorkspaceConfig } from './model';
import { ancestors, filePath, isWithin, normalizePath, PathError } from './paths';
import { applyProjectOps, deriveProject, reidScript, scriptFromRecord } from './project';

export type WorkspaceOp =
  | { op: 'write_file'; path: string; content?: string; base64?: string; expectedHash?: string | null }
  | { op: 'create_dir'; path: string }
  | { op: 'delete'; path: string; recursive?: boolean; expectedHash?: string }
  | { op: 'move'; from: string; to: string; overwrite?: boolean }
  | { op: 'copy'; from: string; to: string; overwrite?: boolean }
  /** script / graph: which script and graph the ops default to (id, name, or path like "player/player.vgraph"). */
  | { op: 'graph'; ops: EditOp[]; defaults?: OpDefaults; script?: string; graph?: string }
  | { op: 'config'; patch: Partial<Omit<WorkspaceConfig, 'version'>> };

export class WorkspaceOpError extends Error {
  constructor(
    message: string,
    readonly code = 'E_INVALID_OPERATION',
    readonly opIndex?: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface WorkspaceApplyResult {
  workspace: Workspace;
  /** Paths whose content changed (added, modified or removed). */
  changedPaths: string[];
  /** "$ref" → id from graph ops. */
  created: Record<string, string>;
  warnings: string[];
}

const KEEP = '.gitkeep';

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function contentRecord(path: string, content: string | Uint8Array, now: number): FileRecord {
  const kind: FileKind = kindForPath(path);
  if (typeof content !== 'string' && kind !== 'binary' && !looksBinary(content)) {
    try {
      return makeRecord(path, dec.decode(content), now, kind);
    } catch {
      /* not UTF-8: keep as binary */
    }
  }
  if (typeof content !== 'string') return makeRecord(path, content, now, 'binary');
  return makeRecord(path, content, now, kind === 'binary' ? 'text' : kind);
}

function filesIn(files: Map<string, FileRecord>, dir: string): string[] {
  return [...files.keys()].filter((p) => isWithin(p, dir) && p !== dir);
}

export function applyWorkspaceOps(ws: Workspace, ops: WorkspaceOp[], tc?: Toolchain, now = Date.now()): WorkspaceApplyResult {
  if (!Array.isArray(ops)) throw new WorkspaceOpError('operations must be an array');
  let current: Workspace = ws;
  let files = new Map(ws.files);
  const changed = new Set<string>();
  const created: Record<string, string> = {};
  const warnings: string[] = [];

  const put = (r: FileRecord) => {
    const prev = files.get(r.path);
    if (prev?.hash === r.hash && prev.kind === r.kind) return;
    // A real file inside a directory makes its .gitkeep marker redundant.
    for (const d of ancestors(r.path)) {
      if (files.has(d)) throw new WorkspaceOpError(`"${d}" is a file, so "${r.path}" can't be created inside it`, 'E_PATH_CONFLICT');
      const keep = `${d}/${KEEP}`;
      if (files.has(keep) && keep !== r.path) {
        files.delete(keep);
        changed.add(keep);
      }
    }
    if (filesIn(files, r.path).length) throw new WorkspaceOpError(`"${r.path}" is a folder`, 'E_PATH_CONFLICT');
    files.set(r.path, r);
    changed.add(r.path);
  };
  const remove = (p: string) => {
    if (files.delete(p)) changed.add(p);
  };
  const exists = (p: string) => files.has(p) || filesIn(files, p).length > 0;

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case 'write_file': {
          const path = filePath(op.path);
          const cur = files.get(path);
          if (op.expectedHash !== undefined) {
            if (op.expectedHash === null && cur) throw new WorkspaceOpError(`${path} already exists`, 'E_FILE_EXISTS');
            if (op.expectedHash !== null && cur?.hash !== op.expectedHash) throw new WorkspaceOpError(`${path} changed since it was read (expected ${op.expectedHash}, now ${cur?.hash ?? 'deleted'})`, 'E_REVISION_CONFLICT', undefined, { path, current: cur?.hash ?? null });
          }
          const content = op.base64 !== undefined ? b64decode(op.base64) : op.content;
          if (content === undefined) throw new WorkspaceOpError('write_file needs content or base64');
          if (path === CONFIG_PATH && typeof content === 'string') {
            put(makeRecord(path, serializeConfig(parseConfig(content, 'Untitled')), now));
            break;
          }
          const rec = contentRecord(path, content, now);
          if (rec.kind === 'graph') {
            // Graph files must be valid, and their script path must match the file path.
            const g = parseGraph(rec.text ?? '');
            const want = scriptPathFor(path);
            if (g.script.path !== want) {
              put(makeRecord(path, serializeGraph({ ...g.script, path: want }, g.language), now, 'graph'));
              break;
            }
          }
          put(rec);
          break;
        }
        case 'create_dir': {
          const path = filePath(op.path);
          if (files.has(path)) throw new WorkspaceOpError(`"${path}" is a file`, 'E_PATH_CONFLICT');
          if (!filesIn(files, path).length) put(makeRecord(`${path}/${KEEP}`, '', now, 'text'));
          break;
        }
        case 'delete': {
          const path = normalizePath(op.path);
          if (!path) throw new WorkspaceOpError('Refusing to delete the whole workspace');
          if (path === CONFIG_PATH) throw new WorkspaceOpError(`${CONFIG_PATH} holds the project settings and can't be deleted`);
          const f = files.get(path);
          if (f) {
            if (op.expectedHash && f.hash !== op.expectedHash) throw new WorkspaceOpError(`${path} changed since it was read`, 'E_REVISION_CONFLICT');
            remove(path);
            break;
          }
          const inside = filesIn(files, path);
          if (!inside.length) throw new WorkspaceOpError(`"${path}" does not exist`, 'E_NOT_FOUND');
          const real = inside.filter((p) => !p.endsWith(`/${KEEP}`) || p !== `${path}/${KEEP}`);
          if (real.length && !op.recursive) throw new WorkspaceOpError(`Folder "${path}" is not empty; pass recursive: true to delete it and its ${real.length} file(s)`);
          if (inside.includes(CONFIG_PATH)) throw new WorkspaceOpError(`Folder contains ${CONFIG_PATH}`);
          inside.forEach(remove);
          break;
        }
        case 'move':
        case 'copy': {
          const from = filePath(op.from);
          const to = filePath(op.to);
          if (from === to) break;
          if (from === CONFIG_PATH && op.op === 'move') throw new WorkspaceOpError(`${CONFIG_PATH} can't be moved`);
          if (isWithin(to, from)) throw new WorkspaceOpError(`Can't ${op.op} "${from}" into itself`);
          const single = files.get(from);
          const sources = single ? [from] : filesIn(files, from);
          if (!sources.length) throw new WorkspaceOpError(`"${from}" does not exist`, 'E_NOT_FOUND');
          if (exists(to) && !op.overwrite) throw new WorkspaceOpError(`"${to}" already exists`, 'E_FILE_EXISTS');
          for (const src of sources) {
            const dest = single ? to : `${to}${src.slice(from.length)}`;
            const r = files.get(src)!;
            const srcGraph = r.kind === 'graph';
            const dstGraph = dest.endsWith(GRAPH_EXT);
            if (srcGraph !== dstGraph) throw new WorkspaceOpError(`Graph files must keep the ${GRAPH_EXT} extension (${src} → ${dest})`);
            if (srcGraph) {
              const g = parseGraph(r.text ?? '');
              let s = { ...scriptFromRecord(r), path: scriptPathFor(dest) };
              if (op.op === 'copy') s = reidScript(s, g.language);
              put(makeRecord(dest, serializeGraph(s, g.language), now, 'graph'));
            } else {
              put({ ...r, path: dest, mtime: now });
            }
            if (op.op === 'move') remove(src);
          }
          break;
        }
        case 'graph': {
          if (!tc) throw new WorkspaceOpError('Graph operations need a toolchain');
          current = { meta: current.meta, files };
          let defaults = op.defaults ?? {};
          if (op.script || op.graph) {
            const p = deriveProject(current).project;
            const sc = op.script ? p.scripts.find((s) => s.id === op.script || s.name === op.script || s.path === op.script || `${s.path}${GRAPH_EXT}` === op.script) : undefined;
            if (op.script && !sc) throw new WorkspaceOpError(`Script "${op.script}" not found (use its path, e.g. "main.vgraph", its name or id)`, 'E_NOT_FOUND');
            const fn = op.graph ? (sc ? [sc] : p.scripts).flatMap((s) => s.functions.map((f) => ({ s, f }))).find((x) => x.f.id === op.graph || x.f.name === op.graph || x.f.graph.id === op.graph) : undefined;
            if (op.graph && !fn) throw new WorkspaceOpError(`Graph "${op.graph}" not found`, 'E_NOT_FOUND');
            defaults = { scriptId: fn?.s.id ?? sc!.id, functionId: fn?.f.id ?? (sc!.id === defaults.scriptId ? defaults.functionId : sc!.functions[0]?.id) };
          }
          const r = applyProjectOps(current, op.ops, tc, defaults, now);
          files = new Map(r.workspace.files);
          r.changedPaths.forEach((p) => changed.add(p));
          Object.assign(created, r.result.created);
          warnings.push(...r.result.warnings);
          break;
        }
        case 'config': {
          const cfg = { ...parseConfig(files.get(CONFIG_PATH)?.text, 'Untitled'), ...op.patch, version: 1 as const };
          put(makeRecord(CONFIG_PATH, serializeConfig(parseConfig(JSON.stringify(cfg), 'Untitled')), now));
          break;
        }
        default:
          throw new WorkspaceOpError(`Unknown operation "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      const opName = (op as { op?: string })?.op ?? '?';
      if (e instanceof WorkspaceOpError) throw new WorkspaceOpError(`Operation ${i + 1} (${opName}): ${e.message}`, e.code, i, e.details);
      if (e instanceof OpError) throw new WorkspaceOpError(`Operation ${i + 1} (${opName}): ${e.message.replace(/^Operation \d+ \([a-z_]+\): /, '')}`, e.code, i, { graphOpIndex: e.opIndex });
      if (e instanceof PathError) throw new WorkspaceOpError(`Operation ${i + 1} (${opName}): ${e.message}`, 'E_INVALID_PATH', i);
      const code = (e as { code?: unknown })?.code;
      throw new WorkspaceOpError(`Operation ${i + 1} (${opName}): ${e instanceof Error ? e.message : String(e)}`, typeof code === 'string' ? code : 'E_INVALID_OPERATION', i);
    }
  });

  const changedPaths = [...changed].filter((p) => ws.files.get(p) !== files.get(p));
  if (!changedPaths.length) return { workspace: ws, changedPaths, created, warnings };
  return { workspace: { meta: { ...ws.meta, updatedAt: now }, files }, changedPaths, created, warnings };
}

export type { JsonValue };
