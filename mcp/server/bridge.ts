/**
 * Loopback WebSocket bridge between the MCP server and one editor tab.
 *
 * Security model:
 *  - binds to 127.0.0.1 only;
 *  - the WebSocket handshake is rejected unless the Origin is http(s)://localhost / 127.0.0.1 or
 *    listed in CODING_STUDIO_ORIGINS (browsers always send Origin; other local programs that
 *    could fake it already have full access to the user's account anyway);
 *  - exactly one tab owns the session. A second tab is told the bridge is busy; it can only take
 *    over when its user clicks "Take over", and the previous owner is told it lost control;
 *  - message size is capped (BRIDGE_MAX_PAYLOAD); idle/dead sockets are dropped by heartbeat.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, type BridgeError, type BridgeMessage, type BridgeMethod, type BridgeWelcome } from '@cs/shared-protocol';

export const SERVER_VERSION = '0.1.0';
export const log = (...a: unknown[]) => console.error('[coding-studio-mcp]', ...a);

export function parseOrigins(env: string | undefined): string[] {
  return (env ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined, extra: string[]): boolean {
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  return extra.includes(origin.replace(/\/+$/, ''));
}

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class EditorBridge {
  private wss: WebSocketServer | null = null;
  private owner: { ws: WebSocket; sessionId: string; origin: string } | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  startError: string | null = null;

  constructor(
    readonly port: number,
    readonly origins: string[],
  ) {}

  start(): Promise<void> {
    return new Promise((done) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        maxPayload: BRIDGE_MAX_PAYLOAD,
        verifyClient: (info: { origin: string }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
          if (isAllowedOrigin(info.origin, this.origins)) return cb(true);
          log(`rejected connection from origin ${info.origin || '(none)'} — add it to CODING_STUDIO_ORIGINS to allow it`);
          cb(false, 403, 'Origin not allowed');
        },
      });
      wss.on('listening', () => {
        log(`waiting for Coding Studio on ws://127.0.0.1:${this.port}`);
        done();
      });
      wss.on('error', (e: NodeJS.ErrnoException) => {
        this.startError = e.code === 'EADDRINUSE' ? `Port ${this.port} is already in use (another Coding Studio MCP server is probably running). Stop it, or set CODING_STUDIO_PORT here and the same port in Coding Studio.` : `Bridge failed: ${e.message}`;
        log(this.startError);
        done();
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, String(req.headers.origin ?? '')));
      this.wss = wss;
      this.heartbeat = setInterval(() => {
        for (const c of wss.clients) {
          const alive = (c as WebSocket & { alive?: boolean }).alive;
          if (alive === false) c.terminate();
          else {
            (c as WebSocket & { alive?: boolean }).alive = false;
            c.ping();
          }
        }
      }, 15_000);
    });
  }

  private onConnection(ws: WebSocket, origin: string) {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
    let identified = false;
    const helloTimer = setTimeout(() => !identified && ws.close(4002, 'No hello'), 5000);
    ws.on('message', (data) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!identified) {
        if (msg.type !== 'hello' || msg.app !== 'coding-studio' || typeof msg.sessionId !== 'string') return ws.close(4003, 'Expected hello');
        clearTimeout(helloTimer);
        if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
          this.send(ws, { type: 'rejected', reason: 'protocol', message: `Editor speaks bridge protocol ${msg.protocol}, server ${BRIDGE_PROTOCOL_VERSION}. Update the MCP server (npm run build:mcp) or reload the editor.` });
          return ws.close(4004, 'Protocol mismatch');
        }
        const cur = this.owner;
        if (cur && cur.ws.readyState === WebSocket.OPEN && cur.sessionId !== msg.sessionId) {
          if (!msg.takeover) {
            this.send(ws, { type: 'rejected', reason: 'busy', message: 'Another Coding Studio tab is connected to Claude Code. Click "Take over" in this tab to move control here.' });
            return ws.close(4001, 'Busy');
          }
          this.send(cur.ws, { type: 'revoked', message: 'Another Coding Studio tab took over the Claude Code connection.' });
          cur.ws.close(4000, 'Taken over');
          this.failPending('The editor tab changed while this request was running; it may or may not have been applied. Call status and re-read the project.');
          log('control moved to another tab (user-initiated takeover)');
        }
        identified = true;
        this.owner = { ws, sessionId: msg.sessionId, origin };
        this.send(ws, { type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
        log(`Coding Studio connected (${origin})`);
        return;
      }
      if (this.owner?.ws !== ws || msg.type !== 'response') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeRequestError(msg.error.code, msg.error.message, msg.error.details));
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.owner?.ws === ws) {
        this.owner = null;
        this.failPending('The editor disconnected before answering. The edit may not have been applied; check status.');
        log('Coding Studio disconnected');
      }
    });
  }

  private send(ws: WebSocket, msg: BridgeWelcome | BridgeMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private failPending(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeRequestError('E_DISCONNECTED', message));
      this.pending.delete(id);
    }
  }

  get connected() {
    return this.owner?.ws.readyState === WebSocket.OPEN;
  }

  get origin() {
    return this.owner?.origin;
  }

  request(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.startError) return Promise.reject(new BridgeRequestError('E_BRIDGE', this.startError));
    const owner = this.owner;
    if (!owner || owner.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeRequestError(
          'E_NOT_CONNECTED',
          `Coding Studio isn't connected. Ask the user to open Coding Studio, click the "MCP" indicator in the toolbar and enable "Allow Claude Code to control this editor" (port ${this.port}). If Coding Studio runs on a hosted URL, that origin must be listed in CODING_STUDIO_ORIGINS.`,
        ),
      );
    }
    const id = `r${++this.seq}`;
    const payload = JSON.stringify({ type: 'request', id, method, params });
    if (payload.length > BRIDGE_MAX_PAYLOAD) return Promise.reject(new BridgeRequestError('E_PAYLOAD_TOO_LARGE', 'Request too large; split it into smaller batches.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeRequestError('E_TIMEOUT', `Coding Studio did not answer "${method}" within ${timeoutMs / 1000}s (a confirmation dialog may be waiting for the user).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      owner.ws.send(payload);
    });
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.failPending('Server shutting down');
    this.wss?.close();
  }
}

export function errorPayload(e: unknown): BridgeError {
  if (e instanceof BridgeRequestError) return { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
}
