/** Shapes of the git MCP results (shared by the editor handlers and the cloud service). */
import { cleanLogLine, parseLogProblems, readState, runState, status, summarizeRun, WORKFLOW_TEMPLATES, type GitHub, type GitState, type PullResult } from '@cs/git';
import type { Workspace } from '@cs/workspace';
import { ServiceError } from './index';

export function gitStatusView(ws: Workspace) {
  const st = readState(ws);
  if (!st) return { linked: false, note: 'This project is not linked to GitHub. Use git_clone to open a repository as a project.' };
  const changes = status(ws, st);
  return { linked: true, repository: `${st.owner}/${st.repo}`, branch: st.branch, commit: st.commit, changes, clean: !changes.length };
}

export function pullView(r: PullResult) {
  return { up_to_date: r.upToDate, branch: r.state.branch, commit: r.state.commit, updated: [...r.updates.keys()], merged: r.merged, conflicts: r.conflicts, ...(r.conflicts.length ? { note: 'Conflicts: text files contain <<<<<<< / ======= / >>>>>>> markers to resolve (edit and commit); graph/binary files kept the local version — write GitHub\'s version with read_files/workspace_batch if you want theirs.' } : {}) };
}

export function requireLinked(st: GitState | null): GitState {
  if (!st) throw new ServiceError('E_NOT_LINKED', 'This project is not linked to a GitHub repository.');
  return st;
}

/** CI (GitHub Actions) tool calls; `hasFile` links log problems to project files. */
export async function ciCall(method: string, gh: GitHub, st: GitState, params: Record<string, unknown>, hasFile: (p: string) => boolean) {
  const { owner, repo } = st;
  switch (method) {
    case 'ci_status': {
      const [workflows, runs] = await Promise.all([gh.workflows(owner, repo), gh.runs(owner, repo, { branch: typeof params.branch === 'string' ? params.branch : st.branch })]);
      return { branch: st.branch, workflows: workflows.map((w) => ({ id: w.id, name: w.name, path: w.path })), runs: runs.slice(0, 10).map((r) => summarizeRun(r)), ...(workflows.length ? {} : { note: 'No workflows. Add one with ci_add_workflow, then git_commit.' }) };
    }
    case 'ci_run': {
      const ref = typeof params.ref === 'string' && params.ref ? params.ref : st.branch;
      const wfs = await gh.workflows(owner, repo);
      const want = String(params.workflow ?? '');
      const wf = wfs.find((w) => String(w.id) === want || w.name === want || w.path === want || w.path.endsWith(`/${want}`)) ?? (wfs.length === 1 && !want ? wfs[0] : undefined);
      if (!wf) throw new ServiceError('E_NOT_FOUND', `Workflow "${want}" not found. Available: ${wfs.map((w) => w.path).join(', ') || 'none'}`);
      await gh.dispatch(owner, repo, wf.id, ref);
      return { started: wf.path, ref, note: 'The run appears in ci_status within a few seconds. The workflow must have "on: workflow_dispatch".' };
    }
    case 'ci_run_details': {
      const id = Number(params.run_id);
      const [run, jobs] = await Promise.all([gh.run(owner, repo, id), gh.jobs(owner, repo, id)]);
      return summarizeRun(run, jobs);
    }
    case 'ci_logs': {
      let jobIds: number[];
      if (params.job_id) jobIds = [Number(params.job_id)];
      else {
        const jobs = await gh.jobs(owner, repo, Number(params.run_id));
        const failed = jobs.filter((j) => runState({ status: j.status as never, conclusion: j.conclusion as never }) === 'failed');
        jobIds = (failed.length ? failed : jobs).map((j) => j.id);
      }
      const tail = Math.min(Number(params.tail) || 120, 1000);
      const out = [];
      for (const id of jobIds.slice(0, 5)) {
        const log = await gh.jobLog(owner, repo, id);
        const lines = log.split('\n').map(cleanLogLine);
        out.push({ job_id: id, problems: parseLogProblems(log, hasFile), tail: lines.slice(-tail).join('\n') });
      }
      return { jobs: out };
    }
    case 'ci_rerun':
      await gh.rerun(owner, repo, Number(params.run_id), params.all !== true);
      return { rerunning: Number(params.run_id), failed_only: params.all !== true };
  }
  throw new ServiceError('E_INVALID', `Unknown CI call ${method}`);
}

/** The file a workflow template would add (written by the caller as a normal file change). */
export function workflowTemplateFile(id: unknown, files: { get(p: string): { text?: string } | undefined; has(p: string): boolean }) {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new ServiceError('E_INVALID', `Unknown template "${String(id)}". Available: ${WORKFLOW_TEMPLATES.map((x) => `${x.id} (${x.title})`).join(', ')}`);
  return { path: t.path, content: t.build({ packageJson: files.get('package.json')?.text, hasLockfile: { npm: files.has('package-lock.json'), pnpm: files.has('pnpm-lock.yaml'), yarn: files.has('yarn.lock') } }) };
}
