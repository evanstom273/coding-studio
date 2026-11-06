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
  pullsList: { number: number; title: string; head: string; base: string }[] = [];
  calls: string[] = [];
  private n = 0;
  constructor(
    readonly owner = 'lyra',
    readonly name = 'game',
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
    if (path.startsWith('/user/repos')) return ok([{ full_name: `${this.owner}/${this.name}`, name: this.name, owner: { login: this.owner }, private: true, default_branch: 'main' }]);
    if (path === base) return ok({ full_name: `${this.owner}/${this.name}`, name: this.name, owner: { login: this.owner }, private: true, default_branch: 'main' });
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
      const pr = { number: this.pullsList.length + 1, title: String(body.title), head: String(body.head), base: String(body.base) };
      this.pullsList.push(pr);
      return ok({ number: pr.number, html_url: `https://github.com/${this.owner}/${this.name}/pull/${pr.number}` }, 201);
    }
    if (path.startsWith(`${base}/pulls`)) return ok(this.pullsList.map((p) => ({ number: p.number, title: p.title, html_url: '', head: { ref: p.head }, base: { ref: p.base }, user: { login: this.owner } })));
    return nf;
  };
}
