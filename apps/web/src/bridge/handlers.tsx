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
import { createBackup, deleteProject, duplicateProject, getBackup, insertProject, listBackups, listProjects } from '@web/db/projects';
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
      const p = await insertProject(createProject(tc.adapter, name, { template, scriptName }));
      await openAndWait(p.id);
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
      return { id: copy.id, name: copy.name };
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
      if (isSubstantial(ops as EditOp[])) await createBackup(p, `Before Claude batch (${ops.length} ops)`, 'mcp');
      let res;
      try {
        res = useEditor.getState().dispatch(ops as EditOp[], `Claude: ${(ops as EditOp[]).length === 1 ? (ops as EditOp[])[0].op.replace(/_/g, ' ') : `${ops.length} edits`}`, {
          source: 'mcp',
          defaults: { scriptId: str(params.script) ? p.scripts.find((s) => s.id === params.script || s.name === params.script)?.id : useEditor.getState().activeScriptId, functionId: str(params.graph) ? locateFunction(p, params.graph, params.script).fn.id : useEditor.getState().activeFunctionId },
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
      await createBackup(p, 'Before restoring a backup (Claude)', 'mcp');
      useEditor.getState().replaceProject(row.doc, `Claude: restore backup "${row.label}"`, 'mcp');
      return { restored: row.id, label: row.label, revision: projectRevision(useEditor.getState().project!) };
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
