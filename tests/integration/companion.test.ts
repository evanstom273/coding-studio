import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startCompanion } from '../../mcp/companion/service';
import { EXAMPLES } from '@cs/examples';
import { toolchainFor } from '@cs/toolchain';
import { compileProject } from '@cs/compiler-core';

const PORT = 48777;
let server: Server;
const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;
const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(url(p), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

beforeAll(async () => {
  server = await startCompanion(PORT);
});
afterAll(() => server.close());

describe('Godot companion service', () => {
  const tc = toolchainFor('gdscript');
  it('health and palette', async () => {
    expect(await (await fetch(url('/health'))).json()).toMatchObject({ ok: true, languages: ['gdscript', 'typescript'] });
    const palette = (await (await fetch(url('/palette?language=gdscript'))).json()) as { type: string }[];
    expect(palette.some((p) => p.type === 'godot.characterbody2d.move_and_slide')).toBe(true);
  });

  it('compiles exactly like the web editor (shared compiler)', async () => {
    for (const ex of EXAMPLES) {
      const p = ex.build(tc);
      const r = (await (await post('/compile', { project: p })).json()) as { ok: boolean; files: { content: string }[] };
      expect(r.ok).toBe(true);
      expect(r.files.map((f) => f.content)).toEqual(compileProject(tc, p).files.map((f) => f.content));
    }
  });

  it('describes graphs with ports for GraphEdit slots and applies atomic edits', async () => {
    const p = EXAMPLES[0].build(tc);
    const fn = p.scripts[0].functions[0];
    const d = (await (await post('/describe', { project: p, function: fn.id })).json()) as { nodes: { type: string; outputs: { id: string; color: string }[]; inputs: { editable: string | null }[] }[] };
    const print = d.nodes.find((n) => n.type === 'core.print')!;
    expect(print.inputs.some((i) => i.editable === null)).toBe(true);
    const ok = (await (await post('/apply', { project: p, operations: [{ op: 'add_node', ref: 'x', graph: fn.id, type: 'core.print' }] })).json()) as { created: { x: string }; project: { scripts: { functions: { graph: { nodes: unknown[] } }[] }[] } };
    expect(ok.created.x).toBeTruthy();
    expect(ok.project.scripts[0].functions[0].graph.nodes).toHaveLength(3);
    const bad = await post('/apply', { project: p, operations: [{ op: 'add_node', graph: fn.id, type: 'nope.nope' }] });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('E_UNKNOWN_NODE');
  });

  it('refuses browser (Origin) requests', async () => {
    const r = await post('/compile', { project: EXAMPLES[0].build(tc) }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });
});
