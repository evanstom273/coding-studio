/** An in-memory GitHub (git data + repos + pulls REST endpoints) for tests. */
import { gitBlobHash } from '@cs/workspace';
import type { Fetch } from '@cs/git';

interface Commit {
  tree: Map<string, { sha: string; mode: string }>;
  parents: string[];
  message: string;
}

export class FakeGitHub {
  blobs = new Map<string, Uint8Array>();
  commits = new Map<string, Commit>();
  trees = new Map<string, Map<string, { sha: string; mode: string }>>();
  refs = new Map<string, string>();
  pullsList: { number: number; title: string; head: string; base: string; body?: string; state: 'open' | 'closed'; merged?: boolean; conflict?: boolean }[] = [];
  repoInfo = { private: true, description: '' as string, deleted: false, created: [] as string[] };
  runsList: { id: number; name: string; run_number: number; workflow_id: number; head_branch: string; head_sha: string; event: string; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string; jobs: { id: number; name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null; number: number }[]; log: string }[] }[] = [];
  dispatches: { workflow: string; ref: string }[] = [];
  calls: string[] = [];
  private n = 0;
  constructor(
    readonly owner = 'lyra',
    public name = 'game',
  ) {}

  private id() {
    return (++this.n).toString(16).padStart(40, '0');
  }

  /** Make a commit on a branch directly (as if someone pushed from elsewhere). */
  push(branch: string, files: Record<string, string | Uint8Array | null>, message = 'remote change') {
    const parent = this.refs.get(branch);
    const tree = new Map(parent ? this.commits.get(parent)!.tree : []);
    for (const [p, c] of Object.entries(files)) {
      if (c === null) tree.delete(p);
      else {
        const data = typeof c === 'string' ? new TextEncoder().encode(c) : c;
        const sha = gitBlobHash(data);
        this.blobs.set(sha, data);
        tree.set(p, { sha, mode: '100644' });
      }
    }
    const tsha = this.id();
    this.trees.set(tsha, tree);
    const csha = this.id();
    this.commits.set(csha, { tree, parents: parent ? [parent] : [], message });
    this.refs.set(branch, csha);
    return csha;
  }

  /** Workflows = files under .github/workflows on main. */
  workflowList() {
    const main = this.refs.get('main');
    const tree = main ? this.commits.get(main)!.tree : new Map();
    return [...tree.keys()].filter((p) => p.startsWith('.github/workflows/')).map((p, i) => ({ id: 100 + i, name: p.split('/').pop()!.replace(/\.ya?ml$/, ''), path: p, state: 'active' }));
  }

  addRun(branch: string, opts: { name?: string; conclusion?: string | null; log?: string; event?: string } = {}) {
    const id = 5000 + this.runsList.length;
    const done = opts.conclusion !== null;
    const run = { id, name: opts.name ?? 'CI', run_number: this.runsList.length + 1, workflow_id: 100, head_branch: branch, head_sha: this.refs.get(branch) ?? '0', event: opts.event ?? 'push', status: done ? 'completed' : 'in_progress', conclusion: done ? (opts.conclusion ?? 'success') : null, html_url: `https://github.com/${this.owner}/${this.name}/actions/runs/${id}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), jobs: [{ id: id * 10, name: 'check', status: done ? 'completed' : 'in_progress', conclusion: done ? (opts.conclusion ?? 'success') : null, steps: [{ name: 'test', status: 'completed', conclusion: done ? (opts.conclusion ?? 'success') : null, number: 1 }], log: opts.log ?? '2026-01-01T00:00:00.0000000Z all good' }] };
    this.runsList.unshift(run);
    return run;
  }

  finish(id: number, conclusion: string, log?: string) {
    const r = this.runsList.find((x) => x.id === id)!;
    r.status = 'completed';
    r.conclusion = conclusion;
    for (const j of r.jobs) {
      j.status = 'completed';
      j.conclusion = conclusion;
      j.steps.forEach((st) => (st.conclusion = conclusion));
      if (log) j.log = log;
    }
  }

  files(branch: string): Record<string, string> {
    const c = this.commits.get(this.refs.get(branch)!)!;
    return Object.fromEntries([...c.tree].map(([p, e]) => [p, new TextDecoder().decode(this.blobs.get(e.sha))]));
  }

  private treeOf(csha: string) {
    for (const [t, tree] of this.trees) if (tree === this.commits.get(csha)!.tree) return t;
    throw new Error('no tree');
  }

  fetch: Fetch = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${path}`);
    const body = init.body as Record<string, unknown>;
    const base = `/repos/${this.owner}/${this.name}`;
    const ok = (b: unknown, status = 200) => ({ status, body: b });
    const nf = { status: 404, body: { message: 'Not Found' } };
    let m: RegExpExecArray | null;
    if (path === '/user') return ok({ login: this.owner });
    const info = () => ({ full_name: `${this.owner}/${this.name}`, name: this.name, owner: { login: this.owner }, private: this.repoInfo.private, description: this.repoInfo.description, default_branch: 'main', html_url: `https://github.com/${this.owner}/${this.name}` });
    if (path === '/user/repos' && method === 'POST') {
      // One repository per fake: creating replaces it (with GitHub's README commit).
      this.name = String(body.name);
      this.refs.clear();
      this.pullsList = [];
      this.repoInfo = { ...this.repoInfo, private: body.private !== false, description: String(body.description ?? ''), deleted: false, created: [...this.repoInfo.created, this.name] };
      if (body.auto_init) this.push('main', { 'README.md': `# ${this.name}\n` }, 'Initial commit');
      return ok(info(), 201);
    }
    if (this.repoInfo.deleted && path.startsWith(base)) return nf;
    if (path === base && method === 'PATCH') {
      if (body.name) this.name = String(body.name);
      if (typeof body.private === 'boolean') this.repoInfo.private = body.private;
      if (typeof body.description === 'string') this.repoInfo.description = body.description;
      return ok(info());
    }
    if (path === base && method === 'DELETE') {
      this.repoInfo.deleted = true;
      return { status: 204, body: null };
    }
    if ((m = new RegExp(`^${base}/git/refs/heads/(.+)$`).exec(path)) && method === 'DELETE') {
      this.refs.delete(decodeURIComponent(m[1]));
      return { status: 204, body: null };
    }
    const prJson = (p: (typeof this.pullsList)[number]) => ({ number: p.number, title: p.title, body: p.body ?? null, html_url: `https://github.com/${this.owner}/${this.name}/pull/${p.number}`, state: p.state, merged: !!p.merged, mergeable: p.merged || p.state !== 'open' ? null : !p.conflict, mergeable_state: p.conflict ? 'dirty' : 'clean', head: { ref: p.head, sha: this.refs.get(p.head) ?? '' }, base: { ref: p.base }, user: { login: this.owner }, changed_files: 1, commits: 1 });
    if ((m = new RegExp(`^${base}/pulls/(\\d+)/merge$`).exec(path)) && method === 'PUT') {
      const pr = this.pullsList.find((x) => x.number === +m![1]);
      if (!pr) return nf;
      if (pr.conflict) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      const head = this.refs.get(pr.head)!;
      const parent = this.refs.get(pr.base)!;
      const tree = new Map(this.commits.get(head)!.tree);
      const tsha = this.id();
      this.trees.set(tsha, tree);
      const csha = this.id();
      this.commits.set(csha, { tree, parents: body.merge_method === 'merge' ? [parent, head] : [parent], message: String(body.commit_title ?? `Merge pull request #${pr.number}`) });
      this.refs.set(pr.base, csha);
      pr.merged = true;
      pr.state = 'closed';
      return ok({ sha: csha, merged: true, message: 'Pull Request successfully merged' });
    }
    if ((m = new RegExp(`^${base}/pulls/(\\d+)/files`).exec(path))) return ok([{ filename: 'main.gd', status: 'modified', additions: 1, deletions: 0 }]);
    if ((m = new RegExp(`^${base}/pulls/(\\d+)$`).exec(path))) {
      const pr = this.pullsList.find((x) => x.number === +m![1]);
      if (!pr) return nf;
      if (method === 'PATCH') {
        if (body.title) pr.title = String(body.title);
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pr.state = body.state;
      }
      return ok(prJson(pr));
    }
    if (path.startsWith('/user/repos')) return ok([{ full_name: `${this.owner}/${this.name}`, name: this.name, owner: { login: this.owner }, private: true, default_branch: 'main' }]);
    if (path === base) return ok(info());
    if (path.startsWith(`${base}/branches`)) return ok([...this.refs].map(([name, sha]) => ({ name, commit: { sha } })));
    if ((m = new RegExp(`^${base}/git/ref/heads/(.+)$`).exec(path))) {
      const sha = this.refs.get(decodeURIComponent(m[1]));
      return sha ? ok({ object: { sha } }) : nf;
    }
    if ((m = new RegExp(`^${base}/git/commits/([0-9a-f]+)$`).exec(path))) {
      const c = this.commits.get(m[1]);
      return c ? ok({ sha: m[1], tree: { sha: this.treeOf(m[1]) }, message: c.message, parents: c.parents.map((sha) => ({ sha })) }) : nf;
    }
    if ((m = new RegExp(`^${base}/git/trees/([0-9a-f]+)\\?recursive=1$`).exec(path))) {
      const t = this.trees.get(m[1]);
      return t ? ok({ truncated: false, tree: [...t].map(([p, e]) => ({ path: p, mode: e.mode, type: 'blob', sha: e.sha, size: this.blobs.get(e.sha)!.length })) }) : nf;
    }
    if ((m = new RegExp(`^${base}/git/blobs/([0-9a-f]+)$`).exec(path))) {
      const b = this.blobs.get(m[1]);
      if (!b) return nf;
      let s = '';
      b.forEach((x) => (s += String.fromCharCode(x)));
      return ok({ content: btoa(s), encoding: 'base64' });
    }
    if (path === `${base}/git/blobs` && method === 'POST') {
      const data = Uint8Array.from(atob(String(body.content)), (c) => c.charCodeAt(0));
      const sha = gitBlobHash(data);
      this.blobs.set(sha, data);
      return ok({ sha }, 201);
    }
    if (path === `${base}/git/trees` && method === 'POST') {
      const t = new Map(this.trees.get(String(body.base_tree)));
      for (const e of body.tree as { path: string; mode: string; sha: string | null }[]) {
        if (e.sha === null) t.delete(e.path);
        else t.set(e.path, { sha: e.sha, mode: e.mode });
      }
      const sha = this.id();
      this.trees.set(sha, t);
      return ok({ sha }, 201);
    }
    if (path === `${base}/git/commits` && method === 'POST') {
      const sha = this.id();
      this.commits.set(sha, { tree: this.trees.get(String(body.tree))!, parents: body.parents as string[], message: String(body.message) });
      return ok({ sha }, 201);
    }
    if ((m = new RegExp(`^${base}/git/refs/heads/(.+)$`).exec(path)) && method === 'PATCH') {
      const br = decodeURIComponent(m[1]);
      const cur = this.refs.get(br);
      const next = this.commits.get(String(body.sha))!;
      if (!next.parents.includes(cur!)) return { status: 422, body: { message: 'Update is not a fast forward' } };
      this.refs.set(br, String(body.sha));
      return ok({});
    }
    if (path === `${base}/git/refs` && method === 'POST') {
      const br = String(body.ref).replace('refs/heads/', '');
      if (this.refs.has(br)) return { status: 422, body: { message: 'Reference already exists' } };
      this.refs.set(br, String(body.sha));
      return ok({}, 201);
    }
    if (path === `${base}/pulls` && method === 'POST') {
      if (!this.refs.has(String(body.head))) return { status: 422, body: { message: 'Validation Failed: head does not exist' } };
      const pr = { number: this.pullsList.length + 1, title: String(body.title), head: String(body.head), base: String(body.base), body: body.body as string | undefined, state: 'open' as const };
      this.pullsList.push(pr);
      return ok({ number: pr.number, html_url: `https://github.com/${this.owner}/${this.name}/pull/${pr.number}` }, 201);
    }
    if (path.startsWith(`${base}/actions/workflows?`)) return ok({ workflows: this.workflowList() });
    if ((m = new RegExp(`^${base}/actions/workflows/([^/]+)/dispatches$`).exec(path)) && method === 'POST') {
      const wf = this.workflowList().find((w) => String(w.id) === decodeURIComponent(m![1]) || w.path.endsWith(decodeURIComponent(m![1])));
      if (!wf) return { status: 404, body: { message: 'Workflow not found' } };
      this.dispatches.push({ workflow: wf.path, ref: String(body.ref) });
      this.addRun(String(body.ref), { name: wf.name, conclusion: null, event: 'workflow_dispatch' });
      return { status: 204, body: null };
    }
    if (path.startsWith(`${base}/actions/runs?`)) {
      const q = new URL(`http://x${path}`).searchParams;
      const strip = ({ jobs: _j, ...r }: (typeof this.runsList)[number]) => (void _j, r);
      return ok({ workflow_runs: this.runsList.filter((r) => (!q.get('branch') || r.head_branch === q.get('branch')) && (!q.get('head_sha') || r.head_sha === q.get('head_sha'))).map(strip) });
    }
    if ((m = new RegExp(`^${base}/actions/runs/(\\d+)/jobs`).exec(path))) {
      const r = this.runsList.find((x) => x.id === +m![1]);
      return r ? ok({ jobs: r.jobs.map(({ log: _l, ...j }) => (void _l, j)) }) : nf;
    }
    if ((m = new RegExp(`^${base}/actions/runs/(\\d+)/rerun-failed-jobs$`).exec(path)) && method === 'POST') {
      const r = this.runsList.find((x) => x.id === +m![1]);
      if (!r) return nf;
      r.status = 'in_progress';
      r.conclusion = null;
      return ok({}, 201);
    }
    if ((m = new RegExp(`^${base}/actions/runs/(\\d+)$`).exec(path))) {
      const r = this.runsList.find((x) => x.id === +m![1]);
      return r ? ok({ ...r, jobs: undefined }) : nf;
    }
    if ((m = new RegExp(`^${base}/actions/jobs/(\\d+)/logs$`).exec(path))) {
      const j = this.runsList.flatMap((r) => r.jobs).find((x) => x.id === +m![1]);
      return j ? ok({ text: j.log }) : nf;
    }
    if (path.startsWith(`${base}/pulls`)) {
      const state = new URL(`http://x${path}`).searchParams.get('state') ?? 'open';
      return ok(this.pullsList.filter((p) => state === 'all' || p.state === state).map(prJson));
    }
    return nf;
  };
}
