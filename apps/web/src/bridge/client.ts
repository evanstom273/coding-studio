/**
 * Connections from the editor to Claude. Both are OFF by default and independent:
 *
 *  - local:  ws://127.0.0.1:<port> — the MCP server Claude Code / Claude desktop runs on this PC.
 *  - remote: wss://<this site>/bridge/<key> — the "Claude connector" served by this site's Worker,
 *            for Claude on a phone, on claude.ai, or anywhere a local server can't run.
 *
 * Each says hello with a random per-tab session id. If another tab already owns that link, the
 * tab is told it's busy and shows a "Take over" button — nothing is replaced silently. Requests
 * from either link run one at a time, in order, through the same edit operations as the UI.
 * The editor works exactly the same when both are off.
 */
import { create } from 'zustand';
import { BRIDGE_DEFAULT_PORT, BRIDGE_MAX_PAYLOAD, BRIDGE_PROTOCOL_VERSION, type BridgeHello, type BridgeMessage, type BridgeResponse } from '@cs/shared-protocol';

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'unavailable' | 'busy' | 'revoked';

export interface BridgeLogEntry {
  at: number;
  method: string;
  ok: boolean;
  ms: number;
  text: string;
}

interface BridgeState {
  // local MCP server
  enabled: boolean;
  port: number;
  status: BridgeStatus;
  statusText: string;
  /** True when this page is served by the local MCP server. */
  servedByMcp: boolean;
  // remote connector
  remoteEnabled: boolean;
  remoteKey: string;
  remoteStatus: BridgeStatus;
  remoteStatusText: string;
  log: BridgeLogEntry[];
  setEnabled(on: boolean): void;
  setPort(port: number): void;
  takeOver(): void;
  setRemoteEnabled(on: boolean): void;
  /** New secret link; the old one stops working. */
  resetRemoteKey(): void;
  takeOverRemote(): void;
  clearLog(): void;
}

const KEY = 'coding-studio:bridge';
const REMOTE_KEY = 'coding-studio:connector';
export const APP_VERSION = '0.2.0';

const randomId = (bytes: number) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const sessionId = randomId(12);

