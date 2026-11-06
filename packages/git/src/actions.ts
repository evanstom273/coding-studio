/**
 * GitHub Actions helpers: workflow templates for the project, and turning a job log into a list
 * of problems that point at files in the workspace.
 */
import type { Job, WorkflowRun } from "./github";

export const WORKFLOW_DIR = ".github/workflows";

export interface WorkflowTemplate {
  id: string;
  title: string;
  description: string;
  path: string;
  build(ctx: {
    packageJson?: string;
    hasLockfile: { npm: boolean; pnpm: boolean; yarn: boolean };
  }): string;
}

function scriptsOf(pkg?: string): Record<string, string> {
  try {
    return (
      (JSON.parse(pkg ?? "{}") as { scripts?: Record<string, string> })
        .scripts ?? {}
    );
  } catch {
    return {};
  }
}

function setupSteps(ctx: Parameters<WorkflowTemplate["build"]>[0]) {
  const pm = ctx.hasLockfile.pnpm
    ? "pnpm"
    : ctx.hasLockfile.yarn
      ? "yarn"
      : "npm";
  const install =
    pm === "pnpm"
      ? "pnpm install --frozen-lockfile"
      : pm === "yarn"
        ? "yarn install --frozen-lockfile"
        : ctx.hasLockfile.npm
          ? "npm ci"
          : "npm install";
  return {
    pm,
    yaml: `      - uses: actions/checkout@v4
${pm === "pnpm" ? "      - uses: pnpm/action-setup@v4\n" : ""}      - uses: actions/setup-node@v4
        with:
          node-version: 22
${pm !== "npm" || ctx.hasLockfile.npm ? `          cache: ${pm}\n` : ""}      - run: ${install}
`,
  };
}

const run = (pm: string, script: string) =>
  pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "ci",
    title: "Check & test (Node / Vite / TypeScript)",
    description:
      "On every push and pull request: install, then run the typecheck, lint, test and build scripts your package.json has.",
    path: `${WORKFLOW_DIR}/ci.yml`,
    build(ctx) {
      const s = scriptsOf(ctx.packageJson);
      const { pm, yaml } = setupSteps(ctx);
      const steps = ["typecheck", "lint", "test", "build"]
        .filter((k) => s[k])
        .map((k) => `      - name: ${k}\n        run: ${run(pm, k)}\n`);
      if (!steps.length)
        steps.push(
          '      - name: build\n        run: echo "Add typecheck / lint / test / build scripts to package.json"\n',
        );
      return `name: CI
on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
${yaml}${steps.join("")}`;
    },
  },
  {
    id: "cloudflare",
    title: "Deploy to Cloudflare (Workers)",
    description:
      "On pushes to main (or when run by hand): build and deploy with wrangler. Needs repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    path: `${WORKFLOW_DIR}/deploy.yml`,
    build(ctx) {
      const s = scriptsOf(ctx.packageJson);
      const { pm, yaml } = setupSteps(ctx);
      return `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
${yaml}${s.build ? `      - run: ${run(pm, "build")}\n` : ""}      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
    },
  },
];

export interface LogProblem {
  /** Line in the log (1-based). */
  logLine: number;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
}

// Timestamps GitHub prefixes to every log line.
const TS = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

export function cleanLogLine(l: string) {
  return l.replace(TS, "").replace(ANSI, "");
}

/**
 * Find errors in a job log: `##[error]` annotations, `file(line,col): error` (tsc),
 * `file:line:col` (eslint, vite, node, vitest stack frames) — matched against workspace paths.
 */
export function parseLogProblems(
  log: string,
  hasFile: (path: string) => boolean,
): LogProblem[] {
  const out: LogProblem[] = [];
  const seen = new Set<string>();
  const lines = log.split("\n");
  const resolve = (raw: string) => {
    const p = raw
      .replace(/^\.?\//, "")
      .replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, "");
    return hasFile(p) ? p : undefined;
  };
  let lastFailure = -100;
  lines.forEach((rawLine, i) => {
    const l = cleanLogLine(rawLine);
    const failing = /error|fail|✗|×|FAIL|Error/.test(l);
    const ann = /^##\[(error|warning)\](.*)$/.exec(l);
    const tsc =
      /([\w./@-]+\.[a-zA-Z]+)\((\d+),(\d+)\):\s*(error|warning)\s*(.*)$/.exec(
        l,
      );
    const loc =
      /(?:^|[\s(])((?:\.?\/)?[\w./@-]+\.[a-zA-Z]{1,5}):(\d+)(?::(\d+))?/.exec(
        l,
      );
    let p: LogProblem | null = null;
    if (tsc && resolve(tsc[1]))
      p = {
        logLine: i + 1,
        file: resolve(tsc[1]),
        line: +tsc[2],
        column: +tsc[3],
        severity: tsc[4] as "error",
        message: tsc[5].trim(),
      };
    else if (ann) {
      const f = loc ? resolve(loc[1]) : undefined;
      p = {
        logLine: i + 1,
        severity: ann[1] as "error",
        message: ann[2].trim() || "Error",
        ...(f
          ? {
              file: f,
              line: +loc![2],
              ...(loc![3] ? { column: +loc![3] } : {}),
            }
          : {}),
      };
      // A location on a failure line, or just after one (test runners print the frame below the message).
    } else if (loc && resolve(loc[1]) && (failing || i - lastFailure <= 6))
      p = {
        logLine: i + 1,
        severity: "error",
        message: l.trim().slice(0, 300),
        file: resolve(loc[1]),
        line: +loc[2],
        ...(loc[3] ? { column: +loc[3] } : {}),
      };
    if (failing && !ann) lastFailure = i;
    if (!p) return;
    const key = `${p.file}:${p.line}:${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  });
  return out.slice(0, 200);
}

export const runState = (r: Pick<WorkflowRun, "status" | "conclusion">) =>
  r.status !== "completed"
    ? "running"
    : r.conclusion === "success"
      ? "passed"
      : r.conclusion === "skipped" ||
          r.conclusion === "cancelled" ||
          r.conclusion === "neutral"
        ? r.conclusion
        : "failed";

export function summarizeRun(r: WorkflowRun, jobs?: Job[]) {
  return {
    id: r.id,
    workflow: r.name,
    number: r.run_number,
    branch: r.head_branch,
    commit: r.head_sha.slice(0, 7),
    event: r.event,
    state: runState(r),
    title: r.display_title,
    url: r.html_url,
    started: r.created_at,
    ...(jobs
      ? {
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            state: runState({
              status: j.status as WorkflowRun["status"],
              conclusion: j.conclusion as WorkflowRun["conclusion"],
            }),
            failed_steps: (j.steps ?? [])
              .filter((s) => s.conclusion === "failure")
              .map((s) => s.name),
          })),
        }
      : {}),
  };
}
