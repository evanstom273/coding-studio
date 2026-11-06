/**
 * Optional connection from the editor to the local MCP server (mcp/server). OFF by default.
 *
 * - Connects only to ws://127.0.0.1:<port> (loopback).
 * - Says hello with a random per-tab session id. If another tab already owns the bridge the server
 *   answers "busy"; this tab then shows a "Take over" button — nothing is replaced silently.
 * - Requests run one at a time, in order, through the same edit operations as the UI.
 * - The editor works exactly the same when the bridge is off or the server is not running.
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
  enabled: boolean;
  port: number;
  status: BridgeStatus;
  statusText: string;
  log: BridgeLogEntry[];
  setEnabled(on: boolean): void;
  setPort(port: number): void;
  takeOver(): void;
  clearLog(): void;
}

const KEY = 'coding-studio:bridge';
export const APP_VERSION = '0.1.0';
const sessionId = (() => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
})();

function load(): { enabled: boolean; port: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: v.enabled === true, port: Number.isInteger(v.port) && v.port > 1024 && v.port < 65536 ? v.port : BRIDGE_DEFAULT_PORT };
  } catch {
    return { enabled: false, port: BRIDGE_DEFAULT_PORT };
  }
}

function persist() {
  const { enabled, port } = useBridge.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled, port }));
  } catch {
    /* ignore */
  }
}

export const useBridge = create<BridgeState>()((set, get) => ({
  ...load(),
  status: 'off',
  statusText: 'Claude Code access is off',
  log: [],
  setEnabled(enabled) {
    set({ enabled });
    persist();
    disconnect();
    if (enabled) connect(false);
  },
  setPort(port) {
    set({ port });
    persist();
    if (get().enabled) {
      disconnect();
      connect(false);
    }
  },
  takeOver() {
    disconnect();
    connect(true);
  },
  clearLog() {
    set({ log: [] });
  },
}));

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
let queue: Promise<void> = Promise.resolve();

export function bridgeLog(entry: Omit<BridgeLogEntry, 'at'>) {
  useBridge.setState((s) => ({ log: [{ at: Date.now(), ...entry }, ...s.log].slice(0, 200) }));
}

function setStatus(status: BridgeStatus, statusText: string) {
  useBridge.setState({ status, statusText });
}

function disconnect() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const s = socket;
  socket = null;
  s?.close(1000);
  setStatus('off', useBridge.getState().enabled ? 'Disconnected' : 'Claude Code access is off');
}

function connect(takeover: boolean) {
  const { enabled, port } = useBridge.getState();
  if (!enabled || socket) return;
  setStatus('connecting', `Connecting to 127.0.0.1:${port}…`);
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    setStatus('unavailable', `Browser blocked the connection: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  socket = ws;
  let welcomed = false;
  ws.onopen = () => {
    const hello: BridgeHello = { type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, app: 'coding-studio', appVersion: APP_VERSION, sessionId, ...(takeover ? { takeover: true } : {}) };
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    if (raw.length > BRIDGE_MAX_PAYLOAD) return;
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      welcomed = true;
      retryDelay = 1000;
      setStatus('connected', 'Connected to Claude Code');
      bridgeLog({ method: 'connected', ok: true, ms: 0, text: 'This tab now accepts edits from Claude Code' });
      return;
    }
    if (msg.type === 'rejected') {
      setStatus(msg.reason === 'busy' ? 'busy' : 'unavailable', msg.message);
      socket = null;
      ws.close();
      return;
    }
    if (msg.type === 'revoked') {
      setStatus('revoked', msg.message);
      bridgeLog({ method: 'revoked', ok: false, ms: 0, text: msg.message });
      socket = null;
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
    if (socket === ws) {
      socket = null;
      if (useBridge.getState().enabled) scheduleRetry();
    }
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

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

function scheduleRetry() {
  if (!useBridge.getState().enabled) return;
  const { port } = useBridge.getState();
  setStatus('unavailable', `MCP server not reachable on 127.0.0.1:${port}. Is Claude Code running with the coding-studio server? Retrying…`);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect(false);
  }, retryDelay);
  retryDelay = Math.min(10_000, retryDelay * 1.6);
}

/** Reconnect on load if the user enabled the bridge before. */
export function initBridge() {
  if (useBridge.getState().enabled && !socket) connect(false);
}
