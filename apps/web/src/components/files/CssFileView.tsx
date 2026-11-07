/**
 * CSS files open as a list of styles (selectors) with the visual style editor; the text editor is
 * one tap away. Edits change only the declarations the editor owns, in place: comments, other
 * rules, unknown properties and formatting stay as written. One undo step per burst of changes.
 */
import { useMemo, useState } from 'react';
import { Code2, Paintbrush, Plus, Trash2 } from 'lucide-react';
import { addStyle, listStyles, readStyle, removeStyle, writeStyle, type StyleSpec } from '@cs/styling';
import { useEditor } from '@web/store/editor';
import { toast } from '@web/store/toasts';
import { confirmDialog, cx } from '../ui/primitives';
import { ctl } from '../fields/controls';
import { StyleEditor } from '../fields/StyleEditor';
import { TextFileView } from './FileView';

const modes = new Map<string, 'visual' | 'text'>();
export const isCssFile = (path: string) => /\.css$/i.test(path);

export function CssFileView({ path }: { path: string }) {
  const rec = useEditor((s) => s.workspace?.files.get(path));
  const [mode, setModeState] = useState(modes.get(path) ?? 'visual');
  const setMode = (m: 'visual' | 'text') => (modes.set(path, m), setModeState(m));
  const text = rec?.text ?? '';
  const parsed = useMemo(() => {
    try {
      return { styles: listStyles(text) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), styles: [] };
    }
  }, [text]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newSel, setNewSel] = useState('');
  const sel = selected && parsed.styles.some((s) => s.selector === selected) ? selected : (parsed.styles[0]?.selector ?? null);
  const style = useMemo(() => (sel && !parsed.error ? readStyle(text, sel) : null), [text, sel, parsed.error]);

  const write = (next: (t: string) => string, label: string, mergeKey?: string) => {
    const cur = useEditor.getState().workspace?.files.get(path);
    if (!cur) return;
    try {
      const out = next(cur.text ?? '');
      if (out !== cur.text) useEditor.getState().applyFiles([{ op: 'write_file', path, content: out, expectedHash: cur.hash }], label, mergeKey ? { mergeKey: `css:${path}:${mergeKey}` } : {});
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };
  const add = (s: string) => {
    const selector = s.trim();
    if (!selector) return;
    write((t) => addStyle(t, selector), `Add style ${selector}`);
    setSelected(selector);
    setNewSel('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="css-view" data-path={path}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="mr-1 truncate text-[11.5px] font-medium">{path.split('/').pop()}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {(['visual', 'text'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cx('flex h-[32px] items-center gap-1 rounded px-2 text-[11.5px] sm:h-[24px]', mode === m ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} data-testid={`css-mode-${m}`}>
              {m === 'visual' ? <Paintbrush size={12} /> : <Code2 size={12} />} {m === 'visual' ? 'Visual' : 'Text'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'text' ? (
        <div className="min-h-0 flex-1">
          <TextFileView key={path} path={path} />
        </div>
      ) : parsed.error ? (
        <div className="p-4 text-[12px] text-red-300" data-testid="css-parse-error">
          This CSS can't be read ({parsed.error}). <button className="text-accent underline" onClick={() => setMode('text')}>Fix it in the text editor</button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row">
          <div className="shrink-0 border-b border-border p-2 md:w-56 md:border-b-0 md:border-r">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Styles</div>
            <div className="flex flex-wrap gap-1 md:flex-col">
              {parsed.styles.map((s) => (
                <button key={s.selector} type="button" onClick={() => setSelected(s.selector)} className={cx('flex h-[36px] items-center gap-1 rounded px-2 text-left font-mono text-[12px] sm:h-[28px]', s.selector === sel ? 'bg-accent/25 text-text' : 'text-muted hover:bg-panel-2 hover:text-text')} data-testid="css-style" data-selector={s.selector}>
                  <span className="truncate">{s.selector}</span>
                  {s.variants.filter(Boolean).length > 0 && <span className="text-[10px] text-[#7d8696]">+{s.variants.filter(Boolean).length}</span>}
                </button>
              ))}
              {!parsed.styles.length && <div className="text-[11.5px] text-muted">No styles yet.</div>}
            </div>
            <div className="mt-2 flex gap-1">
              <input className={cx(ctl, 'font-mono')} placeholder=".card, button, #title" value={newSel} onChange={(e) => setNewSel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(newSel)} data-testid="css-new-selector" />
              <button type="button" className={cx(ctl, 'w-auto shrink-0 px-2')} onClick={() => add(newSel)} aria-label="Add style" data-testid="css-add">
                <Plus size={13} />
              </button>
            </div>
            <div className="mt-1 text-[10.5px] text-[#7d8696]">.name = elements with class="name" · tag = every such element · #id = one element</div>
          </div>
          {sel && style && (
            <div className="min-w-0 flex-1 p-2">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[13px]">{sel}</span>
                <button
                  type="button"
                  className="ml-auto text-muted hover:text-red-300"
                  aria-label={`Delete ${sel}`}
                  data-testid="css-delete"
                  onClick={async () => {
                    if (await confirmDialog({ title: `Delete ${sel}?`, message: 'Its rules (including hover / screen-size variants) are removed from the file.', confirm: 'Delete', danger: true })) write((t) => removeStyle(t, sel), `Delete style ${sel}`);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <StyleEditor key={sel} spec={style.spec} onChange={(spec: StyleSpec, mergeKey) => write((t) => writeStyle(t, sel, spec), `Style ${sel}`, mergeKey ? `${sel}:${mergeKey}` : undefined)} previewText={sel.startsWith('.') || sel.startsWith('#') ? sel.slice(1) : sel} />
              {Object.keys(style.other).length > 0 && (
                <div className="mt-2 rounded border border-border p-2 text-[11px] text-[#7d8696]" data-testid="css-other">
                  Also in this style, kept as written (edit in Text):
                  {Object.entries(style.other).map(([v, decls]) => (
                    <div key={v} className="font-mono">
                      {v && <span className="text-muted">{v}: </span>}
                      {decls.map(([p, x]) => `${p}: ${x}`).join('; ')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
