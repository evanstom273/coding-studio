import { describe, expect, it } from 'vitest';
import { createProject } from '@cs/project-format';
import { toolchainFor } from '@cs/toolchain';
import { applyWorkspaceOps, projectToWorkspace, workspaceRevision, workspaceToZip, zipToWorkspace } from '@cs/workspace';
import { zipSync, strToU8 } from 'fflate';
import { buildTree, remapPath, visibleRows } from '../../apps/web/src/lib/fileTree';
import { searchFiles } from '../../apps/web/src/components/files/SearchPanel';
import { monacoLanguage, previewKind } from '../../apps/web/src/lib/fileTypes';

describe('file tree', () => {
  it('folders first, natural order, .gitkeep hidden, only expanded folders visible', () => {
    const t = buildTree(['b.txt', 'src/z.ts', 'src/a10.ts', 'src/a2.ts', 'empty/.gitkeep', 'A.md']);
    expect(t.children.map((c) => c.name)).toEqual(['empty', 'src', 'A.md', 'b.txt']);
    expect(t.children[0].children).toEqual([]);
    expect(visibleRows(t, new Set()).map((r) => r.node.path)).toEqual(['empty', 'src', 'A.md', 'b.txt']);
    expect(visibleRows(t, new Set(['src'])).map((r) => `${r.depth}:${r.node.name}`)).toEqual(['0:empty', '0:src', '1:a2.ts', '1:a10.ts', '1:z.ts', '0:A.md', '0:b.txt']);
  });
  it('remaps paths after moves', () => {
    expect(remapPath('src/a.ts', 'src', 'lib/src')).toBe('lib/src/a.ts');
    expect(remapPath('srcx/a.ts', 'src', 'lib')).toBe('srcx/a.ts');
    expect(remapPath('a.ts', 'a.ts', 'b.ts')).toBe('b.ts');
  });
  it('file types', () => {
    expect(monacoLanguage('src/app.tsx')).toBe('typescript');
    expect(monacoLanguage('.env.local')).toBe('ini');
    expect(previewKind('a/b.PNG')).toBe('image');
  });
});

describe('search', () => {
  const files = [
    { path: 'a.ts', kind: 'text', text: 'const Needle = 1;\nneedle again' },
    { path: 'b.png', kind: 'binary' },
  ];
  it('plain, case-sensitive and regex', () => {
    expect(searchFiles(files, 'needle').hits.map((h) => h.line)).toEqual([1, 2]);
    expect(searchFiles(files, 'needle', { caseSensitive: true }).hits.map((h) => h.line)).toEqual([2]);
    expect(searchFiles(files, 'N.e+dle', { regex: true }).hits[0]).toMatchObject({ start: 6, end: 12 });
    expect(searchFiles(files, '(', { regex: true }).error).toBeTruthy();
    expect(searchFiles(files, 'a.t').hits).toEqual([]); // literal, not regex
  });
});

describe('workspace zip', () => {
  const tc = toolchainFor('gdscript');
  it('round-trips every file byte-exact', () => {
    const ws0 = projectToWorkspace(createProject(tc.adapter, 'Zip', { template: 'node' }));
    const ws = applyWorkspaceOps(ws0, [{ op: 'write_file', path: 'img/x.png', base64: 'AAEC/w==' }, { op: 'write_file', path: 'src/a.ts', content: 'export {}' }, { op: 'create_dir', path: 'empty' }], tc).workspace;
    const back = zipToWorkspace(workspaceToZip(ws), 'new', 'fallback')!;
    expect(workspaceRevision(back.workspace)).toBe(workspaceRevision(ws));
  });
  it('a plain folder zip becomes a workspace: top folder unwrapped, junk skipped, config created', () => {
    const z = zipSync({ 'my-app/src/main.ts': strToU8('x'), 'my-app/node_modules/x/index.js': strToU8('y'), 'my-app/.git/HEAD': strToU8('z'), 'my-app/package.json': strToU8('{}') });
    const r = zipToWorkspace(z, 'id', 'my-app')!;
    expect([...r.workspace.files.keys()].sort()).toEqual(['codingstudio.json', 'package.json', 'src/main.ts']);
    expect(r.skipped).toBe(2);
  });
  it('leaves .vproj archives to the project importer', () => {
    expect(zipToWorkspace(zipSync({ 'manifest.json': strToU8('{}'), 'project.json': strToU8('{}') }), 'id', 'x')).toBeNull();
  });
});
