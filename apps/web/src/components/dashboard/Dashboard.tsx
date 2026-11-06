import { useCallback, useEffect, useState } from 'react';
import { Copy, FolderOpen, Plus, Sparkles, Trash2, Upload, Workflow } from 'lucide-react';
import { EXAMPLES } from '@cs/examples';
import { deleteProject, duplicateProject, listProjects, type ProjectSummary } from '@web/db/projects';
import { navigate } from '@web/lib/router';
import { pickFile } from '@web/lib/files';
import { importProjectFile, openExample } from '@web/lib/projectActions';
import { languages } from '@web/lib/toolchain';
import { useUI } from '@web/store/ui';
import { Button, confirmDialog, IconButton } from '../ui/primitives';
import { NewProjectDialog } from '../dialogs/NewProjectDialog';
import { McpDialog } from '../dialogs/McpDialog';
import { McpIndicator } from '../panels/McpIndicator';

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const dialog = useUI((s) => s.dialog);
  const setUI = useUI((s) => s.set);
  const refresh = useCallback(() => void listProjects().then(setProjects), []);
  useEffect(refresh, [refresh]);
  // Cloud sync (Claude connector) can add or remove projects while this page is open.
  useEffect(() => {
    window.addEventListener('cs:projects-changed', refresh);
    return () => window.removeEventListener('cs:projects-changed', refresh);
  }, [refresh]);
  useEffect(() => {
    document.title = 'Coding Studio';
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-4">
        <Workflow size={20} className="text-accent" />
        <span className="text-[15px] font-semibold">Coding Studio</span>
        <span className="text-[12px] text-muted">Visual programming → readable source code</span>
        <div className="flex-1" />
        <McpIndicator />
      </header>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => setUI({ dialog: 'new-project' })} data-testid="new-project">
              <Plus size={14} /> New project
            </Button>
            <Button
              onClick={async () => {
                const f = await pickFile('.vproj,.json,application/zip,application/json');
                if (f) await importProjectFile(f);
              }}
            >
              <Upload size={14} /> Import project
            </Button>
            <span className="ml-2 text-[12px] text-muted">Languages: {languages.all().map((l) => l.name).join(', ')} · projects are stored in this browser</span>
          </div>

          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Recent projects</h2>
          {projects === null ? (
            <div className="text-muted">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="mb-8 rounded-lg border border-dashed border-border p-8 text-center">
              <p className="mb-3 text-[14px]">No projects yet.</p>
              <p className="mb-4 text-muted">Create an empty project, or open one of the examples below to see how graphs become GDScript.</p>
              <Button variant="primary" onClick={() => setUI({ dialog: 'new-project' })}>
                <Plus size={14} /> Create your first script
              </Button>
            </div>
          ) : (
            <div className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" data-testid="project-list">
              {projects.map((p) => (
                <div key={p.id} className="group rounded-lg border border-border bg-panel p-3 hover:border-accent/60">
                  <button className="block w-full text-left" onClick={() => navigate({ name: 'project', id: p.id })} data-testid="project-card">
                    <div className="truncate text-[14px] font-medium">{p.name}</div>
                    <div className="mt-1 text-[11px] text-muted">
                      {languages.get(p.language)?.name ?? p.language} · edited {ago(p.updatedAt)}
                    </div>
                  </button>
                  <div className="mt-2 flex gap-1 opacity-60 group-hover:opacity-100">
                    <IconButton label="Open" onClick={() => navigate({ name: 'project', id: p.id })}>
                      <FolderOpen size={14} />
                    </IconButton>
                    <IconButton
                      label="Duplicate"
                      onClick={async () => {
                        await duplicateProject(p.id);
                        refresh();
                      }}
                    >
                      <Copy size={14} />
                    </IconButton>
                    <IconButton
                      label="Delete"
                      onClick={async () => {
                        if (await confirmDialog({ title: 'Delete project?', message: `"${p.name}" and its backups will be permanently deleted from this browser.`, confirm: 'Delete', danger: true })) {
                          await deleteProject(p.id);
                          refresh();
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">
            <Sparkles size={13} /> Examples (Godot 4 · GDScript)
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {EXAMPLES.map((ex) => (
              <button key={ex.id} onClick={() => void openExample(ex.id)} className="rounded-lg border border-border bg-panel p-3 text-left hover:border-accent/60" data-testid={`example-${ex.id}`}>
                <div className="text-[13px] font-medium">{ex.title}</div>
                <div className="mt-1 text-[11px] leading-snug text-muted">{ex.description}</div>
              </button>
            ))}
          </div>
        </div>
      </main>
      {dialog === 'new-project' && <NewProjectDialog onClose={() => setUI({ dialog: null })} />}
      {dialog === 'mcp' && <McpDialog onClose={() => setUI({ dialog: null })} />}
    </div>
  );
}
