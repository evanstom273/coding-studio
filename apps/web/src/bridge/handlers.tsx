/**
 * Executes MCP bridge requests inside the editor. Every mutation goes through
 * useEditor.dispatch → applyOps, exactly like mouse edits: same validation, one undo step per
 * batch, autosaved. Projects are opened through the normal route so the user sees what Claude
 * is editing.
 */
import type { BridgeMethod } from '@cs/shared-protocol';
import { createProject, OpError, projectRevision, projectToJson, type EditOp, type Project } from '@cs/project-format';
import { toolchainFor, languages } from '@web/lib/toolchain';
import * as svc from '@cs/project-service';
import { navigate } from '@web/lib/router';
import { backupToWorkspace, createBackup, deleteProject, duplicateProject, getBackup, insertProject, insertWorkspace, listBackups, listProjects } from '@web/db/projects';
import { buildWebStarter } from '@cs/examples';
import { newId } from '@cs/graph-core';
import { CONFIG_PATH, configOf, defaultConfig, makeRecord, serializeConfig, workspaceRevision, type FileRecord, type Workspace } from '@cs/workspace';
import { readState } from '@cs/git';
import { cloneRepo, commitOpen, github, openOutputs, publishOpen, pullOpen, switchOpen } from '@web/lib/git';
import { saveNow } from '@web/hooks/useAutosave';
import { useEditor } from '@web/store/editor';
import { compileNow } from '@web/compile/store';
import { confirmDialog } from '@web/components/ui/primitives';
import { APP_VERSION } from './client';

type Params = Record<string, unknown>;

