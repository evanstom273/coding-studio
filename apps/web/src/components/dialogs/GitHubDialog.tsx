/** Open a GitHub repository as a project (clone a branch into this browser). */
import { useEffect, useMemo, useState } from 'react';
import { GitBranch as Github, Lock } from 'lucide-react';
import type { RepoInfo } from '@cs/git';
import { cloneRepo, github, tokenStatus } from '@web/lib/git';
import { navigate } from '@web/lib/router';
import { toast } from '@web/store/toasts';
import { Button, Dialog, Field, inputCls } from '../ui/primitives';
import { TokenForm } from '../files/SourceControl';

export function GitHubDialog({ onClose }: { onClose: () => void }) {
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<RepoInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    tokenStatus()
      .then((s) => setLogin(s.connected ? (s.login ?? '') : null))
      .catch(() => setLogin(null));
  }, []);
  useEffect(() => {
    if (!login) return;
    github()
      .repos()
      .then(setRepos)
      .catch((e) => toast('error', e instanceof Error ? e.message : String(e)));
  }, [login]);
  useEffect(() => {
    if (!pick) return;
    setBranch(pick.default_branch);
    github()
      .branches(pick.owner.login, pick.name)
      .then((b) => setBranches(b.map((x) => x.name)))
      .catch(() => setBranches([pick.default_branch]));
  }, [pick]);
  const shown = useMemo(() => (repos ?? []).filter((r) => r.full_name.toLowerCase().includes(q.toLowerCase())).slice(0, 100), [repos, q]);

  return (
    <Dialog
      title="Open from GitHub"
      onClose={onClose}
      width={560}
      footer={
        pick && (
          <Button
            variant="primary"
            disabled={!!progress}
            data-testid="clone-repo"
            onClick={async () => {
              setProgress('Starting…');
              try {
                const ws = await cloneRepo(pick.owner.login, pick.name, branch || undefined, (d, t) => setProgress(`Downloading ${d}/${t} files…`));
                toast('success', `Opened ${pick.full_name} (${branch})`);
                onClose();
                navigate({ name: 'project', id: ws.meta.id });
              } catch (e) {
                toast('error', e instanceof Error ? e.message : String(e));
                setProgress(null);
              }
            }}
          >
            {progress ?? `Open ${pick.name}`}
          </Button>
        )
      }
    >
      {login === undefined && <div className="text-muted">Checking GitHub…</div>}
      {login === null && <TokenForm onDone={setLogin} />}
      {login && !pick && (
        <>
          <input className={`${inputCls} mb-2`} placeholder={`Search ${repos?.length ?? '…'} repositories`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus data-testid="repo-search" />
          {!repos && <div className="text-muted">Loading repositories…</div>}
          <div className="max-h-[50vh] overflow-auto">
            {shown.map((r) => (
              <button key={r.full_name} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-panel-2" onClick={() => setPick(r)} data-testid="repo-row">
                <Github size={14} className="shrink-0 text-muted" />
                <span className="truncate">{r.full_name}</span>
                {r.private && <Lock size={11} className="shrink-0 text-muted" />}
              </button>
            ))}
          </div>
        </>
      )}
      {login && pick && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Github size={16} /> <b>{pick.full_name}</b>
            <button className="ml-auto text-[12px] text-accent hover:underline" onClick={() => setPick(null)}>
              Change
            </button>
          </div>
          <Field label="Branch">
            <select className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="clone-branch">
              {(branches.length ? branches : [pick.default_branch]).map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </Field>
          <p className="text-[11.5px] text-muted">The branch is downloaded into this browser (and your cloud copy if the Claude connector is on). Commit and pull from the Git tab in the editor.</p>
        </>
      )}
    </Dialog>
  );
}
