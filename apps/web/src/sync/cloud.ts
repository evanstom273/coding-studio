/**
 * Cloud sync for the Claude connector. While the connector is on:
 *  - on connect, this browser and the cloud copy are reconciled (newer copy wins, new projects
 *    go both ways, deletions propagate);
 *  - every save here is pushed up; if Claude changed the project in the meantime, the cloud's
 *    version is kept and loaded here instead (never silently merged);
 *  - edits Claude makes in the cloud arrive live; if that project is open they appear as an
 *    undoable step labelled "Claude: …".
 */
import { migrateProject, projectRevision, type Project } from '@cs/project-format';
import { deleteProject, listProjects, loadProject, projectEvents, saveProject } from '@web/db/projects';
import { useBridge, sendToCloud } from '@web/bridge/client';
import { useEditor } from '@web/store/editor';
import { navigate } from '@web/lib/router';
import { toast } from '@web/store/toasts';

/** Cloud revision this browser last saw for each project. */
const known = new Map<string, string>();
let wired = false;
let reconciling: Promise<void> | null = null;

const enabled = () => useBridge.getState().remoteEnabled && useBridge.getState().remoteStatus === 'connected';
const base = () => `/sync/${useBridge.getState().remoteKey}/projects`;
const changed = () => window.dispatchEvent(new Event('cs:projects-changed'));

async function api(path: string, init?: RequestInit) {
  const r = await fetch(base() + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}

/** Put a cloud copy into this browser (and the editor, if it's the open project). */
async function adopt(raw: unknown, label: string) {
  const p = migrateProject(raw).project;
  known.set(p.id, projectRevision(p));
  await saveProject(p, { silent: true });
  const ed = useEditor.getState();
  if (ed.project?.id === p.id && projectRevision(ed.project) !== projectRevision(p)) {
    ed.replaceProject(p, label, 'mcp');
  }
  changed();
}

async function upload(p: Project) {
  const r = await api(`/${p.id}`, { method: 'PUT', body: JSON.stringify({ doc: p, baseRevision: known.get(p.id) }) });
  if (r.status === 200) known.set(p.id, r.body.revision);
  else if (r.status === 409) {
    await adopt(r.body.conflict, 'Claude: newer cloud version');
    toast('warning', `"${p.name}" was changed by Claude at the same time; the cloud version was kept.`);
  }
}

async function reconcile() {
  const r = await api('');
  if (r.status !== 200) return;
  const cloud = r.body.projects as { id: string; revision: string; updatedAt: number }[];
  const tombstones = r.body.tombstones as Record<string, number>;
  const local = await listProjects();
  const cloudById = new Map(cloud.map((c) => [c.id, c]));
  for (const c of cloud) {
    const l = local.find((x) => x.id === c.id);
    const lp = l ? (await loadProject(c.id))?.project : undefined;
    if (lp && projectRevision(lp) === c.revision) {
      known.set(c.id, c.revision);
      continue;
    }
    if (lp && lp.updatedAt > c.updatedAt) {
      known.set(c.id, c.revision);
      await upload(lp);
    } else {
      const d = await api(`/${c.id}`);
      if (d.status === 200) await adopt(d.body, 'Claude: edits made while away');
    }
  }
  for (const l of local) {
    if (cloudById.has(l.id)) continue;
    if (tombstones[l.id] && tombstones[l.id] > l.updatedAt) {
      await removeLocal(l.id);
      continue;
    }
    const lp = (await loadProject(l.id))?.project;
    if (lp) await upload(lp);
  }
  changed();
}

async function removeLocal(id: string) {
  if (useEditor.getState().project?.id === id) {
    navigate({ name: 'dashboard' });
    toast('info', 'This project was deleted (by Claude or on another device).');
  }
  await deleteProject(id, { silent: true });
  known.delete(id);
  changed();
}

function wire() {
  if (wired) return;
  wired = true;
  projectEvents.addEventListener('saved', (e) => {
    if (enabled()) void upload((e as CustomEvent<Project>).detail);
  });
  projectEvents.addEventListener('deleted', (e) => {
    const id = (e as CustomEvent<string>).detail;
    known.delete(id);
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
  reconciling ??= reconcile().finally(() => (reconciling = null));
  await reconciling;
  const s = useEditor.getState();
  if (s.project) sendToCloud({ type: 'active', projectId: s.project.id, scriptId: s.activeScriptId, functionId: s.activeFunctionId });
}

export async function onCloudMessage(msg: Record<string, unknown>) {
  if (msg.type !== 'project-updated' || typeof msg.id !== 'string') return;
  if (reconciling) await reconciling;
  if (msg.deleted) {
    if ((await listProjects()).some((p) => p.id === msg.id)) await removeLocal(msg.id);
    return;
  }
  if (known.get(msg.id) === msg.revision) return; // our own save echoing back
  const d = await api(`/${msg.id}`);
  if (d.status === 200) await adopt(d.body, msg.by === 'claude' ? 'Claude edit' : 'Update from another device');
}
