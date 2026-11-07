/**
 * Local execution host (part of the local MCP server, i.e. on the user's computer).
 *
 *  - Link a project to a folder: its files and generated code are written there (paths can't
 *    escape the folder), and edits made in the folder (another editor, a formatter) flow back.
 *  - Run tasks in that folder, from a fixed allow-list: install, a script named in package.json
 *    (test, build, lint…), and the dev server (long-running; its URL is detected from its output).
 *    Commands are always the project's package manager with fixed arguments: never a shell.
 */
import { isDirectlyWritable } from "../../packages/workspace/src/model";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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

const gitHash = (data: Buffer) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const IGNORED =
  /(^|[\\/])(node_modules|\.git|dist|build|\.vite|\.wrangler|\.codingstudio)([\\/]|$)/;

/** Resolve a workspace path inside `root`; refuses anything that would land outside it. */
export function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new HostError(
      "E_INVALID_PATH",
      `"${path}" is outside the project folder`,
    );
  return full;
}

export type PackageManager = "npm" | "pnpm" | "yarn";

export function packageManager(folder: string): PackageManager {
  if (existsSync(join(folder, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(folder, "yarn.lock"))) return "yarn";
  return "npm";
}

function scripts(folder: string): Record<string, string> {
  try {
    return (
      (
        JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {}
    );
  } catch {
    return {};
  }
}

export interface TaskInfo {
  id: string;
  kind: "install" | "script" | "dev";
  command: string;
  state: "running" | "passed" | "failed" | "stopped";
  exitCode?: number | null;
  url?: string;
  startedAt: number;
  endedAt?: number;
  output: string;
}

const MAX_OUTPUT = 200_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+\/?/;

export class ProjectFolder {
  private written = new Map<string, string>(); // path → hash we wrote (to ignore our own echoes)
  private watcher?: FSWatcher;
  private tasks = new Map<string, { info: TaskInfo; child?: ChildProcess }>();
  private seq = 0;

  constructor(readonly root: string) {
    if (!isAbsolute(root))
      throw new HostError(
        "E_INVALID_PATH",
        "The folder must be an absolute path",
      );
    mkdirSync(root, { recursive: true });
    if (!statSync(root).isDirectory())
      throw new HostError("E_INVALID_PATH", `${root} is not a folder`);
  }

  /** Write files into the folder (only those whose content differs). Returns the paths written. */
  write(files: HostFile[], opts: { keepLocalEdits?: boolean } = {}): string[] {
    const out: string[] = [];
    for (const f of files) {
      const full = inside(this.root, f.path);
      const data =
        f.base64 !== undefined
          ? Buffer.from(f.base64, "base64")
          : Buffer.from(f.text ?? "", "utf8");
      const hash = gitHash(data);
      const onDisk = existsSync(full) ? gitHash(readFileSync(full)) : undefined;
      if (onDisk === hash) {
        this.written.set(f.path, hash);
        continue;
      }
      // Changed in the folder since we last wrote it, and not yet brought back: leave it.
      if (
        opts.keepLocalEdits &&
        onDisk !== undefined &&
        this.written.has(f.path) &&
        this.written.get(f.path) !== onDisk
      )
        continue;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      this.written.set(f.path, hash);
      out.push(f.path);
    }
    return out;
  }

  /** Every file in the folder (minus node_modules, .git, build output…), for opening it as a project. */
  readAll(
    limits = {
      files: 20_000,
      fileBytes: 5 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
    },
  ): { files: HostFile[]; skipped: string[] } {
    const files: HostFile[] = [];
    const skipped: string[] = [];
    let total = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const full = join(dir, e.name);
        const p = relative(this.root, full).split(sep).join("/");
        if (IGNORED.test(p) || e.name === ".DS_Store") continue;
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const size = statSync(full).size;
          if (
            size > limits.fileBytes ||
            total + size > limits.totalBytes ||
            files.length >= limits.files
          ) {
            skipped.push(p);
            continue;
          }
          total += size;
          const data = readFileSync(full);
          this.written.set(p, gitHash(data));
          const text = data.includes(0) ? undefined : data.toString("utf8");
          files.push(
            text !== undefined && Buffer.from(text, "utf8").equals(data)
              ? { path: p, text }
              : { path: p, base64: data.toString("base64") },
          );
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
        const data =
          f.base64 !== undefined
            ? Buffer.from(f.base64, "base64")
            : Buffer.from(f.text ?? "", "utf8");
        return gitHash(readFileSync(full)) !== gitHash(data);
      })
      .map((f) => f.path);
  }

  /** Watch for changes made in the folder to files the project knows; calls back with their new content. */
  watch(
    known: () => Set<string>,
    onChange: (files: HostFile[]) => void,
    debounceMs = 300,
  ) {
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
        const text = data.includes(0) ? undefined : data.toString("utf8");
        files.push(
          text !== undefined && Buffer.from(text, "utf8").equals(data)
            ? { path: p, text }
            : { path: p, base64: data.toString("base64") },
        );
      }
      pending.clear();
      if (files.length) onChange(files);
    };
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
      if (!name) return;
      const p = String(name).split(sep).join("/");
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

  /** Run git in the folder (argument array, never a shell) and wait for it. */
  git(
    args: string[],
    timeoutMs = 300_000,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((done, failed) => {
      const child = spawn("git", args, {
        cwd: this.root,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_PAGER: "cat",
          LC_ALL: "C",
        },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on(
        "data",
        (b: Buffer) =>
          (stdout = (stdout + b.toString("utf8")).slice(-MAX_OUTPUT)),
      );
      child.stderr.on(
        "data",
        (b: Buffer) =>
          (stderr = (stderr + b.toString("utf8")).slice(-MAX_OUTPUT)),
      );
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        failed(
          new HostError(
            "E_NO_GIT",
            `Could not run git (${e.message}). Is git installed on this computer?`,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, stdout, stderr });
      });
    });
  }

  // --- tasks ------------------------------------------------------------------------------------

  private start(kind: TaskInfo["kind"], args: string[]): TaskInfo {
    const pm = packageManager(this.root);
    const bin = process.platform === "win32" ? `${pm}.cmd` : pm;
    const info: TaskInfo = {
      id: `t${++this.seq}`,
      kind,
      command: `${pm} ${args.join(" ")}`,
      state: "running",
      startedAt: Date.now(),
      output: "",
    };
    const child = spawn(bin, args, {
      cwd: this.root,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        BROWSER: "none",
        CI: kind === "dev" ? "" : "1",
      },
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const add = (b: Buffer) => {
      info.output = (info.output + b.toString("utf8")).slice(-MAX_OUTPUT);
      if (kind === "dev" && !info.url)
        info.url = URL_RE.exec(info.output.replace(ANSI, ""))?.[0].replace(
          "0.0.0.0",
          "localhost",
        );
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => {
      info.output += `\n${e.message}\n`;
      info.state = "failed";
      info.endedAt = Date.now();
    });
    child.on("exit", (code) => {
      if (info.state === "running")
        info.state = code === 0 ? "passed" : "failed";
      info.exitCode = code;
      info.endedAt = Date.now();
    });
    this.tasks.set(info.id, { info, child });
    return info;
  }

  install(): TaskInfo {
    return this.start("install", ["install"]);
  }

  /** Run a script that package.json defines. */
  run(script: string): TaskInfo {
    const all = scripts(this.root);
    if (!(script in all))
      throw new HostError(
        "E_UNKNOWN_SCRIPT",
        `package.json has no "${script}" script. Available: ${Object.keys(all).join(", ") || "none"}`,
      );
    if (
      script === "dev" ||
      script === "start" ||
      script === "serve" ||
      script === "preview"
    )
      return this.devServer(script);
    return this.start("script", ["run", script]);
  }

  devServer(script = "dev"): TaskInfo {
    const running = [...this.tasks.values()].find(
      (t) => t.info.kind === "dev" && t.info.state === "running",
    );
    if (running) return running.info;
    if (!(script in scripts(this.root)))
      throw new HostError(
        "E_UNKNOWN_SCRIPT",
        `package.json has no "${script}" script`,
      );
    return this.start("dev", ["run", script]);
  }

  stop(id?: string): TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const t of this.tasks.values()) {
      if (
        t.info.state !== "running" ||
        (id && t.info.id !== id) ||
        (!id && t.info.kind !== "dev")
      )
        continue;
      t.info.state = "stopped";
      try {
        if (process.platform !== "win32" && t.child?.pid)
          process.kill(-t.child.pid, "SIGTERM");
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
    return [...this.tasks.values()].map((t) => ({
      ...t.info,
      output: t.info.output.slice(-2000),
    }));
  }

  /** Wait for a task to finish (or `ms`, for dev servers: until the URL appears). */
  async wait(id: string, ms = 600_000): Promise<TaskInfo> {
    const t0 = Date.now();
    for (;;) {
      const info = this.task(id);
      if (!info) throw new HostError("E_NOT_FOUND", `No task ${id}`);
      if (
        info.state !== "running" ||
        (info.kind === "dev" && info.url) ||
        Date.now() - t0 > ms
      )
        return info;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  dispose() {
    this.unwatch();
    for (const t of this.tasks.values())
      if (t.info.state === "running") this.stop(t.info.id);
  }
}

// --- the tools' side: one linked folder per project ------------------------------------------------

type Req = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

interface Snapshot {
  project: string;
  name: string;
  files: (HostFile & { generated?: boolean })[];
}

/** Links projects to folders and runs tasks in them. `request` relays to the editor. */
export class LocalHost {
  private folders = new Map<
    string,
    { folder: ProjectFolder; known: Set<string>; revision?: string }
  >();
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
        const r = (await this.request(
          "host_revision",
          { project: id },
          5000,
        ).catch(() => null)) as { open: boolean; revision?: string } | null;
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
    return (await this.request(
      "host_snapshot",
      project ? { project } : {},
      60_000,
    )) as Snapshot;
  }

  private linked(projectId: string) {
    const l = this.folders.get(projectId);
    if (!l)
      throw new HostError(
        "E_NOT_LINKED",
        "This project is not linked to a folder on this computer yet. Call link_folder with an absolute folder path first.",
      );
    return l;
  }

  private async current(project?: string) {
    const s = await this.snapshot(project);
    return { snap: s, link: this.linked(s.project) };
  }

  /** Write the project (and its generated code) into `dir`, then keep the two in step. */
  async link(
    dir: string,
    opts: { project?: string; overwrite?: boolean; watch?: boolean },
  ) {
    const s = await this.snapshot(opts.project);
    const folder = new ProjectFolder(resolve(dir));
    const conflicts = folder.conflicts(s.files);
    if (conflicts.length) {
      if (!opts.overwrite)
        throw new HostError(
          "E_FILE_EXISTS",
          `These files already exist in ${folder.root} with different content, so nothing was written:\n${conflicts.slice(0, 50).join("\n")}\nRe-run with overwrite: true; the user will be asked to approve it in Coding Studio.`,
          { conflicts },
        );
      const ok = (await this.request(
        "confirm_overwrite",
        { dir: folder.root, files: conflicts },
        300_000,
      )) as { approved: boolean };
      if (!ok.approved)
        throw new HostError(
          "E_DECLINED",
          "The user declined overwriting the existing files. Nothing was written.",
          { conflicts },
        );
    }
    this.folders.get(s.project)?.folder.dispose();
    const known = new Set(
      s.files.filter((f) => !f.generated).map((f) => f.path),
    );
    this.folders.set(s.project, { folder, known });
    const written = folder.write(s.files);
    if (opts.watch !== false)
      folder.watch(
        () => known,
        (files) => void this.pullBack(s.project, files),
      );
    this.startPolling();
    return {
      project: s.project,
      folder: folder.root,
      files: s.files.length,
      written: written.length,
      overwritten: conflicts,
      watching: opts.watch !== false,
      package_manager: packageManager(folder.root),
      scripts: Object.keys(scripts(folder.root)),
    };
  }

  /** Open an existing folder (e.g. a Vite repo) as a new project, linked to it. */
  async open(
    dir: string,
    opts: { name?: string; watch?: boolean; cloneUrl?: string } = {},
  ) {
    const full = resolve(dir);
    if (opts.cloneUrl) {
      if (!/^(https:\/\/|git@|file:\/\/)\S+$/.test(opts.cloneUrl))
        throw new HostError(
          "E_INVALID",
          "clone_url must be an https://, git@ or file:// repository address",
        );
      mkdirSync(full, { recursive: true });
      if (readdirSync(full).length)
        throw new HostError(
          "E_FILE_EXISTS",
          `${full} is not empty; pick a new folder to clone into.`,
        );
      const r = await new ProjectFolder(full).git(
        ["clone", "--", opts.cloneUrl, "."],
        1_800_000,
      );
      if (r.code !== 0)
        throw new HostError(
          "E_GIT",
          `git clone failed: ${r.stderr.trim().slice(-2000)}`,
        );
    }
    if (!existsSync(full) || !statSync(full).isDirectory())
      throw new HostError("E_NOT_FOUND", `${full} is not a folder`);
    const folder = new ProjectFolder(full);
    const { files, skipped } = folder.readAll();
    const r = (await this.request(
      "host_import",
      { name: opts.name ?? basename(full), files },
      120_000,
    )) as { project: string };
    // Generated code for any graphs goes in; nothing the folder already has is replaced.
    const s = await this.snapshot(r.project);
    const known = new Set(
      s.files.filter((f) => !f.generated).map((f) => f.path),
    );
    this.folders.get(r.project)?.folder.dispose();
    this.folders.set(r.project, { folder, known });
    const generated = s.files.filter(
      (f) => f.generated && !existsSync(join(full, f.path)),
    );
    folder.write(
      s.files
        .filter((f) => !f.generated && !existsSync(join(full, f.path)))
        .concat(generated),
    );
    if (opts.watch !== false)
      folder.watch(
        () => known,
        (changed) => void this.pullBack(r.project, changed),
      );
    this.startPolling();
    return {
      project: r.project,
      folder: full,
      files: files.length,
      ...(skipped.length
        ? {
            skipped: skipped.slice(0, 100),
            skipped_note:
              "Too large (over 5 MB, or past the 200 MB / 20,000 file limit); left on disk only.",
          }
        : {}),
      package_manager: packageManager(full),
      scripts: Object.keys(scripts(full)),
      note: "Opened in Coding Studio. install, then dev_server start or run_tests.",
    };
  }

  /** Edits made in the folder go back into the project (one undo step per burst). */
  private async pullBack(projectId: string, all: HostFile[]) {
    // Visual-only: code edited in the folder never comes into the project (only notes and assets).
    const files = all.filter((f) => isDirectlyWritable(f.path));
    if (!files.length) return;
    try {
      await this.request(
        "workspace_batch",
        {
          project: projectId,
          operations: files.map((f) => ({
            op: "write_file",
            path: f.path,
            ...(f.text !== undefined
              ? { content: f.text }
              : { base64: f.base64 }),
          })),
        },
        60_000,
      );
    } catch (e) {
      process.stderr.write(
        `[coding-studio] could not apply folder changes: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /** Write the project's current files into its folder again (only what changed). */
  async sync(project?: string) {
    const { snap, link } = await this.current(project);
    for (const f of snap.files) if (!f.generated) link.known.add(f.path);
    return { folder: link.folder.root, written: link.folder.write(snap.files) };
  }

  private view(t: TaskInfo, tail = 8000) {
    return {
      ...t,
      output: t.output.length > tail ? `…${t.output.slice(-tail)}` : t.output,
      duration_ms: (t.endedAt ?? Date.now()) - t.startedAt,
    };
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
    return this.view(
      opts.wait === false
        ? t
        : await link.folder.wait(t.id, t.kind === "dev" ? 60_000 : undefined),
    );
  }

  async dev(
    action: "start" | "stop" | "status",
    opts: { project?: string; script?: string } = {},
  ) {
    const { link } = await this.current(opts.project);
    if (action === "stop")
      return { stopped: link.folder.stop().map((t) => t.id) };
    if (action === "status")
      return { tasks: link.folder.list().filter((t) => t.kind === "dev") };
    await this.sync(opts.project);
    const t = link.folder.devServer(opts.script);
    const r = await link.folder.wait(t.id, 60_000);
    return {
      ...this.view(r, 3000),
      ...(r.url
        ? {
            note: `Running at ${r.url}. It keeps running (and Vite reloads on every change) until dev_server stop.`,
          }
        : r.state === "running"
          ? {
              note: "Started, but no URL appeared in its output yet; check task_output.",
            }
          : {}),
    };
  }

  async output(id: string | undefined, project?: string) {
    const { link } = await this.current(project);
    if (!id)
      return {
        tasks: link.folder.list().map((t) => ({ ...t, output: undefined })),
      };
    const t = link.folder.task(id);
    if (!t)
      throw new HostError(
        "E_NOT_FOUND",
        `No task ${id}. Call task_output without an id to list them.`,
      );
    return this.view(t, 50_000);
  }

  /** Bring the folder's current files into the project (after git changed the working tree). */
  private async rescan(projectId: string) {
    const link = this.linked(projectId);
    const s = await this.snapshot(projectId);
    const generated = new Set(
      s.files.filter((f) => f.generated).map((f) => f.path),
    );
    const mine = new Map(
      s.files.filter((f) => !f.generated).map((f) => [f.path, f]),
    );
    const { files } = link.folder.readAll();
    const ops: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    const onDisk = new Set<string>();
    for (const f of files) {
      if (generated.has(f.path)) continue;
      onDisk.add(f.path);
      const m = mine.get(f.path);
      if (m && m.text === f.text && m.base64 === f.base64) continue;
      if (!isDirectlyWritable(f.path)) {
        skipped.push(f.path);
        continue;
      }
      ops.push({
        op: "write_file",
        path: f.path,
        ...(f.text !== undefined ? { content: f.text } : { base64: f.base64 }),
      });
      link.known.add(f.path);
    }
    for (const p of mine.keys())
      if (!onDisk.has(p) && p !== "codingstudio.json")
        ops.push({ op: "delete", path: p });
    if (ops.length)
      await this.request(
        "workspace_batch",
        { project: projectId, operations: ops },
        120_000,
      );
    return ops.length;
  }

  async git(
    action: GitAction,
    params: GitParams & { project?: string } = {},
    fromEditor = false,
  ) {
    if (!GIT_ACTIONS.includes(action))
      throw new HostError(
        "E_INVALID",
        `Unknown git action "${action}". One of: ${GIT_ACTIONS.join(", ")}`,
      );
    const { snap, link } = await this.current(params.project);
    const root = link.folder.root;
    if (action !== "init" && !existsSync(join(root, ".git")))
      throw new HostError(
        "E_NOT_A_REPO",
        `${root} is not a git repository. Use action "init", or open_folder with clone_url.`,
      );
    // Make sure git sees what the editor has (commit, push, rebase… act on the folder).
    await this.sync(params.project);
    const args = gitArgs(root, action, params);
    if (action === "rebase_continue") await link.folder.git(["add", "-A"]);
    if (action === "commit") {
      const add = await link.folder.git([
        "add",
        "--",
        ...(params.paths?.length
          ? params.paths.map((x) => safePath(root, x))
          : ["."]),
      ]);
      if (add.code !== 0)
        throw new HostError("E_GIT", add.stderr.trim() || "git add failed");
    }
    if (NEEDS_APPROVAL.has(action) && !fromEditor) {
      const ok = (await this.request(
        "confirm_action",
        {
          title: `Claude wants to run git ${action}`,
          message: `In ${root}:\n\ngit ${args.join(" ")}`,
          confirm: action === "push" ? "Push" : "Rebase",
        },
        300_000,
      )) as { approved: boolean };
      if (!ok.approved)
        throw new HostError(
          "E_DECLINED",
          `The user declined git ${action}. Nothing was run.`,
        );
    }
    const r = await link.folder.git(args);
    const imported = CHANGES_FILES.has(action)
      ? await this.rescan(snap.project)
      : 0;
    const base = {
      action,
      command: `git ${args.join(" ")}`,
      exit_code: r.code,
      ...(imported ? { files_updated_in_project: imported } : {}),
    };
    if (r.code !== 0) {
      const st = parseStatus(
        (await link.folder.git(["status", "--porcelain=v2", "--branch"]))
          .stdout,
      );
      return {
        ...base,
        ok: false,
        error: (r.stderr || r.stdout).trim().slice(-4000),
        ...(st.conflicts.length
          ? {
              conflicts: st.conflicts,
              note: "Resolve the conflict markers in these files (read_files / write_file), then rebase_continue (or commit for a merge / cherry-pick), or *_abort.",
            }
          : {}),
      };
    }
    if (action === "status")
      return { ...base, ok: true, ...parseStatus(r.stdout) };
    if (action === "blame")
      return { ...base, ok: true, lines: parseBlame(r.stdout) };
    if (action === "log")
      return {
        ...base,
        ok: true,
        commits: r.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [sha, author, date, ...subject] = l.split("\t");
            return { sha, author, date, subject: subject.join("\t") };
          }),
      };
    if (action === "branches")
      return {
        ...base,
        ok: true,
        branches: r.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [name, sha, upstream, head] = l.split("\t");
            return {
              name,
              sha,
              ...(upstream ? { upstream } : {}),
              ...(head === "*" ? { current: true } : {}),
            };
          }),
      };
    return {
      ...base,
      ok: true,
      output: (r.stdout + r.stderr).trim().slice(-8000),
    };
  }

  /** What the Computer panel shows for a project. */
  info(projectId: string) {
    const l = this.folders.get(projectId);
    if (!l) return { linked: false };
    const root = l.folder.root;
    return {
      linked: true,
      folder: root,
      package_manager: packageManager(root),
      scripts: Object.keys(scripts(root)),
      git: existsSync(join(root, ".git")),
      tasks: l.folder.list(),
    };
  }

  /** Requests from the editor's Computer panel (the user clicking, so no extra approval). */
  async fromEditor(method: string, p: Record<string, unknown>) {
    const project = typeof p.project === "string" ? p.project : undefined;
    const s = (k: string) =>
      typeof p[k] === "string" ? (p[k] as string) : undefined;
    switch (method) {
      case "info":
        return this.info(project ?? "");
      case "link":
        return this.link(s("folder") ?? "", {
          project,
          overwrite: p.overwrite === true,
        });
      case "open":
        return this.open(s("folder") ?? "", { cloneUrl: s("clone_url") });
      case "install":
        return this.install(project, false);
      case "run":
        return this.run(s("script") ?? "", { project, wait: false });
      case "dev":
        return this.dev(
          (s("action") ?? "status") as "start" | "stop" | "status",
          { project },
        );
      case "output":
        return this.output(s("id"), project);
      case "stop": {
        const l = this.linked(project ?? "");
        return { stopped: l.folder.stop(s("id")).map((t) => t.id) };
      }
      case "git":
        return this.git(
          s("action") as GitAction,
          p as GitParams & { project?: string },
          true,
        );
      case "unlink": {
        this.folders.get(project ?? "")?.folder.dispose();
        this.folders.delete(project ?? "");
        return { linked: false };
      }
      default:
        throw new HostError("E_INVALID", `Unknown host request ${method}`);
    }
  }

  dispose() {
    if (this.poller) clearInterval(this.poller);
    for (const l of this.folders.values()) l.folder.dispose();
  }
}

// --- git through the host (Phase 11) -----------------------------------------------------------------

export const GIT_ACTIONS = [
  "status",
  "log",
  "diff",
  "blame",
  "branches",
  "switch",
  "commit",
  "fetch",
  "pull",
  "push",
  "stash",
  "stash_pop",
  "stash_list",
  "rebase",
  "rebase_continue",
  "rebase_abort",
  "cherry_pick",
  "merge",
  "merge_abort",
  "lfs_status",
  "lfs_pull",
  "lfs_track",
  "init",
] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

export interface GitParams {
  path?: string;
  paths?: string[];
  message?: string;
  branch?: string;
  create?: boolean;
  onto?: string;
  commit?: string;
  ref?: string;
  limit?: number;
  remote?: string;
  pattern?: string;
  url?: string;
}

/** Actions that change the working tree (the project is re-read from the folder afterwards). */
const CHANGES_FILES = new Set<GitAction>([
  "switch",
  "pull",
  "stash",
  "stash_pop",
  "rebase",
  "rebase_continue",
  "rebase_abort",
  "cherry_pick",
  "merge",
  "merge_abort",
  "lfs_pull",
]);
/** Actions that rewrite history or publish: the user approves them in the editor. */
const NEEDS_APPROVAL = new Set<GitAction>(["push", "rebase"]);

const safeRef = (v: string | undefined, what: string) => {
  if (!v || !/^[\w./@{}~^:-]+$/.test(v) || v.startsWith("-"))
    throw new HostError(
      "E_INVALID",
      `${what} must be a branch, tag or commit name`,
    );
  return v;
};
const safePath = (root: string, v: string | undefined) => {
  if (!v) throw new HostError("E_INVALID", "path is required");
  return relative(root, inside(root, v)).split(sep).join("/");
};

/** Fixed argument lists per action; values are checked so none can become an option. */
export function gitArgs(
  root: string,
  action: GitAction,
  p: GitParams,
): string[] {
  const n = Math.min(Math.max(Number(p.limit) || 20, 1), 500);
  switch (action) {
    case "status":
      return ["status", "--porcelain=v2", "--branch"];
    case "log":
      return [
        "log",
        `-n${n}`,
        "--format=%H%x09%an%x09%aI%x09%s",
        ...(p.ref ? [safeRef(p.ref, "ref")] : []),
        ...(p.path ? ["--", safePath(root, p.path)] : []),
      ];
    case "diff":
      return [
        "diff",
        ...(p.ref ? [safeRef(p.ref, "ref")] : []),
        "--",
        ...(p.paths ?? (p.path ? [p.path] : [])).map((x) => safePath(root, x)),
      ];
    case "blame":
      return [
        "blame",
        "--line-porcelain",
        ...(p.ref ? [safeRef(p.ref, "ref")] : []),
        "--",
        safePath(root, p.path),
      ];
    case "branches":
      return [
        "branch",
        "-a",
        "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)",
      ];
    case "switch":
      return [
        "switch",
        ...(p.create ? ["-c"] : []),
        safeRef(p.branch, "branch"),
      ];
    case "commit":
      if (!p.message?.trim())
        throw new HostError("E_INVALID", "message is required");
      return ["commit", "-m", p.message];
    case "fetch":
      return ["fetch", "--prune", safeRef(p.remote ?? "origin", "remote")];
    case "pull":
      return [
        "pull",
        "--no-edit",
        "--ff",
        safeRef(p.remote ?? "origin", "remote"),
        ...(p.branch ? [safeRef(p.branch, "branch")] : []),
      ];
    case "push":
      return [
        "push",
        "-u",
        safeRef(p.remote ?? "origin", "remote"),
        safeRef(p.branch ?? "HEAD", "branch"),
      ];
    case "stash":
      return [
        "stash",
        "push",
        "--include-untracked",
        ...(p.message ? ["-m", p.message] : []),
      ];
    case "stash_pop":
      return ["stash", "pop"];
    case "stash_list":
      return ["stash", "list"];
    case "rebase":
      return ["rebase", safeRef(p.onto, "onto")];
    case "rebase_continue":
      return ["-c", "core.editor=true", "rebase", "--continue"];
    case "rebase_abort":
      return ["rebase", "--abort"];
    case "cherry_pick":
      return ["cherry-pick", safeRef(p.commit, "commit")];
    case "merge":
      return ["merge", "--no-edit", safeRef(p.branch, "branch")];
    case "merge_abort":
      return ["merge", "--abort"];
    case "lfs_status":
      return ["lfs", "status"];
    case "lfs_pull":
      return ["lfs", "pull"];
    case "lfs_track":
      if (!p.pattern || p.pattern.startsWith("-"))
        throw new HostError("E_INVALID", 'pattern is required, e.g. "*.png"');
      return ["lfs", "track", p.pattern];
    case "init":
      return ["init", "-b", safeRef(p.branch ?? "main", "branch")];
  }
}

/** Parse `git status --porcelain=v2 --branch` into something readable. */
export function parseStatus(out: string) {
  const r: {
    branch?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    changed: { path: string; staged: string; unstaged: string }[];
    untracked: string[];
    conflicts: string[];
  } = { ahead: 0, behind: 0, changed: [], untracked: [], conflicts: [] };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) r.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) r.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      r.ahead = Number(a);
      r.behind = -Number(b);
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1];
      const path = line.startsWith("2 ")
        ? parts.slice(9).join(" ").split("\t")[0]
        : parts.slice(8).join(" ");
      r.changed.push({ path, staged: xy[0], unstaged: xy[1] });
    } else if (line.startsWith("u "))
      r.conflicts.push(line.split(" ").slice(10).join(" "));
    else if (line.startsWith("? ")) r.untracked.push(line.slice(2));
  }
  return r;
}

/** Parse `git blame --line-porcelain` into per-line author/commit. */
export function parseBlame(out: string) {
  const lines: {
    line: number;
    commit: string;
    author: string;
    time: string;
    summary: string;
    text: string;
  }[] = [];
  let cur:
    | {
        commit: string;
        line: number;
        author?: string;
        time?: string;
        summary?: string;
      }
    | undefined;
  for (const l of out.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (head) cur = { commit: head[1].slice(0, 10), line: Number(head[2]) };
    else if (cur && l.startsWith("author ")) cur.author = l.slice(7);
    else if (cur && l.startsWith("author-time "))
      cur.time = new Date(Number(l.slice(12)) * 1000).toISOString();
    else if (cur && l.startsWith("summary ")) cur.summary = l.slice(8);
    else if (cur && l.startsWith("\t")) {
      lines.push({
        line: cur.line,
        commit: cur.commit,
        author: cur.author ?? "",
        time: cur.time ?? "",
        summary: cur.summary ?? "",
        text: l.slice(1),
      });
      cur = undefined;
    }
  }
  return lines;
}
