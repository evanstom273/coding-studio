/** Source control: GitHub token, changes, commit & push (optionally to a new branch), pull, PRs. */
import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  GitBranch,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { useEditor } from "@web/store/editor";
import { toast } from "@web/store/toasts";
import { useUI } from "@web/store/ui";
import { useCompact } from "@web/hooks/useLayout";
import {
  commitOpen,
  forgetToken,
  github,
  gitState,
  gitStatus,
  pullOpen,
  saveToken,
  takeTheirs,
  tokenStatus,
} from "@web/lib/git";
import { Button, cx, inputCls } from "../ui/primitives";
import { iconFor } from "./FileExplorer";
import { DIFF_PREFIX } from "@web/lib/fileTypes";
import { ActionsPanel } from "./ActionsPanel";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TokenForm({ onDone }: { onDone: (login: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 text-[12px]" data-testid="github-token-form">
      <p className="text-muted">
        Connect GitHub with a{" "}
        <a
          className="text-accent hover:underline"
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
        >
          fine-grained personal access token
        </a>{" "}
        with <b>Contents</b> and <b>Pull requests</b> set to “Read and write”
        for the repositories you want. It's kept in your own Coding Studio cloud
        storage, never in this browser or in your projects.
      </p>
      <input
        className={inputCls}
        type="password"
        autoComplete="off"
        placeholder="github_pat_…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        data-testid="github-token"
      />
      <Button
        variant="primary"
        disabled={!token.trim() || busy}
        data-testid="github-token-save"
        onClick={async () => {
          setBusy(true);
          try {
            const r = await saveToken(token);
            setToken("");
            toast("success", `Connected to GitHub as ${r.login}`);
            onDone(r.login);
          } catch (e) {
            toast("error", errMsg(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Connect GitHub
      </Button>
    </div>
  );
}

export function SourceControl() {
  const ws = useEditor((s) => s.workspace)!;
  const st = useMemo(() => gitState(ws), [ws]);
  const changes = useMemo(() => gitStatus(ws), [ws]);
  const compact = useCompact();
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  const [newBranch, setNewBranch] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ path: string; kind: string }[]>(
    [],
  );
  const [pr, setPr] = useState<{ branch: string; url?: string } | null>(null);
  const [view, setView] = useState<"changes" | "actions">("changes");

  useEffect(() => {
    tokenStatus()
      .then((s) => setLogin(s.connected ? (s.login ?? "") : null))
      .catch(() => setLogin(null));
  }, []);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast("error", errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (login === undefined)
    return <div className="p-3 text-muted">Checking GitHub…</div>;
  if (login === null)
    return (
      <div className="p-3">
        <TokenForm onDone={setLogin} />
      </div>
    );
  if (!st)
    return (
      <div
        className="space-y-2 p-3 text-[12px] text-muted"
        data-testid="git-not-linked"
      >
        <p>Connected to GitHub as {login}.</p>
        <p>
          This project isn't linked to a repository. Open one with “Open from
          GitHub” on the projects page.
        </p>
        <button
          className="text-accent hover:underline"
          onClick={() => void forgetToken().then(() => setLogin(null))}
        >
          Disconnect GitHub
        </button>
      </div>
    );

  const open = (path: string, status: string) => {
    // New files open directly; changed and deleted ones as a comparison with GitHub.
    useEditor
      .getState()
      .openTab(status === "added" ? path : `${DIFF_PREFIX}${path}`);
    if (compact) useUI.getState().set({ drawer: null });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-[12px]"
      data-testid="source-control"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <GitBranch size={13} className="text-muted" />
        <span className="truncate font-medium" data-testid="git-branch">
          {st.owner}/{st.repo} · {st.branch}
        </span>
        <Button
          className="ml-auto h-6"
          variant="ghost"
          disabled={!!busy}
          data-testid="git-pull"
          onClick={() =>
            run("pull", async () => {
              const r = await pullOpen();
              setConflicts(r.conflicts);
              toast(
                r.conflicts.length ? "warning" : "success",
                r.upToDate
                  ? "Already up to date"
                  : `Pulled ${r.updates.size} file(s)${r.merged.length ? `, merged ${r.merged.length}` : ""}${r.conflicts.length ? ` — ${r.conflicts.length} conflict(s) to resolve` : ""}`,
              );
            })
          }
        >
          <RefreshCw
            size={12}
            className={busy === "pull" ? "animate-spin" : ""}
          />{" "}
          Pull
        </Button>
      </div>
      <div className="flex shrink-0 border-b border-border" role="tablist">
        {(["changes", "actions"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={cx(
              "flex-1 py-1.5 text-[11.5px] capitalize",
              view === v
                ? "border-b-2 border-accent text-text"
                : "text-muted hover:text-text",
            )}
            onClick={() => setView(v)}
            data-testid={`git-view-${v}`}
          >
            {v === "changes" ? `Changes (${changes.length})` : "Actions"}
          </button>
        ))}
      </div>
      {view === "actions" && <ActionsPanel st={st} />}
      {view === "changes" && conflicts.length > 0 && (
        <div
          className="border-b border-amber-400/30 bg-amber-400/10 px-3 py-2"
          data-testid="git-conflicts"
        >
          <div className="mb-1 font-medium text-amber-100">
            Changed here and on GitHub
          </div>
          {conflicts.map((c) => (
            <div key={c.path} className="flex items-center gap-1.5 py-0.5">
              {iconFor(c.path)}
              <span className="truncate">{c.path}</span>
              <span className="text-[10.5px] text-muted">
                {c.kind === "text" ? "markers added" : c.kind}
              </span>
              <button
                className="ml-auto text-accent hover:underline"
                onClick={() =>
                  run(
                    "theirs",
                    async () => (
                      await takeTheirs(c.path),
                      setConflicts((x) => x.filter((y) => y.path !== c.path))
                    ),
                  )
                }
              >
                Use GitHub's
              </button>
              <button
                className="text-muted hover:text-text"
                onClick={() =>
                  setConflicts((x) => x.filter((y) => y.path !== c.path))
                }
              >
                Keep mine
              </button>
            </div>
          ))}
        </div>
      )}
      {view === "changes" && (
        <>
          <div className="space-y-1.5 border-b border-border p-3">
            <textarea
              className={cx(inputCls, "h-16 resize-none py-1.5")}
              placeholder="Commit message"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              data-testid="commit-message"
            />
            <label className="flex items-center gap-1.5 text-muted">
              <input
                type="checkbox"
                checked={newBranch}
                onChange={(e) => setNewBranch(e.target.checked)}
                data-testid="commit-new-branch"
              />{" "}
              Commit to a new branch
            </label>
            {newBranch && (
              <input
                className={inputCls}
                placeholder="branch-name"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                data-testid="commit-branch-name"
              />
            )}
            <Button
              variant="primary"
              className="w-full"
              disabled={
                !changes.length ||
                !msg.trim() ||
                (newBranch && !branchName.trim()) ||
                !!busy
              }
              data-testid="commit-push"
              onClick={() =>
                run("commit", async () => {
                  const r = await commitOpen(
                    msg,
                    newBranch ? { newBranch: branchName.trim() } : {},
                  );
                  toast("success", `Pushed ${r.files} file(s) to ${r.branch}`);
                  setMsg("");
                  if (newBranch) setPr({ branch: r.branch, url: undefined });
                  setNewBranch(false);
                  setBranchName("");
                })
              }
            >
              {busy === "commit"
                ? "Pushing…"
                : `Commit & push ${changes.length} change(s)`}
            </Button>
            {pr && (
              <Button
                className="w-full"
                data-testid="create-pr"
                disabled={!!busy}
                onClick={() =>
                  run("pr", async () => {
                    const gh = github();
                    const info = await gh.repo(st.owner, st.repo);
                    const r = await gh.createPull(st.owner, st.repo, {
                      title: pr.branch.replace(/[-_/]/g, " "),
                      head: pr.branch,
                      base: info.default_branch,
                    });
                    setPr({ branch: pr.branch, url: r.html_url });
                    toast("success", `Pull request #${r.number} opened`);
                  })
                }
              >
                <GitPullRequest size={13} />{" "}
                {pr.url
                  ? "Pull request opened"
                  : `Open a pull request for ${pr.branch}`}
              </Button>
            )}
            {pr?.url && (
              <a
                className="flex items-center gap-1 text-accent hover:underline"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                data-testid="pr-link"
              >
                <ExternalLink size={12} /> View on GitHub
              </a>
            )}
          </div>
          <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Changes ({changes.length})
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            {changes.map((c) => (
              <div
                key={c.path}
                className="mx-1 flex cursor-pointer items-center gap-1.5 rounded px-2 py-[3px] hover:bg-panel-2"
                onClick={() => open(c.path, c.status)}
                data-testid="git-change"
                data-path={c.path}
              >
                {iconFor(c.path)}
                <span className="truncate">{c.path}</span>
                <span
                  className={cx(
                    "ml-auto w-3 text-center font-mono text-[11px]",
                    c.status === "added"
                      ? "text-emerald-300"
                      : c.status === "deleted"
                        ? "text-red-300"
                        : "text-amber-300",
                  )}
                >
                  {c.status[0].toUpperCase()}
                </span>
              </div>
            ))}
            {!changes.length && (
              <div className="px-3 text-muted">
                No changes since the last commit.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
