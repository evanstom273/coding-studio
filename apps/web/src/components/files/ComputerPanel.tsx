/**
 * "Computer": the project in a real folder on this computer, through the local MCP server.
 * Link or open a folder, install, run package.json scripts, start the dev server, and git
 * (status, commit, pull, push, stash, branches). Shown only when connected to Claude on this computer.
 */
import { useCallback, useEffect, useState } from "react";
import {
  FolderOpen,
  GitBranch,
  Play,
  RefreshCw,
  Square,
  Terminal,
} from "lucide-react";
import { hostRequest, useBridge } from "@web/bridge/client";
import { useEditor } from "@web/store/editor";
import { toast } from "@web/store/toasts";
import { Button, cx, inputCls } from "../ui/primitives";

interface Task {
  id: string;
  kind: string;
  command: string;
  state: string;
  url?: string;
  exitCode?: number | null;
  output?: string;
}
interface Info {
  linked: boolean;
  folder?: string;
  package_manager?: string;
  scripts?: string[];
  git?: boolean;
  tasks?: Task[];
}
interface GitStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changed: { path: string }[];
  untracked: string[];
  conflicts: string[];
}

const err = (e: unknown) =>
  toast("error", e instanceof Error ? e.message : String(e));

export function ComputerPanel() {
  const host = useBridge((s) => s.host);
  const project = useEditor((s) => s.workspace?.meta.id);
  const [info, setInfo] = useState<Info | null>(null);
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<Task | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!host || !project) return;
    try {
      const i = await hostRequest<Info>("info", { project });
      setInfo(i);
      if (i.linked && i.git)
        setGit(
          (await hostRequest<GitStatus & { ok: boolean }>("git", {
            project,
            action: "status",
          })) ?? null,
        );
      else setGit(null);
    } catch (e) {
      err(e);
    }
  }, [host, project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Follow the selected task's output while it runs.
  useEffect(() => {
    if (!selected || !project) return;
    let stop = false;
    const tick = async () => {
      try {
        const t = await hostRequest<Task>("output", { project, id: selected });
        if (stop) return;
        setOutput(t);
        if (t.state === "running") setTimeout(tick, 800);
        else void refresh();
      } catch {
        /* gone */
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [selected, project, refresh]);

  if (!host)
    return (
      <div
        className="p-3 text-[12px] text-muted"
        data-testid="computer-unavailable"
      >
        Run Coding Studio through Claude on a computer (the local MCP server) to
        link this project to a folder there, run its scripts and dev server, and
        use git. On a phone, use Git → Actions instead.
      </div>
    );

  const act = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const r = (await f()) as
        | { id?: string; ok?: boolean; error?: string; conflicts?: string[] }
        | undefined;
      if (r && r.ok === false)
        toast(
          "error",
          r.conflicts?.length
            ? `Conflicts in ${r.conflicts.join(", ")}: fix them, then continue.`
            : (r.error ?? `${label} failed`),
        );
      if (r?.id) setSelected(r.id);
    } catch (e) {
      err(e);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  if (!info?.linked)
    return (
      <div
        className="flex flex-col gap-2 p-3 text-[12px]"
        data-testid="computer-panel"
      >
        <p className="text-muted">
          Put this project in a folder on this computer, to install, run, test
          and build it there. Changes go both ways.
        </p>
        <input
          className={inputCls}
          placeholder="/home/me/projects/my-app"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          data-testid="computer-folder"
        />
        <Button
          disabled={!folder.trim() || !!busy}
          onClick={() =>
            act("Link", () =>
              hostRequest("link", { project, folder: folder.trim() }),
            )
          }
          data-testid="computer-link"
        >
          <FolderOpen size={13} /> Link to this folder
        </Button>
        <Button
          variant="ghost"
          disabled={!folder.trim() || !!busy}
          onClick={() =>
            act("Open", () => hostRequest("open", { folder: folder.trim() }))
          }
          title="Open the folder as a new project instead"
        >
          Open the folder as a new project
        </Button>
      </div>
    );

  const tasks = info.tasks ?? [];
  const dev = tasks.find((t) => t.kind === "dev" && t.state === "running");
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto text-[12px]"
      data-testid="computer-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <FolderOpen size={13} className="shrink-0 text-muted" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          title={info.folder}
          data-testid="computer-linked"
        >
          {info.folder}
        </span>
        <button
          onClick={() => void refresh()}
          title="Refresh"
          className="text-muted hover:text-text"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <section className="border-b border-border px-3 py-2">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
          Run ({info.package_manager})
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            disabled={!!busy}
            onClick={() =>
              act("Install", () => hostRequest("install", { project }))
            }
            data-testid="computer-install"
          >
            Install
          </Button>
          {(info.scripts ?? []).map((s) => (
            <Button
              key={s}
              disabled={!!busy}
              onClick={() =>
                act(s, () =>
                  ["dev", "start", "serve", "preview"].includes(s)
                    ? hostRequest("dev", { project, action: "start" })
                    : hostRequest("run", { project, script: s }),
                )
              }
              data-testid={`computer-script-${s}`}
            >
              <Play size={11} /> {s}
            </Button>
          ))}
        </div>
        {dev && (
          <div
            className="mt-2 flex items-center gap-2"
            data-testid="computer-dev"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            {dev.url ? (
              <a
                href={dev.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent underline"
              >
                {dev.url}
              </a>
            ) : (
              <span className="text-muted">starting…</span>
            )}
            <button
              className="ml-auto text-muted hover:text-text"
              title="Stop"
              onClick={() =>
                act("Stop", () =>
                  hostRequest("dev", { project, action: "stop" }),
                )
              }
              data-testid="computer-dev-stop"
            >
              <Square size={12} />
            </button>
          </div>
        )}
        {tasks.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {tasks
              .slice(-6)
              .reverse()
              .map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelected(t.id)}
                    className={cx(
                      "flex w-full items-center gap-2 rounded px-1 text-left hover:bg-white/5",
                      selected === t.id && "bg-white/5",
                    )}
                    data-testid="computer-task"
                  >
                    <Terminal size={11} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                      {t.command}
                    </span>
                    <span
                      className={cx(
                        "text-[10.5px]",
                        t.state === "passed"
                          ? "text-emerald-300"
                          : t.state === "failed"
                            ? "text-red-300"
                            : "text-muted",
                      )}
                    >
                      {t.state}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
        {output && (
          <pre
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[#0b0e13] p-2 font-mono text-[10.5px] text-[#c9d1d9]"
            data-testid="computer-output"
          >
            {output.output || "(no output yet)"}
          </pre>
        )}
      </section>
      <section className="px-3 py-2" data-testid="computer-git">
        <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-muted">
          <GitBranch size={11} /> Git on this computer
        </div>
        {!info.git ? (
          <Button
            disabled={!!busy}
            onClick={() =>
              act("git init", () =>
                hostRequest("git", { project, action: "init" }),
              )
            }
          >
            Start a git repository here
          </Button>
        ) : (
          git && (
            <>
              <div className="mb-1" data-testid="computer-git-branch">
                <span className="font-mono">{git.branch}</span>
                {git.upstream && (
                  <span className="text-muted">
                    {" "}
                    → {git.upstream} {git.ahead ? `↑${git.ahead}` : ""}{" "}
                    {git.behind ? `↓${git.behind}` : ""}
                  </span>
                )}
              </div>
              {git.conflicts.length > 0 && (
                <div className="mb-1 text-red-300">
                  Conflicts: {git.conflicts.join(", ")}
                </div>
              )}
              <ul
                className="mb-2 max-h-40 overflow-auto font-mono text-[11px]"
                data-testid="computer-git-changes"
              >
                {[...git.changed.map((c) => c.path), ...git.untracked].map(
                  (p) => (
                    <li key={p} className="truncate">
                      {p}
                    </li>
                  ),
                )}
                {!git.changed.length && !git.untracked.length && (
                  <li className="text-muted">No changes</li>
                )}
              </ul>
              <input
                className={inputCls}
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                data-testid="computer-git-message"
              />
              <div className="mt-1 flex flex-wrap gap-1">
                <Button
                  disabled={!!busy || !message.trim()}
                  onClick={() =>
                    act("Commit", async () => {
                      const r = await hostRequest("git", {
                        project,
                        action: "commit",
                        message,
                      });
                      setMessage("");
                      return r;
                    })
                  }
                  data-testid="computer-git-commit"
                >
                  Commit all
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    act("Pull", () =>
                      hostRequest("git", { project, action: "pull" }),
                    )
                  }
                >
                  Pull
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    act("Push", () =>
                      hostRequest("git", { project, action: "push" }),
                    )
                  }
                >
                  Push
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    act("Stash", () =>
                      hostRequest("git", { project, action: "stash" }),
                    )
                  }
                >
                  Stash
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    act("Pop", () =>
                      hostRequest("git", { project, action: "stash_pop" }),
                    )
                  }
                >
                  Pop stash
                </Button>
              </div>
            </>
          )
        )}
      </section>
    </div>
  );
}
