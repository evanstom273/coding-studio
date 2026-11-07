/** GitHub Actions for the linked repository: add a workflow, run it, follow runs, read logs. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, ExternalLink, Play, RotateCcw, XCircle } from 'lucide-react';
import { runState, summarizeRun, WORKFLOW_DIR, WORKFLOW_TEMPLATES, type GitState, type Job, type Workflow, type WorkflowRun } from '@cs/git';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { useUI } from '@web/store/ui';
import { useCompact } from '@web/hooks/useLayout';
import { github } from '@web/lib/git';
import { LOG_PREFIX } from '@web/lib/fileTypes';
import { Button, cx } from '../ui/primitives';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StateIcon({ state, size = 13 }: { state: string; size?: number }) {
  if (state === 'running') return <CircleDashed size={size} className="shrink-0 animate-spin text-amber-300" />;
  if (state === 'passed') return <CheckCircle2 size={size} className="shrink-0 text-emerald-400" />;
  if (state === 'failed') return <XCircle size={size} className="shrink-0 text-red-400" />;
  return <CircleDashed size={size} className="shrink-0 text-muted" />;
}

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function ActionsPanel({ st }: { st: GitState }) {
  const ws = useEditor((s) => s.workspace)!;
  const compact = useCompact();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Record<number, Job[]>>({});
  const [busy, setBusy] = useState(false);
  const localWorkflows = useMemo(() => [...ws.files.keys()].filter((p) => p.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(p)), [ws.files]);

  const refresh = useCallback(async () => {
    const gh = github();
    try {
      const [w, r] = await Promise.all([gh.workflows(st.owner, st.repo), gh.runs(st.owner, st.repo, { branch: st.branch })]);
      setWorkflows(w);
      setRuns(r);
    } catch (e) {
      toast('error', errMsg(e));
      setWorkflows((x) => x ?? []);
      setRuns((x) => x ?? []);
    }
  }, [st.owner, st.repo, st.branch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Follow runs: every 5 s while one is running, every 30 s otherwise.
  const running = runs?.some((r) => runState(r) === 'running');
  useEffect(() => {
    const t = setInterval(() => void refresh(), running ? 5000 : 30000);
    return () => clearInterval(t);
  }, [refresh, running]);
  useEffect(() => {
    if (open === null) return;
    void github()
      .jobs(st.owner, st.repo, open)
      .then((j) => setJobs((x) => ({ ...x, [open]: j })))
      .catch((e) => toast('error', errMsg(e)));
  }, [open, runs, st.owner, st.repo]);

  const addTemplate = (id: string) => {
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === id)!;
    const content = t.build({ packageJson: ws.files.get('package.json')?.text, hasLockfile: { npm: ws.files.has('package-lock.json'), pnpm: ws.files.has('pnpm-lock.yaml'), yarn: ws.files.has('yarn.lock') } });
    try {
      useEditor.getState().applyFiles([{ op: 'write_file', path: t.path, content, expectedHash: null }], `Add workflow ${t.path}`);
      useEditor.getState().openTab(t.path);
      toast('info', 'Workflow added. Commit & push it to turn it on.');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const openLog = (run: number, job: number) => {
    useEditor.getState().openTab(`${LOG_PREFIX}${run}:${job}`);
    if (compact) useUI.getState().set({ drawer: null });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-3 text-[12px]" data-testid="actions-panel">
      <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Workflows</div>
      {workflows === null && <div className="px-3 text-muted">Loading…</div>}
      {workflows?.map((w) => (
        <div key={w.id} className="mx-1 flex items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2" data-testid="workflow-row">
          <span className="truncate">{w.name}</span>
          <span className="truncate text-[10.5px] text-muted">{w.path.replace(`${WORKFLOW_DIR}/`, '')}</span>
          <Button
            className="ml-auto h-6"
            variant="ghost"
            disabled={busy}
            data-testid="run-workflow"
            onClick={async () => {
              setBusy(true);
              try {
                await github().dispatch(st.owner, st.repo, w.id, st.branch);
                toast('success', `Started ${w.name} on ${st.branch}`);
                setTimeout(() => void refresh(), 1500);
              } catch (e) {
                toast('error', /403|permission/i.test(errMsg(e)) ? `${errMsg(e)} Running a workflow by hand needs the token's "Actions: Read and write".` : `${errMsg(e)} (to be run by hand the workflow needs "on: workflow_dispatch")`);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play size={12} /> Run
          </Button>
        </div>
      ))}
      {workflows && !workflows.length && (
        <div className="space-y-1.5 px-3">
          <p className="text-muted">{localWorkflows.length ? 'Your workflow isn’t on GitHub yet: commit & push it.' : 'No workflows yet. Add one, then commit & push:'}</p>
          {!localWorkflows.length &&
            WORKFLOW_TEMPLATES.map((t) => (
              <button key={t.id} className="block w-full rounded border border-border p-2 text-left hover:border-accent/60" onClick={() => addTemplate(t.id)} data-testid={`add-workflow-${t.id}`}>
                <div className="font-medium">{t.title}</div>
                <div className="text-[11px] text-muted">{t.description}</div>
              </button>
            ))}
        </div>
      )}
      {workflows && workflows.length > 0 && (
        <details className="px-3 pt-1 text-muted">
          <summary className="cursor-pointer text-[11px]">Add another workflow</summary>
          {WORKFLOW_TEMPLATES.filter((t) => !ws.files.has(t.path)).map((t) => (
            <button key={t.id} className="mt-1 block w-full rounded border border-border p-2 text-left hover:border-accent/60" onClick={() => addTemplate(t.id)}>
              <div className="font-medium text-text">{t.title}</div>
              <div className="text-[11px]">{t.description}</div>
            </button>
          ))}
        </details>
      )}

      <div className="flex items-center px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Runs on {st.branch}
        <button className="ml-auto font-normal normal-case text-accent hover:underline" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {runs?.length === 0 && <div className="px-3 text-muted">No runs on this branch yet.</div>}
      {runs?.map((r) => {
        const s = summarizeRun(r);
        return (
          <div key={r.id} className="mx-1">
            <div className={cx('flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2', open === r.id && 'bg-panel-2')} onClick={() => setOpen(open === r.id ? null : r.id)} data-testid="run-row" data-state={s.state}>
              <StateIcon state={s.state} />
              <span className="truncate">
                {r.name} #{r.run_number}
              </span>
              <span className="ml-auto shrink-0 text-[10.5px] text-muted">
                {s.commit} · {ago(r.created_at)}
              </span>
            </div>
            {open === r.id && (
              <div className="mb-1 ml-5 border-l border-border pl-2">
                {(jobs[r.id] ?? []).map((j) => {
                  const js = runState({ status: j.status as WorkflowRun['status'], conclusion: j.conclusion as WorkflowRun['conclusion'] });
                  return (
                    <div key={j.id} className="py-0.5">
                      <div className="flex items-center gap-1.5">
                        <StateIcon state={js} size={12} />
                        <span className="truncate">{j.name}</span>
                        <button className="ml-auto text-accent hover:underline" onClick={() => openLog(r.id, j.id)} data-testid="open-log">
                          Log
                        </button>
                      </div>
                      {(j.steps ?? [])
                        .filter((x) => x.conclusion === 'failure')
                        .map((x) => (
                          <div key={x.number} className="pl-5 text-[11px] text-red-300">
                            ✗ {x.name}
                          </div>
                        ))}
                    </div>
                  );
                })}
                <div className="flex gap-2 py-1">
                  {s.state === 'failed' && (
                    <button
                      className="flex items-center gap-1 text-accent hover:underline"
                      data-testid="rerun-failed"
                      onClick={async () => {
                        try {
                          await github().rerun(st.owner, st.repo, r.id);
                          toast('success', 'Re-running failed jobs');
                          setTimeout(() => void refresh(), 1500);
                        } catch (e) {
                          toast('error', errMsg(e));
                        }
                      }}
                    >
                      <RotateCcw size={11} /> Re-run failed
                    </button>
                  )}
                  <a className="flex items-center gap-1 text-accent hover:underline" href={r.html_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={11} /> GitHub
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
