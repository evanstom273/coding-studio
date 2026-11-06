/**
 * Coding Studio Worker.
 *
 *  - Serves the editor (static assets, SPA fallback).
 *  - /mcp/<key>     Remote MCP endpoint for Claude connectors (claude.ai, Claude mobile/desktop).
 *  - /bridge/<key>  WebSocket the editor tab opens when "Claude connector" is switched on.
 *
 * <key> is a random secret generated in the user's browser (≥ 32 chars). Anyone who has the
 * connector link can drive that user's open editor tab, so it is shown only in the editor and
 * can be regenerated there. The editor WebSocket is only accepted from this site's own origin.
 * Durable Objects are named by a hash of the key, so the key itself is never used as a name.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { BridgeRequestError } from '../mcp/server/errors';
import { buildServer, type Relay, type ToolHost } from '../mcp/server/tools';
import { BridgeRoom, type Env, type RelayResult } from './bridge-room';

export { BridgeRoom };

const KEY = /^[A-Za-z0-9_-]{32,128}$/;

async function room(env: Env, key: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const name = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return env.BRIDGE.get(env.BRIDGE.idFromName(name));
}

function remoteHost(site: string): ToolHost {
  return {
    openEditorDescription: `Coding Studio runs in the user's browser at ${site}. Use this to get the address and instructions to give the user when status says it isn't connected.`,
    async openEditor() {
      return { url: site, instructions: `Ask the user to open ${site}, tap the robot "MCP" button in the toolbar and switch on "Claude connector", then call status again. On a phone, keep the tab visible (e.g. split screen) while you work.` };
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    let m = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (m) {
      if (!KEY.test(m[1])) return json(404, { error: 'Unknown connector link. Copy it again from Coding Studio.' });
      const stub = await room(env, m[1]);
      const relay: Relay = {
        async request(method, params = {}, timeoutMs = 30_000) {
          // RPC types can't express `unknown` results, so restate the shape.
          const r = (await stub.relay(method, params, timeoutMs, url.origin)) as unknown as RelayResult;
          if (r.ok) return r.result;
          throw new BridgeRequestError(r.error.code, r.error.message, r.error.details);
        },
      };
      const server = buildServer(relay, remoteHost(url.origin));
      // Stateless: every HTTP request is self-contained; state lives in the editor.
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    m = /^\/bridge\/([^/]+)\/?$/.exec(url.pathname);
    if (m) {
      if (!KEY.test(m[1])) return json(404, { error: 'Unknown connector key' });
      // Only Coding Studio pages from this very site may attach as the editor.
      if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'Origin not allowed' });
      return (await room(env, m[1])).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