/** Same class as the cloud service uses, so both report errors identically. */
export const BridgeHandlerError = svc.ServiceError;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new BridgeHandlerError('E_TIMEOUT', `Timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function findProjectId(ref: string): Promise<string> {
  const all = await listProjects();
  if (all.some((p) => p.id === ref)) return ref;
  const byName = all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new BridgeHandlerError('E_AMBIGUOUS', `Several projects are called "${ref}": ${byName.map((p) => p.id).join(', ')}. Use the id.`);
  throw new BridgeHandlerError('E_NOT_FOUND', `No project "${ref}". Use list_projects.`);
}

async function openAndWait(id: string) {
  if (useEditor.getState().project?.id === id) return;
  await saveNow();
  navigate({ name: 'project', id });
  await waitFor(() => useEditor.getState().project?.id === id, 10_000, 'the project to open in the editor');
}

async function ensureOpen(ref: unknown): Promise<Project> {
  const r = str(ref);
  if (r) await openAndWait(await findProjectId(r));
  const p = useEditor.getState().project;
  if (!p) throw new BridgeHandlerError('E_NO_PROJECT', 'No project is open in Coding Studio. Pass "project" (id or name), or use create_project / open_project.');
  return p;
}

const locateFunction = (p: Project, ref: unknown, scriptRef?: unknown) => svc.locateFunction(p, ref, scriptRef, useEditor.getState().activeFunctionId);
const describeProject = (p: Project) => {
  const st = useEditor.getState();
  return svc.describeProject(p, st.project?.id === p.id ? { scriptId: st.activeScriptId, functionId: st.activeFunctionId } : {});
};
const { describeGraph, diagSummary, isSubstantial } = svc;

function generatedFiles() {
  return svc.generatedOutputs(useEditor.getState().project ?? undefined);
}

function describeOp(o: { op: string; path?: string; from?: string; to?: string }) {
  return `${o.op.replace(/_/g, ' ')}${o.path ? ` ${o.path}` : o.from ? ` ${o.from} → ${o.to}` : ''}`;
}

function batchResult(ws: Workspace, changed: string[], created: Record<string, string>, warnings: string[], graphs: boolean) {
  const p = useEditor.getState().project!;
  return {
    workspace_revision: workspaceRevision(ws),
    revision: projectRevision(p),
    changed: changed.map((path) => ({ path, hash: ws.files.get(path)?.hash ?? null })),
    created,
    warnings,
    ...(graphs ? { diagnostics: diagSummary(compileNow(p).diagnostics) } : {}),
    undo: 'This batch is one undo step (tool "undo").',
  };
}

function opError(e: unknown): never {
  if (e instanceof OpError) throw new BridgeHandlerError(e.code, e.message, { opIndex: e.opIndex, projectUnchanged: true });
  throw e;
}

export async function handleRequest(method: BridgeMethod, params: Params): Promise<unknown> {
  switch (method) {
    case 'status': {
      const p = useEditor.getState().project;
      return {
        app: 'Coding Studio',
        version: APP_VERSION,
        origin: window.location.origin,
        openProject: p ? { id: p.id, name: p.name, language: p.language, revision: projectRevision(p), activeScript: useEditor.getState().activeScriptId, activeGraph: useEditor.getState().activeFunctionId } : null,
        languages: languages.all().map((l) => ({ id: l.id, name: l.name })),
      };
    }
    case 'list_projects':
      return listProjects();
    case 'create_project': {
      const language = str(params.language) ?? 'gdscript';
      const tc = toolchainFor(language);
      const name = str(params.name);
      if (!name) throw new BridgeHandlerError('E_INVALID', 'name is required');
      const template = str(params.template) ?? tc.adapter.templates[0]?.id;
      if (template && !tc.adapter.templates.some((t) => t.id === template)) throw new BridgeHandlerError('E_INVALID', `Unknown template "${template}". Available: ${tc.adapter.templates.map((t) => t.id).join(', ')}`);
      const scriptName = str(params.script_name) ?? 'Main';
      if (!tc.adapter.identifiers.isValid(scriptName)) throw new BridgeHandlerError('E_INVALID_IDENTIFIER', `script_name "${scriptName}" is not a valid identifier`);
      await saveNow();
      const p = language === 'typescript' && template === 'web-app' ? await insertWorkspace(buildWebStarter(tc, name)) : await insertProject(createProject(tc.adapter, name, { template, scriptName }));
      await openAndWait(p.meta.id);
      return describeProject(useEditor.getState().project!);
    }
    case 'open_project':
      return describeProject(await ensureOpen(params.project));
    case 'get_project': {
      const p = await ensureOpen(params.project);
      return params.full === true ? JSON.parse(projectToJson(p)) : describeProject(p);
    }
    case 'save_project': {
      await ensureOpen(params.project);
      await saveNow();
      return { saved: useEditor.getState().saveState === 'saved', state: useEditor.getState().saveState };
    }
    case 'duplicate_project': {
      const id = await findProjectId(str(params.project) ?? useEditor.getState().project?.id ?? '');
      await saveNow();
      const copy = await duplicateProject(id, str(params.name));
      return { id: copy.meta.id, name: configOf(copy).name };
    }
    case 'delete_project': {
      const id = await findProjectId(str(params.project) ?? '');
      const name = (await listProjects()).find((p) => p.id === id)?.name;
      const ok = await confirmDialog({ title: 'Claude wants to delete a project', message: `Allow Claude Code to permanently delete "${name}" and its backups from this browser?`, confirm: 'Delete', danger: true });
      if (!ok) throw new BridgeHandlerError('E_DECLINED', 'The user declined the deletion. Nothing was deleted.');
      if (useEditor.getState().project?.id === id) {
        navigate({ name: 'dashboard' });
        await waitFor(() => !useEditor.getState().project, 5000, 'the editor to close').catch(() => undefined);
      }
      await deleteProject(id);
      return { deleted: id };
    }
    case 'list_graphs':
      return svc.listGraphs(await ensureOpen(params.project));
    case 'get_graph': {
      const p = await ensureOpen(params.project);
      const { script, fn } = locateFunction(p, params.graph, params.script);
      if (params.focus !== false) useEditor.getState().setActive(script.id, fn.id);
      return describeGraph(p, script, fn);
    }
    case 'list_node_types':
      return svc.listNodeTypes(str(params.language) ?? useEditor.getState().project?.language ?? 'gdscript', str(params.category));
    case 'search_nodes':
      return svc.searchNodes(str(params.language) ?? useEditor.getState().project?.language ?? 'gdscript', String(params.query ?? ''), Number(params.limit) || 25);
    case 'get_node_schema': {
      const p = useEditor.getState().project;
      return svc.nodeSchema(p?.language ?? 'gdscript', String(params.type ?? ''), params.props as Record<string, unknown> | undefined, p ? { project: p, ...locateFunction(p, params.graph, params.script) } : undefined);
    }
    case 'list_language_capabilities':
      return svc.languageCapabilities(str(params.language) ?? useEditor.getState().project?.language ?? 'gdscript');
    case 'batch_edit': {
      const p = await ensureOpen(params.project);
      const ops = params.operations;
      if (!Array.isArray(ops) || ops.length === 0) throw new BridgeHandlerError('E_INVALID', 'operations must be a non-empty array');
      const expected = str(params.expected_revision);
      const current = projectRevision(p);
      if (expected && expected !== current) {
        throw new BridgeHandlerError('E_REVISION_CONFLICT', `The project changed since revision ${expected} (now ${current}) — probably the user edited it. Nothing was applied. Re-read the graph (get_graph) and retry with the new revision.`, { expected, current });
      }
      if (isSubstantial(ops as EditOp[])) await createBackup(useEditor.getState().workspace!, `Before Claude batch (${ops.length} ops)`, 'mcp');
      let res;
      try {
        res = useEditor.getState().dispatch(ops as EditOp[], `Claude: ${(ops as EditOp[]).length === 1 ? (ops as EditOp[])[0].op.replace(/_/g, ' ') : `${ops.length} edits`}`, {
          source: 'mcp',
          defaults: { scriptId: str(params.script) ? svc.findScript(p, params.script)?.id : useEditor.getState().activeScriptId, functionId: str(params.graph) ? locateFunction(p, params.graph, params.script).fn.id : useEditor.getState().activeFunctionId },
        });
      } catch (e) {
        opError(e);
      }
      const next = useEditor.getState().project!;
      const diags = compileNow(next).diagnostics;
      return { revision: projectRevision(next), created: res.created, warnings: res.warnings, diagnostics: diagSummary(diags), undo: 'This batch is one undo step (tool "undo").' };
    }
    case 'validate_graph': {
      const p = await ensureOpen(params.project);
      compileNow(p);
      return svc.validate(p, params.graph, params.script, useEditor.getState().activeFunctionId);
    }
    case 'compile_script':
      return svc.compileOne(await ensureOpen(params.project), params.script, useEditor.getState().activeScriptId);
    case 'compile_project': {
      const p = await ensureOpen(params.project);
      compileNow(p);
      return svc.compileAll(p);
    }
    case 'export_files':
      return svc.exportFiles(await ensureOpen(params.project), params.script, params.include_project === true);
    case 'undo': {
      await ensureOpen(params.project);
      const label = useEditor.getState().undo();
      if (!label) throw new BridgeHandlerError('E_NOTHING_TO_UNDO', 'Nothing to undo.');
      return { undone: label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'redo': {
      await ensureOpen(params.project);
      const label = useEditor.getState().redo();
      if (!label) throw new BridgeHandlerError('E_NOTHING_TO_REDO', 'Nothing to redo.');
      return { redone: label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'list_backups': {
      const p = await ensureOpen(params.project);
      return listBackups(p.id);
    }
    case 'restore_backup': {
      const p = await ensureOpen(params.project);
      const row = await getBackup(Number(params.backup));
      if (!row || row.projectId !== p.id) throw new BridgeHandlerError('E_NOT_FOUND', `Backup ${String(params.backup)} not found for this project. Use list_backups.`);
      await createBackup(useEditor.getState().workspace!, 'Before restoring a backup (Claude)', 'mcp');
      useEditor.getState().replaceWorkspace(backupToWorkspace(row.doc, p.id), `Claude: restore backup "${row.label}"`, 'mcp');
      return { restored: row.id, label: row.label, revision: projectRevision(useEditor.getState().project!) };
    }
    case 'read_tree': {
      await ensureOpen(params.project);
      const ws = useEditor.getState().workspace!;
      return svc.describeTree([...ws.files.values()], { path: params.path, depth: params.depth, revision: workspaceRevision(ws), generated: generatedFiles().map((f) => f.path) });
    }
    case 'read_files': {
      await ensureOpen(params.project);
      const ws = useEditor.getState().workspace!;
      return svc.readFilesView(params.paths, (p) => ws.files.get(p), (p) => generatedFiles().find((f) => f.path === p)?.content);
    }
    case 'read_config': {
      await ensureOpen(params.project);
      const path = String(params.path ?? '');
      return svc.configView(path, useEditor.getState().workspace!.files.get(path)?.text);
    }
    case 'edit_config': {
      await ensureOpen(params.project);
      const path = String(params.path ?? '');
      const cur = useEditor.getState().workspace!.files.get(path);
      const r = svc.configEdit(path, cur?.text, params.edits);
      useEditor.getState().applyFiles([{ op: 'write_file', path, content: r.content, expectedHash: cur ? cur.hash : null }], `Claude: edit ${path.split('/').pop()}`, { source: 'mcp' });
      return { path, hash: useEditor.getState().workspace!.files.get(path)?.hash, problems: r.problems };
    }
    case 'search_files': {
      await ensureOpen(params.project);
      return svc.searchView(useEditor.getState().workspace!.files.values(), params);
    }
    case 'workspace_batch': {
      const p = await ensureOpen(params.project);
      const st = useEditor.getState();
      const ws = st.workspace!;
      const expected = str(params.expected_revision);
      if (expected && expected !== workspaceRevision(ws)) throw new BridgeHandlerError('E_REVISION_CONFLICT', `The project's files changed since revision ${expected} (now ${workspaceRevision(ws)}). Nothing was applied. Re-read (read_tree / read_files) and retry, or use per-file expected_hash.`, { expected, current: workspaceRevision(ws) });
      const { ops, destructive, touchesGraphs } = svc.prepareBatch(p, params.operations, { scriptId: st.activeScriptId, functionId: st.activeFunctionId });
      if (destructive || ops.length >= 20) await createBackup(ws, `Before Claude file batch (${ops.length} ops)`, 'mcp');
      let r;
      try {
        r = st.applyFiles(ops, `Claude: ${ops.length === 1 ? describeOp(ops[0]) : `${ops.length} file changes`}`, { source: 'mcp' });
      } catch (e) {
        throw new BridgeHandlerError(String((e as { code?: string }).code ?? 'E_INVALID_OPERATION'), e instanceof Error ? e.message : String(e), { ...((e as { details?: object }).details ?? {}), opIndex: (e as { opIndex?: number }).opIndex, projectUnchanged: true });
      }
      return batchResult(r.workspace, r.changedPaths, r.created, r.warnings, touchesGraphs);
    }
    case 'git_status':
      await ensureOpen(params.project);
      return svc.gitStatusView(useEditor.getState().workspace!, openOutputs(false));
    case 'git_commit': {
      await ensureOpen(params.project);
      await saveNow();
      const r = await commitOpen(String(params.message ?? ''), { paths: Array.isArray(params.paths) ? params.paths.map(String) : undefined, newBranch: str(params.new_branch) }, 'mcp');
      return { commit: r.commit, branch: r.branch, files: r.files };
    }
    case 'git_pull': {
      await ensureOpen(params.project);
      return svc.pullView(await pullOpen('mcp'));
    }
    case 'git_create_pr':
    case 'git_pr_list':
    case 'git_pr_get':
    case 'git_pr_update':
    case 'git_pr_merge':
    case 'git_repo_create':
    case 'git_repo_update':
    case 'git_repo_delete': {
      const ws = useEditor.getState().workspace;
      const st = ws ? readState(ws) : null;
      if (method === 'git_pr_merge') {
        const r = (await svc.githubCall(method, github(), params, st)) as { into: string; deleted_branch?: string };
        // The project's branch was merged and deleted: move it to the branch it went into.
        if (st && r.deleted_branch === st.branch && !str(params.repository)) return { ...r, switched_project_to: svc.switchView(await switchOpen(r.into, 'mcp')) };
        return r;
      }
      return svc.githubCall(method, github(), params, st, (full) => confirmDialog({ title: 'Delete a GitHub repository?', message: <>Claude wants to delete <b>{full}</b> on GitHub. This can't be undone: its code, issues and pull requests are gone for good.</>, confirm: 'Delete repository', danger: true }));
    }
    case 'git_branches': {
      await ensureOpen(params.project);
      const st = svc.requireLinked(readState(useEditor.getState().workspace!));
      const [bs, info] = await Promise.all([github().branches(st.owner, st.repo), github().repo(st.owner, st.repo)]);
      return { current: st.branch, default: info.default_branch, current_exists: bs.some((b) => b.name === st.branch), branches: bs.map((b) => b.name) };
    }
    case 'git_switch_branch': {
      await ensureOpen(params.project);
      await saveNow();
      return svc.switchView(await switchOpen(String(params.branch ?? ''), 'mcp'));
    }
    case 'git_publish': {
      await ensureOpen(params.project);
      await saveNow();
      return publishOpen({ name: String(params.name ?? ''), description: str(params.description), private: params.private !== false, org: str(params.org) }, str(params.message), 'mcp');
    }
    case 'git_clone': {
      const [owner, repo] = String(params.repository ?? '').split('/');
      if (!owner || !repo) throw new BridgeHandlerError('E_INVALID', 'repository must be "owner/name"');
      await saveNow();
      const ws = await cloneRepo(owner, repo, str(params.branch));
      await openAndWait(ws.meta.id);
      return { project: ws.meta.id, files: ws.files.size, ...svc.gitStatusView(ws, svc.workspaceOutputs(ws, false)) };
    }
    case 'git_repos':
      return (await github().repos()).map((r) => ({ repository: r.full_name, private: r.private, default_branch: r.default_branch, updated: r.updated_at }));
    case 'ci_status':
    case 'ci_run':
    case 'ci_run_details':
    case 'ci_logs':
    case 'ci_rerun': {
      await ensureOpen(params.project);
      const ws = useEditor.getState().workspace!;
      return svc.ciCall(method, github(), svc.requireLinked(readState(ws)), params, (p) => ws.files.has(p));
    }
    case 'ci_add_workflow': {
      const p = await ensureOpen(params.project);
      const ws = useEditor.getState().workspace!;
      const fs = svc.workflowTemplateFiles(params.template, ws.files, p.name);
      useEditor.getState().applyFiles(fs.map((f) => ({ op: 'write_file' as const, path: f.path, content: f.content, expectedHash: null })), `Claude: add workflow ${fs[0].path}`, { source: 'mcp' });
      return { added: fs.map((f) => f.path), files: fs, note: 'Commit them with git_commit to turn the workflow on.' };
    }
    case 'deps_list':
    case 'deps_search':
    case 'deps_add':
    case 'deps_remove': {
      const p = await ensureOpen(params.project);
      const ws = useEditor.getState().workspace!;
      const r = await svc.depsCall(method, ws.files, params, async (u) => (await fetch(u)).json(), p.name);
      if (r.write) useEditor.getState().applyFiles([{ op: 'write_file', path: r.write.path, content: r.write.content }], r.write.label, { source: 'mcp' });
      return r.result;
    }
    case 'host_snapshot': {
      // Every file of the project plus generated code, for writing into a folder on the user's computer.
      const p = await ensureOpen(params.project);
      await saveNow();
      const ws = useEditor.getState().workspace!;
      return svc.hostSnapshot(p, ws.files.values(), generatedFiles());
    }
    case 'host_revision': {
      // Cheap poll for the local host: has the open project changed? Never switches projects.
      const ws = useEditor.getState().workspace;
      return ws && ws.meta.id === params.project ? { open: true, revision: workspaceRevision(ws) } : { open: false };
    }
    case 'host_import': {
      // A folder from the user's computer becomes a new project (the local host reads it).
      const list = Array.isArray(params.files) ? (params.files as { path: string; text?: string; base64?: string }[]) : [];
      const now = Date.now();
      const files = new Map<string, FileRecord>();
      for (const f of list) files.set(f.path, makeRecord(f.path, f.base64 !== undefined ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : (f.text ?? ''), now));
      const name = str(params.name) ?? 'Folder';
      if (!files.has(CONFIG_PATH)) files.set(CONFIG_PATH, makeRecord(CONFIG_PATH, serializeConfig(files.has('package.json') || files.has('tsconfig.json') ? defaultConfig(name, 'typescript', 'es2022') : defaultConfig(name)), now));
      await saveNow();
      const ws = await insertWorkspace(svc.stripGenerated({ meta: { id: newId('p'), schemaVersion: 2, createdAt: now, updatedAt: now }, files }));
      await openAndWait(ws.meta.id);
      return { project: ws.meta.id, files: ws.files.size };
    }
    case 'confirm_action': {
      const ok = await confirmDialog({
        title: str(params.title) ?? 'Claude wants to run a command',
        message: <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px]">{String(params.message ?? '')}</pre>,
        confirm: str(params.confirm) ?? 'Allow',
        danger: true,
      });
      return { approved: ok };
    }
    case 'confirm_overwrite': {
      const files = Array.isArray(params.files) ? (params.files as string[]) : [];
      const ok = await confirmDialog({
        title: 'Claude wants to overwrite files',
        message: (
          <>
            Allow Claude Code to overwrite {files.length} existing file(s) in <code className="font-mono text-[11.5px]">{String(params.dir)}</code>?
            <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 font-mono text-[11px]">
              {files.slice(0, 50).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        ),
        confirm: 'Overwrite',
        danger: true,
      });
      return { approved: ok };
    }
  }
}
