/**
 * Golden-file tests: every example graph compiles without errors and produces exactly the
 * checked-in GDScript. Run with UPDATE_GOLDEN=1 to rewrite the fixtures after an intended change
 * (and review the diff). GODOT_OUT=<dir> also writes the files for validation with Godot.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toolchainFor } from '@cs/toolchain';
import { compileProject } from '@cs/compiler-core';
import { EXAMPLES } from '@cs/examples';

const GOLDEN = join(__dirname, '../fixtures/golden');
const tc = toolchainFor('gdscript');

describe('example graphs', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.id} compiles to the golden GDScript`, () => {
      const r = compileProject(tc, ex.build(tc));
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.files).toHaveLength(1);
      const file = join(GOLDEN, `${ex.id}.gd`);
      const content = r.files[0].content;
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, content);
      expect(content).toBe(readFileSync(file, 'utf8'));
      if (process.env.GODOT_OUT) {
        const out = join(process.env.GODOT_OUT, r.files[0].path);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, content);
      }
    });
  }

  it('is deterministic: rebuilding (with fresh random ids) gives identical output', () => {
    for (const ex of EXAMPLES) {
      const a = compileProject(tc, ex.build(tc)).files.map((f) => f.content);
      const b = compileProject(tc, ex.build(tc)).files.map((f) => f.content);
      expect(a).toEqual(b);
    }
  });

  it('source maps point generated lines back to graph nodes', () => {
    const p = EXAMPLES.find((e) => e.id === 'conditional-logic')!.build(tc);
    const r = compileProject(tc, p);
    const f = r.files[0];
    const lines = f.content.split('\n');
    const ifLine = lines.findIndex((l) => l.includes('if health > 50')) + 1;
    const entry = f.sourceMap.find((m) => m.line === ifLine);
    const branch = p.scripts[0].functions[0].graph.nodes.find((n) => n.id === entry?.nodeId);
    expect(branch?.type).toBe('core.branch');
  });
});
