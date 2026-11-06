/**
 * Cloud copy of the user's projects, and Claude's editing of them, inside the Durable Object.
 *
 * Claude's MCP tools call `handle(method, params)` — the same methods the editor's own handlers
 * implement — so Claude can work with no browser open. The editor syncs with this copy (see
 * apps/web/src/sync) and gets live updates over its WebSocket.
 *
 * Edits use the same `applyOps` as the editor (validated, atomic). Each Claude batch is undoable
 * here; undo is refused if the project has been changed since (e.g. by the user), so it never
 * throws away someone else's work — restore_backup is the explicit way back in that case.
 */
import { applyOps, createProject, OpError, migrateProject, projectRevision, reidProject, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor, languages } from '@cs/toolchain';
import * as svc from '@cs/project-service';
import type { BridgeMethod } from '../packages/shared-protocol/src/index';

const HISTORY_LIMIT = 30;
const BACKUP_LIMIT = 30;

export interface ProjectSummary {
  id: string;
  name: string;
  language: string;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

interface Meta {
  active?: { projectId?: string; scriptId?: string; functionId?: string };
  /** id → deletion time, so other devices delete their copies too. */
  tombstones: Record<string, number>;
  seq: number;
}

interface HistoryIndex {
  undo: { seq: number; label: string; after: string }[];
  redo: { seq: number; label: string; after: string }[];
}

interface BackupEntry {
  id: number;
  at: number;
  label: string;
  source: string;
}

export type Broadcast = (msg: { type: 'project-updated'; id: string; revision: string; deleted?: boolean; by: 'claude' | 'editor' }) => void;

export class CloudService {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly broadcast: Broadcast,
    private readonly site: string,
    private readonly editorsOpen: () => number,
  ) {}

  // --- storage -----------------------------------------------------------------------------

  private async meta(): Promise<Meta> {
    return ((await this.storage.get<Meta>('meta')) ?? { tombstones: {}, seq: 0 }) as Meta;
  }
  private async setMeta(m: Meta) {
    await this.storage.put('meta', m);
  }
  private async nextSeq() {
    const m = await this.meta();
    m.seq += 1;
    await this.setMeta(m);
    return m.seq;
  }

