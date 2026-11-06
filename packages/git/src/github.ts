/**
 * Minimal GitHub REST client over an injected `fetch` (the browser goes through the Worker's
 * proxy, which adds the token; the Durable Object calls GitHub directly). Only the git data,
 * repo and pull-request endpoints the IDE needs.
 */
export type Fetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

export class GitHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepoInfo {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  description?: string | null;
  updated_at?: string;
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  constructor(private readonly f: Fetch) {}

  private async req<T>(path: string, init?: { method?: string; body?: unknown }, ok = [200, 201]): Promise<T> {
    const r = await this.f(path, init);
    if (ok.includes(r.status)) return r.body as T;
    const msg = (r.body as { message?: string } | null)?.message ?? `HTTP ${r.status}`;
    if (r.status === 401) throw new GitHubError('E_GITHUB_AUTH', 'GitHub rejected the token (expired or revoked?). Add a new token in Source control.', 401);
    if (r.status === 403 && /rate limit/i.test(msg)) throw new GitHubError('E_GITHUB_RATE_LIMIT', `GitHub rate limit: ${msg}`, 403);
    if (r.status === 404) throw new GitHubError('E_NOT_FOUND', `Not found on GitHub (${path}). Check the name, and that the token can access this repository.`, 404);
    if (r.status === 409 || r.status === 422) throw new GitHubError('E_GITHUB_REJECTED', `GitHub refused: ${msg}`, r.status);
    throw new GitHubError('E_GITHUB', `GitHub error ${r.status}: ${msg}`, r.status);
  }

  user() {
    return this.req<{ login: string; name?: string }>('/user');
  }
  repos() {
    return this.req<RepoInfo[]>('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
  }
  repo(owner: string, repo: string) {
    return this.req<RepoInfo>(`/repos/${enc(owner)}/${enc(repo)}`);
  }
  branches(owner: string, repo: string) {
    return this.req<{ name: string; commit: { sha: string } }[]>(`/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`);
  }
  async head(owner: string, repo: string, branch: string): Promise<string> {
    return (await this.req<{ object: { sha: string } }>(`/repos/${enc(owner)}/${enc(repo)}/git/ref/heads/${enc(branch)}`)).object.sha;
  }
  commit(owner: string, repo: string, sha: string) {
    return this.req<{ sha: string; tree: { sha: string }; message: string; parents: { sha: string }[] }>(`/repos/${enc(owner)}/${enc(repo)}/git/commits/${sha}`);
  }
  async tree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
    const t = await this.req<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new GitHubError('E_TOO_LARGE', 'This repository is too large for GitHub to list in one go (over ~100,000 files).');
    return t.tree;
  }
  async blob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
    const b = await this.req<{ content: string; encoding: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/blobs/${sha}`);
    if (b.encoding !== 'base64') return new TextEncoder().encode(b.content);
    return Uint8Array.from(atob(b.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  }
  async createBlob(owner: string, repo: string, data: Uint8Array): Promise<string> {
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/blobs`, { method: 'POST', body: { content: btoa(s), encoding: 'base64' } })).sha;
  }
  async createTree(owner: string, repo: string, baseTree: string, entries: { path: string; mode: string; type: 'blob'; sha: string | null }[]): Promise<string> {
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree: entries } })).sha;
  }
  async createCommit(owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<string> {
    return (await this.req<{ sha: string }>(`/repos/${enc(owner)}/${enc(repo)}/git/commits`, { method: 'POST', body: { message, tree, parents } })).sha;
  }
  /** Fast-forward a branch; GitHub refuses (422) if it isn't a fast-forward. */
  updateRef(owner: string, repo: string, branch: string, sha: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/git/refs/heads/${enc(branch)}`, { method: 'PATCH', body: { sha, force: false } });
  }
  createRef(owner: string, repo: string, branch: string, sha: string) {
    return this.req(`/repos/${enc(owner)}/${enc(repo)}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha } });
  }
  createPull(owner: string, repo: string, p: { title: string; head: string; base: string; body?: string }) {
    return this.req<{ number: number; html_url: string }>(`/repos/${enc(owner)}/${enc(repo)}/pulls`, { method: 'POST', body: p });
  }
  pulls(owner: string, repo: string) {
    return this.req<{ number: number; title: string; html_url: string; head: { ref: string }; base: { ref: string }; user: { login: string } }[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&per_page=50`);
  }
}
