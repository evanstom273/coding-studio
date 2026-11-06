/**
 * Git operations between a workspace and a GitHub branch.
 *
 * Our file hashes are git blob SHA-1s, so the state we last synced with GitHub is just a map
 * path → blob sha (kept in `.codingstudio/git.json`, a file inside the workspace so it travels
 * with the project through cloud sync, but never committed). Status is a comparison of hashes;
 * commit uploads only changed blobs; pull is a per-file three-way merge.
 */
import { GRAPH_EXT, makeRecord, type FileRecord, type Workspace } from '@cs/workspace';
import { GitHub, GitHubError, type TreeEntry } from './github';
import { merge3 } from './merge';

export const GIT_STATE_PATH = '.codingstudio/git.json';
/** Workspace-internal files that are never committed. */
export const isInternal = (path: string) => path.startsWith('.codingstudio/');
/** Files larger than this aren't downloaded on clone (listed as skipped). */
export const CLONE_FILE_LIMIT = 20 * 1024 * 1024;

export interface GitState {
  provider: 'github';
  owner: string;
  repo: string;
  branch: string;
  /** Commit the workspace was last in sync with. */
  commit: string;
  /** path → blob sha at that commit (only blobs we track). */
  tree: Record<string, string>;
  /** path → file mode (executables, symlinks are kept as they were). */
  modes?: Record<string, string>;
  /** Files left out on clone (too large / submodules): never deleted by commits. */
  skipped?: string[];
}

export function readState(ws: Workspace): GitState | null {
  const t = ws.files.get(GIT_STATE_PATH)?.text;
  if (!t) return null;
  try {
    const s = JSON.parse(t) as GitState;
    return s && s.provider === 'github' && s.owner && s.repo ? s : null;
  } catch {
    return null;
  }
}

export const stateRecord = (s: GitState, now = Date.now()) => makeRecord(GIT_STATE_PATH, JSON.stringify(s, null, 1) + '\n', now, 'text');

