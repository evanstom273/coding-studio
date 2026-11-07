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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, type BridgeMessage, type BridgeMethod, type BridgeWelcome } from '@cs/shared-protocol';
import { BridgeRequestError, errorPayload, SERVER_VERSION } from './errors';
export { BridgeRequestError, errorPayload, SERVER_VERSION };

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


interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Built editor files (published path → base64), bundled into the server so it can serve the IDE itself. */
export type EditorAssets = Record<string, string>;

const MIME: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ttf: 'font/ttf', woff2: 'font/woff2', json: 'application/json', wasm: 'application/wasm' };
const PAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:* https://registry.npmjs.org https://data.jsdelivr.com https://cdn.jsdelivr.net; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
};

/** The Preview's frame page runs the user's app: its own CSP, and only our pages may frame it. */
const PREVIEW_FRAME_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://esm.sh https://cdn.jsdelivr.net https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https:; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src *; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'",
};

/** Serve the bundled editor. Only GET/HEAD; unknown routes fall back to index.html (client-side routing). */
export function serveEditor(assets: EditorAssets, port: number, req: IncomingMessage, res: ServerResponse) {
  // Only answer requests addressed to this machine by name (blocks DNS-rebinding pages).
  const host = String(req.headers.host ?? '');
  if (!new RegExp(`^(localhost|127\\.0\\.0\\.1)(:${port})?$`).test(host)) return void res.writeHead(403).end('Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  if (path === '/__coding-studio/bridge') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ app: 'coding-studio-mcp', version: SERVER_VERSION, port }));
  }
  if (!Object.keys(assets).length) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('This build of the Coding Studio MCP server does not include the editor. Rebuild it with "npm run build:mcp".');
  }
  let key = path.replace(/^\/+/, '');
  if (!assets[key] && assets[`${key}.html`]) key = `${key}.html`; // /preview-frame → preview-frame.html (as Cloudflare does)
  if (!assets[key]) key = 'index.html';
  const ext = key.split('.').pop() ?? '';
  const body = Buffer.from(assets[key], 'base64');
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': key.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', ...(key === 'preview-frame.html' ? PREVIEW_FRAME_HEADERS : PAGE_HEADERS) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export class EditorBridge {
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private owner: { ws: WebSocket; sessionId: string; origin: string } | null = null;
  /** Requests from the editor to this computer (the Computer panel); set by the local server. */
  hostHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  startError: string | null = null;

  constructor(
    readonly port: number,
    readonly origins: string[],
    readonly assets: EditorAssets = {},
  ) {}

  /** Where the built-in editor is served. */
  get editorUrl() {
    return `http://localhost:${this.port}`;
  }

  /** Relay link to the copy that owns the port, when this copy couldn't bind it. */
  private upstream: WebSocket | null = null;
  private upstreamPending = new Map<string, Pending>();
  private closed = false;

  start(): Promise<void> {
    return new Promise((done) => {
      // One port for both: HTTP serves the editor, WebSocket upgrades are the bridge.
      const http = createServer((req, res) => serveEditor(this.assets, this.port, req, res));
      const wss = new WebSocketServer({
        server: http,
        maxPayload: BRIDGE_MAX_PAYLOAD,
        verifyClient: (info: { origin: string }, cb: (ok: boolean, code?: number, msg?: string) => void) => {
          // No Origin = a local non-browser process (another copy of this server). Browsers always
          // send Origin, so web pages can't use this path; such connections may only relay requests.
          if (!info.origin || isAllowedOrigin(info.origin, this.origins)) return cb(true);
          log(`rejected connection from origin ${info.origin || '(none)'} — add it to CODING_STUDIO_ORIGINS to allow it`);
          cb(false, 403, 'Origin not allowed');
        },
      });
      http.on('listening', () => {
        log(`editor available at ${this.editorUrl} (bridge on ws://127.0.0.1:${this.port})`);
        done();
      });
      http.on('error', (e: NodeJS.ErrnoException) => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.wss = null;
        this.http = null;
        wss.close();
        if (e.code === 'EADDRINUSE') {
          // Another copy (e.g. the same app started this server twice) owns the port: relay through it.
          void this.connectUpstream().then(done);
          return;
        }
        this.startError = `Bridge failed: ${e.message}`;
        log(this.startError);
        done();
      });
      wss.on('error', () => undefined); // errors surface on the HTTP server
      wss.on('connection', (ws, req) => this.onConnection(ws, String(req.headers.origin ?? '')));
      this.wss = wss;
      this.http = http;
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
      http.listen(this.port, '127.0.0.1');
    });
  }

  private onConnection(ws: WebSocket, origin: string) {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
    let identified = false;
    let isPeer = false;
    const helloTimer = setTimeout(() => !identified && ws.close(4002, 'No hello'), 5000);
    ws.on('message', (data) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const peerMsg = msg as unknown as { type: string; id?: string; method?: BridgeMethod; params?: Record<string, unknown>; timeoutMs?: number };
      if (!identified && peerMsg.type === 'peer-hello' && !origin) {
        clearTimeout(helloTimer);
        identified = true;
        isPeer = true;
        ws.send(JSON.stringify({ type: 'peer-welcome' }));
        log('another copy of the MCP server is relaying through this one');
        return;
      }
      if (isPeer) {
        if (peerMsg.type !== 'peer-request' || !peerMsg.id || !peerMsg.method) return;
        const id = peerMsg.id;
        this.request(peerMsg.method, peerMsg.params ?? {}, Math.min(Number(peerMsg.timeoutMs) || 30_000, 600_000)).then(
          (result) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'peer-response', id, ok: true, result })),
          (e: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'peer-response', id, ok: false, error: errorPayload(e) })),
        );
        return;
      }
      if (!identified) {
        if (!origin) return ws.close(4003, 'Editor connections must come from a browser');
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
        this.send(ws, { type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: SERVER_VERSION, ...(this.hostHandler ? { host: true } : {}) });
        log(`Coding Studio connected (${origin})`);
        return;
      }
      const hostMsg = msg as unknown as { type: string; id?: string; method?: string; params?: Record<string, unknown> };
      if (this.owner?.ws === ws && hostMsg.type === 'host-request' && hostMsg.id && hostMsg.method) {
        const id = hostMsg.id;
        const reply = (body: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'host-response', id, ...body }));
        if (!this.hostHandler) reply({ ok: false, error: { code: 'E_NO_HOST', message: 'This server cannot run things on the computer.' } });
        else this.hostHandler(hostMsg.method, hostMsg.params ?? {}).then((result) => reply({ ok: true, result }), (e: unknown) => reply({ ok: false, error: errorPayload(e) }));
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

  /** Connect to the copy that owns the port. If it isn't a Coding Studio server, report the port conflict. */
  private connectUpstream(): Promise<void> {
    return new Promise((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (!ok) {
          this.startError = `Port ${this.port} is in use by another program. Set CODING_STUDIO_PORT to a free port here and the same port in Coding Studio.`;
          log(this.startError);
        }
        done();
      };
      const timer = setTimeout(() => {
        ws.terminate();
        finish(false);
      }, 3000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'peer-hello', app: 'coding-studio-mcp', protocol: BRIDGE_PROTOCOL_VERSION })));
      ws.on('message', (data) => {
        let m: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { code: string; message: string; details?: unknown } };
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        if (m.type === 'peer-welcome') {
          clearTimeout(timer);
          this.upstream = ws;
          this.startError = null;
          log(`port ${this.port} is owned by another copy of this server; relaying through it`);
          finish(true);
          return;
        }
        if (m.type !== 'peer-response' || !m.id) return;
        const p = this.upstreamPending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.upstreamPending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new BridgeRequestError(m.error?.code ?? 'E_INTERNAL', m.error?.message ?? 'Unknown error', m.error?.details));
      });
      ws.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (this.upstream !== ws) return finish(false);
        this.upstream = null;
        for (const [id, p] of this.upstreamPending) {
          clearTimeout(p.timer);
          p.reject(new BridgeRequestError('E_DISCONNECTED', 'The other MCP server copy stopped while this request was running; check status.'));
          this.upstreamPending.delete(id);
        }
        // The owner went away: try to take the port over (or relay through whoever has it now).
        if (!this.closed) setTimeout(() => void this.start(), 500);
      });
    });
  }

  get connected() {
    if (this.upstream) return this.upstream.readyState === WebSocket.OPEN;
    return this.owner?.ws.readyState === WebSocket.OPEN;
  }

  get origin() {
    return this.owner?.origin;
  }

  request(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const up = this.upstream;
    if (up && up.readyState === WebSocket.OPEN) {
      const id = `p${++this.seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.upstreamPending.delete(id);
          reject(new BridgeRequestError('E_TIMEOUT', `Coding Studio did not answer "${method}" within ${timeoutMs / 1000}s.`));
        }, timeoutMs + 5000);
        this.upstreamPending.set(id, { resolve, reject, timer });
        up.send(JSON.stringify({ type: 'peer-request', id, method, params, timeoutMs }));
      });
    }
    if (this.startError) return Promise.reject(new BridgeRequestError('E_BRIDGE', this.startError));
    const owner = this.owner;
    if (!owner || owner.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeRequestError(
          'E_NOT_CONNECTED',
          `Coding Studio isn't open. Call the open_editor tool to open it in the user's browser (it is served by this MCP server at ${this.editorUrl}), then retry. A hosted copy of the editor can be used instead if its origin is listed in CODING_STUDIO_ORIGINS and its MCP toggle is on.`,
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
    this.closed = true;
    this.upstream?.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.failPending('Server shutting down');
    // ws doesn't drop open connections on close(); do it so relaying copies notice and take over.
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
    this.http?.close();
  }
}

