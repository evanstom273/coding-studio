import { createProject, parseProjectFile } from '@cs/project-format';
import { configOf, zipToWorkspace, type Workspace } from '@cs/workspace';
import { newId } from '@cs/graph-core';
import { exampleById } from '@cs/examples';
import { insertProject, insertWorkspace } from '@web/db/projects';
import { navigate } from './router';
import { toolchainFor } from './toolchain';
import { toast } from '@web/store/toasts';

export async function newProject(name: string, template: string, language = 'gdscript', scriptName = 'Main'): Promise<Workspace> {
  const tc = toolchainFor(language);
  const p = await insertProject(createProject(tc.adapter, name, { template, scriptName }));
  navigate({ name: 'project', id: p.meta.id });
  return p;
}

export async function openExample(id: string): Promise<Workspace> {
  const ex = exampleById(id);
  if (!ex) throw new Error(`Unknown example ${id}`);
  const p = await insertProject(ex.build(toolchainFor('gdscript')));
  navigate({ name: 'project', id: p.meta.id });
  return p;
}

export async function importProjectFile(file: File): Promise<Workspace | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A zip of a folder (or an exported workspace) → a workspace with all its files.
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const z = zipToWorkspace(bytes, newId('p'), file.name.replace(/\.zip$/i, '') || 'Imported');
      if (z) {
        const ws = await insertWorkspace(z.workspace);
        const notes = [z.skipped ? `${z.skipped} file(s) from .git / node_modules skipped` : '', z.issues.length ? `${z.issues.length} problem(s): ${z.issues[0]}` : ''].filter(Boolean);
        toast(notes.length ? 'warning' : 'success', `Imported "${configOf(ws).name}" (${ws.files.size} files)${notes.length ? ` — ${notes.join('; ')}` : ''}`);
        navigate({ name: 'project', id: ws.meta.id });
        return ws;
      }
    }
    const r = parseProjectFile(bytes);
    toolchainFor(r.project.language); // throws for unknown languages
    const p = await insertProject(r.project);
    if (r.issues.length) toast('warning', `Imported with ${r.issues.length} repaired problem(s): ${r.issues[0]}`);
    else toast('success', `Imported "${configOf(p).name}"`);
    navigate({ name: 'project', id: p.meta.id });
    return p;
  } catch (e) {
    toast('error', `Import failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
