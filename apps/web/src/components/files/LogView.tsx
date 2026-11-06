/** A GitHub Actions job log, with the problems found in it linked to files in the project. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import Editor from '@monaco-editor/react';
import '@web/lib/monaco';
import { cleanLogLine, parseLogProblems, readState } from '@cs/git';
import { useEditor } from '@web/store/editor';
import { github } from '@web/lib/git';
import { cx } from '../ui/primitives';

export function LogView({ id }: { id: string }) {
  const [, runId, jobId] = id.split(':');
  const ws = useEditor((s) => s.workspace)!;
  const st = useMemo(() => readState(ws), [ws]);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ed = useRef<editor.IStandaloneCodeEditor | null>(null);
  const setLine = (l: number) => {
    ed.current?.revealLineInCenter(l);
    ed.current?.setSelection({ startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1000 });
  };
  useEffect(() => {
    if (!st) return;
    let live = true;
    github()
      .jobLog(st.owner, st.repo, Number(jobId))
      .then((t) => live && setLog(t))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [st, jobId]);
  const text = useMemo(() => (log ?? '').split('\n').map(cleanLogLine).join('\n'), [log]);
  const problems = useMemo(() => (log ? parseLogProblems(log, (p) => ws.files.has(p)) : []), [log, ws.files]);
  if (!st) return <div className="p-6 text-muted">This project isn't linked to GitHub.</div>;
  if (error) return <div className="p-6 text-red-300">{error}</div>;
  if (log === null) return <div className="p-6 text-muted">Loading log for run {runId}…</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="log-view">
      {problems.length > 0 && (
        <div className="max-h-[35%] shrink-0 overflow-auto border-b border-border py-1 text-[12px]" data-testid="log-problems">
          {problems.map((p) => (
            <div key={`${p.logLine}`} className="flex cursor-pointer items-baseline gap-2 px-3 py-0.5 hover:bg-panel-2" onClick={() => (p.file ? useEditor.getState().openTab(p.file, { line: p.line }) : setLine(p.logLine))} data-testid="log-problem">
              <span className={cx('shrink-0 text-[10.5px] font-semibold uppercase', p.severity === 'error' ? 'text-red-300' : 'text-amber-300')}>{p.severity}</span>
              {p.file && (
                <span className="shrink-0 font-mono text-accent">
                  {p.file}:{p.line}
                </span>
              )}
              <span className="truncate">{p.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          theme="coding-studio"
          path={`log:///${runId}/${jobId}`}
          language="plaintext"
          value={text}
          onMount={(e) => {
            ed.current = e;
            e.revealLineInCenter(problems.at(-1)?.logLine ?? text.split('\n').length);
          }}
          options={{ readOnly: true, domReadOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true, lineNumbers: 'on' }}
        />
      </div>
    </div>
  );
}
