/** Shapes of the git MCP results (shared by the editor handlers and the cloud service). */
import { readState, status, type GitState, type PullResult } from '@cs/git';
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
