/** Shapes of the git MCP results (shared by the editor handlers and the cloud service). */
import { cleanLogLine, parseLogProblems, readState, runState, status, summarizeRun, WORKFLOW_TEMPLATES, workflowTemplateFiles as workflowTemplateFiles_, type GitHub, type GitState, type PullResult } from '@cs/git';
import { deriveProject, type Workspace } from '@cs/workspace';
import { generatedOutputs, ServiceError } from './index';

export function gitStatusView(ws: Workspace, generated: { path: string; content: string }[] = []) {
  const st = readState(ws);
  if (!st) return { linked: false, note: 'This project is not linked to GitHub. Use git_clone to open a repository as a project.' };
  const gen = new Set(generated.map((g) => g.path));
  const changes = status(ws, st, generated).map((c) => (gen.has(c.path) && !ws.files.has(c.path) ? { ...c, generated: true } : c));
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
export function workflowTemplateFiles(id: unknown, files: { get(p: string): { text?: string } | undefined; has(p: string): boolean }, projectName = 'app') {
  const t = WORKFLOW_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new ServiceError('E_INVALID', `Unknown template "${String(id)}". Available: ${WORKFLOW_TEMPLATES.map((x) => `${x.id} (${x.title})`).join(', ')}`);
  return workflowTemplateFiles_(t, files, projectName);
}

/** Which repository a repo/PR call is about: `repository: "owner/name"`, or the linked one. */
export function targetRepo(params: Record<string, unknown>, st: GitState | null): { owner: string; repo: string } {
  const r = typeof params.repository === 'string' ? params.repository.trim() : '';
  if (r) {
    const [owner, repo] = r.split('/');
    if (!owner || !repo) throw new ServiceError('E_INVALID', 'repository must be "owner/name"');
    return { owner, repo };
  }
  if (!st) throw new ServiceError('E_NOT_LINKED', 'This project is not linked to a GitHub repository; pass repository: "owner/name".');
  return { owner: st.owner, repo: st.repo };
}

const prView = (p: { number: number; title: string; html_url: string; state: string; draft?: boolean; merged?: boolean; mergeable?: boolean | null; mergeable_state?: string; head: { ref: string }; base: { ref: string }; user: { login: string }; body?: string | null; changed_files?: number; commits?: number }) => ({
  number: p.number,
  title: p.title,
  url: p.html_url,
  state: p.merged ? 'merged' : p.state,
  ...(p.draft ? { draft: true } : {}),
  head: p.head.ref,
  base: p.base.ref,
  author: p.user.login,
  ...(p.mergeable !== undefined ? { mergeable: p.mergeable, mergeable_state: p.mergeable_state } : {}),
  ...(p.body ? { body: p.body } : {}),
  ...(p.changed_files !== undefined ? { changed_files: p.changed_files, commits: p.commits } : {}),
});

/**
 * Repository and pull-request tool calls. `confirmDelete` asks the user (the editor shows a
 * dialog; the cloud service has none, so deleting there relies on confirm_name alone).
 */
export async function githubCall(method: string, gh: GitHub, params: Record<string, unknown>, st: GitState | null, confirmDelete?: (fullName: string) => Promise<boolean>) {
  const s = (k: string) => (typeof params[k] === 'string' && (params[k] as string).trim() ? (params[k] as string).trim() : undefined);
  const b = (k: string) => (typeof params[k] === 'boolean' ? (params[k] as boolean) : undefined);
  switch (method) {
    case 'git_pr_list': {
      const { owner, repo } = targetRepo(params, st);
      const state = s('state') === 'closed' || s('state') === 'all' ? (s('state') as 'closed' | 'all') : 'open';
      return { repository: `${owner}/${repo}`, pull_requests: (await gh.pulls(owner, repo, state)).map(prView) };
    }
    case 'git_pr_get': {
      const { owner, repo } = targetRepo(params, st);
      const n = Number(params.number);
      const [p, files] = await Promise.all([gh.pull(owner, repo, n), gh.pullFiles(owner, repo, n)]);
      return { ...prView(p), files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) };
    }
    case 'git_create_pr': {
      const { owner, repo } = targetRepo(params, st);
      const head = s('head') ?? st?.branch;
      if (!head) throw new ServiceError('E_INVALID', 'head (the branch with the changes) is required');
      const base = s('base') ?? (await gh.repo(owner, repo)).default_branch;
      if (head === base) throw new ServiceError('E_INVALID', `head and base are both "${base}". Commit to a new branch first (git_commit with new_branch), then open the PR from it.`);
      const r = await gh.createPull(owner, repo, { title: s('title') ?? head.replace(/[-_/]+/g, ' '), head, base, ...(s('body') ? { body: s('body') } : {}), ...(b('draft') ? { draft: true } : {}) } as never);
      return { number: r.number, url: r.html_url, head, base };
    }
    case 'git_pr_update': {
      const { owner, repo } = targetRepo(params, st);
      const p = await gh.updatePull(owner, repo, Number(params.number), { ...(s('title') ? { title: s('title') } : {}), ...(typeof params.body === 'string' ? { body: params.body } : {}), ...(s('base') ? { base: s('base') } : {}), ...(s('state') === 'closed' || s('state') === 'open' ? { state: s('state') as 'open' | 'closed' } : {}) });
      return prView(p);
    }
    case 'git_pr_merge': {
      const { owner, repo } = targetRepo(params, st);
      const n = Number(params.number);
      const method = s('method') === 'squash' || s('method') === 'rebase' ? (s('method') as 'squash' | 'rebase') : 'merge';
      const pr = await gh.pull(owner, repo, n);
      if (pr.merged) return { merged: true, already: true, number: n };
      if (pr.state !== 'open') throw new ServiceError('E_INVALID', `Pull request #${n} is closed.`);
      if (pr.mergeable === false) throw new ServiceError('E_MERGE_CONFLICT', `#${n} has conflicts with ${pr.base.ref}. Pull ${pr.base.ref} into ${pr.head.ref}, fix the conflicts, commit, then merge.`, { mergeable_state: pr.mergeable_state });
      const r = await gh.mergePull(owner, repo, n, { merge_method: method, ...(s('commit_title') ? { commit_title: s('commit_title') } : {}), sha: pr.head.sha });
      let deleted = false;
      if (b('delete_branch') && pr.head.ref !== (await gh.repo(owner, repo)).default_branch) deleted = await gh.deleteBranch(owner, repo, pr.head.ref).then(() => true, () => false);
      return { merged: r.merged, sha: r.sha, method, number: n, into: pr.base.ref, ...(deleted ? { deleted_branch: pr.head.ref } : {}) };
    }
    case 'git_repo_create': {
      const name = s('name');
      if (!name || !/^[\w.-]{1,100}$/.test(name)) throw new ServiceError('E_INVALID', 'name is required (letters, digits, - _ .)');
      const r = await gh.createRepo({ name, description: s('description'), private: b('private') !== false, auto_init: b('auto_init') !== false, org: s('org') });
      return { repository: r.full_name, url: r.html_url, private: r.private, default_branch: r.default_branch };
    }
    case 'git_repo_update': {
      const { owner, repo } = targetRepo(params, st);
      const r = await gh.updateRepo(owner, repo, { ...(s('name') ? { name: s('name') } : {}), ...(typeof params.description === 'string' ? { description: params.description } : {}), ...(b('private') !== undefined ? { private: b('private') } : {}), ...(s('default_branch') ? { default_branch: s('default_branch') } : {}), ...(typeof params.homepage === 'string' ? { homepage: params.homepage } : {}), ...(b('archived') !== undefined ? { archived: b('archived') } : {}) });
      return { repository: r.full_name, url: r.html_url, private: r.private, default_branch: r.default_branch, description: r.description ?? '' };
    }
    case 'git_repo_delete': {
      const { owner, repo } = targetRepo(params, st);
      const full = `${owner}/${repo}`;
      if (s('confirm_name') !== full) throw new ServiceError('E_CONFIRM', `Deleting a repository can't be undone. Pass confirm_name: "${full}" to confirm (and the user will be asked in the editor when it's open).`);
      if (confirmDelete && !(await confirmDelete(full))) throw new ServiceError('E_DECLINED', 'The user declined deleting the repository. Nothing was deleted.');
      await gh.deleteRepo(owner, repo);
      return { deleted: full };
    }
  }
  throw new ServiceError('E_INVALID', `Unknown GitHub call ${method}`);
}

/**
 * Generated code in a freshly cloned repository is rebuilt from its graphs, so it isn't kept as
 * an editable file (the graph stays the one source of truth); the git state still knows GitHub's
 * copy, so a changed graph shows up as a modified generated file.
 */
export function stripGenerated(ws: Workspace): Workspace {
  let gen: { path: string }[];
  try {
    gen = generatedOutputs(deriveProject(ws).project);
  } catch {
    return ws;
  }
  if (!gen.some((g) => ws.files.has(g.path))) return ws;
  const files = new Map(ws.files);
  for (const g of gen) files.delete(g.path);
  return { meta: ws.meta, files };
}

/** Generated files of a workspace's project (strict: refuses with the graph errors). */
export function workspaceOutputs(ws: Workspace, strict = true) {
  return generatedOutputs(deriveProject(ws).project, { strict });
}
