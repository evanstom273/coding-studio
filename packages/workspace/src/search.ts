/** Text search over workspace files (shared by the editor's search panel and the MCP tools). */
const MAX_RESULTS = 2000;

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export function searchFiles(files: Iterable<{ path: string; kind: string; text?: string }>, query: string, opts: { caseSensitive?: boolean; regex?: boolean; limit?: number; under?: string } = {}): { hits: SearchHit[]; error?: string; truncated: boolean } {
  if (!query) return { hits: [], truncated: false };
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch (e) {
    return { hits: [], error: e instanceof Error ? e.message : String(e), truncated: false };
  }
  const limit = opts.limit ?? MAX_RESULTS;
  const hits: SearchHit[] = [];
  for (const f of files) {
    if (f.kind !== 'text' || !f.text || f.path.endsWith('.gitkeep')) continue;
    if (opts.under && f.path !== opts.under && !f.path.startsWith(`${opts.under}/`)) continue;
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 300), start: m.index, end: m.index + Math.max(1, m[0].length) });
      if (hits.length >= limit) return { hits, truncated: true };
    }
  }
  return { hits, truncated: false };
}
