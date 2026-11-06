import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorBridge, isAllowedOrigin, parseOrigins } from '../../mcp/server/bridge';
import { planExport, writePlan, ExportError } from '../../mcp/server/export';
import { BRIDGE_PROTOCOL_VERSION } from '@cs/shared-protocol';

let bridge: EditorBridge | null = null;
afterEach(() => bridge?.close());

let port = 48100;
async function start() {
  bridge = new EditorBridge(++port, []);
  await bridge.start();
  return bridge;
}

function tab(origin = 'http://localhost:5173', sessionId = Math.random().toString(36), takeover = false) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const messages: Record<string, unknown>[] = [];
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, app: 'coding-studio', appVersion: 't', sessionId, takeover })));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      messages.push(m);
      if (m.type === 'request') ws.send(JSON.stringify({ type: 'response', id: m.id, ok: true, result: { echo: m.method, from: sessionId } }));
      if (m.type === 'welcome' || m.type === 'rejected') resolve(m);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, ready, messages };
}

describe('origin allow-list', () => {
  it('allows loopback and configured origins only', () => {
    const extra = parseOrigins('https://studio.example.workers.dev/, https://x.dev');
    expect(isAllowedOrigin('http://localhost:5173', [])).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173', [])).toBe(true);
    expect(isAllowedOrigin('https://evil.example', [])).toBe(false);
    expect(isAllowedOrigin(undefined, [])).toBe(false);
    expect(isAllowedOrigin('https://studio.example.workers.dev', extra)).toBe(true);
  });

  it('rejects the WebSocket handshake from foreign origins', async () => {
    await start();
    await expect(tab('https://evil.example').ready).rejects.toThrow(/403/);
  });
});

describe('session ownership', () => {
  it('relays requests to the owning tab', async () => {
    const b = await start();
    const a = tab('http://localhost:5173', 'A');
    expect((await a.ready).type).toBe('welcome');
    expect(await b.request('status')).toEqual({ echo: 'status', from: 'A' });
    a.ws.close();
  });

  it('a second tab cannot silently take over; an explicit takeover revokes the first', async () => {
    const b = await start();
    const a = tab('http://localhost:5173', 'A');
    await a.ready;
    const second = tab('http://localhost:5173', 'B');
    expect(await second.ready).toMatchObject({ type: 'rejected', reason: 'busy' });
    expect(await b.request('status')).toMatchObject({ from: 'A' });
    const third = tab('http://localhost:5173', 'B', true);
    expect((await third.ready).type).toBe('welcome');
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages.some((m) => m.type === 'revoked')).toBe(true);
    expect(await b.request('status')).toMatchObject({ from: 'B' });
    third.ws.close();
  });

  it('fails fast with a helpful error when no editor is connected', async () => {
    const b = await start();
    await expect(b.request('status')).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });
});

describe('safe export', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'cs-export-'));
  it('writes allowed files inside output_dir', () => {
    const dir = root();
    const plan = planExport(dir, { 'player/player.gd': 'extends Node\n' }, []);
    expect(writePlan(plan, { 'player/player.gd': 'extends Node\n' })).toEqual(['player/player.gd']);
    expect(readFileSync(join(dir, 'player/player.gd'), 'utf8')).toBe('extends Node\n');
  });
  it('rejects relative, system and escaping destinations', () => {
    expect(() => planExport('relative/dir', { 'a.gd': '' }, [])).toThrow(ExportError);
    expect(() => planExport('/', { 'a.gd': '' }, [])).toThrow(/system or top-level/);
    expect(() => planExport('/etc', { 'a.gd': '' }, [])).toThrow(ExportError);
    const dir = root();
    expect(() => planExport(dir, { '../x.gd': '' }, [])).toThrow(/unsafe/);
    expect(() => planExport(dir, { 'run.sh': '' }, [])).toThrow(/only/);
    expect(() => planExport(dir, { 'a.gd': '' }, [join(tmpdir(), 'somewhere-else-entirely')])).toThrow(/CODING_STUDIO_EXPORT_ROOTS/);
  });
  it('detects existing files and refuses symlink escapes', () => {
    const dir = root();
    writeFileSync(join(dir, 'a.gd'), 'old');
    expect(planExport(dir, { 'a.gd': 'new' }, []).targets[0].exists).toBe(true);
    const outside = root();
    mkdirSync(join(dir, 'sub'));
    symlinkSync(outside, join(dir, 'sub', 'link'));
    expect(() => planExport(dir, { 'sub/link/b.gd': '' }, [])).toThrow(/symbolic link/);
  });
});