function readJson(key: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

function loadLocal() {
  const v = readJson(KEY);
  return { enabled: v.enabled === true, port: Number.isInteger(v.port) && (v.port as number) > 1024 && (v.port as number) < 65536 ? (v.port as number) : BRIDGE_DEFAULT_PORT };
}
function loadRemote() {
  const v = readJson(REMOTE_KEY);
  const key = typeof v.key === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(v.key) ? v.key : randomId(32);
  return { remoteEnabled: v.enabled === true, remoteKey: key };
}

/** The link to paste into Claude → Settings → Connectors → Add custom connector. */
export function connectorUrl(key = useBridge.getState().remoteKey) {
  return `${window.location.origin}/mcp/${key}`;
}

export const useBridge = create<BridgeState>()((set, get) => ({
  ...loadLocal(),
  ...loadRemote(),
  status: 'off',
  statusText: 'Claude Code access is off',
  remoteStatus: 'off',
  remoteStatusText: 'Claude connector is off',
  servedByMcp: false,
  log: [],
  setEnabled(enabled) {
    set({ enabled });
    writeJson(KEY, { enabled, port: get().port });
    local.restart(false);
  },
  setPort(port) {
    set({ port });
    writeJson(KEY, { enabled: get().enabled, port });
    if (get().enabled) local.restart(false);
  },
  takeOver() {
    local.restart(true);
  },
  setRemoteEnabled(remoteEnabled) {
    set({ remoteEnabled });
    writeJson(REMOTE_KEY, { enabled: remoteEnabled, key: get().remoteKey });
    remote.restart(false);
  },
  resetRemoteKey() {
    const remoteKey = randomId(32);
    set({ remoteKey });
    writeJson(REMOTE_KEY, { enabled: get().remoteEnabled, key: remoteKey });
    remote.restart(false);
  },
  takeOverRemote() {
    remote.restart(true);
  },
  clearLog() {
    set({ log: [] });
  },
}));

export function bridgeLog(entry: Omit<BridgeLogEntry, 'at'>) {
  useBridge.setState((s) => ({ log: [{ at: Date.now(), ...entry }, ...s.log].slice(0, 200) }));
}

/** Requests from both links share one queue so edits never interleave. */
let queue: Promise<void> = Promise.resolve();

interface LinkConfig {
  name: string;
  enabled(): boolean;
  url(): string;
  setStatus(status: BridgeStatus, text: string): void;
  offText: string;
  unreachableText(): string;
  /** Send "ping" this often (ms) to keep proxies from dropping an idle socket. */
  keepAlive?: number;
}

class Link {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryDelay = 1000;

  constructor(private readonly cfg: LinkConfig) {}

  get open() {
    return !!this.socket;
  }

  restart(takeover: boolean) {
    this.stop();
    if (this.cfg.enabled()) this.connect(takeover);
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.close(1000);
    this.cfg.setStatus('off', this.cfg.enabled() ? 'Disconnected' : this.cfg.offText);
  }

  connect(takeover: boolean) {
    if (!this.cfg.enabled() || this.socket) return;
    const url = this.cfg.url();
    this.cfg.setStatus('connecting', 'Connecting…');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.cfg.setStatus('unavailable', `The browser blocked the connection: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.socket = ws;
    let welcomed = false;
    ws.onopen = () => {
      const hello: BridgeHello = { type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, app: 'coding-studio', appVersion: APP_VERSION, sessionId, ...(takeover ? { takeover: true } : {}) };
      ws.send(JSON.stringify(hello));
      if (this.cfg.keepAlive) this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), this.cfg.keepAlive);
    };
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      if (raw === 'pong' || raw.length > BRIDGE_MAX_PAYLOAD) return;
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        welcomed = true;
        this.retryDelay = 1000;
        this.cfg.setStatus('connected', `Connected (${this.cfg.name})`);
        bridgeLog({ method: 'connected', ok: true, ms: 0, text: `This tab now accepts edits from Claude (${this.cfg.name})` });
        return;
      }
      if (msg.type === 'rejected' || msg.type === 'revoked') {
        this.cfg.setStatus(msg.type === 'revoked' ? 'revoked' : msg.reason === 'busy' ? 'busy' : 'unavailable', msg.message);
        if (msg.type === 'revoked') bridgeLog({ method: 'revoked', ok: false, ms: 0, text: msg.message });
        this.socket = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        ws.close();
        return;
      }
      if (msg.type !== 'request' || !welcomed) return;
      queue = queue.then(async () => {
        const t0 = performance.now();
        let res: BridgeResponse;
        const { handleRequest, BridgeHandlerError } = await import('./handlers');
        try {
          const result = await handleRequest(msg.method, msg.params ?? {});
          res = { type: 'response', id: msg.id, ok: true, result };
          bridgeLog({ method: msg.method, ok: true, ms: performance.now() - t0, text: summarize(msg.method, msg.params) });
        } catch (e) {
          const err = e instanceof BridgeHandlerError ? { code: e.code, message: e.message, details: e.details } : { code: (e as { code?: string })?.code ?? 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
          res = { type: 'response', id: msg.id, ok: false, error: err };
          bridgeLog({ method: msg.method, ok: false, ms: performance.now() - t0, text: err.message });
        }
        let out = JSON.stringify(res);
        if (out.length > BRIDGE_MAX_PAYLOAD) out = JSON.stringify({ type: 'response', id: msg.id, ok: false, error: { code: 'E_PAYLOAD_TOO_LARGE', message: 'Result exceeds the bridge payload limit; request less data.' } } satisfies BridgeResponse);
        if (ws.readyState === WebSocket.OPEN) ws.send(out);
      });
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.cfg.enabled()) this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleRetry() {
    this.cfg.setStatus('unavailable', this.cfg.unreachableText());
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(false);
    }, this.retryDelay);
    this.retryDelay = Math.min(10_000, this.retryDelay * 1.6);
  }

  /** Reconnect straight away (e.g. when a phone brings the tab back to the front). */
  nudge() {
    if (this.cfg.enabled() && !this.socket) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retryDelay = 1000;
      this.connect(false);
    }
  }
}

const local = new Link({
  name: 'Claude on this computer',
  enabled: () => useBridge.getState().enabled,
  url: () => `ws://127.0.0.1:${useBridge.getState().port}`,
  setStatus: (status, statusText) => useBridge.setState({ status, statusText: status === 'connected' ? 'Connected to Claude on this computer' : statusText }),
  offText: 'Claude Code access is off',
  unreachableText: () => `MCP server not reachable on 127.0.0.1:${useBridge.getState().port}. Is Claude running with the coding-studio server? Retrying…`,
});

const remote = new Link({
  name: 'Claude connector',
  enabled: () => useBridge.getState().remoteEnabled,
  url: () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/bridge/${useBridge.getState().remoteKey}`,
  setStatus: (remoteStatus, remoteStatusText) => useBridge.setState({ remoteStatus, remoteStatusText: remoteStatus === 'connected' ? 'Connected: Claude can use this tab through the connector' : remoteStatusText }),
  offText: 'Claude connector is off',
  unreachableText: () => 'Connector service not reachable from this page. Retrying… (it only exists on the deployed site, not on localhost dev servers)',
  keepAlive: 25_000,
});

function summarize(method: string, params: Record<string, unknown>): string {
  if (method === 'batch_edit' && Array.isArray(params.operations)) {
    const ops = params.operations as { op?: string }[];
    const counts = new Map<string, number>();
    for (const o of ops) counts.set(o.op ?? '?', (counts.get(o.op ?? '?') ?? 0) + 1);
    return `${ops.length} operation(s): ${[...counts].map(([k, v]) => `${v}× ${k}`).join(', ')}`;
  }
  const keys = Object.entries(params)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return keys.join(' ');
}

let started = false;
/** Reconnect on load to whatever the user enabled before. */
export function initBridge() {
  if (started) return;
  started = true;
  if (useBridge.getState().enabled) local.connect(false);
  if (useBridge.getState().remoteEnabled) remote.connect(false);
  // Phones suspend background tabs; reconnect as soon as the tab is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      local.nudge();
      remote.nudge();
    }
  });
  void detectLocalServer();
}

/**
 * When this page is served by the local MCP server itself (http://localhost:47831), opening it is
 * the user's explicit choice to work with Claude, so the bridge is switched on automatically —
 * unless the user turned it off on this origin before.
 */
async function detectLocalServer() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return;
  try {
    const r = await fetch('/__coding-studio/bridge', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) return;
    const info = (await r.json()) as { app?: string; port?: number };
    if (info.app !== 'coding-studio-mcp' || !Number.isInteger(info.port)) return;
    useBridge.setState({ servedByMcp: true });
    let explicit = false;
    try {
      explicit = localStorage.getItem(KEY) !== null;
    } catch {
      /* storage unavailable */
    }
    if (explicit) return;
    const s = useBridge.getState();
    if (s.port !== info.port) s.setPort(info.port!);
    if (!useBridge.getState().enabled) useBridge.getState().setEnabled(true);
  } catch {
    /* not served by the MCP server (dev server, Cloudflare): nothing to do */
  }
}
