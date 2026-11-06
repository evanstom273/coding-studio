/**
 * Viewers for non-graph tabs:
 *  - text files: Monaco, writing through WorkspaceOps (debounced, one undo step per burst of
 *    typing). If the file changes underneath (Claude, sync, undo) while there are unsaved
 *    keystrokes, a banner offers "keep mine" / "use theirs" — nothing is silently overwritten.
 *  - images / audio / video / fonts: previews; other binaries: size + download.
 *  - generated code (`gen:` tabs): read-only, with a way back to the graph.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import '@web/lib/monaco';
import type { editor } from 'monaco-editor';
import { Download, Workflow } from 'lucide-react';
import { useEditor } from '@web/store/editor';
import { useCompile } from '@web/compile/store';
import { toast } from '@web/store/toasts';
import { downloadBytes } from '@web/lib/files';
import { DIFF_PREFIX, formatSize, GEN_PREFIX, mimeType, monacoLanguage, previewKind } from '@web/lib/fileTypes';
import { baseVersion } from '@web/lib/git';
import { Button } from '../ui/primitives';

const EDIT_LIMIT = 5 * 1024 * 1024;
const DEBOUNCE_MS = 400;

/** Pending keystrokes in open text editors, flushed before saving / switching. */
const flushers = new Set<() => void>();
export function flushTextEdits() {
  for (const f of flushers) f();
}

const editorOptions: editor.IStandaloneEditorConstructionOptions = { minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordWrap: 'on', renderWhitespace: 'selection' };

export function TextFileView({ path }: { path: string }) {
  const rec = useEditor((s) => s.workspace?.files.get(path));
  const reveal = useEditor((s) => (s.revealRequest?.tab === path ? s.revealRequest : undefined));
  const ed = useRef<editor.IStandaloneCodeEditor | null>(null);
  /** Hash and text of the content the editor is based on. */
  const base = useRef<{ hash: string; text: string } | null>(rec ? { hash: rec.hash, text: rec.text ?? '' } : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conflict, setConflict] = useState<{ hash: string; text: string } | null>(null);

  const write = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const m = ed.current?.getModel();
    const b = base.current;
    if (!m || !b) return;
    const text = m.getValue();
    if (text === b.text) return;
    try {
      const r = useEditor.getState().applyFiles([{ op: 'write_file', path, content: text, expectedHash: b.hash }], `Edit ${path.split('/').pop()}`, { mergeKey: `edit:${path}` });
      const now = r.workspace.files.get(path);
      if (now) base.current = { hash: now.hash, text: now.text ?? text };
    } catch (e) {
      const cur = useEditor.getState().workspace?.files.get(path);
      if ((e as { code?: string }).code === 'E_REVISION_CONFLICT' && cur) setConflict({ hash: cur.hash, text: cur.text ?? '' });
      else toast('error', e instanceof Error ? e.message.replace(/^Operation \d+ \([a-z_]+\): /, '') : String(e));
    }
  };
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    const f = () => writeRef.current();
    flushers.add(f);
    return () => {
      f();
      flushers.delete(f);
    };
  }, []);

  // The file changed in the store (Claude, sync, undo/redo, another tab).
  useEffect(() => {
    const m = ed.current?.getModel();
    if (!rec || !m || !base.current || rec.hash === base.current.hash) return;
    const incoming = { hash: rec.hash, text: rec.text ?? '' };
    if (m.getValue() === base.current.text) {
      // No unsaved typing: take the new content, keeping it undoable inside the editor too.
      if (m.getValue() !== incoming.text) m.pushEditOperations([], [{ range: m.getFullModelRange(), text: incoming.text }], () => null);
      base.current = incoming;
    } else if (m.getValue() === incoming.text) base.current = incoming;
    else setConflict(incoming);
  }, [rec]);

  useEffect(() => {
    if (reveal && ed.current) {
      ed.current.revealLineInCenter(reveal.line);
      ed.current.setPosition({ lineNumber: reveal.line, column: 1 });
      ed.current.focus();
    }
  }, [reveal]);

  if (!rec) return <Empty>This file no longer exists.</Empty>;
  if (rec.size > EDIT_LIMIT)
    return (
      <Empty>
        {path} is {formatSize(rec.size)} — too large to edit here.
        <Button onClick={() => downloadBytes(path.split('/').pop()!, rec.text ?? '', 'text/plain')}>
          <Download size={13} /> Download
        </Button>
      </Empty>
    );

  const onMount: OnMount = (e) => {
    ed.current = e;
    e.onDidChangeModelContent(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => writeRef.current(), DEBOUNCE_MS);
    });
    e.onDidBlurEditorText(() => writeRef.current());
    const r = useEditor.getState().revealRequest;
    if (r?.tab === path) e.revealLineInCenter(r.line);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="text-editor" data-path={path}>
      {conflict && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-[12px] text-amber-100" data-testid="file-conflict">
          <span className="flex-1">This file was changed elsewhere (e.g. by Claude) while you were typing.</span>
          <Button
            onClick={() => {
              base.current = conflict;
              setConflict(null);
              writeRef.current();
            }}
            data-testid="conflict-keep-mine"
          >
            Keep mine
          </Button>
          <Button
            onClick={() => {
              const m = ed.current?.getModel();
              base.current = conflict;
              if (m) m.pushEditOperations([], [{ range: m.getFullModelRange(), text: conflict.text }], () => null);
              setConflict(null);
            }}
            data-testid="conflict-use-theirs"
          >
            Use theirs
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor height="100%" theme="coding-studio" path={`file:///${path}`} defaultLanguage={monacoLanguage(path)} defaultValue={rec.text ?? ''} onMount={onMount} options={editorOptions} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted">{children}</div>;
}

