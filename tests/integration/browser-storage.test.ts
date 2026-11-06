/**
 * Browser storage (Dexie v2): per-file workspaces, lazy migration of schema-1 projects, backups.
 */
import { describe, expect, it } from 'vitest';
import { createProject, projectToJson } from '@cs/project-format';
import { compileAll } from '@cs/project-service';
import { toolchainFor } from '@cs/toolchain';
import { EXAMPLES } from '@cs/examples';
import { applyWorkspaceOps, configOf, deriveProject, makeRecord, workspaceRevision, type Workspace } from '@cs/workspace';
import { db } from '../../apps/web/src/db/db';
import { backupToWorkspace, createBackup, deleteProject, duplicateProject, getBackup, insertProject, listBackups, listProjects, loadWorkspace, saveWorkspace } from '../../apps/web/src/db/projects';

const tc = toolchainFor('gdscript');

describe('browser storage', () => {
  it('migrates schema-1 projects lazily, keeps the original as a backup, and compiles identically', async () => {
    for (const ex of EXAMPLES) {
      const p = ex.build(tc);
      await db.projects.put({ id: p.id, name: p.name, language: p.language, createdAt: p.createdAt, updatedAt: p.updatedAt, doc: JSON.parse(projectToJson(p)) });
      expect((await listProjects()).some((x) => x.id === p.id && x.name === p.name)).toBe(true);
      const l = (await loadWorkspace(p.id))!;
      expect(l.migratedFrom).toBe(1);
      expect(compileAll(deriveProject(l.workspace).project).files).toEqual(compileAll(p).files);
      expect(await db.projects.get(p.id)).toBeUndefined();
      expect((await listBackups(p.id))[0].label).toMatch(/Original project/);
      // second load reads the per-file copy
      const again = (await loadWorkspace(p.id))!;
      expect(again.migratedFrom).toBeUndefined();
      expect(workspaceRevision(again.workspace)).toBe(workspaceRevision(l.workspace));
      // the v1 backup converts back to the same project
      const row = (await getBackup((await listBackups(p.id))[0].id!))!;
      expect(compileAll(deriveProject(backupToWorkspace(row.doc, p.id)).project).files).toEqual(compileAll(p).files);
    }
  });

  it('saves only changed paths, deletes removed ones, duplicates with fresh ids', async () => {
    const ws = await insertProject(createProject(tc.adapter, 'Files', { template: 'node' }));
    const r = applyWorkspaceOps(ws, [{ op: 'write_file', path: 'docs/readme.md', content: 'hello' }, { op: 'write_file', path: 'img.png', base64: 'AAEC' }], tc);
    await saveWorkspace(r.workspace, r.changedPaths);
    const back = (await loadWorkspace(ws.meta.id))!.workspace;
    expect(back.files.get('docs/readme.md')!.text).toBe('hello');
    expect([...back.files.get('img.png')!.data!]).toEqual([0, 1, 2]);
    const r2 = applyWorkspaceOps(back, [{ op: 'delete', path: 'docs', recursive: true }], tc);
    await saveWorkspace(r2.workspace, r2.changedPaths);
    expect((await loadWorkspace(ws.meta.id))!.workspace.files.has('docs/readme.md')).toBe(false);
    const copy = await duplicateProject(ws.meta.id, 'Files 2');
    expect(configOf(copy).name).toBe('Files 2');
    expect(copy.files.get('img.png')!.hash).toBe(back.files.get('img.png')!.hash);
    expect(deriveProject(copy).project.scripts[0].id).not.toBe(deriveProject(back).project.scripts[0].id);
    await createBackup(r2.workspace, 'manual', 'user');
    const b = (await getBackup((await listBackups(ws.meta.id))[0].id!))!;
    expect(workspaceRevision(backupToWorkspace(b.doc, ws.meta.id))).toBe(workspaceRevision(r2.workspace));
    await deleteProject(ws.meta.id);
    expect(await loadWorkspace(ws.meta.id)).toBeUndefined();
    expect(await db.files.where('ws').equals(ws.meta.id).count()).toBe(0);
  });

  it('loads a 5,000-file workspace index in under a second', async () => {
    const ws = await insertProject(createProject(tc.adapter, 'Big', { template: 'node' }));
    const files = new Map(ws.files);
    for (let i = 0; i < 5000; i++) files.set(`src/m${i % 50}/f${i}.ts`, makeRecord(`src/m${i % 50}/f${i}.ts`, `export const v${i} = ${i};\n`, 1));
    const big: Workspace = { meta: ws.meta, files };
    await saveWorkspace(big);
    const t0 = performance.now();
    const l = (await loadWorkspace(ws.meta.id))!;
    const ms = performance.now() - t0;
    expect(l.workspace.files.size).toBe(files.size);
    expect(ms).toBeLessThan(1000);
  });
});
