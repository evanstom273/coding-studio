/**
 * GitHub from the editor. Calls go through this site's Worker (`/github/<key>/api/...`), which
 * adds the token kept in your Durable Object — the token never lives in this browser.
 */
import { branchExists, cloneFiles, commitAndPush, createRepoFor, switchBranch, type GeneratedFile, GitHub, GIT_STATE_PATH, pull, readState, remoteFile, stateRecord, status, type Fetch, type GitState } from '@cs/git';
import { CONFIG_PATH, defaultConfig, makeRecord, serializeConfig, type FileRecord, type Workspace, type WorkspaceOp } from '@cs/workspace';
import { newId } from '@cs/graph-core';
import { useBridge } from '@web/bridge/client';
import { insertWorkspace } from '@web/db/projects';
import { useEditor } from '@web/store/editor';
import { generatedOutputs, stripGenerated } from '@cs/project-service';

const base = () => {
  useBridge.getState().saveRemoteKey();
  return `/github/${useBridge.getState().remoteKey}`;
};

const proxy: Fetch = async (path, init = {}) => {
  const r = await fetch(`${base()}/api${path}`, { method: init.method ?? 'GET', headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : {}, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (r.status === 401 && (body as { code?: string })?.code === 'E_GITHUB_NOT_CONNECTED') throw Object.assign(new Error('GitHub is not connected. Add a token in Source control.'), { code: 'E_GITHUB_NOT_CONNECTED' });
  return { status: r.status, body };
};

export const github = () => new GitHub(proxy);

export async function tokenStatus(): Promise<{ connected: boolean; login?: string }> {
  const r = await fetch(`${base()}/token`);
  if (!r.ok) throw new Error(`Couldn't reach the Coding Studio server (${r.status})`);
  return r.json();
}

// --- Cloudflare deploy credentials (kept in the cloud vault, written into repository secrets) -------
async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base()}/cloudflare${path}`, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.error?.message ?? `Failed (${r.status})`), { code: body?.error?.code });
  return body as T;
}
export const cloudflareStatus = () => cf<{ configured: boolean; accountId?: string }>('');
export const saveCloudflare = (token: string, accountId: string) => cf<{ configured: boolean; accountId: string }>('', { method: 'PUT', body: JSON.stringify({ token, accountId }) });
export const forgetCloudflare = () => cf<{ configured: boolean }>('', { method: 'DELETE' });
/** Put the saved Cloudflare credentials into a repository's Actions secrets. */
export const setCloudflareSecrets = (owner: string, repo: string) => cf<{ repository: string; secrets: string[] }>('/secrets', { method: 'POST', body: JSON.stringify({ owner, repo }) });

export async function saveToken(token: string) {
  const r = await fetch(`${base()}/token`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const body = await r.json();
  if (!r.ok) throw Object.assign(new Error(body?.error?.message ?? `Failed (${r.status})`), { code: body?.error?.code });
  return body as { connected: boolean; login: string };
}

export async function forgetToken() {
  await fetch(`${base()}/token`, { method: 'DELETE' });
}

/** Clone a repository branch into a new project in this browser. */
export async function cloneRepo(owner: string, repo: string, branch?: string, onProgress?: (done: number, total: number) => void): Promise<Workspace> {
  const c = await cloneFiles(github(), owner, repo, branch, onProgress);
  const now = Date.now();
  const files = new Map<string, FileRecord>(c.files.map((f) => [f.path, f]));
  if (!files.has(CONFIG_PATH)) files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(defaultConfig(c.state.repo)), now));
  return insertWorkspace(stripGenerated({ meta: { id: newId('p'), schemaVersion: 2, createdAt: now, updatedAt: now }, files }));
}

/**
 * The open project's generated code, as it goes to GitHub (the same compile as exports and the
 * linked folder). Strict (for commits) refuses with the graph errors.
 */
export function openOutputs(strict: boolean): GeneratedFile[] {
  return generatedOutputs(useEditor.getState().project ?? undefined, { strict });
}

export function gitState(ws: Workspace | null): GitState | null {
  return ws ? readState(ws) : null;
}

export function gitStatus(ws: Workspace) {
  const st = readState(ws);
  return st ? status(ws, st, openOutputs(false)) : [];
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const writeOp = (f: FileRecord): WorkspaceOp => (f.kind === 'binary' ? { op: 'write_file', path: f.path, base64: b64(f.data ?? new Uint8Array()) } : { op: 'write_file', path: f.path, content: f.text ?? '' });

/** Commit and push the open project (all changes, or `paths`). */
export async function commitOpen(message: string, opts: { paths?: string[]; newBranch?: string } = {}, source: 'user' | 'mcp' = 'user') {
  const ws = useEditor.getState().workspace;
  if (!ws) throw new Error('No project is open');
  const r = await commitAndPush(github(), ws, message, { ...opts, generated: openOutputs(true) });
  useEditor.getState().applyFiles([writeOp(stateRecord(r.state))], `Commit "${message.split('\n')[0]}"`, { source });
  return r;
}

/** Create a GitHub repository for the open (unlinked) project and push everything to it. */
export async function publishOpen(p: { name: string; description?: string; private?: boolean; org?: string }, message = 'First commit from Coding Studio', source: 'user' | 'mcp' = 'user') {
  const ws = useEditor.getState().workspace;
  if (!ws) throw new Error('No project is open');
  if (readState(ws)) throw new Error('This project is already linked to a GitHub repository.');
  openOutputs(true); // refuse before creating anything if the graphs can't be compiled
  const { state, url } = await createRepoFor(github(), p);
  useEditor.getState().applyFiles([writeOp(stateRecord(state))], `Link to ${state.owner}/${state.repo}`, { source });
  const r = await commitOpen(message, {}, source);
  return { repository: `${state.owner}/${state.repo}`, url, branch: r.branch, commit: r.commit, files: r.files };
}

/**
 * Switch the open project to another GitHub branch as one undoable step. Unchanged files become
 * that branch's version; your changed files are kept (nothing is lost).
 */
export async function switchOpen(branch: string, source: 'user' | 'mcp' = 'user') {
  const ws = useEditor.getState().workspace;
  if (!ws) throw new Error('No project is open');
  const r = await switchBranch(github(), ws, branch, new Set(openOutputs(false).map((g) => g.path)));
  const ops: WorkspaceOp[] = [...r.updates].map(([p, f]) => (f ? writeOp(f) : { op: 'delete', path: p }));
  ops.push(writeOp(stateRecord(r.state)));
  useEditor.getState().applyFiles(ops, `Switch to branch ${branch}`, { source });
  return r;
}

/** If the tracked branch was deleted on GitHub (e.g. after its PR was merged), move to the repository's default branch. */
export async function recoverDeletedBranch(source: 'user' | 'mcp' = 'user') {
  const ws = useEditor.getState().workspace;
  const st = ws && readState(ws);
  if (!st || (await branchExists(github(), st))) return null;
  const def = (await github().repo(st.owner, st.repo)).default_branch;
  return { deleted: st.branch, ...(await switchOpen(def, source)) };
}

/** Pull into the open project as one undoable step. */
export async function pullOpen(source: 'user' | 'mcp' = 'user') {
  const ws = useEditor.getState().workspace;
  if (!ws) throw new Error('No project is open');
  const r = await pull(github(), ws, new Set(openOutputs(false).map((g) => g.path)));
  if (r.upToDate) return r;
  const ops: WorkspaceOp[] = [...r.updates].map(([p, f]) => (f ? writeOp(f) : { op: 'delete', path: p }));
  ops.push(writeOp(stateRecord(r.state)));
  useEditor.getState().applyFiles(ops, `Pull from GitHub (${r.state.branch})`, { source });
  return r;
}

/** Resolve a conflicted file by taking GitHub's version. */
export async function takeTheirs(path: string) {
  const ws = useEditor.getState().workspace!;
  const st = readState(ws)!;
  const f = await remoteFile(github(), st, path, 'base');
  useEditor.getState().applyFiles([f ? writeOp(f) : { op: 'delete', path }], `Use GitHub's ${path}`);
}

/** GitHub's version of a file at the last synced commit (for diffs). */
export async function baseVersion(path: string): Promise<FileRecord | null> {
  const ws = useEditor.getState().workspace!;
  const st = readState(ws);
  return st ? remoteFile(github(), st, path, 'base') : null;
}

export { GIT_STATE_PATH };
