/**
 * Cloud sync for the Claude connector, file by file. While the connector is on:
 *  - on connect, every project is reconciled with its cloud copy;
 *  - every save here pushes just the files that changed, each with the hash it was based on;
 *  - Claude's edits in the cloud arrive live (only the changed files are fetched); if the
 *    project is open they appear as an undoable step labelled "Claude: …".
 *
 * Reconciling uses a three-way comparison per file against the last state both sides agreed on
 * (the "base", kept in IndexedDB): changed only here → push; changed only in the cloud → pull;
 * changed on both → the cloud copy wins and the user is told (never silently merged).
 */
import { makeRecord, type FileKind, type FileRecord, type Workspace } from '@cs/workspace';
import { deleteProject, getSetting, listProjects, loadWorkspace, projectEvents, saveWorkspace, setSetting, type SavedDetail } from '@web/db/projects';
import { useBridge, sendToCloud } from '@web/bridge/client';
import { useEditor } from '@web/store/editor';
import { markSaved, saveNow } from '@web/hooks/useAutosave';
import { navigate } from '@web/lib/router';
import { toast } from '@web/store/toasts';

interface CloudIndexEntry {
  path: string;
  kind: FileKind;
  hash: string;
  size: number;
  mtime: number;
}
interface CloudWorkspace {
  id: string;
  name: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
}
type Base = Record<string, string>;

/** Cloud revision this browser last saw for each project (to ignore our own echoes). */
const known = new Map<string, string>();
/** Per-project queue, so syncs of one project never interleave. */
const queues = new Map<string, Promise<unknown>>();
let wired = false;
let reconciling: Promise<void> | null = null;

const PUSH_BATCH_BYTES = 4 * 1024 * 1024;
const READ_BATCH = 200;

const enabled = () => useBridge.getState().remoteEnabled && useBridge.getState().remoteStatus === 'connected';
const root = () => `/sync/${useBridge.getState().remoteKey}/workspaces`;
const changed = () => window.dispatchEvent(new Event('cs:projects-changed'));
const baseKey = (id: string) => `sync:${id}`;

async function api(path: string, init?: RequestInit) {
  const r = await fetch(root() + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}

function queue<T>(id: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  queues.set(
    id,
    next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    }),
  );
  return next;
}

function b64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Fetch file contents from the cloud (batched). */
async function readCloud(id: string, paths: string[]): Promise<FileRecord[]> {
  const out: FileRecord[] = [];
  for (let i = 0; i < paths.length; i += READ_BATCH) {
    const r = await api(`/${id}/read`, { method: 'POST', body: JSON.stringify({ paths: paths.slice(i, i + READ_BATCH) }) });
    if (r.status !== 200) throw new Error(`Cloud read failed (${r.status})`);
    for (const f of r.body.files as { path: string; kind: FileKind; mtime: number; text?: string; base64?: string }[]) {
      out.push(makeRecord(f.path, f.base64 !== undefined ? unb64(f.base64) : (f.text ?? ''), f.mtime, f.kind));
    }
  }
  return out;
}

/** Push files (batched by size). Returns false on a conflict (someone changed a file meanwhile). */
async function pushFiles(ws: Workspace, paths: string[], base: (p: string) => string | null): Promise<boolean> {
  let batch: unknown[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return true;
    const r = await api(`/${ws.meta.id}/apply`, { method: 'POST', body: JSON.stringify({ createdAt: ws.meta.createdAt, changes: batch }) });
    batch = [];
    bytes = 0;
    if (r.status === 200) {
      known.set(ws.meta.id, r.body.revision);
      return true;
    }
    if (r.status === 409) return false;
    throw new Error(`Cloud sync failed (${r.status}${r.body?.error ? `: ${r.body.error}` : ''})`);
  };
  // codingstudio.json first, so the cloud knows the project's name as soon as anything arrives.
  const ordered = [...paths].sort((a, b) => (a === 'codingstudio.json' ? -1 : b === 'codingstudio.json' ? 1 : 0));
  for (const p of ordered) {
    const f = ws.files.get(p);
    const change = f ? { path: p, base: base(p), kind: f.kind, ...(f.kind === 'binary' ? { base64: b64(f.data ?? new Uint8Array()) } : { text: f.text ?? '' }) } : { path: p, base: base(p), delete: true };
    batch.push(change);
    bytes += f?.size ?? 0;
    if (bytes >= PUSH_BATCH_BYTES && !(await flush())) return false;
  }
  return flush();
}

