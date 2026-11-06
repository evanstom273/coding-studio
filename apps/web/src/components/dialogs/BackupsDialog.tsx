import { useCallback, useEffect, useState } from 'react';
import { createBackup, getBackup, listBackups } from '@web/db/projects';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { Button, confirmDialog, Dialog } from '../ui/primitives';

export function BackupsDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const [list, setList] = useState<Awaited<ReturnType<typeof listBackups>>>([]);
  const refresh = useCallback(() => void listBackups(project.id).then(setList), [project.id]);
  useEffect(refresh, [refresh]);
  return (
    <Dialog
      title="Backups"
      onClose={onClose}
      width={560}
      footer={
        <Button
          onClick={async () => {
            await createBackup(useEditor.getState().project!, 'Manual backup', 'user');
            refresh();
            toast('success', 'Backup created');
          }}
          data-testid="create-backup"
        >
          Create backup now
        </Button>
      }
    >
      <p className="mb-3 text-[12px] text-muted">Backups are taken automatically before destructive edits, large Claude batches and restores. The newest 30 are kept in this browser.</p>
      {list.length === 0 && <div className="text-muted">No backups yet.</div>}
      {list.map((b) => (
        <div key={b.id} className="mb-1.5 flex items-center gap-3 rounded border border-border px-3 py-2" data-testid="backup-row">
          <div className="flex-1">
            <div className="text-[12.5px]">{b.label}</div>
            <div className="text-[11px] text-muted">
              {new Date(b.at).toLocaleString()} · {b.source}
            </div>
          </div>
          <Button
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Restore backup?', message: 'The current state is backed up first, and the restore can be undone with Ctrl+Z.', confirm: 'Restore' }))) return;
              const row = await getBackup(b.id!);
              if (!row) return;
              await createBackup(useEditor.getState().project!, 'Before restoring a backup', 'auto');
              useEditor.getState().replaceProject(row.doc, `Restore backup "${b.label}"`);
              toast('success', 'Backup restored');
              onClose();
            }}
          >
            Restore
          </Button>
        </div>
      ))}
    </Dialog>
  );
}
