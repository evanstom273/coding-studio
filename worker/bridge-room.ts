/**
 * One BridgeRoom per connector key. It holds the WebSocket of the Coding Studio tab that switched
 * the Claude connector on, and relays MCP tool calls to it. Same rules as the local bridge:
 * one tab owns the room; another tab must explicitly take over; nothing is replaced silently.
 *
 * Uses WebSocket hibernation, so an idle open tab costs (almost) nothing.
 */
import { DurableObject } from 'cloudflare:workers';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, type BridgeError, type BridgeMethod } from '../packages/shared-protocol/src/index';

export interface Env {
  BRIDGE: DurableObjectNamespace<BridgeRoom>;
  ASSETS: Fetcher;
}

type Attachment = { owner?: boolean; sessionId?: string };
export type RelayResult = { ok: true; result: unknown } | { ok: false; error: BridgeError };

export class BridgeRoom extends DurableObject<Env> {
  private pending = new Map<string, { resolve: (r: RelayResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings from the editor are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? {};
  }

  private owner(): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => this.att(ws).owner && ws.readyState === WebSocket.OPEN);
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  private failPending(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: { code: 'E_DISCONNECTED', message } });
      this.pending.delete(id);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > BRIDGE_MAX_PAYLOAD) return;
    let msg: { type?: string; app?: string; protocol?: number; sessionId?: string; takeover?: boolean; id?: string; ok?: boolean; result?: unknown; error?: BridgeError };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!this.att(ws).owner) {
      if (msg.type !== 'hello' || msg.app !== 'coding-studio' || typeof msg.sessionId !== 'string') return ws.close(4003, 'Expected hello');
      if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
        this.send(ws, { type: 'rejected', reason: 'protocol', message: 'This page is out of date. Reload it.' });
        return ws.close(4004, 'Protocol mismatch');
      }
      const cur = this.owner();
      if (cur && cur !== ws) {
        const same = this.att(cur).sessionId === msg.sessionId;
        if (!same && !msg.takeover) {
          this.send(ws, { type: 'rejected', reason: 'busy', message: 'Another Coding Studio tab is using this Claude connector. Tap "Take over" to move it here.' });
          return ws.close(4001, 'Busy');
        }
        if (!same) this.send(cur, { type: 'revoked', message: 'Another Coding Studio tab took over the Claude connector.' });
        cur.serializeAttachment({} satisfies Attachment);
        cur.close(4000, same ? 'Reconnected' : 'Taken over');
        this.failPending('The editor tab changed while this request was running; check status.');
      }
      ws.serializeAttachment({ owner: true, sessionId: msg.sessionId } satisfies Attachment);
      this.send(ws, { type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: 'remote' });
      return;
    }
    if (msg.type !== 'response' || !msg.id) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error ?? { code: 'E_INTERNAL', message: 'Unknown error' } });
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    const wasOwner = this.att(ws).owner;
    ws.serializeAttachment({} satisfies Attachment);
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
    if (wasOwner) this.failPending('The editor tab disconnected before answering. The edit may not have been applied; check status.');
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011);
  }

  /** Called by the Worker for each MCP tool call (RPC). */
  async relay(method: BridgeMethod, params: Record<string, unknown>, timeoutMs: number, siteUrl: string): Promise<RelayResult> {
    const ws = this.owner();
    if (!ws) {
      return {
        ok: false,
        error: {
          code: 'E_NOT_CONNECTED',
          message: `Coding Studio isn't connected to this connector. Ask the user to open ${siteUrl} (on their phone or computer), tap the robot "MCP" button in the toolbar and switch on "Claude connector". The tab has to stay open while you work.`,
        },
      };
    }
    const id = `c${++this.seq}`;
    const body = JSON.stringify({ type: 'request', id, method, params });
    if (body.length > BRIDGE_MAX_PAYLOAD) return { ok: false, error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'Request too large; split it into smaller batches.' } };
    const wait = Math.min(Math.max(timeoutMs, 1000), 300_000);
    return new Promise<RelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'E_TIMEOUT', message: `Coding Studio did not answer "${method}" within ${wait / 1000}s. If the tab is in the background on a phone, bring it to the front (or use split screen).` } });
      }, wait);
      this.pending.set(id, { resolve, timer });
      ws.send(body);
    });
  }
}
