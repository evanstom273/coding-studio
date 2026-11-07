/** Git through the local host: real git against a local "remote". */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitArgs, LocalHost, parseStatus } from "../../mcp/server/host";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });

/** A fake editor: keeps the project's files in a Map and answers the host's bridge calls. */
function fakeEditor() {
  const files = new Map<string, string>();
  let rev = 0;
  const confirms: string[] = [];
  let approve = true;
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (method === "host_import") {
      for (const f of params.files as { path: string; text: string }[])
        files.set(f.path, f.text);
      rev++;
      return { project: "g1" };
    }
    if (method === "host_snapshot")
      return {
        project: "g1",
        name: "g",
        files: [...files].map(([path, text]) => ({ path, text })),
      };
    if (method === "host_revision")
      return { open: true, revision: String(rev) };
    if (method === "workspace_batch") {
      for (const o of params.operations as {
        op: string;
        path: string;
        content?: string;
      }[]) {
        if (o.op === "delete") files.delete(o.path);
        else files.set(o.path, o.content ?? "");
      }
      rev++;
      return {};
    }
    if (method === "confirm_action") {
      confirms.push(String(params.message));
      return { approved: approve };
    }
    return {};
  };
  return {
    files,
    request,
    confirms,
    setApprove: (v: boolean) => (approve = v),
    edit: (p: string, t: string) => (files.set(p, t), rev++),
  };
}

describe("local_git", () => {
  it("never lets a value become an option", () => {
    expect(() => gitArgs("/r", "switch", { branch: "--orphan" })).toThrow(
      /branch/,
    );
    expect(() => gitArgs("/r", "blame", { path: "../x" })).toThrow(/outside/);
    expect(gitArgs("/r", "commit", { message: "--amend" })).toEqual([
      "commit",
      "-m",
      "--amend",
    ]);
    expect(
      parseStatus(
        "# branch.head main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n? new.txt\n",
      ),
    ).toMatchObject({
      branch: "main",
      ahead: 2,
      behind: 1,
      changed: [{ path: "src/a.ts", staged: ".", unstaged: "M" }],
      untracked: ["new.txt"],
    });
  });

  it("clones, commits, stashes, rebases through a conflict, cherry-picks, blames and pushes (with approval)", async () => {
    const base = mkdtempSync(join(tmpdir(), "cs-git-"));
    const remote = join(base, "remote.git");
    const seed = join(base, "seed");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    execFileSync("git", ["clone", remote, seed], { stdio: "ignore" });
    writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-m", "first");
    sh(seed, "push", "origin", "main");

    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Claude";
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "c@x";
    const ed = fakeEditor();
    const host = new LocalHost(ed.request, 0);
    const work = join(base, "work");
    const opened = (await host.open(work, {
      cloneUrl: `file://${remote}`,
    })) as { files: number };
    expect(opened.files).toBe(1);
    expect(ed.files.get("a.txt")).toBe("one\ntwo\nthree\n");

    // edit in the editor → commit (written to the folder first)
    ed.edit("a.txt", "ONE\ntwo\nthree\n");
    expect(await host.git("commit", { message: "shout one" })).toMatchObject({
      ok: true,
    });
    expect(
      (await host.git("log")) as { commits: { subject: string }[] },
    ).toMatchObject({
      commits: [{ subject: "shout one" }, { subject: "first" }],
    });

    // stash takes an uncommitted edit out of the project; stash_pop brings it back
    ed.edit("a.txt", "ONE\ntwo\nthree\nfour\n");
    await host.git("stash", { message: "wip" });
    expect(ed.files.get("a.txt")).toBe("ONE\ntwo\nthree\n");
    await host.git("stash_pop");
    expect(ed.files.get("a.txt")).toBe("ONE\ntwo\nthree\nfour\n");
    await host.git("commit", { message: "add four" });

    // someone else changes the same line upstream → rebase stops with a conflict
    writeFileSync(join(seed, "a.txt"), "uno\ntwo\nthree\n");
    sh(seed, "commit", "-am", "spanish");
    sh(seed, "push", "origin", "main");
    await host.git("fetch");
    const reb = (await host.git("rebase", { onto: "origin/main" })) as {
      ok: boolean;
      conflicts: string[];
    };
    expect(ed.confirms.at(-1)).toContain("git rebase origin/main");
    expect(reb).toMatchObject({ ok: false, conflicts: ["a.txt"] });
    expect(ed.files.get("a.txt")).toContain("<<<<<<<");
    ed.edit("a.txt", "Uno\ntwo\nthree\n");
    const cont = (await host.git("rebase_continue")) as {
      ok: boolean;
      error?: string;
    };
    expect(cont.ok, cont.error).toBe(true);
    // "add four" now applies on top
    expect(ed.files.get("a.txt")).toBe("Uno\ntwo\nthree\nfour\n");

    // cherry-pick a commit from another branch
    sh(seed, "switch", "-c", "extra");
    writeFileSync(join(seed, "b.txt"), "bee\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-m", "add b");
    sh(seed, "push", "origin", "extra");
    const sha = sh(seed, "rev-parse", "HEAD").trim();
    await host.git("fetch");
    expect(await host.git("cherry_pick", { commit: sha })).toMatchObject({
      ok: true,
    });
    expect(ed.files.get("b.txt")).toBe("bee\n");

    const blame = (await host.git("blame", { path: "a.txt" })) as {
      lines: { line: number; author: string; summary: string }[];
    };
    expect(blame.lines[1]).toMatchObject({
      line: 2,
      author: "T",
      summary: "first",
    });
    expect(
      (await host.git("status")) as { branch: string; ahead: number },
    ).toMatchObject({ branch: "main", ahead: 3 });

    ed.setApprove(false);
    await expect(host.git("push")).rejects.toMatchObject({
      code: "E_DECLINED",
    });
    ed.setApprove(true);
    expect(await host.git("push")).toMatchObject({ ok: true });
    expect(sh(remote, "log", "--format=%s", "main")).toBe(
      "add b\nadd four\nshout one\nspanish\nfirst\n",
    );
    expect(await host.git("lfs_track", { pattern: "*.png" })).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(work, ".gitattributes"), "utf8")).toContain(
      "*.png filter=lfs",
    );
    host.dispose();
  }, 60_000);
});
