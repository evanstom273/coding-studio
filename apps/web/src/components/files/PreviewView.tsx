/**
 * Preview: the project bundled in the browser and run in a sandboxed iframe, rebuilt as you
 * edit. Build errors link to their file and line; the page's console output is shown below.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useEditor } from '@web/store/editor';
import { generatedFiles, useCompile } from '@web/compile/store';
import type { PreviewBuild } from '@cs/preview';
import { Button, cx } from '../ui/primitives';

interface LogLine {
  level: string;
  text: string;
}

export function PreviewView() {
  const ws = useEditor((s) => s.workspace)!;
  const lastGood = useCompile((s) => s.lastGood);
  const [html, setHtml] = useState<string | null>(null);
  const [build, setBuild] = useState<PreviewBuild | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef<string | null>(null);
  htmlRef.current = html;

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const { buildPreview } = await import('@web/lib/previewRunner');
      const r = await buildPreview(useEditor.getState().workspace!, generatedFiles().map(([, f]) => ({ path: f.path, content: f.content })));
      setBuild(r.build);
      if (!r.build.errors.length) {
        setLogs([]);
        setHtml(r.html);
        setNonce((n) => n + 1);
      }
    } catch (e) {
      setBuild({ js: '', css: '', errors: [{ message: e instanceof Error ? e.message : String(e) }], warnings: [], ms: 0 });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!auto && html !== null) return;
    const t = setTimeout(() => void run(), html === null ? 0 : 800);
    return () => clearTimeout(t);
  }, [ws.files, lastGood, auto, run]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      // The frame page is ready: hand it the app (it runs under the frame's own, looser CSP).
      if (e.data?.source === 'coding-studio-preview-frame' && htmlRef.current !== null) {
        frame.current?.contentWindow?.postMessage({ source: 'coding-studio-editor', html: htmlRef.current }, window.location.origin);
        return;
      }
      if (e.data?.source !== 'coding-studio-preview') return;
      setLogs((l) => [...l.slice(-499), { level: String(e.data.level), text: (e.data.args as string[]).join(' ') }]);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  const errors = build?.errors ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="preview-view">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span className="font-medium text-text">Preview</span>
        {build?.entry && <span className="font-mono">{build.entry}</span>}
        {busy ? <span>building…</span> : build && !errors.length && <span>built in {build.ms} ms</span>}
        <label className="ml-auto flex items-center gap-1">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh
        </label>
        <Button variant="ghost" onClick={() => void run()} data-testid="preview-refresh">
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Run
        </Button>
      </div>
      {errors.length > 0 && (
        <div className="max-h-[40%] shrink-0 overflow-auto border-b border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px]" data-testid="preview-errors">
          {errors.map((e, i) => (
            <button key={i} className="block w-full py-0.5 text-left text-red-200 hover:underline" onClick={() => e.path && useEditor.getState().openTab(e.path, e.line ? { line: e.line } : {})}>
              {e.path && (
                <span className="mr-2 font-mono text-red-300">
                  {e.path}:{e.line}
                </span>
              )}
              {e.message}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 bg-white">
        {html !== null && <iframe key={nonce} ref={frame} title="Preview" src="/preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin" className="h-full w-full border-0" data-testid="preview-frame" />}
      </div>
      <div className="flex h-[28%] min-h-[80px] shrink-0 flex-col border-t border-border bg-[#0f1218]">
        <div className="flex items-center gap-2 px-3 py-0.5 text-[11px] text-muted">
          Console ({logs.length})
          <button className="ml-auto hover:text-text" aria-label="Clear console" onClick={() => setLogs([])}>
            <Trash2 size={11} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-1 font-mono text-[11.5px]" data-testid="preview-console">
          {logs.map((l, i) => (
            <div key={i} className={cx('whitespace-pre-wrap border-b border-border/30 py-0.5', l.level === 'error' ? 'text-red-300' : l.level === 'warn' ? 'text-amber-200' : 'text-[#c3c9d4]')}>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
