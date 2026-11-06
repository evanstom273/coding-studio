/**
 * Line-based three-way merge (diff3). Non-overlapping changes from both sides are combined;
 * overlapping ones become conflict blocks with standard markers.
 */
type Hunk = { baseStart: number; baseEnd: number; lines: string[] };

/** Changes from `base` to `other` as hunks over base line ranges (LCS on lines). */
export function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // Trim common prefix/suffix (keeps the DP small for typical edits).
  let pre = 0;
  while (pre < n && pre < m && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === other[m - 1 - suf]) suf++;
  const a = base.slice(pre, n - suf);
  const b = other.slice(pre, m - suf);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > 25_000_000) return [{ baseStart: pre, baseEnd: n - suf, lines: b }];
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i === a.length || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
      cur ??= { baseStart: pre + i, baseEnd: pre + i, lines: [] };
      cur.lines.push(b[j++]);
    } else {
      cur ??= { baseStart: pre + i, baseEnd: pre + i, lines: [] };
      i++;
      cur.baseEnd = pre + i;
    }
  }
  flush();
  return hunks;
}

export interface MergeResult {
  text: string;
  conflicts: number;
}

export function merge3(base: string, ours: string, theirs: string, labels = { ours: 'yours', theirs: 'GitHub' }): MergeResult {
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: ours, conflicts: 0 };
  const B = base.split('\n');
  const O = ours.split('\n');
  const T = theirs.split('\n');
  const ho = diffHunks(B, O).map((h) => ({ ...h, side: 'o' as const }));
  const ht = diffHunks(B, T).map((h) => ({ ...h, side: 't' as const }));
  const all = [...ho, ...ht].sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd);
  const out: string[] = [];
  let pos = 0;
  let conflicts = 0;
  let k = 0;
  while (k < all.length) {
    // Group hunks that overlap (or touch at the same insertion point).
    let start = all[k].baseStart;
    let end = all[k].baseEnd;
    const group = [all[k++]];
    // Overlapping ranges, or an insertion touching the group's edge, can't be combined safely.
    while (k < all.length && (all[k].baseStart < end || (all[k].baseStart === end && (all[k].baseStart === all[k].baseEnd || start === end)))) {
      end = Math.max(end, all[k].baseEnd);
      start = Math.min(start, all[k].baseStart);
      group.push(all[k++]);
    }
    out.push(...B.slice(pos, start));
    const sides = new Set(group.map((g) => g.side));
    const render = (side: 'o' | 't') => {
      const res: string[] = [];
      let p = start;
      for (const g of group.filter((x) => x.side === side)) {
        res.push(...B.slice(p, g.baseStart), ...g.lines);
        p = g.baseEnd;
      }
      res.push(...B.slice(p, end));
      return res;
    };
    if (sides.size === 1) out.push(...render(group[0].side));
    else {
      const o = render('o');
      const t = render('t');
      if (o.join('\n') === t.join('\n')) out.push(...o);
      else {
        conflicts++;
        out.push(`<<<<<<< ${labels.ours}`, ...o, '=======', ...t, `>>>>>>> ${labels.theirs}`);
      }
    }
    pos = end;
  }
  out.push(...B.slice(pos));
  return { text: out.join('\n'), conflicts };
}
