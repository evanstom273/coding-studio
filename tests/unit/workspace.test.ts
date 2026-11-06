import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { toolchainFor } from '@cs/toolchain';
import { compileProject } from '@cs/compiler-core';
import { EXAMPLES } from '@cs/examples';
import { createProject } from '@cs/project-format';
import {
  applyProjectOps,
  applyWorkspaceOps,
  configOf,
  CONFIG_PATH,
  defaultConfig,
  deriveProject,
  diffWorkspaces,
  emptyHistory,
  emptyWorkspace,
  gitBlobHash,
  HistoryConflict,
  normalizePath,
  projectToWorkspace,
  pushHistory,
  redoHistory,
  undoHistory,
  workspaceRevision,
  WorkspaceOpError,
  type Workspace,
} from '@cs/workspace';

const tc = toolchainFor('gdscript');
const fresh = (): Workspace => projectToWorkspace(createProject(tc.adapter, 'WS', { template: 'node' }));
const apply = (ws: Workspace, ops: Parameters<typeof applyWorkspaceOps>[1]) => applyWorkspaceOps(ws, ops, tc);

describe('git-compatible hashing', () => {
  it('matches git hash-object for text, empty and binary content', () => {
    expect(gitBlobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(gitBlobHash('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    const bytes = new Uint8Array(70_001).map((_, i) => (i * 7919 + 13) % 256);
    expect(gitBlobHash(bytes)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString().trim());
    expect(gitBlobHash('héllo 🌍')).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: 'héllo 🌍' }).toString().trim());
  });
});

describe('paths', () => {
  it('normalises and rejects escapes', () => {
    expect(normalizePath('/a//b/./c.ts')).toBe('a/b/c.ts');
    expect(normalizePath('a\\b')).toBe('a/b');
    expect(() => normalizePath('a/../../etc')).toThrow();
    expect(() => normalizePath('a/b|c')).toThrow();
  });
});

describe('workspace operations', () => {
  it('writes, moves, copies and deletes files and folders atomically', () => {
    let ws = fresh();
    ws = apply(ws, [
      { op: 'write_file', path: 'src/util/math.ts', content: 'export const two = 2;\n' },
      { op: 'write_file', path: 'README.md', content: '# hi\n' },
      { op: 'create_dir', path: 'assets/empty' },
      { op: 'write_file', path: 'assets/icon.png', base64: btoa(String.fromCharCode(0, 1, 2, 255)) },
    ]).workspace;
    expect(ws.files.get('assets/icon.png')!.kind).toBe('binary');
    expect(ws.files.has('assets/empty/.gitkeep')).toBe(true);
    ws = apply(ws, [{ op: 'move', from: 'src/util', to: 'lib' }]).workspace;
    expect(ws.files.has('lib/math.ts')).toBe(true);
    expect(ws.files.has('src/util/math.ts')).toBe(false);
    ws = apply(ws, [{ op: 'copy', from: 'lib/math.ts', to: 'lib/math2.ts' }]).workspace;
    expect(ws.files.get('lib/math2.ts')!.hash).toBe(ws.files.get('lib/math.ts')!.hash);

    const before = ws;
    expect(() => apply(ws, [{ op: 'delete', path: 'README.md' }, { op: 'delete', path: 'nope.txt' }])).toThrow(WorkspaceOpError);
    expect(ws).toBe(before);
    expect(ws.files.has('README.md')).toBe(true);
    expect(() => apply(ws, [{ op: 'delete', path: 'lib' }])).toThrow(/not empty/);
    ws = apply(ws, [{ op: 'delete', path: 'lib', recursive: true }]).workspace;
    expect([...ws.files.keys()].some((p) => p.startsWith('lib/'))).toBe(false);
    expect(() => apply(ws, [{ op: 'delete', path: CONFIG_PATH }])).toThrow();
    expect(() => apply(ws, [{ op: 'write_file', path: 'README.md/x', content: '' }])).toThrow(/is a file/);
  });

  it('per-file expected hashes detect concurrent changes', () => {
    let ws = apply(fresh(), [{ op: 'write_file', path: 'a.ts', content: 'a' }]).workspace;
    const h = ws.files.get('a.ts')!.hash;
    ws = apply(ws, [{ op: 'write_file', path: 'a.ts', content: 'a2', expectedHash: h }]).workspace;
    expect(() => apply(ws, [{ op: 'write_file', path: 'a.ts', content: 'a3', expectedHash: h }])).toThrow(expect.objectContaining({ code: 'E_REVISION_CONFLICT' }));
    expect(() => apply(ws, [{ op: 'write_file', path: 'a.ts', content: 'x', expectedHash: null }])).toThrow(expect.objectContaining({ code: 'E_FILE_EXISTS' }));
  });

  it('graph operations rewrite only the scripts they change', () => {
    let ws = fresh();
    ws = apply(ws, [{ op: 'graph', ops: [{ op: 'add_script', name: 'Other' }] }]).workspace;
    const other = ws.files.get('other.vgraph')!;
    const main = ws.files.get('main.vgraph')!;
    const ready = deriveProject(ws).project.scripts.find((s) => s.name === 'Main')!.functions[0];
    const r = apply(ws, [{ op: 'graph', ops: [{ op: 'add_node', ref: 'p', graph: ready.id, type: 'core.print' }] }]);
    expect(r.changedPaths).toEqual(['main.vgraph']);
    expect(r.created.p).toBeTruthy();
    expect(r.workspace.files.get('other.vgraph')).toBe(other);
    expect(r.workspace.files.get('main.vgraph')).not.toBe(main);
    // unchanged scripts keep object identity (memoised UI, copy-on-write)
    expect(deriveProject(r.workspace).project.scripts.find((s) => s.name === 'Other')).toBe(deriveProject(ws).project.scripts.find((s) => s.name === 'Other'));
    // renaming a script's path moves its file
    const moved = apply(r.workspace, [{ op: 'graph', ops: [{ op: 'update_script', script: 'Other', path: 'scripts/other' }] }]);
    expect(moved.workspace.files.has('scripts/other.vgraph')).toBe(true);
    expect(moved.workspace.files.has('other.vgraph')).toBe(false);
    // project settings live in codingstudio.json
    const renamed = applyProjectOps(moved.workspace, [{ op: 'update_project', name: 'Renamed' }], tc);
    expect(renamed.changedPaths).toEqual([CONFIG_PATH]);
    expect(configOf(renamed.workspace).name).toBe('Renamed');
  });

  it('moving or copying graph files keeps them consistent', () => {
    let ws = fresh();
    ws = apply(ws, [{ op: 'move', from: 'main.vgraph', to: 'game/player.vgraph' }]).workspace;
    expect(deriveProject(ws).project.scripts[0].path).toBe('game/player');
    ws = apply(ws, [{ op: 'copy', from: 'game/player.vgraph', to: 'game/enemy.vgraph' }]).workspace;
    const [a, b] = deriveProject(ws).project.scripts;
    expect(a.id).not.toBe(b.id);
    expect(compileProject(tc, deriveProject(ws).project).ok).toBe(true);
    expect(() => apply(ws, [{ op: 'move', from: 'game/enemy.vgraph', to: 'game/enemy.txt' }])).toThrow(/extension/);
  });
});