export interface Change {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export function status(ws: Workspace, st: GitState): Change[] {
  const out: Change[] = [];
  for (const [p, f] of ws.files) {
    if (isInternal(p)) continue;
    const base = st.tree[p];
    if (!base) out.push({ path: p, status: 'added' });
    else if (base !== f.hash) out.push({ path: p, status: 'modified' });
  }
  for (const p of Object.keys(st.tree)) if (!ws.files.has(p)) out.push({ path: p, status: 'deleted' });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function recordFrom(path: string, data: Uint8Array, now: number): FileRecord {
  // Text if it decodes as UTF-8 and has no NULs; `makeRecord` picks graph/text/binary by name.
  let text: string | undefined;
  if (!data.subarray(0, 8192).includes(0)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      text = undefined;
    }
  }
  return text !== undefined ? makeRecord(path, text, now) : makeRecord(path, data, now, 'binary');
}

async function download(gh: GitHub, owner: string, repo: string, entries: TreeEntry[], onProgress?: (done: number, total: number) => void) {
  const files: FileRecord[] = [];
  const now = Date.now();
  let done = 0;
  const queue = [...entries];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const data = await gh.blob(owner, repo, e.sha);
      const r = recordFrom(e.path, data, now);
      if (r.hash !== e.sha) throw new GitHubError('E_GITHUB', `Content check failed for ${e.path}`);
      files.push(r);
      onProgress?.(++done, entries.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return files;
}

const trackable = (e: TreeEntry) => e.type === 'blob' && e.mode !== '120000' && (e.size ?? 0) <= CLONE_FILE_LIMIT;

/** Download a branch into a fresh workspace's files (plus the git state file). */
export async function cloneFiles(gh: GitHub, owner: string, repo: string, branch: string | undefined, onProgress?: (done: number, total: number) => void) {
  const info = await gh.repo(owner, repo);
  const br = branch || info.default_branch;
  const commit = await gh.head(owner, repo, br);
  const tree = await gh.tree(owner, repo, (await gh.commit(owner, repo, commit)).tree.sha);
  const blobs = tree.filter(trackable).filter((e) => !isInternal(e.path));
  const skipped = tree.filter((e) => (e.type === 'blob' && !trackable(e)) || e.type === 'commit').map((e) => e.path);
  const files = await download(gh, owner, repo, blobs, onProgress);
  const st: GitState = { provider: 'github', owner: info.owner.login, repo: info.name, branch: br, commit, tree: Object.fromEntries(blobs.map((e) => [e.path, e.sha])), modes: Object.fromEntries(blobs.filter((e) => e.mode !== '100644').map((e) => [e.path, e.mode])), ...(skipped.length ? { skipped } : {}) };
  files.push(stateRecord(st));
  return { files, state: st, private: info.private, fullName: info.full_name };
}

export interface CommitResult {
  commit: string;
  branch: string;
  files: number;
  state: GitState;
}

/**
 * Commit every change (or only `paths`) and push. With `newBranch` the commit goes to a new
 * branch made from the current one. Refused with E_NOT_FAST_FORWARD if GitHub moved on — pull first.
 */
export async function commitAndPush(gh: GitHub, ws: Workspace, message: string, opts: { paths?: string[]; newBranch?: string } = {}): Promise<CommitResult> {
  const st = readState(ws);
  if (!st) throw new GitHubError('E_NOT_LINKED', 'This project is not linked to a GitHub repository.');
  if (!message.trim()) throw new GitHubError('E_INVALID', 'A commit message is required.');
  let changes = status(ws, st);
  if (opts.paths) {
    const want = new Set(opts.paths);
    changes = changes.filter((c) => want.has(c.path));
  }
  if (!changes.length) throw new GitHubError('E_NOTHING_TO_COMMIT', 'Nothing to commit: no files differ from GitHub.');
  const { owner, repo } = st;
  const branch = opts.newBranch?.trim() || st.branch;
  if (!opts.newBranch) {
    const remote = await gh.head(owner, repo, st.branch);
    if (remote !== st.commit) throw new GitHubError('E_NOT_FAST_FORWARD', `${st.branch} has new commits on GitHub. Pull first, then commit.`);
  }
  const entries: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
  for (const c of changes) {
    if (c.status === 'deleted') {
      entries.push({ path: c.path, mode: st.modes?.[c.path] ?? '100644', type: 'blob', sha: null });
      continue;
    }
    const f = ws.files.get(c.path)!;
    const sha = await gh.createBlob(owner, repo, f.data ?? new TextEncoder().encode(f.text ?? ''));
    if (sha !== f.hash) throw new GitHubError('E_GITHUB', `GitHub stored ${c.path} with an unexpected hash`);
    entries.push({ path: c.path, mode: st.modes?.[c.path] ?? '100644', type: 'blob', sha });
  }
  const base = await gh.commit(owner, repo, st.commit);
  const tree = await gh.createTree(owner, repo, base.tree.sha, entries);
  const commit = await gh.createCommit(owner, repo, message.trim(), tree, [st.commit]);
  if (opts.newBranch) await gh.createRef(owner, repo, branch, commit);
  else
    await gh.updateRef(owner, repo, branch, commit).catch((e) => {
      if (e instanceof GitHubError && e.code === 'E_GITHUB_REJECTED') throw new GitHubError('E_NOT_FAST_FORWARD', `${branch} moved on GitHub while committing. Pull first, then commit.`);
      throw e;
    });
  const next: GitState = { ...st, branch, commit, tree: { ...st.tree } };
  for (const c of changes) {
    if (c.status === 'deleted') delete next.tree[c.path];
    else next.tree[c.path] = ws.files.get(c.path)!.hash;
  }
  return { commit, branch, files: changes.length, state: next };
}

export interface PullResult {
  /** New and changed records (and deletions as `null`) to apply to the workspace. */
  updates: Map<string, FileRecord | null>;
  state: GitState;
  /** Files changed on both sides that couldn't be merged automatically. */
  conflicts: { path: string; kind: 'text' | 'graph' | 'binary' | 'delete' }[];
  merged: string[];
  upToDate: boolean;
}

/**
 * Bring GitHub's new commits into the workspace. Files changed only on GitHub are taken; files
 * changed only here are kept; text changed on both is merged line by line (conflict markers
 * where they overlap); graphs and binaries changed on both keep your version and are reported
 * so you can choose.
 */
export async function pull(gh: GitHub, ws: Workspace): Promise<PullResult> {
  const st = readState(ws);
  if (!st) throw new GitHubError('E_NOT_LINKED', 'This project is not linked to a GitHub repository.');
  const { owner, repo } = st;
  const remote = await gh.head(owner, repo, st.branch);
  const updates = new Map<string, FileRecord | null>();
  if (remote === st.commit) return { updates, state: st, conflicts: [], merged: [], upToDate: true };
  const tree = (await gh.tree(owner, repo, (await gh.commit(owner, repo, remote)).tree.sha)).filter(trackable).filter((e) => !isInternal(e.path));
  const theirs = new Map(tree.map((e) => [e.path, e.sha]));
  const paths = new Set([...Object.keys(st.tree), ...theirs.keys()]);
  const need = tree.filter((e) => {
    const local = ws.files.get(e.path)?.hash;
    return e.sha !== st.tree[e.path] && e.sha !== local;
  });
  const fetched = new Map((await download(gh, owner, repo, need)).map((f) => [f.path, f]));
  const conflicts: PullResult['conflicts'] = [];
  const merged: string[] = [];
  const nextTree: Record<string, string> = {};
  const now = Date.now();
  const baseText = async (path: string) => {
    const sha = st.tree[path];
    return sha ? new TextDecoder().decode(await gh.blob(owner, repo, sha)) : '';
  };
  for (const p of paths) {
    const base = st.tree[p];
    const t = theirs.get(p);
    const local = ws.files.get(p);
    if (t) nextTree[p] = t;
    if (t === base) continue; // unchanged on GitHub: keep whatever is here
    if (local?.hash === t) continue; // same change on both sides
    const localChanged = (local?.hash ?? undefined) !== base;
    if (!localChanged) {
      updates.set(p, t ? fetched.get(p)! : null);
      continue;
    }
    // Changed on both sides.
    if (!t || !local) {
      conflicts.push({ path: p, kind: 'delete' });
      continue;
    }
    const remoteRec = fetched.get(p)!;
    if (local.kind === 'binary' || remoteRec.kind === 'binary') conflicts.push({ path: p, kind: 'binary' });
    else if (p.endsWith(GRAPH_EXT)) conflicts.push({ path: p, kind: 'graph' });
    else {
      const m = merge3(await baseText(p), local.text ?? '', remoteRec.text ?? '');
      updates.set(p, makeRecord(p, m.text, now));
      if (m.conflicts) conflicts.push({ path: p, kind: 'text' });
      else merged.push(p);
    }
  }
  return { updates, state: { ...st, commit: remote, tree: nextTree }, conflicts, merged, upToDate: false };
}

/** Fetch GitHub's version of one file (for "use theirs" / diff views). */
export async function remoteFile(gh: GitHub, st: GitState, path: string, at: 'base' | 'head' = 'head'): Promise<FileRecord | null> {
  const commit = at === 'base' ? st.commit : await gh.head(st.owner, st.repo, st.branch);
  const sha = at === 'base' ? st.tree[path] : (await gh.tree(st.owner, st.repo, (await gh.commit(st.owner, st.repo, commit)).tree.sha)).find((e) => e.path === path)?.sha;
  if (!sha) return null;
  return recordFrom(path, await gh.blob(st.owner, st.repo, sha), Date.now());
}
