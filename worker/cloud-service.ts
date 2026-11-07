/**
 * Cloud copy of the user's projects, and Claude's editing of them, inside the Durable Object.
 *
 * Projects are workspaces stored per file (see cloud-store.ts). Claude's MCP tools call
 * `handle(method, params)` — the same methods the editor's own handlers implement — so Claude can
 * work with no browser open. The editor syncs file by file (apps/web/src/sync) and gets live
 * updates over its WebSocket.
 *
 * Graph edits use the same EditOp engine as the editor (validated, atomic) and rewrite only the
 * `.vgraph` files they touch. Each Claude batch is one undo step here; undo is refused if those
 * files changed since (e.g. the user edited them), so it never throws away someone else's work.
 */
import { createProject, OpError, projectRevision, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor, languages } from '@cs/toolchain';
import * as svc from '@cs/project-service';
import { applyProjectOps, applyWorkspaceOps, CONFIG_PATH, deriveProject, makeRecord, projectToWorkspace, reidWorkspace, WorkspaceOpError, type Workspace } from '@cs/workspace';
import { newId } from '@cs/graph-core';
import { buildWebStarter } from '@cs/examples';
import type { BridgeMethod } from '../packages/shared-protocol/src/index';
import { CloudStore, diffFiles, type StoreBackend } from './cloud-store';
import { CloudflareVault } from './cloudflare';
import { GitHubVault } from './github';
import { cloneFiles, commitAndPush, createRepoFor, switchBranch, GitHubError, pull, readState, stateRecord } from '@cs/git';
import { defaultConfig, serializeConfig } from '@cs/workspace';

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
  /** 2 once schema-1 whole-project entries have been converted to per-file storage. */
  layout?: number;
}

export type Broadcast = (msg: { type: 'workspace-updated'; id: string; revision: string; paths?: string[]; deleted?: boolean; by: 'claude' | 'editor' }) => void;

/** Only what the graph tools need: codingstudio.json and the graph files. */
const graphOnly = (e: { path: string; kind: string }) => e.kind === 'graph' || e.path === CONFIG_PATH;

/** The KV half of Durable Object storage that this service uses (meta + legacy entries). */
export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>;
}

export class CloudService {
  readonly store: CloudStore;
  constructor(
    private readonly kv: KvLike,
    backend: StoreBackend,
    private readonly broadcast: Broadcast,
    private readonly site: string,
    private readonly editorsOpen: () => number,
  ) {
    this.store = new CloudStore(backend);
  }

  /** GitHub (token in this Durable Object). Overridable for tests. */
  github = () => new GitHubVault(this.kv);
  cloudflare = () => new CloudflareVault(this.kv);

  // --- meta ----------------------------------------------------------------------------------

  private async meta(): Promise<Meta> {
    return ((await this.kv.get<Meta>('meta')) ?? { tombstones: {} }) as Meta;
  }
  private async setMeta(m: Meta) {
    await this.kv.put('meta', m);
  }

  /** One-time conversion of schema-1 storage (one JSON document per project) to per-file storage. */
  async migrate() {
    const m = await this.meta();
    if (m.layout === 2) return;
    const old = await this.kv.list<Project>({ prefix: 'p:' });
    for (const [key, p] of old) {
      if (!this.store.get(p.id)) {
        const ws = projectToWorkspace(p);
        this.store.write(p.id, diffFiles(new Map(), ws.files), { createdAt: p.createdAt });
      }
      const backups = (await this.kv.get<{ id: number; at: number; label: string; source: string }[]>(`bi:${p.id}`)) ?? [];
      for (const b of backups.reverse()) {
        const doc = await this.kv.get<Project>(`b:${p.id}:${b.id}`);
        if (doc) this.store.importBackup(p.id, b.label, b.source, b.at, [...projectToWorkspace({ ...doc, id: p.id }).files.values()]);
        await this.kv.delete(`b:${p.id}:${b.id}`);
      }
      await this.kv.delete(`bi:${p.id}`);
      const hist = await this.kv.list<unknown>({ prefix: `h:${p.id}:` });
      for (const k of hist.keys()) await this.kv.delete(k);
      await this.kv.delete(`hi:${p.id}`);
      await this.kv.delete(key);
    }
    m.layout = 2;
    await this.setMeta(m);
  }

