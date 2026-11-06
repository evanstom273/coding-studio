/**
 * Local execution host (part of the local MCP server, i.e. on the user's computer).
 *
 *  - Link a project to a folder: its files and generated code are written there (paths can't
 *    escape the folder), and edits made in the folder (another editor, a formatter) flow back.
 *  - Run tasks in that folder, from a fixed allow-list: install, a script named in package.json
 *    (test, build, lint…), and the dev server (long-running; its URL is detected from its output).
 *    Commands are always the project's package manager with fixed arguments: never a shell.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface HostFile {
  path: string;
  text?: string;
  base64?: string;
}

const gitHash = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build|\.vite|\.wrangler|\.codingstudio)([\\/]|$)/;

/** Resolve a workspace path inside `root`; refuses anything that would land outside it. */
export function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new HostError('E_INVALID_PATH', `"${path}" is outside the project folder`);
  return full;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export function packageManager(folder: string): PackageManager {
  if (existsSync(join(folder, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(folder, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function scripts(folder: string): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

export interface TaskInfo {
  id: string;
  kind: 'install' | 'script' | 'dev';
  command: string;
  state: 'running' | 'passed' | 'failed' | 'stopped';
  exitCode?: number | null;
  url?: string;
  startedAt: number;
  endedAt?: number;
  output: string;
}

const MAX_OUTPUT = 200_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+\/?/;

export class ProjectFolder {
  private written = new Map<string, string>(); // path → hash we wrote (to ignore our own echoes)
  private watcher?: FSWatcher;
  private tasks = new Map<string, { info: TaskInfo; child?: ChildProcess }>();
  private seq = 0;

  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new HostError('E_INVALID_PATH', 'The folder must be an absolute path');
    mkdirSync(root, { recursive: true });
    if (!statSync(root).isDirectory()) throw new HostError('E_INVALID_PATH', `${root} is not a folder`);
  }

  /** Write files into the folder (only those whose content differs). Returns the paths written. */
  write(files: HostFile[], opts: { keepLocalEdits?: boolean } = {}): string[] {
    const out: string[] = [];
    for (const f of files) {
      const full = inside(this.root, f.path);
      const data = f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? '', 'utf8');
      const hash = gitHash(data);
      const onDisk = existsSync(full) ? gitHash(readFileSync(full)) : undefined;
      if (onDisk === hash) {
        this.written.set(f.path, hash);
        continue;
      }
      // Changed in the folder since we last wrote it, and not yet brought back: leave it.
      if (opts.keepLocalEdits && onDisk !== undefined && this.written.has(f.path) && this.written.get(f.path) !== onDisk) continue;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      this.written.set(f.path, hash);
      out.push(f.path);
    }
    return out;
  }

  /** Every file in the folder (minus node_modules, .git, build output…), for opening it as a project. */
  readAll(limits = { files: 20_000, fileBytes: 5 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 }): { files: HostFile[]; skipped: string[] } {
    const files: HostFile[] = [];
    const skipped: string[] = [];
    let total = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, e.name);
        const p = relative(this.root, full).split(sep).join('/');
        if (IGNORED.test(p) || e.name === '.DS_Store') continue;
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const size = statSync(full).size;
          if (size > limits.fileBytes || total + size > limits.totalBytes || files.length >= limits.files) {
            skipped.push(p);
            continue;
          }
          total += size;
          const data = readFileSync(full);
          this.written.set(p, gitHash(data));
          const text = data.includes(0) ? undefined : data.toString('utf8');
          files.push(text !== undefined && Buffer.from(text, 'utf8').equals(data) ? { path: p, text } : { path: p, base64: data.toString('base64') });
        }
      }
    };
    walk(this.root);
    return { files, skipped };
  }

  /** Paths of the listed files that exist in the folder already with different content. */
  conflicts(files: HostFile[]): string[] {
    return files
      .filter((f) => {
        const full = inside(this.root, f.path);
        if (!existsSync(full)) return false;
        const data = f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? '', 'utf8');
        return gitHash(readFileSync(full)) !== gitHash(data);
      })
      .map((f) => f.path);
  }

  /** Watch for changes made in the folder to files the project knows; calls back with their new content. */
  watch(known: () => Set<string>, onChange: (files: HostFile[]) => void, debounceMs = 300) {
    this.unwatch();
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const files: HostFile[] = [];
      for (const p of pending) {
        const full = join(this.root, p);
        if (!existsSync(full) || !statSync(full).isFile()) continue;
        const data = readFileSync(full);
        const hash = gitHash(data);
        if (this.written.get(p) === hash) continue; // our own write
        this.written.set(p, hash);
        const text = data.includes(0) ? undefined : data.toString('utf8');
        files.push(text !== undefined && Buffer.from(text, 'utf8').equals(data) ? { path: p, text } : { path: p, base64: data.toString('base64') });
      }
      pending.clear();
      if (files.length) onChange(files);
    };
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const p = String(name).split(sep).join('/');
      if (IGNORED.test(p) || !known().has(p)) return;
      pending.add(p);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });
  }

  unwatch() {
    this.watcher?.close();
    this.watcher = undefined;
  }

  // --- tasks ------------------------------------------------------------------------------------

  private start(kind: TaskInfo['kind'], args: string[]): TaskInfo {
    const pm = packageManager(this.root);
    const bin = process.platform === 'win32' ? `${pm}.cmd` : pm;
    const info: TaskInfo = { id: `t${++this.seq}`, kind, command: `${pm} ${args.join(' ')}`, state: 'running', startedAt: Date.now(), output: '' };
    const child = spawn(bin, args, { cwd: this.root, env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none', CI: kind === 'dev' ? '' : '1' }, detached: process.platform !== 'win32', shell: process.platform === 'win32', windowsHide: true });
    const add = (b: Buffer) => {
      info.output = (info.output + b.toString('utf8')).slice(-MAX_OUTPUT);
      if (kind === 'dev' && !info.url) info.url = URL_RE.exec(info.output.replace(ANSI, ''))?.[0].replace('0.0.0.0', 'localhost');
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    child.on('error', (e) => {
      info.output += `\n${e.message}\n`;
      info.state = 'failed';
      info.endedAt = Date.now();
    });
    child.on('exit', (code) => {
      if (info.state === 'running') info.state = code === 0 ? 'passed' : 'failed';
      info.exitCode = code;
      info.endedAt = Date.now();
    });
    this.tasks.set(info.id, { info, child });
    return info;
  }

  install(): TaskInfo {
    return this.start('install', ['install']);
  }

  /** Run a script that package.json defines. */
  run(script: string): TaskInfo {
    const all = scripts(this.root);
    if (!(script in all)) throw new HostError('E_UNKNOWN_SCRIPT', `package.json has no "${script}" script. Available: ${Object.keys(all).join(', ') || 'none'}`);
    if (script === 'dev' || script === 'start' || script === 'serve' || script === 'preview') return this.devServer(script);
    return this.start('script', ['run', script]);
  }

  devServer(script = 'dev'): TaskInfo {
    const running = [...this.tasks.values()].find((t) => t.info.kind === 'dev' && t.info.state === 'running');
    if (running) return running.info;
    if (!(script in scripts(this.root))) throw new HostError('E_UNKNOWN_SCRIPT', `package.json has no "${script}" script`);
    return this.start('dev', ['run', script]);
  }

  stop(id?: string): TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const t of this.tasks.values()) {
      if (t.info.state !== 'running' || (id && t.info.id !== id) || (!id && t.info.kind !== 'dev')) continue;
      t.info.state = 'stopped';
      try {
        if (process.platform !== 'win32' && t.child?.pid) process.kill(-t.child.pid, 'SIGTERM');
        else t.child?.kill();
      } catch {
        /* already gone */
      }
      out.push(t.info);
    }
    return out;
  }

  task(id: string): TaskInfo | undefined {
    return this.tasks.get(id)?.info;
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((t) => ({ ...t.info, output: t.info.output.slice(-2000) }));
  }

  /** Wait for a task to finish (or `ms`, for dev servers: until the URL appears). */
  async wait(id: string, ms = 600_000): Promise<TaskInfo> {
    const t0 = Date.now();
    for (;;) {
      const info = this.task(id);
      if (!info) throw new HostError('E_NOT_FOUND', `No task ${id}`);
      if (info.state !== 'running' || (info.kind === 'dev' && info.url) || Date.now() - t0 > ms) return info;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  dispose() {
    this.unwatch();
    for (const t of this.tasks.values()) if (t.info.state === 'running') this.stop(t.info.id);
  }
}

// --- the tools' side: one linked folder per project ------------------------------------------------

type Req = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

interface Snapshot {
  project: string;
  name: string;
  files: (HostFile & { generated?: boolean })[];
}

/** Links projects to folders and runs tasks in them. `request` relays to the editor. */
export class LocalHost {
  private folders = new Map<string, { folder: ProjectFolder; known: Set<string>; revision?: string }>();
  private poller?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(
    private request: Req,
    private pollMs = 1000,
  ) {}

  /** Edits made in the editor reach linked folders within about a second (so Vite hot-reloads). */
  private startPolling() {
    if (this.poller || !this.pollMs) return;
    this.poller = setInterval(() => void this.poll(), this.pollMs);
    this.poller.unref?.();
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [id, link] of this.folders) {
        const r = (await this.request('host_revision', { project: id }, 5000).catch(() => null)) as { open: boolean; revision?: string } | null;
        if (!r?.open || r.revision === link.revision) continue;
        const s = await this.snapshot(id);
        for (const f of s.files) if (!f.generated) link.known.add(f.path);
        link.folder.write(s.files, { keepLocalEdits: true });
        link.revision = r.revision;
      }
    } catch {
      /* editor closed or busy: try again next tick */
    } finally {
      this.polling = false;
    }
  }

  private async snapshot(project?: string) {
    return (await this.request('host_snapshot', project ? { project } : {}, 60_000)) as Snapshot;
  }

  private linked(projectId: string) {
    const l = this.folders.get(projectId);
    if (!l) throw new HostError('E_NOT_LINKED', 'This project is not linked to a folder on this computer yet. Call link_folder with an absolute folder path first.');
    return l;
  }

  private async current(project?: string) {
    const s = await this.snapshot(project);
    return { snap: s, link: this.linked(s.project) };
  }

  /** Write the project (and its generated code) into `dir`, then keep the two in step. */
  async link(dir: string, opts: { project?: string; overwrite?: boolean; watch?: boolean }) {
    const s = await this.snapshot(opts.project);
    const folder = new ProjectFolder(resolve(dir));
    const conflicts = folder.conflicts(s.files);
    if (conflicts.length) {
      if (!opts.overwrite) throw new HostError('E_FILE_EXISTS', `These files already exist in ${folder.root} with different content, so nothing was written:\n${conflicts.slice(0, 50).join('\n')}\nRe-run with overwrite: true; the user will be asked to approve it in Coding Studio.`, { conflicts });
      const ok = (await this.request('confirm_overwrite', { dir: folder.root, files: conflicts }, 300_000)) as { approved: boolean };
      if (!ok.approved) throw new HostError('E_DECLINED', 'The user declined overwriting the existing files. Nothing was written.', { conflicts });
    }
    this.folders.get(s.project)?.folder.dispose();
    const known = new Set(s.files.filter((f) => !f.generated).map((f) => f.path));
    this.folders.set(s.project, { folder, known });
    const written = folder.write(s.files);
    if (opts.watch !== false) folder.watch(() => known, (files) => void this.pullBack(s.project, files));
    this.startPolling();
    return { project: s.project, folder: folder.root, files: s.files.length, written: written.length, overwritten: conflicts, watching: opts.watch !== false, package_manager: packageManager(folder.root), scripts: Object.keys(scripts(folder.root)) };
  }

  /** Open an existing folder (e.g. a Vite repo) as a new project, linked to it. */
  async open(dir: string, opts: { name?: string; watch?: boolean } = {}) {
    const full = resolve(dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new HostError('E_NOT_FOUND', `${full} is not a folder`);
    const folder = new ProjectFolder(full);
    const { files, skipped } = folder.readAll();
    const r = (await this.request('host_import', { name: opts.name ?? basename(full), files }, 120_000)) as { project: string };
    // Generated code for any graphs goes in; nothing the folder already has is replaced.
    const s = await this.snapshot(r.project);
    const known = new Set(s.files.filter((f) => !f.generated).map((f) => f.path));
    this.folders.get(r.project)?.folder.dispose();
    this.folders.set(r.project, { folder, known });
    const generated = s.files.filter((f) => f.generated && !existsSync(join(full, f.path)));
    folder.write(s.files.filter((f) => !f.generated && !existsSync(join(full, f.path))).concat(generated));
    if (opts.watch !== false) folder.watch(() => known, (changed) => void this.pullBack(r.project, changed));
    this.startPolling();
    return { project: r.project, folder: full, files: files.length, ...(skipped.length ? { skipped: skipped.slice(0, 100), skipped_note: 'Too large (over 5 MB, or past the 200 MB / 20,000 file limit); left on disk only.' } : {}), package_manager: packageManager(full), scripts: Object.keys(scripts(full)), note: 'Opened in Coding Studio. install, then dev_server start or run_tests.' };
  }

  /** Edits made in the folder go back into the project (one undo step per burst). */
  private async pullBack(projectId: string, files: HostFile[]) {
    try {
      await this.request('workspace_batch', { project: projectId, operations: files.map((f) => ({ op: 'write_file', path: f.path, ...(f.text !== undefined ? { content: f.text } : { base64: f.base64 }) })) }, 60_000);
    } catch (e) {
      process.stderr.write(`[coding-studio] could not apply folder changes: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  /** Write the project's current files into its folder again (only what changed). */
  async sync(project?: string) {
    const { snap, link } = await this.current(project);
    for (const f of snap.files) if (!f.generated) link.known.add(f.path);
    return { folder: link.folder.root, written: link.folder.write(snap.files) };
  }

  private view(t: TaskInfo, tail = 8000) {
    return { ...t, output: t.output.length > tail ? `…${t.output.slice(-tail)}` : t.output, duration_ms: (t.endedAt ?? Date.now()) - t.startedAt };
  }

  async install(project?: string, wait = true) {
    const { link } = await this.current(project);
    await this.sync(project);
    const t = link.folder.install();
    return this.view(wait ? await link.folder.wait(t.id) : t);
  }

  async run(script: string, opts: { project?: string; wait?: boolean } = {}) {
    const { link } = await this.current(opts.project);
    await this.sync(opts.project);
    const t = link.folder.run(script);
    return this.view(opts.wait === false ? t : await link.folder.wait(t.id, t.kind === 'dev' ? 60_000 : undefined));
  }

  async dev(action: 'start' | 'stop' | 'status', opts: { project?: string; script?: string } = {}) {
    const { link } = await this.current(opts.project);
    if (action === 'stop') return { stopped: link.folder.stop().map((t) => t.id) };
    if (action === 'status') return { tasks: link.folder.list().filter((t) => t.kind === 'dev') };
    await this.sync(opts.project);
    const t = link.folder.devServer(opts.script);
    const r = await link.folder.wait(t.id, 60_000);
    return { ...this.view(r, 3000), ...(r.url ? { note: `Running at ${r.url}. It keeps running (and Vite reloads on every change) until dev_server stop.` } : r.state === 'running' ? { note: 'Started, but no URL appeared in its output yet; check task_output.' } : {}) };
  }

  async output(id: string | undefined, project?: string) {
    const { link } = await this.current(project);
    if (!id) return { tasks: link.folder.list().map((t) => ({ ...t, output: undefined })) };
    const t = link.folder.task(id);
    if (!t) throw new HostError('E_NOT_FOUND', `No task ${id}. Call task_output without an id to list them.`);
    return this.view(t, 50_000);
  }

  dispose() {
    if (this.poller) clearInterval(this.poller);
    for (const l of this.folders.values()) l.folder.dispose();
  }
}
