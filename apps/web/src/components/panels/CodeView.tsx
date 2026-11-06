import { useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import '@web/lib/monaco';
import type { editor } from 'monaco-editor';
import { useCompile } from '@web/compile/store';
import { useEditor } from '@web/store/editor';

/**
 * Read-only view of the generated source for the active script. The graph is the source of
 * truth: editing here is intentionally disabled. Selecting a node highlights its lines; clicking
 * a line selects the node that produced it.
 */
export default function CodeView() {
  const scriptId = useEditor((s) => s.activeScriptId);
  const selection = useEditor((s) => s.selection.nodes);
  const file = useCompile((s) => (scriptId ? s.lastGood[scriptId] : undefined));
  const stale = useCompile((s) => (scriptId ? s.stale[scriptId] : false));
  const errors = useCompile((s) => s.diagnostics.filter((d) => d.scriptId === scriptId && d.severity === 'error').length);
  const edRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<editor.IEditorDecorationsCollection | null>(null);
  const mapRef = useRef(file?.sourceMap ?? []);
  mapRef.current = file?.sourceMap ?? [];

  const lines = useMemo(() => {
    const set = new Set(selection);
    return (file?.sourceMap ?? []).filter((m) => m.nodeId && set.has(m.nodeId)).map((m) => m.line);
  }, [file, selection]);

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    decoRef.current?.clear();
    decoRef.current = ed.createDecorationsCollection(lines.map((l) => ({ range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 }, options: { isWholeLine: true, className: 'bg-amber-400/15', linesDecorationsClassName: 'border-l-2 border-amber-400' } })));
    if (lines.length) ed.revealLineInCenterIfOutsideViewport(lines[0]);
  }, [lines, file]);

  const onMount: OnMount = (ed) => {
    edRef.current = ed;
    ed.onMouseDown((e) => {
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const hit = mapRef.current.filter((m) => m.line === line && m.nodeId).pop();
      if (hit?.nodeId && hit.graphId) {
        const fn = useEditor.getState().project?.scripts.flatMap((s) => s.functions).find((f) => f.graph.id === hit.graphId);
        if (fn) useEditor.getState().focusNode(fn.id, hit.nodeId);
      }
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span className="font-mono text-text" data-testid="code-file">
          {file?.path ?? '—'}
        </span>
        {stale && <span className="rounded bg-amber-400/15 px-1.5 text-amber-200">out of date — {errors} error(s) must be fixed before new code is generated</span>}
        {!file && errors > 0 && <span className="text-red-300">No code yet: fix the {errors} error(s) listed under Errors.</span>}
        <span className="ml-auto">read-only · the graph is the source</span>
        {file && (
          <button className="text-accent hover:underline" onClick={() => void navigator.clipboard?.writeText(file.content)} data-testid="copy-code">
            Copy
          </button>
        )}
      </div>
      <pre className="sr-only" data-testid="code-text" aria-hidden>
        {file?.content ?? ''}
      </pre>
      <div className="min-h-0 flex-1" data-testid="code-view">
        <Editor
          height="100%"
          language="gdscript"
          theme="coding-studio"
          value={file?.content ?? ''}
          onMount={onMount}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12.5, scrollBeyondLastLine: false, renderLineHighlight: 'none', tabSize: 4, insertSpaces: false, renderWhitespace: 'none', automaticLayout: true, domReadOnly: true }}
        />
      </div>
    </div>
  );
}
