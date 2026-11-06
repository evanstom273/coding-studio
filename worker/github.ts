/**
 * GitHub access for one connector key. The token lives only in this Durable Object's storage:
 * the browser never stores it (it talks to GitHub through /github/<key>/api/...), and it is never
 * written into project files or returned by any endpoint.
 */
import { GitHub, type Fetch } from '@cs/git';
import type { KvLike } from './cloud-service';

const TOKEN_KEY = 'github:token';
const API = 'https://api.github.com';

export function githubFetch(token: string): Fetch {
  return async (path, init = {}) => {
    const r = await fetch(API + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'coding-studio', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await r.text();
    let body: unknown;
    // Job logs are plain text (GitHub redirects to them; fetch follows). Keep the end: that's where failures are.
    if (!(r.headers.get('content-type') ?? '').includes('json') && r.ok) return { status: r.status, body: { text: text.length > 3_000_000 ? text.slice(-3_000_000) : text } };
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 300) };
    }
    return { status: r.status, body };
  };
}

export class GitHubVault {
  constructor(
    private readonly kv: KvLike,
    /** Overridable for tests. */
    private readonly makeFetch: (token: string) => Fetch = githubFetch,
  ) {}

  async token(): Promise<string | undefined> {
    return (await this.kv.get<{ token: string }>(TOKEN_KEY))?.token;
  }

  async status() {
    const t = await this.kv.get<{ token: string; login: string; at: number }>(TOKEN_KEY);
    return t ? { connected: true, login: t.login, since: t.at } : { connected: false };
  }

  /** Check the token with GitHub, then keep it. */
  async set(token: string) {
    const t = token.trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(t)) throw Object.assign(new Error('That does not look like a GitHub token.'), { code: 'E_INVALID' });
    const user = await new GitHub(this.makeFetch(t)).user();
    await this.kv.put(TOKEN_KEY, { token: t, login: user.login, at: Date.now() });
    return { connected: true, login: user.login };
  }

  async clear() {
    await this.kv.delete(TOKEN_KEY);
    return { connected: false };
  }

  async client(): Promise<GitHub> {
    const t = await this.token();
    if (!t) throw Object.assign(new Error('GitHub is not connected. Add a token in Coding Studio → Source control.'), { code: 'E_GITHUB_NOT_CONNECTED' });
    return new GitHub(this.makeFetch(t));
  }

  /** Proxy one REST call for the browser (paths under /user and /repos only). */
  async proxy(path: string, method: string, body: unknown) {
    if (!/^\/(user|repos)(\/|\?|$)/.test(path)) return { status: 400, body: { message: 'Only /user and /repos endpoints are proxied' } };
    if (!['GET', 'POST', 'PATCH'].includes(method)) return { status: 405, body: { message: 'Method not allowed' } };
    const t = await this.token();
    if (!t) return { status: 401, body: { message: 'GitHub is not connected', code: 'E_GITHUB_NOT_CONNECTED' } };
    return this.makeFetch(t)(path, { method, ...(body !== undefined ? { body } : {}) });
  }
}
