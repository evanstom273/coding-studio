import { createProject, parseProjectFile } from '@cs/project-format';
import { configOf, type Workspace } from '@cs/workspace';
import { exampleById } from '@cs/examples';
import { insertProject } from '@web/db/projects';
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
    const r = parseProjectFile(new Uint8Array(await file.arrayBuffer()));
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