/** Install a new local snapshot: IndexedDB, and the editor if this project is open. */
async function adopt(ws: Workspace, label: string) {
  await saveWorkspace(ws, undefined, { silent: true });
  const ed = useEditor.getState();
  if (ed.workspace?.meta.id === ws.meta.id) {
    ed.replaceWorkspace(ws, label, 'mcp');
    markSaved(useEditor.getState().workspace);
  }
  changed();
}

/**
 * Bring one project and its cloud copy into agreement. `cloud` undefined = not in the cloud.
 */
async function syncOne(id: string, label: string, cloud?: CloudWorkspace) {
  if (useEditor.getState().workspace?.meta.id === id) await saveNow();
  const local = (await loadWorkspace(id))?.workspace;
  const base = await getSetting<Base | null>(baseKey(id), null);
  const res = cloud ? await api(`/${id}`) : { status: 404, body: null };
  const remote = res.status === 200 ? (res.body as CloudWorkspace & { files: CloudIndexEntry[] }) : undefined;
  if (!local && !remote) return;

  const cIdx = new Map((remote?.files ?? []).map((f) => [f.path, f]));
  const paths = new Set([...(local?.files.keys() ?? []), ...cIdx.keys()]);
  const push: string[] = [];
  const pull: string[] = [];
  let conflicts = 0;
  const localNewer = (local?.meta.updatedAt ?? 0) > (remote?.updatedAt ?? 0);
  for (const p of paths) {
    const l = local?.files.get(p)?.hash;
    const c = cIdx.get(p)?.hash;
    if (l === c) continue;
    const b = base?.[p];
    if (base && l === b) pull.push(p);
    else if (base && c === b) push.push(p);
    else if (!remote) push.push(p);
    else if (!local) pull.push(p);
    else if (!base) (localNewer ? push : pull).push(p);
    else {
      pull.push(p); // changed on both sides: the cloud wins
      conflicts++;
    }
  }

  let ws: Workspace | undefined = local;
  if (pull.length) {
    const want = pull.filter((p) => cIdx.has(p));
    const got = await readCloud(id, want);
    const files = new Map(local?.files ?? []);
    for (const p of pull) if (!cIdx.has(p)) files.delete(p);
    for (const f of got) files.set(f.path, f);
    const now = Date.now();
    ws = { meta: local ? { ...local.meta, updatedAt: now } : { id, schemaVersion: 2, createdAt: remote!.createdAt, updatedAt: remote!.updatedAt }, files };
    await adopt(ws, label);
    if (conflicts) toast('warning', `${conflicts} file(s) in "${remote?.name}" were changed by Claude and here at the same time; the cloud version was kept.`);
  }
  if (push.length && ws) {
    const cloudHash = (p: string) => cIdx.get(p)?.hash ?? null;
    if (!(await pushFiles(ws, push, cloudHash))) {
      // Changed in the cloud while we were pushing: go round again (the cloud wins conflicts).
      return syncOne(id, label, { ...(remote ?? { id, name: '', revision: '', createdAt: 0, updatedAt: 0 }) });
    }
  } else if (remote) known.set(id, remote.revision);
  if (ws) await setSetting(baseKey(id), Object.fromEntries([...ws.files].map(([p, f]) => [p, f.hash])));
}

async function reconcile() {
  const r = await api('');
  if (r.status !== 200) return;
  const cloud = r.body.workspaces as CloudWorkspace[];
  const tombstones = r.body.tombstones as Record<string, number>;
  const local = await listProjects();
  const cloudById = new Map(cloud.map((c) => [c.id, c]));
  for (const c of cloud) {
    if (known.get(c.id) === c.revision) continue;
    await queue(c.id, () => syncOne(c.id, 'Claude: edits made while away', c));
  }
  for (const l of local) {
    if (cloudById.has(l.id)) continue;
    if (tombstones[l.id] && tombstones[l.id] > l.updatedAt) {
      await removeLocal(l.id);
      continue;
    }
    await setSetting(baseKey(l.id), null);
    await queue(l.id, () => syncOne(l.id, 'Sync'));
  }
  changed();
}

async function removeLocal(id: string) {
  if (useEditor.getState().workspace?.meta.id === id) {
    navigate({ name: 'dashboard' });
    toast('info', 'This project was deleted (by Claude or on another device).');
  }
  await deleteProject(id, { silent: true });
  await setSetting(baseKey(id), null);
  known.delete(id);
  changed();
}