describe('migration from schema-1 projects', () => {
  it('every example converts to a workspace that compiles to identical GDScript', () => {
    for (const ex of EXAMPLES) {
      const p = ex.build(tc);
      const ws = projectToWorkspace(p);
      expect(ws.files.has(CONFIG_PATH)).toBe(true);
      const back = deriveProject(ws);
      expect(back.issues).toEqual([]);
      expect(compileProject(tc, back.project).files.map((f) => f.content)).toEqual(compileProject(tc, p).files.map((f) => f.content));
      expect(back.project.name).toBe(p.name);
    }
  });

  it('unreadable graph files are reported, not dropped silently', () => {
    const ws = apply(fresh(), [{ op: 'write_file', path: 'x.vgraph', content: '{"format":"coding-studio-graph","version":1,"language":"gdscript","script":{"id":"s1","name":"X","path":"x","settings":{},"variables":[],"functions":[],"signals":[],"enums":[]}}' }]).workspace;
    const broken = { meta: ws.meta, files: new Map(ws.files).set('y.vgraph', { ...ws.files.get('x.vgraph')!, path: 'y.vgraph', text: 'nonsense', hash: 'zz' }) };
    expect(deriveProject(broken).issues).toEqual([expect.objectContaining({ path: 'y.vgraph' })]);
    expect(() => apply(ws, [{ op: 'write_file', path: 'z.vgraph', content: 'nonsense' }])).toThrow();
  });
});

describe('history', () => {
  it('undo/redo restore file states and refuse to overwrite newer changes', () => {
    let ws = emptyWorkspace('w', defaultConfig('T'));
    let h = emptyHistory();
    const step = (ops: Parameters<typeof applyWorkspaceOps>[1], label: string, mergeKey?: string) => {
      const r = apply(ws, ops);
      h = pushHistory(h, { label, source: 'user', mergeKey, changes: diffWorkspaces(ws, r.workspace, r.changedPaths) });
      ws = r.workspace;
    };
    step([{ op: 'write_file', path: 'a.ts', content: '1' }], 'create');
    step([{ op: 'write_file', path: 'a.ts', content: '12' }], 'type', 'k');
    step([{ op: 'write_file', path: 'a.ts', content: '123' }], 'type', 'k');
    expect(h.past).toHaveLength(2); // typing merged
    const rev = workspaceRevision(ws);
    let u = undoHistory(h, ws)!;
    expect(u.workspace.files.get('a.ts')!.text).toBe('1');
    u = undoHistory(u.history, u.workspace)!;
    expect(u.workspace.files.has('a.ts')).toBe(false);
    const r = redoHistory(redoHistory(u.history, u.workspace)!.history, redoHistory(u.history, u.workspace)!.workspace)!;
    expect(workspaceRevision(r.workspace)).toBe(rev);
    // a change from elsewhere blocks undo instead of being overwritten
    const external = apply(r.workspace, [{ op: 'write_file', path: 'a.ts', content: 'from sync' }]).workspace;
    expect(() => undoHistory(r.history, external)).toThrow(HistoryConflict);
  });
});
