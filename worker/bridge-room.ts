/**
 * One BridgeRoom per connector key: the cloud copy of that user's projects.
 *
 *   /mcp           Claude's MCP endpoint (tools edit the stored projects directly)
 *   /bridge        WebSocket for open editors: live "project-updated" notices, active project
 *   /sync/...      the editor's sync API (list / get / put / delete projects)
 *
 * Runs inside the Durable Object (not the Worker) so compiling and editing get the Durable
 * Object's generous CPU limit. Editor sockets use hibernation, so idle tabs cost nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION } from '../packages/shared-protocol/src/index';
import { buildServer, type ToolHost } from '../mcp/server/tools';
import { CloudService } from './cloud-service';

export interface Env {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  ASSETS: Fetcher;
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

  private service(site: string) {
    return new CloudService(
      this.ctx.storage,
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

    const m = /^\/sync\/projects(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
    if (m) {
      const id = m[1];
      if (!id && request.method === 'GET') return json(200, { projects: await cloud.list(), tombstones: await cloud.tombstones() });
      if (id && request.method === 'GET') {
        const p = await cloud.get(id);
        return p ? json(200, p) : json(404, { error: 'not found' });
      }
      if (id && request.method === 'PUT') {
        const text = await request.text();
        if (text.length > 4 * 1024 * 1024) return json(413, { error: 'Project too large' });
        const body = JSON.parse(text) as { doc: unknown; baseRevision?: string };
        const r = await cloud.put(body.doc, body.baseRevision);
        return r.ok ? json(200, r) : json(409, r);
      }
      if (id && request.method === 'DELETE') {
        await cloud.remove(id, 'editor');
        return json(200, { deleted: id });
      }
    }
    return json(404, { error: 'not found' });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > BRIDGE_MAX_PAYLOAD) return;
    let msg: { type?: string; projectId?: string; scriptId?: string; functionId?: string };
    try {
      msg = JSON.parse(message);
    } catch {
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