/** A local save: push only the files that changed, each based on the last agreed hash. */
async function pushSaved(d: SavedDetail) {
  const id = d.workspace.meta.id;
  const base = await getSetting<Base | null>(baseKey(id), null);
  if (!base) return syncOne(id, 'Sync', { id, name: '', revision: '', createdAt: 0, updatedAt: 0 });
  const paths = d.changedPaths.filter((p) => (d.workspace.files.get(p)?.hash ?? undefined) !== base[p]);
  if (!paths.length) return;
  if (!(await pushFiles(d.workspace, paths, (p) => base[p] ?? null))) {
    return syncOne(id, 'Claude: newer cloud version', { id, name: '', revision: '', createdAt: 0, updatedAt: 0 });
  }
  const next = { ...base };
  for (const p of paths) {
    const f = d.workspace.files.get(p);
    if (f) next[p] = f.hash;
    else delete next[p];
  }
  await setSetting(baseKey(id), next);
}

function wire() {
  if (wired) return;
  wired = true;
  projectEvents.addEventListener('saved', (e) => {
    const d = (e as CustomEvent<SavedDetail>).detail;
    if (enabled()) void queue(d.workspace.meta.id, () => pushSaved(d)).catch((err) => toast('error', `Cloud sync: ${err instanceof Error ? err.message : String(err)}`));
  });
  projectEvents.addEventListener('deleted', (e) => {
    const id = (e as CustomEvent<string>).detail;
    known.delete(id);
    void setSetting(baseKey(id), null);
    if (enabled()) void api(`/${id}`, { method: 'DELETE' });
  });
  // Tell the cloud which project/graph is open, so "the one I have open" means something to Claude.
  let last = '';
  useEditor.subscribe((s) => {
    const key = `${s.project?.id}|${s.activeScriptId}|${s.activeFunctionId}`;
    if (!s.project || key === last) return;
    last = key;
    sendToCloud({ type: 'active', projectId: s.project.id, scriptId: s.activeScriptId, functionId: s.activeFunctionId });
  });
}

export async function onCloudConnected() {
  wire();
  reconciling ??= reconcile()
    .catch((e) => toast('error', `Cloud sync: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => (reconciling = null));
  await reconciling;
  const s = useEditor.getState();
  if (s.project) sendToCloud({ type: 'active', projectId: s.project.id, scriptId: s.activeScriptId, functionId: s.activeFunctionId });
}

export async function onCloudMessage(msg: Record<string, unknown>) {
  if (msg.type === 'ask' && typeof msg.id === 'string') return void answer(msg);
  if (msg.type !== 'workspace-updated' || typeof msg.id !== 'string') return;
  const id = msg.id;
  if (reconciling) await reconciling;
  if (msg.deleted) {
    if ((await listProjects()).some((p) => p.id === id)) await removeLocal(id);
    return;
  }
  if (known.get(id) === msg.revision) return; // our own save echoing back
  await queue(id, async () => {
    if (known.get(id) === msg.revision) return;
    await syncOne(id, msg.by === 'claude' ? 'Claude edit' : 'Update from another device', { id, name: '', revision: String(msg.revision), createdAt: 0, updatedAt: 0 });
  }).catch((e) => toast('error', `Cloud sync: ${e instanceof Error ? e.message : String(e)}`));
}

/** Questions from the cloud (Claude / ChatGPT working there) that only an open editor can answer. */
async function answer(msg: Record<string, unknown>) {
  const reply = (result: unknown) => sendToCloud({ type: 'answer', id: msg.id, result });
  if (msg.question !== 'type-check' || typeof msg.projectId !== 'string') return;
  const st = useEditor.getState();
  // Only the project open here can be type-checked (its TypeScript service is the one running).
  if (st.project?.id !== msg.projectId) {
    reply({ unavailable: st.project ? 'TypeScript types were not checked: Coding Studio is open on a different project. Open this project there and run check_project again.' : 'TypeScript types were not checked: Coding Studio is open but no project is. Open this project and run check_project again.' });
    return;
  }
  try {
    // Apply any sync for this project first, so the check sees what the cloud has.
    if (reconciling) await reconciling;
    await queue(msg.projectId, async () => undefined);
    const { editorTypeCheck } = await import('../bridge/handlers');
    reply(await editorTypeCheck(useEditor.getState().project!));
  } catch (e) {
    reply({ unavailable: `TypeScript types were not checked: ${e instanceof Error ? e.message : String(e)}` });
  }
}
