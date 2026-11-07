/**
 * Config and data files (JSON, YAML, TOML, XML, .properties) open in a visual editor: a form
 * when Coding Studio knows the file (package.json, fabric.mod.json, mods.toml, pom.xml…), a
 * tree for anything else, and the text editor one tap away. Every change is a minimal edit to
 * the file's text (comments, order and unknown fields survive) and one undo step per burst.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Code2, ListTree, SlidersHorizontal } from 'lucide-react';
import { editData, formatFor, parseData, schemaFor, validate, type Edit, type Format } from '@cs/structured-data';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { cx } from '../ui/primitives';
import { DataEditor } from '../fields/DataForm';
import { TextFileView } from './FileView';

type Mode = 'form' | 'tree' | 'text';
const modes = new Map<string, Mode>();

export const isDataFile = (path: string) => formatFor(path) !== undefined;

const FORMAT_LABEL: Record<Format, string> = { json: 'JSON', yaml: 'YAML', toml: 'TOML', xml: 'XML', properties: 'Properties' };

export function DataFileView({ path }: { path: string }) {
  const rec = useEditor((s) => s.workspace?.files.get(path));
  const format = formatFor(path)!;
  const schema = useMemo(() => schemaFor(path), [path]);
  const [mode, setModeState] = useState<Mode>(modes.get(path) ?? (schema ? 'form' : 'tree'));
  const setMode = (m: Mode) => {
    modes.set(path, m);
    setModeState(m);
  };
  const text = rec?.text ?? '';
  const parsed = useMemo(() => parseData(format, text), [format, text]);
  const issues = useMemo(() => (parsed.value !== undefined ? validate(parsed.value, schema) : []), [parsed.value, schema]);
  const errors = issues.filter((i) => i.severity === 'error');

  const onEdit = (edits: Edit[], mergeKey?: string) => {
    const cur = useEditor.getState().workspace?.files.get(path);
    if (!cur) return;
    try {
      const next = editData(format, cur.text ?? '', edits);
      if (next === cur.text) return;
      useEditor.getState().applyFiles([{ op: 'write_file', path, content: next, expectedHash: cur.hash }], `Edit ${path.split('/').pop()}`, mergeKey ? { mergeKey: `data:${path}:${mergeKey}` } : {});
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const tab = (m: Mode, label: string, icon: React.ReactNode, disabled?: boolean) => (
    <button type="button" disabled={disabled} onClick={() => setMode(m)} className={cx('flex h-[32px] items-center gap-1 rounded px-2 text-[11.5px] disabled:opacity-30 sm:h-[24px]', mode === m ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} data-testid={`data-mode-${m}`}>
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="data-view" data-path={path}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <span className="mr-1 truncate text-[11.5px]">
          <span className="font-medium text-text">{schema?.title ?? path.split('/').pop()}</span> <span className="text-muted">· {FORMAT_LABEL[format]}</span>
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {schema && tab('form', 'Form', <SlidersHorizontal size={12} />)}
          {tab('tree', 'Tree', <ListTree size={12} />)}
          {tab('text', 'Text', <Code2 size={12} />)}
        </div>
      </div>
      {mode === 'text' ? (
        <div className="min-h-0 flex-1">
          <TextFileView key={path} path={path} />
        </div>
      ) : parsed.errors.length ? (
        <div className="space-y-2 p-4 text-[12px]" data-testid="data-parse-error">
          <div className="flex items-center gap-2 text-red-300">
            <AlertTriangle size={14} /> This file can't be read as {FORMAT_LABEL[format]}, so the visual editor can't open it safely.
          </div>
          <ul className="list-disc pl-5 text-muted">
            {parsed.errors.slice(0, 5).map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
          <button type="button" className="text-accent hover:underline" onClick={() => setMode('text')}>
            Fix it in the text editor
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {schema && (
            <div className={cx('mb-3 flex items-center gap-2 rounded px-2 py-1.5 text-[11.5px]', errors.length ? 'bg-red-500/10 text-red-200' : 'bg-emerald-500/10 text-emerald-200')} data-testid="data-status">
              {errors.length ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              {errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors.slice(0, 3).map((e) => e.message).join(' · ')}` : 'Looks valid'}
            </div>
          )}
          <DataEditor root={parsed.value} schema={schema} issues={issues} onEdit={onEdit} mode={mode === 'form' && schema ? 'form' : 'tree'} />
        </div>
      )}
    </div>
  );
}
