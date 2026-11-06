/** Project-wide text search across text files (and generated code is skipped: it's derived). */
import { useDeferredValue, useMemo, useState } from 'react';
import { CaseSensitive, Regex, Search } from 'lucide-react';
import { useEditor } from '@web/store/editor';
import { useUI } from '@web/store/ui';
import { useCompact } from '@web/hooks/useLayout';
import { cx, IconButton } from '../ui/primitives';
import { iconFor } from './FileExplorer';

export { searchFiles, type SearchHit } from '@cs/workspace';
import { searchFiles, type SearchHit } from '@cs/workspace';

export function SearchPanel() {
  const ws = useEditor((s) => s.workspace)!;
  const [q, setQ] = useState('');
  const [cs, setCs] = useState(false);
  const [rx, setRx] = useState(false);
  const query = useDeferredValue(q);
  const compact = useCompact();
  const res = useMemo(() => searchFiles(ws.files.values(), query, { caseSensitive: cs, regex: rx }), [ws.files, query, cs, rx]);
  const groups = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of res.hits) (m.get(h.path) ?? m.set(h.path, []).get(h.path)!).push(h);
    return [...m];
  }, [res]);
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]" data-testid="search-panel">
      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input autoFocus data-testid="search-input" className="w-full rounded border border-border bg-[#0f1218] py-1.5 pl-7 pr-2 text-[12px] focus:border-accent focus:outline-none" placeholder="Search in files…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <IconButton label="Match case" active={cs} onClick={() => setCs(!cs)}>
          <CaseSensitive size={14} />
        </IconButton>
        <IconButton label="Regular expression" active={rx} onClick={() => setRx(!rx)}>
          <Regex size={14} />
        </IconButton>
      </div>
      {res.error && <div className="px-3 text-red-300">{res.error}</div>}
      {query && !res.error && (
        <div className="px-3 pb-1 text-[11px] text-muted">
          {res.hits.length}
          {res.truncated ? '+' : ''} result(s) in {groups.length} file(s)
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {groups.map(([path, hits]) => (
          <div key={path} className="mb-1">
            <div className="flex items-center gap-1.5 px-2 py-0.5 font-medium">
              {iconFor(path)} <span className="truncate">{path}</span> <span className="ml-auto text-[10.5px] text-muted">{hits.length}</span>
            </div>
            {hits.map((h) => (
              <button
                key={`${h.line}:${h.start}`}
                className={cx('block w-full truncate py-[2px] pl-7 pr-2 text-left font-mono text-[11.5px] text-muted hover:bg-panel-2 hover:text-text')}
                data-testid="search-hit"
                onClick={() => {
                  useEditor.getState().openTab(path, { line: h.line });
                  if (compact) useUI.getState().set({ drawer: null });
                }}
              >
                <span className="mr-2 text-[10px] text-[#5b6372]">{h.line}</span>
                {h.text.slice(Math.max(0, h.start - 40), h.start)}
                <mark className="rounded-sm bg-amber-400/30 text-text">{h.text.slice(h.start, h.end)}</mark>
                {h.text.slice(h.end, h.end + 120)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
