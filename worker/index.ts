/**
 * Coding Studio Worker.
 *
 *  - Serves the editor (static assets, SPA fallback).
 *  - /mcp/<key>          Claude connector (claude.ai, Claude phone/desktop apps). Claude edits the
 *                        cloud copy of your projects directly — no browser needs to be open.
 *  - /bridge/<key>       WebSocket for open editors (live updates).
 *  - /sync/<key>/...     The editor's sync API.
 *
 * <key> is the random secret in your connector link; everything for that key lives in one
 * Durable Object (named by a hash of the key). This is a personal tool: the link is the access.
 */
import { BridgeRoom, type Env } from './bridge-room';

export { BridgeRoom };

const KEY = /^[A-Za-z0-9_-]{32,128}$/;

async function room(env: Env, key: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return env.BRIDGE.get(env.BRIDGE.idFromName(name));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/(mcp|bridge|sync|github)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return env.ASSETS.fetch(request);
    const [, kind, key, rest = ''] = m;
    if (!KEY.test(key)) return json(404, { error: 'Unknown connector link. Copy it again from Coding Studio.' });
    // Browser calls to the editor endpoints must come from this site.
    const origin = request.headers.get('Origin');
    if (kind !== 'mcp' && origin && origin !== url.origin) return json(403, { error: 'Origin not allowed' });
    const inner = new URL(request.url);
    inner.pathname = `/${kind}${kind === 'sync' || kind === 'github' ? rest : ''}`;
    const headers = new Headers(request.headers);
    headers.set('X-Site-Origin', url.origin);
    return (await room(env, key)).fetch(new Request(inner, { method: request.method, headers, body: request.body, ...(request.body ? { duplex: 'half' } : {}) } as RequestInit));
  },
} satisfies ExportedHandler<Env>;
