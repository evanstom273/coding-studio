import { Clipboard, FileArchive, FileCode2, FileJson, Package } from 'lucide-react';
import { buildArchive, buildSourceZip, projectToJson } from '@cs/project-format';
import { compileNow } from '@web/compile/store';
import { useEditor } from '@web/store/editor';
import { downloadBytes, safeFileName } from '@web/lib/files';
import { toast } from '@web/store/toasts';
import { Button, Dialog } from '../ui/primitives';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const activeScriptId = useEditor((s) => s.activeScriptId);
  const r = compileNow(project);
  const active = r.scripts.find((s) => s.scriptId === activeScriptId);
  const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
  const base = safeFileName(project.name);
  const Item = ({ icon, title, desc, action, disabled, testId }: { icon: React.ReactNode; title: string; desc: string; action: () => void; disabled?: boolean; testId: string }) => (
    <div className="mb-2 flex items-center gap-3 rounded border border-border p-2.5">
      <div className="text-accent">{icon}</div>
      <div className="flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="text-[11.5px] text-muted">{desc}</div>
      </div>
      <Button onClick={action} disabled={disabled} data-testid={testId}>
        Export
      </Button>
    </div>
  );
  return (
    <Dialog title="Export" onClose={onClose} width={580}>
      {errors > 0 && <div className="mb-3 rounded bg-red-500/15 px-3 py-2 text-[12px] text-red-200">{errors} error(s): source code can't be exported until they are fixed (the editable project can always be exported).</div>}
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Generated source</h3>
      <Item
        testId="export-script"
        icon={<FileCode2 size={18} />}
        title={active?.files[0]?.path ?? 'Active script'}
        desc="The active script as a native file. Runs in Godot without Coding Studio."
        disabled={!active?.ok}
        action={() => {
          const f = active!.files[0];
          downloadBytes(f.path.split('/').pop()!, f.content, 'text/plain');
        }}
      />
      <Item testId="export-sources" icon={<Package size={18} />} title={`${base}-sources.zip`} desc={`All ${r.files.length} generated file(s), with folder structure.`} disabled={!r.ok} action={() => downloadBytes(`${base}-sources.zip`, buildSourceZip(r.files), 'application/zip')} />
      <Item
        testId="export-copy"
        icon={<Clipboard size={18} />}
        title="Copy active script"
        desc="Copy the generated source to the clipboard."
        disabled={!active?.ok}
        action={async () => {
          await navigator.clipboard?.writeText(active!.files[0].content);
          toast('success', 'Copied to clipboard');
        }}
      />
      <h3 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Editable project</h3>
      <Item testId="export-archive" icon={<FileArchive size={18} />} title={`${base}.vproj`} desc="Portable archive with all graphs (+ the generated sources for reference). Re-import it anywhere." action={() => downloadBytes(`${base}.vproj`, buildArchive(project, r.ok ? r.files : []), 'application/zip')} />
      <Item testId="export-json" icon={<FileJson size={18} />} title={`${base}.vproj.json`} desc="Plain JSON project document — the format the Godot plugin opens." action={() => downloadBytes(`${base}.vproj.json`, projectToJson(project), 'application/json')} />
    </Dialog>
  );
}