  list(): ProjectSummary[] {
    return this.store.list();
  }

  async tombstones() {
    return (await this.meta()).tombstones;
  }

  /** The project view (graph files + config only; other files are not loaded). */
  private project(id: string): { ws: Workspace; project: Project } | undefined {
    const ws = this.store.read(id, graphOnly);
    return ws ? { ws, project: deriveProject(ws).project } : undefined;
  }

  private async changed(id: string, revision: string, paths: string[], by: 'claude' | 'editor') {
    const m = await this.meta();
    if (m.tombstones[id]) {
      delete m.tombstones[id];
      await this.setMeta(m);
    }
    this.broadcast({ type: 'workspace-updated', id, revision, paths, by });
  }

  /** Write a new snapshot of (a subset of) a workspace: only paths that differ are stored. */
  private async commit(before: Workspace | undefined, after: Workspace, by: 'claude' | 'editor', history?: { label: string; source: string }) {
    const changes = diffFiles(before?.files ?? new Map(), after.files);
    const r = this.store.write(after.meta.id, changes, { createdAt: after.meta.createdAt, history });
    if (!r.ok) throw new svc.ServiceError('E_REVISION_CONFLICT', 'Changed concurrently');
    if (r.changed.length) await this.changed(after.meta.id, r.revision, r.changed, by);
    return r.revision;
  }

  async remove(id: string, by: 'claude' | 'editor') {
    this.store.removeWorkspace(id);
    const m = await this.meta();
    m.tombstones[id] = Date.now();
    if (m.active?.projectId === id) m.active = undefined;
    await this.setMeta(m);
    this.broadcast({ type: 'workspace-updated', id, revision: '', deleted: true, by });
  }

  // --- editor sync -------------------------------------------------------------------------------

