import { describe, expect, it } from 'vitest';
import { toolchainFor } from '@cs/toolchain';
import { compileProject } from '@cs/compiler-core';
import { EXAMPLES } from '@cs/examples';
import { applyOps, buildArchive, createProject, migrateProject, OpError, parseProjectFile, projectRevision, projectToJson, ProjectFormatError, reidProject, PROJECT_SCHEMA_VERSION } from '@cs/project-format';

const tc = toolchainFor('gdscript');
const fresh = () => {
  const p = createProject(tc.adapter, 'T', { template: 'node' });
  const f = p.scripts[0].functions[0];
  return { p, f, entry: f.graph.nodes[0].id };
};

describe('edit operations', () => {
  it('batches are atomic: a failing op leaves the project untouched', () => {
    const { p, f } = fresh();
    const before = JSON.stringify(p);
    expect(() => applyOps(p, [
      { op: 'add_variable', name: 'ok_var', type: 'int' },
      { op: 'add_node', graph: f.id, type: 'core.print' },
      { op: 'add_node', graph: f.id, type: 'core.nonexistent' },
    ], tc)).toThrow(/Operation 3/);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('structural sharing keeps untouched scripts and graphs identical', () => {
    const { p, f } = fresh();
    const q = applyOps(p, [{ op: 'add_script', name: 'Other' }], tc).project;
    const r = applyOps(q, [{ op: 'add_node', graph: f.id, type: 'core.print' }], tc).project;
    expect(r.scripts[1]).toBe(q.scripts[1]);
    expect(r.scripts[0].functions[1]).toBe(q.scripts[0].functions[1]);
    expect(r.scripts[0].functions[0]).not.toBe(q.scripts[0].functions[0]);
  });

  it('rejects invalid connections with a typed reason', () => {
    const { p, f, entry } = fresh();
    const r = applyOps(p, [{ op: 'add_node', ref: 'b', graph: f.id, type: 'core.branch' }, { op: 'add_node', ref: 's', graph: f.id, type: 'core.literal_string' }], tc);
    expect(() => applyOps(r.project, [{ op: 'connect', from: { node: r.created.s, port: 'value' }, to: { node: r.created.b, port: 'condition' } }], tc)).toThrow(/cannot use String where bool/);
    expect(() => applyOps(r.project, [{ op: 'connect', from: { node: entry, port: 'then' }, to: { node: r.created.b, port: 'condition' } }], tc)).toThrow(/execution pin/);
    try {
      applyOps(r.project, [{ op: 'connect', from: { node: r.created.s, port: 'value' }, to: { node: r.created.b, port: 'condition' } }], tc);
    } catch (e) {
      expect((e as OpError).code).toBe('E_TYPE_MISMATCH');
      expect((e as OpError).opIndex).toBe(0);
    }
  });

  it('rejects execution loops and protects the entry node', () => {
    const { p, f, entry } = fresh();
    const r = applyOps(p, [
      { op: 'add_node', ref: 'a', graph: f.id, type: 'core.print' },
      { op: 'add_node', ref: 'b', graph: f.id, type: 'core.print' },
      { op: 'connect', from: { node: '$a', port: 'then' }, to: { node: '$b', port: 'exec' } },
    ], tc);
    expect(() => applyOps(r.project, [{ op: 'connect', from: { node: r.created.b, port: 'then' }, to: { node: r.created.a, port: 'exec' } }], tc)).toThrow(/execution loop/);
    expect(() => applyOps(r.project, [{ op: 'delete_nodes', nodes: [entry] }], tc)).toThrow(/Entry/);
  });

  it('connecting into an occupied data input replaces the old wire', () => {
    const { p, f } = fresh();
    const r = applyOps(p, [
      { op: 'add_node', ref: 'pr', graph: f.id, type: 'core.print' },
      { op: 'add_node', ref: 'a', graph: f.id, type: 'core.literal_string' },
      { op: 'add_node', ref: 'b', graph: f.id, type: 'core.literal_string' },
      { op: 'connect', from: { node: '$a', port: 'value' }, to: { node: '$pr', port: 'value' } },
      { op: 'connect', from: { node: '$b', port: 'value' }, to: { node: '$pr', port: 'value' } },
    ], tc);
    const edges = r.project.scripts[0].functions[0].graph.edges.filter((e) => e.to.node === r.created.pr);
    expect(edges).toHaveLength(1);
    expect(edges[0].from.node).toBe(r.created.b);
  });

  it('validates props, names and types', () => {
    const { p, f } = fresh();
    expect(() => applyOps(p, [{ op: 'add_node', graph: f.id, type: 'core.sequence', props: { count: 99 } }], tc)).toThrow(/between/);
    expect(() => applyOps(p, [{ op: 'add_variable', name: '1bad', type: 'int' }], tc)).toThrow(/invalid/);
    expect(() => applyOps(p, [{ op: 'add_variable', name: 'x', type: 'Nope' }], tc)).toThrow(/unknown type/);
    expect(() => applyOps(p, [{ op: 'add_variable', name: 'x', type: 'int', default: 'one' }], tc)).toThrow(/does not fit/);
    const ok = applyOps(p, [{ op: 'add_variable', name: 'names', type: 'Array[String]' }], tc).project;
    expect(ok.scripts[0].variables[0].type).toBe('array<string>');
  });

  it('changing a function signature prunes connections to removed parameters', () => {
    const { p } = fresh();
    const r = applyOps(p, [
      { op: 'add_function', ref: 'g', name: 'greet', params: [{ name: 'who', type: 'string' }] },
      { op: 'add_node', ref: 'pr', graph: '$g', type: 'core.print' },
      { op: 'connect', from: { node: '$g.entry', port: 'who' }, to: { node: '$pr', port: 'value' } },
    ], tc);
    const q = applyOps(r.project, [{ op: 'update_function', function: 'greet', params: [] }], tc);
    expect(q.warnings.some((w) => w.includes('no longer exists'))).toBe(true);
    expect(q.project.scripts[0].functions.find((x) => x.name === 'greet')!.graph.edges).toHaveLength(0);
  });

  it('revision changes with content but not with editor state', () => {
    const { p, f } = fresh();
    const r0 = projectRevision(p);
    expect(projectRevision({ ...p, updatedAt: 1, editor: {} })).toBe(r0);
    expect(projectRevision(applyOps(p, [{ op: 'add_node', graph: f.id, type: 'core.print' }], tc).project)).not.toBe(r0);
  });
});

describe('persistence formats', () => {
  it('archive and JSON round-trip preserve the editable graphs', () => {
    for (const ex of EXAMPLES) {
      const p = ex.build(tc);
      const gen = compileProject(tc, p);
      const zip = buildArchive(p, gen.files);
      const back = parseProjectFile(zip).project;
      expect(back).toEqual(p);
      const json = parseProjectFile(new TextEncoder().encode(projectToJson(p))).project;
      expect(compileProject(tc, json).files.map((f) => f.content)).toEqual(gen.files.map((f) => f.content));
    }
  });

  it('re-id gives fresh ids but compiles to the same code', () => {
    const p = EXAMPLES[5].build(tc);
    const q = reidProject(p);
    expect(q.id).not.toBe(p.id);
    expect(q.scripts[0].functions[0].graph.nodes[0].id).not.toBe(p.scripts[0].functions[0].graph.nodes[0].id);
    expect(compileProject(tc, q).files[0].content).toBe(compileProject(tc, p).files[0].content);
  });

  it('migrates schema 0 and refuses newer schemas', () => {
    const p = fresh().p;
    const old: Record<string, unknown> = JSON.parse(JSON.stringify(p));
    delete old.schemaVersion;
    delete old.format;
    delete old.compilerSettings;
    const m = migrateProject(old);
    expect(m.migratedFrom).toBe(0);
    expect(m.project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(m.project.compilerSettings.indent).toBe('tab');
    expect(() => migrateProject({ ...p, schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toThrow(ProjectFormatError);
    expect(() => migrateProject({ format: 'something-else' })).toThrow(/Not a Coding Studio project/);
  });

  it('sanitising reports unreadable data instead of silently dropping it', () => {
    const p = JSON.parse(JSON.stringify(fresh().p));
    p.scripts[0].functions[0].graph.nodes.push({ broken: true });
    const m = migrateProject(p);
    expect(m.issues.length).toBeGreaterThan(0);
  });
});