  async list(): Promise<ProjectSummary[]> {
    const all = await this.storage.list<Project>({ prefix: 'p:' });
    return [...all.values()].map((p) => ({ id: p.id, name: p.name, language: p.language, revision: projectRevision(p), createdAt: p.createdAt, updatedAt: p.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Project | undefined> {
    return this.storage.get<Project>(`p:${id}`);
  }

  async tombstones() {
    return (await this.meta()).tombstones;
  }

  private async save(p: Project, by: 'claude' | 'editor') {
    await this.storage.put(`p:${p.id}`, p);
    const m = await this.meta();
    if (m.tombstones[p.id]) {
      delete m.tombstones[p.id];
      await this.setMeta(m);
    }
    this.broadcast({ type: 'project-updated', id: p.id, revision: projectRevision(p), by });
  }

  /** Editor → cloud. Rejected (with the current copy) if the cloud changed since `baseRevision`. */
  async put(raw: unknown, baseRevision: string | undefined): Promise<{ ok: true; revision: string } | { ok: false; conflict: Project }> {
    const p = migrateProject(raw).project;
    const cur = await this.get(p.id);
    if (cur && baseRevision && baseRevision !== projectRevision(cur)) return { ok: false, conflict: cur };
    await this.save(p, 'editor');
    return { ok: true, revision: projectRevision(p) };
  }

  async remove(id: string, by: 'claude' | 'editor') {
    await this.storage.delete(`p:${id}`);
    const m = await this.meta();
    m.tombstones[id] = Date.now();
    if (m.active?.projectId === id) m.active = undefined;
    await this.setMeta(m);
    this.broadcast({ type: 'project-updated', id, revision: '', deleted: true, by });
  }

  /** The editor reports which project/graph is open, so "the project I have open" works for Claude. */
  async setActive(active: Meta['active']) {
    const m = await this.meta();
    m.active = active;
    await this.setMeta(m);
  }

  // --- history & backups --------------------------------------------------------------------

  private async history(id: string): Promise<HistoryIndex> {
    return (await this.storage.get<HistoryIndex>(`hi:${id}`)) ?? { undo: [], redo: [] };
  }
  private async pushUndo(id: string, before: Project, label: string, after: string) {
    const h = await this.history(id);
    const seq = await this.nextSeq();
    await this.storage.put(`h:${id}:${seq}`, before);
    h.undo.push({ seq, label, after });
    for (const r of h.redo) await this.storage.delete(`h:${id}:${r.seq}`);
    h.redo = [];
    while (h.undo.length > HISTORY_LIMIT) await this.storage.delete(`h:${id}:${h.undo.shift()!.seq}`);
    await this.storage.put(`hi:${id}`, h);
  }

  async backup(p: Project, label: string, source = 'mcp') {
    const idx = (await this.storage.get<BackupEntry[]>(`bi:${p.id}`)) ?? [];
    const id = await this.nextSeq();
    await this.storage.put(`b:${p.id}:${id}`, p);
    idx.unshift({ id, at: Date.now(), label, source });
    while (idx.length > BACKUP_LIMIT) await this.storage.delete(`b:${p.id}:${idx.pop()!.id}`);
    await this.storage.put(`bi:${p.id}`, idx);
  }

  // --- project resolution -----------------------------------------------------------------------

  private async resolve(ref: unknown): Promise<Project> {
    const r = svc.str(ref);
    const projects = await this.list();
    let id: string | undefined;
    if (r) {
      id = projects.find((p) => p.id === r)?.id;
      if (!id) {
        const byName = projects.filter((p) => p.name.toLowerCase() === r.toLowerCase());
        if (byName.length > 1) throw new svc.ServiceError('E_AMBIGUOUS', `Several projects are called "${r}": ${byName.map((p) => p.id).join(', ')}. Use the id.`);
        id = byName[0]?.id;
      }
      if (!id) throw new svc.ServiceError('E_NOT_FOUND', `No project "${r}". Use list_projects.`);
    } else {
      const m = await this.meta();
      id = m.active?.projectId && projects.some((p) => p.id === m.active!.projectId) ? m.active.projectId : projects.length === 1 ? projects[0].id : undefined;
      if (!id) throw new svc.ServiceError('E_NO_PROJECT', projects.length ? 'Several projects exist and none is selected. Pass "project" (id or name) or use open_project.' : 'There are no projects yet. Use create_project.');
    }
    const p = (await this.get(id))!;
    await this.select(p.id);
    return p;
  }

  private async select(projectId: string, functionId?: string) {
    const m = await this.meta();
    if (m.active?.projectId === projectId && !functionId) return;
    const p = await this.get(projectId);
    const fn = functionId ? p?.scripts.flatMap((s) => s.functions.map((f) => ({ s, f }))).find((x) => x.f.id === functionId) : undefined;
    m.active = { projectId, ...(fn ? { scriptId: fn.s.id, functionId: fn.f.id } : m.active?.projectId === projectId ? { scriptId: m.active.scriptId, functionId: m.active.functionId } : {}) };
    await this.setMeta(m);
  }

  private async active() {
    return (await this.meta()).active ?? {};
  }

  // --- MCP methods ---------------------------------------------------------------------------------

  async handle(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.dispatch(method, params);
    } catch (e) {
      if (e instanceof OpError) throw new svc.ServiceError(e.code, e.message, { opIndex: e.opIndex, projectUnchanged: true });
      throw e;
    }
  }

  private async dispatch(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'status': {
        const a = await this.active();
        const p = a.projectId ? await this.get(a.projectId) : undefined;
        return {
          app: 'Coding Studio',
          mode: 'cloud',
          note: `Projects are stored in the cloud and edited directly; the editor does not need to be open. Open ${this.site} to see changes (they appear live in an open editor).`,
          editorsOpen: this.editorsOpen(),
          openProject: p ? { id: p.id, name: p.name, language: p.language, revision: projectRevision(p), activeScript: a.scriptId, activeGraph: a.functionId } : null,
          projects: (await this.list()).length,
          languages: languages.all().map((l) => ({ id: l.id, name: l.name })),
        };
      }
      case 'list_projects':
        return (await this.list()).map((p) => ({ id: p.id, name: p.name, language: p.language, createdAt: p.createdAt, updatedAt: p.updatedAt }));
      case 'create_project': {
        const tc = toolchainFor(svc.str(params.language) ?? 'gdscript');
        const name = svc.str(params.name);
        if (!name) throw new svc.ServiceError('E_INVALID', 'name is required');
        const template = svc.str(params.template) ?? tc.adapter.templates[0]?.id;
        if (template && !tc.adapter.templates.some((t) => t.id === template)) throw new svc.ServiceError('E_INVALID', `Unknown template "${template}". Available: ${tc.adapter.templates.map((t) => t.id).join(', ')}`);
        const scriptName = svc.str(params.script_name) ?? 'Main';
        if (!tc.adapter.identifiers.isValid(scriptName)) throw new svc.ServiceError('E_INVALID_IDENTIFIER', `script_name "${scriptName}" is not a valid identifier`);
        const p = createProject(tc.adapter, name, { template, scriptName });
        await this.save(p, 'claude');
        await this.select(p.id, p.scripts[0]?.functions[0]?.id);
        return svc.describeProject(p, await this.active());
      }
      case 'open_project':
      case 'get_project': {
        const p = await this.resolve(params.project);
        return params.full === true ? p : svc.describeProject(p, await this.active());
      }
      case 'save_project':
        await this.resolve(params.project);
        return { saved: true, state: 'saved', note: 'Cloud projects are saved after every edit.' };
      case 'duplicate_project': {
        const src = await this.resolve(params.project);
        const copy = reidProject(src);
        copy.name = svc.str(params.name) ?? `${src.name} (copy)`;
        copy.createdAt = copy.updatedAt = Date.now();
        await this.save(copy, 'claude');
        return { id: copy.id, name: copy.name };
      }
      case 'delete_project': {
        const p = await this.resolve(params.project);
        await this.backup(p, 'Before Claude deleted the project');
        await this.remove(p.id, 'claude');
        return { deleted: p.id, note: 'A backup was kept; it can be recovered by recreating the project from that backup if needed.' };
      }
      case 'list_graphs':
        return svc.listGraphs(await this.resolve(params.project));
      case 'get_graph': {
        const p = await this.resolve(params.project);
        const { script, fn } = svc.locateFunction(p, params.graph, params.script, (await this.active()).functionId);
        if (params.focus !== false) await this.select(p.id, fn.id);
        return svc.describeGraph(p, script, fn);
      }
      case 'list_node_types':
        return svc.listNodeTypes(svc.str(params.language) ?? 'gdscript', svc.str(params.category));
      case 'search_nodes':
        return svc.searchNodes(svc.str(params.language) ?? 'gdscript', String(params.query ?? ''), Number(params.limit) || 25);
      case 'get_node_schema': {
        const a = await this.active();
        const p = a.projectId ? await this.get(a.projectId) : undefined;
        return svc.nodeSchema(p?.language ?? 'gdscript', String(params.type ?? ''), params.props as Record<string, unknown> | undefined, p ? { project: p, ...svc.locateFunction(p, params.graph, params.script, a.functionId) } : undefined);
      }
      case 'list_language_capabilities':
        return svc.languageCapabilities(svc.str(params.language) ?? 'gdscript');
      case 'batch_edit': {
        const p = await this.resolve(params.project);
        const ops = params.operations as EditOp[];
        if (!Array.isArray(ops) || !ops.length) throw new svc.ServiceError('E_INVALID', 'operations must be a non-empty array');
        const current = projectRevision(p);
        const expected = svc.str(params.expected_revision);
        if (expected && expected !== current) throw new svc.ServiceError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${current}) — probably the user edited it. Nothing was applied. Re-read the graph (get_graph) and retry with the new revision.`, { expected, current });
        const a = await this.active();
        const defaults = {
          scriptId: svc.str(params.script) ? p.scripts.find((s) => s.id === params.script || s.name === params.script)?.id : a.projectId === p.id ? a.scriptId : undefined,
          functionId: svc.str(params.graph) ? svc.locateFunction(p, params.graph, params.script).fn.id : a.projectId === p.id ? a.functionId : undefined,
        };
        const res = applyOps(p, ops, toolchainFor(p.language), defaults);
        const next: Project = { ...res.project, updatedAt: Date.now() };
        const label = `Claude: ${ops.length === 1 ? ops[0].op.replace(/_/g, ' ') : `${ops.length} edits`}`;
        if (svc.isSubstantial(ops)) await this.backup(p, `Before Claude batch (${ops.length} ops)`);
        await this.pushUndo(p.id, p, label, projectRevision(next));
        await this.save(next, 'claude');
        return { revision: projectRevision(next), created: res.created, warnings: res.warnings, diagnostics: svc.diagSummary(svc.compileAll(next).diagnostics), undo: 'This batch is one undo step (tool "undo").' };
      }
      case 'validate_graph': {
        const p = await this.resolve(params.project);
        return svc.validate(p, params.graph, params.script, (await this.active()).functionId);
      }
      case 'compile_script':
        return svc.compileOne(await this.resolve(params.project), params.script, (await this.active()).scriptId);
      case 'compile_project':
        return svc.compileAll(await this.resolve(params.project));
      case 'export_files':
        return svc.exportFiles(await this.resolve(params.project), params.script, params.include_project === true);
      case 'undo':
      case 'redo': {
        const p = await this.resolve(params.project);
        const h = await this.history(p.id);
        const from = method === 'undo' ? h.undo : h.redo;
        const entry = from[from.length - 1];
        if (!entry) throw new svc.ServiceError(method === 'undo' ? 'E_NOTHING_TO_UNDO' : 'E_NOTHING_TO_REDO', `Nothing to ${method} (only Claude's edits can be undone from here; the editor has its own Ctrl+Z).`);
        const cur = projectRevision(p);
        if (method === 'undo' && entry.after !== cur) throw new svc.ServiceError('E_REVISION_CONFLICT', 'The project was changed after that edit (probably in the editor), so undoing it here could throw that work away. Use list_backups / restore_backup, or undo in the editor.');
        const target = await this.storage.get<Project>(`h:${p.id}:${entry.seq}`);
        if (!target) throw new svc.ServiceError('E_NOT_FOUND', 'That history step is no longer available.');
        from.pop();
        const seq = await this.nextSeq();
        await this.storage.put(`h:${p.id}:${seq}`, p);
        const restored = { ...target, updatedAt: Date.now() };
        (method === 'undo' ? h.redo : h.undo).push({ seq, label: entry.label, after: projectRevision(restored) });
        await this.storage.delete(`h:${p.id}:${entry.seq}`);
        await this.storage.put(`hi:${p.id}`, h);
        await this.save(restored, 'claude');
        return { [method === 'undo' ? 'undone' : 'redone']: entry.label, revision: projectRevision(restored) };
      }
      case 'list_backups': {
        const p = await this.resolve(params.project);
        return ((await this.storage.get<BackupEntry[]>(`bi:${p.id}`)) ?? []).map((b) => ({ ...b, projectId: p.id }));
      }
      case 'restore_backup': {
        const p = await this.resolve(params.project);
        const doc = await this.storage.get<Project>(`b:${p.id}:${Number(params.backup)}`);
        if (!doc) throw new svc.ServiceError('E_NOT_FOUND', `Backup ${String(params.backup)} not found for this project. Use list_backups.`);
        await this.backup(p, 'Before restoring a backup (Claude)');
        const restored = { ...doc, id: p.id, updatedAt: Date.now() };
        await this.pushUndo(p.id, p, 'Claude: restore backup', projectRevision(restored));
        await this.save(restored, 'claude');
        const idx = (await this.storage.get<BackupEntry[]>(`bi:${p.id}`)) ?? [];
        return { restored: Number(params.backup), label: idx.find((b) => b.id === Number(params.backup))?.label, revision: projectRevision(restored) };
      }
      case 'confirm_overwrite':
        return { approved: false };
    }
  }
}