  /**
   * Editor → cloud. `changes` carry the hash the editor based each file on (`base`, null = new
   * file); if any differs from the cloud, nothing is written and the conflicting paths come back.
   */
  async apply(id: string, body: { createdAt?: number; changes: { path: string; base?: string | null; delete?: boolean; kind?: string; text?: string; base64?: string }[] }) {
    const expected: Record<string, string | null> = {};
    const changes = body.changes.map((c) => {
      if (c.base !== undefined) expected[c.path] = c.base;
      if (c.delete) return { path: c.path };
      const content = c.base64 !== undefined ? Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0)) : (c.text ?? '');
      return { path: c.path, record: makeRecordFor(c.path, content, c.kind) };
    });
    const r = this.store.write(id, changes, { createdAt: body.createdAt, expected });
    if (r.ok && r.changed.length) await this.changed(id, r.revision, r.changed, 'editor');
    return r;
  }

  /** The editor reports which project/graph is open, so "the project I have open" works for Claude. */
  async setActive(active: Meta['active']) {
    const m = await this.meta();
    m.active = active;
    await this.setMeta(m);
  }

  // --- project resolution -----------------------------------------------------------------------

  private async resolve(ref: unknown): Promise<{ ws: Workspace; project: Project }> {
    const r = svc.str(ref);
    const projects = this.list();
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
    const v = this.project(id)!;
    await this.select(id);
    return v;
  }

  private async select(projectId: string, functionId?: string) {
    const m = await this.meta();
    if (m.active?.projectId === projectId && !functionId) return;
    const p = functionId ? this.project(projectId)?.project : undefined;
    const fn = functionId ? p?.scripts.flatMap((s) => s.functions.map((f) => ({ s, f }))).find((x) => x.f.id === functionId) : undefined;
    m.active = { projectId, ...(fn ? { scriptId: fn.s.id, functionId: fn.f.id } : m.active?.projectId === projectId ? { scriptId: m.active.scriptId, functionId: m.active.functionId } : {}) };
    await this.setMeta(m);
  }

  private async active() {
    return (await this.meta()).active ?? {};
  }

  // --- MCP methods ---------------------------------------------------------------------------------

  /** Put the saved Cloudflare credentials into the project's repository secrets. */
  private async cloudflareSecrets(ws: Workspace) {
    const st = svc.requireLinked(readState(ws));
    return this.cloudflare().setRepoSecrets(await this.github().client(), st.owner, st.repo);
  }

  /** Switch a project to another branch (unchanged files take that branch's version; changes are kept). */
  private async switchTo(project: unknown, branch: string) {
    const { project: p } = await this.resolve(project);
    const ws = this.store.read(p.id)!;
    const r = await switchBranch(await this.github().client(), ws, branch, new Set(svc.generatedOutputs(p).map((g) => g.path)));
    const files = new Map(ws.files);
    for (const [path, f] of r.updates) {
      if (f) files.set(path, f);
      else files.delete(path);
    }
    files.set('.codingstudio/git.json', stateRecord(r.state));
    await this.commit(ws, { meta: ws.meta, files }, 'claude', { label: `Claude: switch to branch ${branch}`, source: 'claude' });
    return svc.switchView(r);
  }

  async handle(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.dispatch(method, params);
    } catch (e) {
      if (e instanceof OpError) throw new svc.ServiceError(e.code, e.message, { opIndex: e.opIndex, projectUnchanged: true });
      if (e instanceof GitHubError) throw new svc.ServiceError(e.code, e.message);
      if (typeof (e as { code?: unknown })?.code === 'string' && e instanceof Error && !(e instanceof svc.ServiceError) && !(e instanceof WorkspaceOpError)) throw new svc.ServiceError((e as unknown as { code: string }).code, e.message);
      if (e instanceof WorkspaceOpError) throw new svc.ServiceError(e.code, e.message, { ...((e.details as object) ?? {}), opIndex: e.opIndex, projectUnchanged: true });
      throw e;
    }
  }

  private async dispatch(method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> {
    await this.migrate();
    switch (method) {
      case 'status': {
        const a = await this.active();
        const v = a.projectId ? this.project(a.projectId) : undefined;
        const p = v?.project;
        return {
          app: 'Coding Studio',
          mode: 'cloud',
          note: `Projects are stored in the cloud and edited directly; the editor does not need to be open. Open ${this.site} to see changes (they appear live in an open editor).`,
          editorsOpen: this.editorsOpen(),
          openProject: p ? { id: p.id, name: p.name, language: p.language, revision: projectRevision(p), activeScript: a.scriptId, activeGraph: a.functionId } : null,
          projects: this.list().length,
          languages: languages.all().map((l) => ({ id: l.id, name: l.name })),
        };
      }
      case 'list_projects':
        return this.list().map((p) => ({ id: p.id, name: p.name, language: p.language, createdAt: p.createdAt, updatedAt: p.updatedAt }));
      case 'create_project': {
        const tc = toolchainFor(svc.str(params.language) ?? 'gdscript');
        const name = svc.str(params.name);
        if (!name) throw new svc.ServiceError('E_INVALID', 'name is required');
        const template = svc.str(params.template) ?? tc.adapter.templates[0]?.id;
        if (template && !tc.adapter.templates.some((t) => t.id === template)) throw new svc.ServiceError('E_INVALID', `Unknown template "${template}". Available: ${tc.adapter.templates.map((t) => t.id).join(', ')}`);
        const scriptName = svc.str(params.script_name) ?? 'Main';
        if (!tc.adapter.identifiers.isValid(scriptName)) throw new svc.ServiceError('E_INVALID_IDENTIFIER', `script_name "${scriptName}" is not a valid identifier`);
        if (tc.adapter.id === 'typescript' && template === 'web-app') {
          const ws = buildWebStarter(tc, name);
          await this.commit(undefined, ws, 'claude');
          await this.select(ws.meta.id);
          return svc.describeProject(this.project(ws.meta.id)!.project, await this.active());
        }
        const p = createProject(tc.adapter, name, { template, scriptName });
        await this.commit(undefined, projectToWorkspace(p), 'claude');
        await this.select(p.id, p.scripts[0]?.functions[0]?.id);
        return svc.describeProject(this.project(p.id)!.project, await this.active());
      }
      case 'open_project':
      case 'get_project': {
        const { project } = await this.resolve(params.project);
        return params.full === true ? project : svc.describeProject(project, await this.active());
      }
      case 'save_project':
        await this.resolve(params.project);
        return { saved: true, state: 'saved', note: 'Cloud projects are saved after every edit.' };
      case 'duplicate_project': {
        const { ws } = await this.resolve(params.project);
        const full = this.store.read(ws.meta.id)!;
        const name = svc.str(params.name) ?? `${deriveProject(ws).project.name} (copy)`;
        const copy = reidWorkspace(full, newId('p'), name);
        await this.commit(undefined, copy, 'claude');
        return { id: copy.meta.id, name };
      }
      case 'delete_project': {
        const { ws } = await this.resolve(params.project);
        this.store.backup(ws.meta.id, 'Before Claude deleted the project');
        await this.remove(ws.meta.id, 'claude');
        return { deleted: ws.meta.id, note: 'A backup was kept in the cloud store.' };
      }
      case 'list_graphs':
        return svc.listGraphs((await this.resolve(params.project)).project);
      case 'get_graph': {
        const { project: p } = await this.resolve(params.project);
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
        const p = a.projectId ? this.project(a.projectId)?.project : undefined;
        return svc.nodeSchema(p?.language ?? 'gdscript', String(params.type ?? ''), params.props as Record<string, unknown> | undefined, p ? { project: p, ...svc.locateFunction(p, params.graph, params.script, a.functionId) } : undefined);
      }
      case 'list_language_capabilities':
        return svc.languageCapabilities(svc.str(params.language) ?? 'gdscript');
      case 'batch_edit': {
        const { ws, project: p } = await this.resolve(params.project);
        const ops = params.operations as EditOp[];
        if (!Array.isArray(ops) || !ops.length) throw new svc.ServiceError('E_INVALID', 'operations must be a non-empty array');
        const current = projectRevision(p);
        const expected = svc.str(params.expected_revision);
        if (expected && expected !== current) throw new svc.ServiceError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${current}) — probably the user edited it. Nothing was applied. Re-read the graph (get_graph) and retry with the new revision.`, { expected, current });
        const a = await this.active();
        const defaults = {
          scriptId: svc.str(params.script) ? svc.findScript(p, params.script)?.id : a.projectId === p.id ? a.scriptId : undefined,
          functionId: svc.str(params.graph) ? svc.locateFunction(p, params.graph, params.script).fn.id : a.projectId === p.id ? a.functionId : undefined,
        };
        const r = applyProjectOps(ws, ops, toolchainFor(p.language), defaults);
        const label = `Claude: ${ops.length === 1 ? ops[0].op.replace(/_/g, ' ') : `${ops.length} edits`}`;
        if (svc.isSubstantial(ops)) this.store.backup(p.id, `Before Claude batch (${ops.length} ops)`);
        await this.commit(ws, r.workspace, 'claude', { label, source: 'claude' });
        const next = deriveProject(r.workspace).project;
        return { revision: projectRevision(next), created: r.result.created, warnings: r.result.warnings, diagnostics: svc.diagSummary(svc.compileAll(next).diagnostics), undo: 'This batch is one undo step (tool "undo").' };
      }
      case 'validate_graph': {
        const { project: p } = await this.resolve(params.project);
        return svc.validate(p, params.graph, params.script, (await this.active()).functionId);
      }
      case 'compile_script':
        return svc.compileOne((await this.resolve(params.project)).project, params.script, (await this.active()).scriptId);
      case 'compile_project':
        return svc.compileAll((await this.resolve(params.project)).project);
      case 'export_files':
        return svc.exportFiles((await this.resolve(params.project)).project, params.script, params.include_project === true);
      case 'undo':
      case 'redo': {
        const { project: p } = await this.resolve(params.project);
        const r = this.store.step(p.id, method);
        if (!r.ok && r.reason === 'empty') throw new svc.ServiceError(method === 'undo' ? 'E_NOTHING_TO_UNDO' : 'E_NOTHING_TO_REDO', `Nothing to ${method} (only Claude's edits can be undone from here; the editor has its own Ctrl+Z).`);
        if (!r.ok) throw new svc.ServiceError('E_REVISION_CONFLICT', `${r.paths?.join(', ')} changed after that edit (probably in the editor), so ${method === 'undo' ? 'undoing' : 'redoing'} it here could throw that work away. Use list_backups / restore_backup, or undo in the editor.`);
        await this.changed(p.id, r.revision, r.changed, 'claude');
        return { [method === 'undo' ? 'undone' : 'redone']: r.label, revision: projectRevision(this.project(p.id)!.project) };
      }
      case 'list_backups': {
        const { project: p } = await this.resolve(params.project);
        return this.store.steps(p.id, 'backup').map((b) => ({ id: b.id, at: b.at, label: b.label, source: b.source, projectId: p.id }));
      }
      case 'restore_backup': {
        const { project: p } = await this.resolve(params.project);
        const files = this.store.backupFiles(p.id, Number(params.backup));
        if (!files) throw new svc.ServiceError('E_NOT_FOUND', `Backup ${String(params.backup)} not found for this project. Use list_backups.`);
        const label = this.store.steps(p.id, 'backup').find((b) => b.id === Number(params.backup))?.label;
        this.store.backup(p.id, 'Before restoring a backup (Claude)');
        const before = this.store.read(p.id)!;
        await this.commit(before, { meta: before.meta, files: new Map(files.map((f) => [f.path, f])) }, 'claude', { label: 'Claude: restore backup', source: 'claude' });
        return { restored: Number(params.backup), label, revision: projectRevision(this.project(p.id)!.project) };
      }
      case 'read_tree': {
        const { project: p } = await this.resolve(params.project);
        const w = this.store.get(p.id)!;
        return svc.describeTree(this.store.index(p.id), { path: params.path, depth: params.depth, revision: w.revision, generated: svc.compileAll(p).files.map((f) => f.path) });
      }
      case 'read_files': {
        const { project: p } = await this.resolve(params.project);
        const wanted = Array.isArray(params.paths) ? params.paths.map(String) : [];
        const recs = new Map(this.store.readPaths(p.id, wanted.map((x) => x.replace(/^\/+/, ''))).map((f) => [f.path, f]));
        let gen: { path: string; content: string }[] | undefined;
        return svc.readFilesView(params.paths, (x) => recs.get(x), (x) => (gen ??= svc.compileAll(p).files).find((f) => f.path === x)?.content);
      }
      case 'read_config': {
        const { project: p } = await this.resolve(params.project);
        const path = String(params.path ?? '');
        return svc.configView(path, this.store.readPaths(p.id, [path])[0]?.text);
      }
      case 'edit_config': {
        const { project: p } = await this.resolve(params.project);
        const path = String(params.path ?? '');
        const before = this.store.read(p.id)!;
        const cur = before.files.get(path);
        const r = svc.configEdit(path, cur?.text, params.edits);
        const w = applyWorkspaceOps(before, [{ op: 'write_file', path, content: r.content, expectedHash: cur ? cur.hash : null }]);
        await this.commit(before, w.workspace, 'claude', { label: `Claude: edit ${path.split('/').pop()}`, source: 'claude' });
        return { path, hash: w.workspace.files.get(path)?.hash, problems: r.problems };
      }
      case 'search_files': {
        const { project: p } = await this.resolve(params.project);
        return svc.searchView(this.store.read(p.id, (e) => e.kind === 'text')!.files.values(), params);
      }
      case 'workspace_batch': {
        const { project: p } = await this.resolve(params.project);
        const before = this.store.read(p.id)!;
        const current = this.store.get(p.id)!.revision;
        const expected = svc.str(params.expected_revision);
        if (expected && expected !== current) throw new svc.ServiceError('E_REVISION_CONFLICT', `The project's files changed since revision ${expected} (now ${current}). Nothing was applied. Re-read (read_tree / read_files) and retry, or use per-file expected_hash.`, { expected, current });
        const a = await this.active();
        const { ops, destructive, touchesGraphs } = svc.prepareBatch(p, params.operations, a.projectId === p.id ? a : {});
        const r = applyWorkspaceOps(before, ops, toolchainFor(p.language));
        if (destructive || ops.length >= 20) this.store.backup(p.id, `Before Claude file batch (${ops.length} ops)`);
        const label = `Claude: ${ops.length === 1 ? ops[0].op.replace(/_/g, ' ') : `${ops.length} file changes`}`;
        const revision = await this.commit(before, r.workspace, 'claude', { label, source: 'claude' });
        const next = deriveProject(r.workspace).project;
        return {
          workspace_revision: revision,
          revision: projectRevision(next),
          changed: r.changedPaths.map((path) => ({ path, hash: r.workspace.files.get(path)?.hash ?? null })),
          created: r.created,
          warnings: r.warnings,
          ...(touchesGraphs ? { diagnostics: svc.diagSummary(svc.compileAll(next).diagnostics) } : {}),
          undo: 'This batch is one undo step (tool "undo").',
        };
      }
      case 'git_status': {
        const { project: p } = await this.resolve(params.project);
        // Status needs only hashes: build the view from the index (no file contents loaded).
        const idx = this.store.index(p.id);
        const state = this.store.readPaths(p.id, ['.codingstudio/git.json'])[0];
        const files = new Map(idx.map((e) => [e.path, e.path === state?.path ? state : { ...e, kind: e.kind }]));
        return svc.gitStatusView({ meta: { id: p.id, schemaVersion: 2, createdAt: 0, updatedAt: 0 }, files } as Workspace, svc.generatedOutputs(p));
      }
      case 'git_commit': {
        const { project: p } = await this.resolve(params.project);
        const ws = this.store.read(p.id)!;
        const r = await commitAndPush(await this.github().client(), ws, String(params.message ?? ''), { paths: Array.isArray(params.paths) ? params.paths.map(String) : undefined, newBranch: svc.str(params.new_branch), generated: svc.generatedOutputs(p, { strict: true }) });
        const files = new Map(ws.files);
        files.set('.codingstudio/git.json', stateRecord(r.state));
        await this.commit(ws, { meta: ws.meta, files }, 'claude', { label: `Claude: commit "${String(params.message).split('\n')[0]}"`, source: 'claude' });
        return { commit: r.commit, branch: r.branch, files: r.files };
      }
      case 'git_pull': {
        const { project: p } = await this.resolve(params.project);
        const ws = this.store.read(p.id)!;
        const r = await pull(await this.github().client(), ws, new Set(svc.generatedOutputs(p).map((g) => g.path)));
        if (!r.upToDate) {
          const files = new Map(ws.files);
          for (const [path, f] of r.updates) {
            if (f) files.set(path, f);
            else files.delete(path);
          }
          files.set('.codingstudio/git.json', stateRecord(r.state));
          await this.commit(ws, { meta: ws.meta, files }, 'claude', { label: `Claude: pull ${r.state.branch}`, source: 'claude' });
        }
        return svc.pullView(r);
      }
      case 'git_create_pr':
      case 'git_pr_list':
      case 'git_pr_get':
      case 'git_pr_update':
      case 'git_pr_merge':
      case 'git_repo_create':
      case 'git_repo_update':
      case 'git_repo_delete': {
        // Repository-level calls work without a project; with one, they default to its repository.
        let st: ReturnType<typeof readState> = null;
        if (!(typeof params.repository === 'string' && params.repository.trim()) && method !== 'git_repo_create') {
          const { project: p } = await this.resolve(params.project);
          st = readState(this.store.read(p.id, (e) => e.path === '.codingstudio/git.json')!);
        }
        const gh = await this.github().client();
        if (method === 'git_pr_merge') {
          const r = (await svc.githubCall(method, gh, params, st)) as { into: string; deleted_branch?: string };
          if (st && r.deleted_branch === st.branch && !svc.str(params.repository)) return { ...r, switched_project_to: await this.switchTo(params.project, r.into) };
          return r;
        }
        return svc.githubCall(method, gh, params, st);
      }
      case 'git_branches': {
        const { project: p } = await this.resolve(params.project);
        const st = svc.requireLinked(readState(this.store.read(p.id, (e) => e.path === '.codingstudio/git.json')!));
        const gh = await this.github().client();
        const [bs, info] = await Promise.all([gh.branches(st.owner, st.repo), gh.repo(st.owner, st.repo)]);
        return { current: st.branch, default: info.default_branch, current_exists: bs.some((b) => b.name === st.branch), branches: bs.map((b) => b.name) };
      }
      case 'git_switch_branch':
        return this.switchTo(params.project, String(params.branch ?? ''));
      case 'git_publish': {
        const { project: p } = await this.resolve(params.project);
        const ws = this.store.read(p.id)!;
        if (readState(ws)) throw new svc.ServiceError('E_INVALID', 'This project is already linked to a GitHub repository.');
        const generated = svc.generatedOutputs(p, { strict: true }); // refuse before creating the repository
        const gh = await this.github().client();
        const { state, url } = await createRepoFor(gh, { name: String(params.name ?? ''), description: svc.str(params.description), private: params.private !== false, org: svc.str(params.org) });
        const linked = new Map(ws.files);
        linked.set('.codingstudio/git.json', stateRecord(state));
        const r = await commitAndPush(gh, { meta: ws.meta, files: linked }, svc.str(params.message) ?? 'First commit from Coding Studio', { generated });
        linked.set('.codingstudio/git.json', stateRecord(r.state));
        await this.commit(ws, { meta: ws.meta, files: linked }, 'claude', { label: `Claude: publish to ${state.owner}/${state.repo}`, source: 'claude' });
        return { repository: `${state.owner}/${state.repo}`, url, branch: r.branch, commit: r.commit, files: r.files };
      }
      case 'git_clone': {
        const [owner, repo] = String(params.repository ?? '').split('/');
        if (!owner || !repo) throw new svc.ServiceError('E_INVALID', 'repository must be "owner/name"');
        const c = await cloneFiles(await this.github().client(), owner, repo, svc.str(params.branch));
        const now = Date.now();
        const files = new Map(c.files.map((f) => [f.path, f]));
        if (!files.has(CONFIG_PATH)) files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(defaultConfig(c.state.repo)), now));
        const ws: Workspace = svc.stripGenerated({ meta: { id: newId('p'), schemaVersion: 2, createdAt: now, updatedAt: now }, files });
        await this.commit(undefined, ws, 'claude');
        await this.select(ws.meta.id);
        return { project: ws.meta.id, files: ws.files.size, ...svc.gitStatusView(ws, svc.workspaceOutputs(ws, false)) };
      }
      case 'git_repos':
        return (await (await this.github().client()).repos()).map((r) => ({ repository: r.full_name, private: r.private, default_branch: r.default_branch, updated: r.updated_at }));
      case 'ci_status':
      case 'ci_run':
      case 'ci_run_details':
      case 'ci_logs':
      case 'ci_rerun': {
        const { project: p } = await this.resolve(params.project);
        const st = svc.requireLinked(readState(this.store.read(p.id, (e) => e.path === '.codingstudio/git.json')!));
        const paths = new Set(this.store.index(p.id).map((e) => e.path));
        return svc.ciCall(method, await this.github().client(), st, params, (x) => paths.has(x));
      }
      case 'ci_add_workflow': {
        const { project: p } = await this.resolve(params.project);
        const before = this.store.read(p.id)!;
        const fs = svc.workflowTemplateFiles(params.template, before.files, p.name);
        const r = applyWorkspaceOps(before, fs.map((f) => ({ op: 'write_file' as const, path: f.path, content: f.content, expectedHash: null })));
        await this.commit(before, r.workspace, 'claude', { label: `Claude: add workflow ${fs[0].path}`, source: 'claude' });
        // The Cloudflare deploy needs its two repository secrets: set them from the saved credentials.
        const secrets = params.template === 'cloudflare' ? await this.cloudflareSecrets(before).catch((e: Error & { code?: string }) => ({ not_set: e.code ?? 'E_CLOUDFLARE', reason: e.message })) : undefined;
        return { added: fs.map((f) => f.path), files: fs, ...(secrets ? { secrets } : {}), note: 'Commit them with git_commit to turn the workflow on.' };
      }
      case 'ci_cloudflare_secrets': {
        const { project: p } = await this.resolve(params.project);
        return this.cloudflareSecrets(this.store.read(p.id, (e) => e.path === '.codingstudio/git.json')!);
      }
      case 'deps_list':
      case 'deps_search':
      case 'deps_add':
      case 'deps_remove': {
        const { project: p } = await this.resolve(params.project);
        const recs = new Map(this.store.readPaths(p.id, ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']).map((f) => [f.path, f]));
        const r = await svc.depsCall(method, recs, params, async (u) => (await fetch(u, { headers: { 'User-Agent': 'coding-studio' } })).json(), p.name);
        if (r.write) {
          const before = this.store.read(p.id)!;
          const next = applyWorkspaceOps(before, [{ op: 'write_file', path: r.write.path, content: r.write.content }]);
          await this.commit(before, next.workspace, 'claude', { label: r.write.label, source: 'claude' });
        }
        return r.result;
      }
      case 'confirm_overwrite':
        return { approved: false };
    }
  }
}

function makeRecordFor(path: string, content: string | Uint8Array, kind?: string) {
  const k = kind === 'graph' || kind === 'text' || kind === 'binary' ? kind : undefined;
  return makeRecord(path, content, Date.now(), k && (typeof content === 'string') === (k !== 'binary') ? k : undefined);
}
