/** Pull requests (list, open, merge, close) and repository settings for the Git tab. */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, GitMerge, GitPullRequest, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { githubCall } from '@cs/project-service';
import type { GitState } from '@cs/git';
import { github } from '@web/lib/git';
import { toast } from '@web/store/toasts';
import { Button, confirmDialog, cx, inputCls } from '../ui/primitives';

interface PR {
  number: number;
  title: string;
  url: string;
  state: string;
  head: string;
  base: string;
  author: string;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
}

const err = (e: unknown) => toast('error', e instanceof Error ? e.message : String(e));
const call = <T,>(method: string, st: GitState, params: Record<string, unknown> = {}) => githubCall(method, github(), params, st) as Promise<T>;

export function PullRequests({ st }: { st: GitState }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [list, setList] = useState<PR[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('squash');
  const [deleteBranch, setDeleteBranch] = useState(true);

  const load = useCallback(async () => {
    try {
      setList((await call<{ pull_requests: PR[] }>('git_pr_list', st, { state })).pull_requests);
    } catch (e) {
      err(e);
      setList([]);
    }
  }, [st, state]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  const act = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await f();
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="pull-requests">
      <div className="flex items-center gap-1 px-3 py-2">
        {(['open', 'closed'] as const).map((s) => (
          <button key={s} onClick={() => setState(s)} className={cx('rounded px-2 py-1 text-[11.5px] capitalize', state === s ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
            {s}
          </button>
        ))}
        <button className="ml-1 text-muted hover:text-text" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={12} />
        </button>
        <Button className="ml-auto h-7" onClick={() => setCreating((v) => !v)} data-testid="pr-new">
          <Plus size={12} /> New
        </Button>
      </div>
      {creating && <NewPullRequest st={st} onDone={() => (setCreating(false), void load())} />}
      {state === 'open' && !!list?.length && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-[11px] text-muted">
          Merge with
          <select className={cx(inputCls, 'h-7 w-auto')} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} data-testid="pr-merge-method">
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> delete branch
          </label>
        </div>
      )}
      {list === null && <div className="px-3 py-2 text-muted">Loading…</div>}
      {list?.length === 0 && <div className="px-3 py-2 text-muted">No {state} pull requests.</div>}
      {list?.map((p) => (
        <div key={p.number} className="mx-2 mb-1.5 rounded border border-border p-2" data-testid="pr-row" data-number={p.number}>
          <div className="flex items-start gap-1.5">
            <GitPullRequest size={13} className={cx('mt-0.5 shrink-0', p.state === 'merged' ? 'text-violet-300' : p.state === 'open' ? 'text-emerald-300' : 'text-red-300')} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {p.title} <span className="text-muted">#{p.number}</span>
              </div>
              <div className="truncate text-[11px] text-muted">
                {p.head} → {p.base} · {p.author} {p.draft ? '· draft' : ''} {p.state !== 'open' ? `· ${p.state}` : ''}
              </div>
            </div>
            <a href={p.url} target="_blank" rel="noreferrer" className="text-muted hover:text-text" title="Open on GitHub">
              <ExternalLink size={12} />
            </a>
          </div>
          {p.state === 'open' && (
            <div className="mt-2 flex gap-1.5">
              <Button
                className="h-8 flex-1"
                disabled={!!busy}
                data-testid="pr-merge"
                onClick={() =>
                  act(`m${p.number}`, async () => {
                    const r = await call<{ merged: boolean; into: string }>('git_pr_merge', st, { number: p.number, method, delete_branch: deleteBranch });
                    toast('success', `Merged #${p.number} into ${r.into}${r.into === st.branch ? ' — pull to get it here' : ''}`);
                  })
                }
              >
                <GitMerge size={13} /> {busy === `m${p.number}` ? 'Merging…' : 'Merge'}
              </Button>
              <Button
                variant="ghost"
                className="h-8"
                disabled={!!busy}
                data-testid="pr-close"
                onClick={() =>
                  act(`c${p.number}`, async () => {
                    if (await confirmDialog({ title: `Close #${p.number}?`, message: 'It is closed without merging (you can reopen it on GitHub).', confirm: 'Close' })) await call('git_pr_update', st, { number: p.number, state: 'closed' });
                  })
                }
              >
                <X size={13} /> Close
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NewPullRequest({ st, onDone }: { st: GitState; onDone: () => void }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [head, setHead] = useState(st.branch);
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const gh = github();
    void Promise.all([gh.branches(st.owner, st.repo), gh.repo(st.owner, st.repo)])
      .then(([bs, info]) => {
        setBranches(bs.map((b) => b.name));
        setBase(info.default_branch);
        if (st.branch === info.default_branch) setHead(bs.find((b) => b.name !== info.default_branch)?.name ?? st.branch);
      })
      .catch(err);
  }, [st]);
  return (
    <div className="mx-2 mb-2 space-y-1.5 rounded border border-accent/40 p-2" data-testid="pr-form">
      <div className="grid grid-cols-[auto_1fr] items-center gap-1.5 text-[11.5px]">
        <span className="text-muted">From</span>
        <select className={inputCls} value={head} onChange={(e) => setHead(e.target.value)} data-testid="pr-head">
          {branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <span className="text-muted">Into</span>
        <select className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} data-testid="pr-base">
          {branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>
      <input className={inputCls} placeholder={`Title (default: ${head.replace(/[-_/]+/g, ' ')})`} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pr-title" />
      <textarea className={cx(inputCls, 'h-16 py-1')} placeholder="Description (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
      <Button
        className="h-8 w-full"
        disabled={busy || !head || !base || head === base}
        data-testid="pr-create"
        onClick={async () => {
          setBusy(true);
          try {
            const r = await call<{ number: number }>('git_create_pr', st, { head, base, title: title.trim() || undefined, body: body.trim() || undefined });
            toast('success', `Pull request #${r.number} opened`);
            onDone();
          } catch (e) {
            err(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {head === base ? 'Pick two different branches' : busy ? 'Opening…' : `Open pull request: ${head} → ${base}`}
      </Button>
    </div>
  );
}

/** Rename, describe, change visibility / default branch, or delete the repository. */
export function RepoSettings({ st, onRenamed }: { st: GitState; onRenamed: (owner: string, repo: string) => void }) {
  const [info, setInfo] = useState<{ name: string; description: string; private: boolean; default_branch: string; branches: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  useEffect(() => {
    const gh = github();
    void Promise.all([gh.repo(st.owner, st.repo), gh.branches(st.owner, st.repo)])
      .then(([r, bs]) => setInfo({ name: r.name, description: r.description ?? '', private: r.private, default_branch: r.default_branch, branches: bs.map((b) => b.name) }))
      .catch(err);
  }, [st.owner, st.repo]);
  if (!info) return <div className="px-3 py-2 text-muted">Loading…</div>;
  const full = `${st.owner}/${st.repo}`;
  return (
    <div className="space-y-2 overflow-auto px-3 py-2 text-[12px]" data-testid="repo-settings">
      <label className="block">
        <span className="text-[11px] text-muted">Name</span>
        <input className={inputCls} value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} data-testid="repo-name" />
      </label>
      <label className="block">
        <span className="text-[11px] text-muted">Description</span>
        <input className={inputCls} value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} data-testid="repo-description" />
      </label>
      <label className="block">
        <span className="text-[11px] text-muted">Default branch</span>
        <select className={inputCls} value={info.default_branch} onChange={(e) => setInfo({ ...info, default_branch: e.target.value })}>
          {info.branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={info.private} onChange={(e) => setInfo({ ...info, private: e.target.checked })} data-testid="repo-private" /> Private
      </label>
      <Button
        className="h-8 w-full"
        disabled={busy}
        data-testid="repo-save"
        onClick={async () => {
          setBusy(true);
          try {
            const r = await call<{ repository: string }>('git_repo_update', st, { name: info.name, description: info.description, private: info.private, default_branch: info.default_branch });
            const [o, n] = r.repository.split('/');
            if (n !== st.repo) onRenamed(o, n);
            toast('success', `Saved ${r.repository}`);
          } catch (e) {
            err(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save repository settings
      </Button>
      <div className="mt-4 space-y-1.5 rounded border border-red-400/40 p-2">
        <div className="font-medium text-red-200">Delete this repository</div>
        <p className="text-[11px] text-muted">Removes it from GitHub for good (code, issues, pull requests). This project stays here, unlinked. Type {full} to confirm.</p>
        <input className={inputCls} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={full} data-testid="repo-delete-confirm" />
        <Button
          variant="danger"
          className="h-8 w-full"
          disabled={busy || confirmName !== full}
          data-testid="repo-delete"
          onClick={async () => {
            setBusy(true);
            try {
              await call('git_repo_delete', st, { confirm_name: full });
              toast('success', `Deleted ${full}`);
              onRenamed('', '');
            } catch (e) {
              err(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 size={13} /> Delete {full}
        </Button>
      </div>
    </div>
  );
}