export function BinaryFileView({ path }: { path: string }) {
  const rec = useEditor((s) => s.workspace?.files.get(path));
  const kind = previewKind(path);
  const url = useMemo(() => (rec?.data ? URL.createObjectURL(new Blob([rec.data as BlobPart], { type: mimeType(path) })) : null), [rec, path]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const [font, setFont] = useState<string | null>(null);
  useEffect(() => {
    if (kind !== 'font' || !url) return;
    const name = `preview-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(name, `url(${url})`);
    face
      .load()
      .then((f) => {
        document.fonts.add(f);
        setFont(name);
      })
      .catch(() => setFont(null));
  }, [kind, url]);
  if (!rec) return <Empty>This file no longer exists.</Empty>;
  const name = path.split('/').pop()!;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="binary-view" data-path={path}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span className="font-mono text-text">{path}</span>
        <span>{formatSize(rec.size)}</span>
        <Button className="ml-auto" variant="ghost" onClick={() => downloadBytes(name, rec.data ?? rec.text ?? '', mimeType(path))}>
          <Download size={13} /> Download
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#0b0d12] p-4">
        {kind === 'image' && url && <img src={url} alt={name} className="max-h-full max-w-full object-contain [image-rendering:pixelated]" style={{ backgroundImage: 'repeating-conic-gradient(#1b1f27 0% 25%, #12151b 0% 50%)', backgroundSize: '16px 16px' }} data-testid="image-preview" />}
        {kind === 'audio' && url && <audio src={url} controls data-testid="audio-preview" />}
        {kind === 'video' && url && <video src={url} controls className="max-h-full max-w-full" />}
        {kind === 'font' && (font ? <div style={{ fontFamily: font }} className="text-center text-[28px] leading-snug text-text">The quick brown fox jumps over the lazy dog<br />0123456789 !?&amp;</div> : <span className="text-muted">Loading font…</span>)}
        {kind === 'none' && <span className="text-muted">No preview for this kind of file.</span>}
      </div>
    </div>
  );
}

export function GeneratedFileView({ id }: { id: string }) {
  const path = id.slice(GEN_PREFIX.length);
  const lastGood = useCompile((s) => s.lastGood);
  const entry = useMemo(() => Object.entries(lastGood).find(([, f]) => f.path === path), [lastGood, path]);
  if (!entry) return <Empty>{path} hasn't been generated (yet). Fix any errors in its graph first.</Empty>;
  const [scriptId, file] = entry;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="generated-view">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span className="font-mono text-text">{path}</span>
        <span>read-only · generated from a visual script</span>
        <Button className="ml-auto" onClick={() => useEditor.getState().setActive(scriptId)} data-testid="open-graph">
          <Workflow size={13} /> Open graph
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Editor height="100%" theme="coding-studio" path={`generated:///${path}`} language={monacoLanguage(path)} value={file.content} options={{ ...editorOptions, readOnly: true, domReadOnly: true }} />
      </div>
    </div>
  );
}

/** A file compared with its version at the last commit synced with GitHub. */
export function DiffFileView({ id }: { id: string }) {
  const path = id.slice(DIFF_PREFIX.length);
  const rec = useEditor((s) => s.workspace?.files.get(path));
  const [original, setOriginal] = useState<{ text: string; binary: boolean } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    baseVersion(path)
      .then((f) => live && setOriginal(f ? { text: f.text ?? '', binary: f.kind === 'binary' } : null))
      .catch((e) => {
        if (live) setOriginal(null);
        toast('error', e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [path]);
  if (original === undefined) return <Empty>Loading GitHub's version…</Empty>;
  if (original?.binary || rec?.kind === 'binary') return <Empty>{path} is a binary file: {original ? (rec ? 'changed' : 'deleted') : 'added'}.</Empty>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="diff-view">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span className="font-mono text-text">{path}</span>
        <span>GitHub (left) → yours (right)</span>
        {rec && (
          <Button className="ml-auto" variant="ghost" onClick={() => useEditor.getState().openTab(path)}>
            Edit file
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor height="100%" theme="coding-studio" language={monacoLanguage(path)} original={original?.text ?? ''} modified={rec?.text ?? ''} options={{ readOnly: true, renderSideBySide: window.innerWidth > 900, automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5 }} />
      </div>
    </div>
  );
}
