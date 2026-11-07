/**
 * One BridgeRoom per connector key: the cloud copy of that user's projects.
 *
 *   /mcp           Claude's MCP endpoint (tools edit the stored projects directly)
 *   /bridge        WebSocket for open editors: live "workspace-updated" notices, active project
 *   /sync/...      the editor's per-file sync API (list / index / read / apply / delete)
 *
 * Runs inside the Durable Object (not the Worker) so compiling and editing get the Durable
 * Object's generous CPU limit. Editor sockets use hibernation, so idle tabs cost nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION } from '../packages/shared-protocol/src/index';
import { buildServer, type ToolHost } from '../mcp/server/tools';
import { CloudService, type KvLike } from './cloud-service';
import { CloudflareVault } from './cloudflare';
import { GitHubVault } from './github';
import type { SqlLike } from './cloud-store';

export interface Env {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  ASSETS: Fetcher;
}

function toBase64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function remoteHost(site: string): ToolHost {
  return {
    openEditorDescription: `Get the address of the Coding Studio editor (${site}). Claude edits cloud projects directly, so the editor does not need to be open; the user can open it to see the changes (they appear live).`,
    async openEditor() {
      return { url: site, note: 'The editor is optional: projects are edited in the cloud. Changes appear live in any open editor.' };
    },
  };
}

export class BridgeRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Questions sent to open editors (e.g. "type-check this project"), answered over their socket. */
  private asks = new Map<string, (v: unknown) => void>();
  private askEditors(msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const open = this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
    if (!open.length) return Promise.reject(new Error('no editor open'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.asks.delete(id);
        reject(new Error('the editor did not answer in time'));
      }, timeoutMs);
      this.asks.set(id, (v) => {
        clearTimeout(t);
        this.asks.delete(id);
        resolve(v);
      });
      const text = JSON.stringify({ ...msg, type: 'ask', id });
      for (const ws of open) {
        try {
          ws.send(text);
        } catch {
          /* closing */
        }
      }
    });
  }

  private service(site: string) {
    const cloud = new CloudService(
      this.ctx.storage as unknown as KvLike,
      { sql: this.ctx.storage.sql as unknown as SqlLike, transaction: (fn) => this.ctx.storage.transactionSync(fn) },
      (msg) => {
        const text = JSON.stringify(msg);
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.send(text);
          } catch {
            /* closing */
          }
        }
      },
      site,
      () => this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN).length,
    );
    cloud.askEditor = (msg, timeoutMs) => this.askEditors(msg, timeoutMs);
    return cloud;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const site = request.headers.get('X-Site-Origin') ?? url.origin;
    const cloud = this.service(site);

    if (url.pathname === '/mcp') {
      const server = buildServer({ request: (method, params = {}) => cloud.handle(method, params) }, remoteHost(site));
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    if (url.pathname === '/bridge') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // GitHub: token kept here, browser calls go through this proxy.
    if (url.pathname.startsWith('/github/')) {
      const vault = new GitHubVault(this.ctx.storage as unknown as KvLike);
      if (url.pathname === '/github/token') {
        try {
          if (request.method === 'GET') return json(200, await vault.status());
          if (request.method === 'DELETE') return json(200, await vault.clear());
          if (request.method === 'PUT') return json(200, await vault.set(String(((await request.json()) as { token?: unknown }).token ?? '')));
        } catch (e) {
          return json(400, { error: { code: (e as { code?: string }).code ?? 'E_GITHUB', message: e instanceof Error ? e.message : String(e) } });
        }
      }
      if (url.pathname === '/github/cloudflare' || url.pathname === '/github/cloudflare/secrets') {
        const cf = new CloudflareVault(this.ctx.storage as unknown as KvLike);
        try {
          if (url.pathname === '/github/cloudflare/secrets' && request.method === 'POST') {
            const b = (await request.json()) as { owner?: string; repo?: string };
            return json(200, await cf.setRepoSecrets(await vault.client(), String(b.owner ?? ''), String(b.repo ?? '')));
          }
          if (request.method === 'GET') return json(200, await cf.status());
          if (request.method === 'DELETE') return json(200, await cf.clear());
          if (request.method === 'PUT') {
            const b = (await request.json()) as { token?: unknown; accountId?: unknown };
            return json(200, await cf.set(String(b.token ?? ''), String(b.accountId ?? '')));
          }
        } catch (e) {
          return json(400, { error: { code: (e as { code?: string }).code ?? 'E_CLOUDFLARE', message: e instanceof Error ? e.message : String(e) } });
        }
      }
      if (url.pathname.startsWith('/github/api/')) {
        const text = request.method === 'GET' ? '' : await request.text();
        if (text.length > 48 * 1024 * 1024) return json(413, { message: 'Request too large' });
        const r = await vault.proxy(url.pathname.slice('/github/api'.length) + url.search, request.method, text ? JSON.parse(text) : undefined);
        // A 204 (e.g. after a delete) can't carry a body; the client treats 200 + null the same.
        return json(r.status === 204 ? 200 : r.status, r.body ?? null);
      }
    }

    // Editor sync API (per file).
    const m = /^\/sync\/workspaces(?:\/([A-Za-z0-9_-]+)(\/read|\/apply)?)?$/.exec(url.pathname);
    if (m) {
      await cloud.migrate();
      const [, id, action] = m;
      if (!id && request.method === 'GET') return json(200, { workspaces: cloud.list(), tombstones: await cloud.tombstones() });
      if (id && !action && request.method === 'GET') {
        const w = cloud.store.get(id);
        return w ? json(200, { ...w, files: cloud.store.index(id) }) : json(404, { error: 'not found' });
      }
      if (id && action === '/read' && request.method === 'POST') {
        const { paths } = (await request.json()) as { paths: string[] };
        const files = cloud.store.readPaths(id, Array.isArray(paths) ? paths : []).map((f) => (f.kind === 'binary' ? { path: f.path, kind: f.kind, hash: f.hash, mtime: f.mtime, base64: toBase64(f.data!) } : { path: f.path, kind: f.kind, hash: f.hash, mtime: f.mtime, text: f.text }));
        return json(200, { files });
      }
      if (id && action === '/apply' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > 48 * 1024 * 1024) return json(413, { error: 'Request too large' });
        const r = await cloud.apply(id, JSON.parse(text));
        return r.ok ? json(200, r) : json(409, r);
      }
      if (id && !action && request.method === 'DELETE') {
        await cloud.remove(id, 'editor');
        return json(200, { deleted: id });
      }
    }
    return json(404, { error: 'not found' });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > BRIDGE_MAX_PAYLOAD) return;
    let msg: { type?: string; projectId?: string; scriptId?: string; functionId?: string; id?: string; result?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type === 'answer' && typeof msg.id === 'string') {
      this.asks.get(msg.id)?.(msg.result);
      return;
    }
    if (msg.type === 'hello') {
      ws.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: 'cloud' }));
      return;
    }
    // The editor tells us what's open so "the project I have open" means something to Claude.
    if (msg.type === 'active' && typeof msg.projectId === 'string') {
      await this.service('').setActive({ projectId: msg.projectId, scriptId: msg.scriptId, functionId: msg.functionId });
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }
}
