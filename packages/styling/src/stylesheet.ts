/**
 * Visual editing of CSS files. A "style" is a selector with its variant rules (`.btn`,
 * `.btn:hover`, `@media (min-width: 768px) { .btn {…} }`). Reading builds a StyleSpec; writing
 * changes only the declarations the model owns, in place, keeping every other declaration, rule,
 * comment and the file's formatting (postcss keeps the original whitespace).
 */
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Root, type Rule } from 'postcss';
import { declsFromCss, declsToCss } from './css';
import { BREAKPOINT_PX, BREAKPOINTS, clean, splitVariant, STATES, type Breakpoint, type Decls, type State, type StyleSpec } from './model';

const STATE_SUFFIX: Record<State, string[]> = { hover: [':hover'], focus: [':focus-visible', ':focus'], active: [':active'], disabled: [':disabled'] };

export function parseCss(text: string): Root {
  return postcss.parse(text);
}

const mediaBp = (a: AtRule): Breakpoint | undefined => {
  if (a.name !== 'media') return undefined;
  const m = /^\(\s*min-width:\s*(\d+)px\s*\)$/.exec(a.params.trim());
  return m ? (Object.entries(BREAKPOINT_PX).find(([, px]) => px === Number(m[1]))?.[0] as Breakpoint | undefined) : undefined;
};

/** Split "sel:hover" into its base selector and state, for selectors we group. */
function splitSelector(sel: string): { base: string; state: State | '' } {
  const s = sel.trim();
  for (const st of STATES) for (const suf of STATE_SUFFIX[st]) if (s.endsWith(suf) && !s.includes(',')) return { base: s.slice(0, -suf.length), state: st };
  return { base: s, state: '' };
}

export interface StyleEntry {
  selector: string;
  variants: string[];
  line: number;
}

/** The styles in a stylesheet (base selectors, with the variants each has), in file order. */
export function listStyles(text: string): StyleEntry[] {
  const root = parseCss(text);
  const map = new Map<string, StyleEntry>();
  const visit = (node: Container<ChildNode>, bp: Breakpoint | '') => {
    node.each((c) => {
      if (c.type === 'rule') {
        const { base, state } = splitSelector(c.selector);
        const e = map.get(base) ?? { selector: base, variants: [], line: c.source?.start?.line ?? 0 };
        const v = [bp, state].filter(Boolean).join(':');
        if (!e.variants.includes(v)) e.variants.push(v);
        map.set(base, e);
      } else if (c.type === 'atrule' && !bp) {
        const b = mediaBp(c);
        if (b) visit(c, b);
      }
    });
  };
  visit(root, '');
  return [...map.values()];
}

function rulesFor(root: Root, selector: string): { rule: Rule; variant: string }[] {
  const out: { rule: Rule; variant: string }[] = [];
  const visit = (node: Container<ChildNode>, bp: Breakpoint | '') =>
    node.each((c) => {
      if (c.type === 'rule') {
        const { base, state } = splitSelector(c.selector);
        if (base === selector.trim()) out.push({ rule: c, variant: [bp, state].filter(Boolean).join(':') });
      } else if (c.type === 'atrule' && !bp) {
        const b = mediaBp(c);
        if (b) visit(c, b);
      }
    });
  visit(root, '');
  return out;
}

const declsOf = (r: Rule): [string, string][] => r.nodes.filter((n): n is Declaration => n.type === 'decl').map((d) => [d.prop, d.value]);
const managed = (prop: string, value: string) => declsFromCss([[prop, value]]).other.length === 0;

/** The style of a selector, plus the declarations per variant the model doesn't cover (kept). */
export function readStyle(text: string, selector: string): { spec: StyleSpec; other: Record<string, [string, string][]> } {
  const spec: StyleSpec = {};
  const other: Record<string, [string, string][]> = {};
  for (const { rule, variant } of rulesFor(parseCss(text), selector)) {
    const r = declsFromCss(declsOf(rule));
    spec[variant] = { ...(spec[variant] ?? {}), ...r.decls };
    if (r.other.length) other[variant] = [...(other[variant] ?? []), ...r.other];
  }
  return { spec: clean(spec), other };
}

function indentOf(text: string, root: Root): string {
  let ind = '  ';
  root.walkDecls((d) => {
    const before = d.raws.before ?? '';
    const m = /\n([ \t]+)$/.exec(before);
    if (m) {
      ind = m[1];
      return false;
    }
    return undefined;
  });
  void text;
  return ind;
}

/** Write a selector's style: only owned declarations change; missing variant rules are added. */
export function writeStyle(text: string, selector: string, spec: StyleSpec): string {
  const root = parseCss(text);
  const ind = indentOf(text, root);
  const want = clean(spec);
  const existing = rulesFor(root, selector);
  const variants = new Set([...Object.keys(want), ...existing.map((e) => e.variant)]);
  for (const v of variants) {
    const decls = declsToCss(want[v] ?? {});
    const rules = existing.filter((e) => e.variant === v).map((e) => e.rule);
    let rule = rules[rules.length - 1];
    // Remove owned declarations that are no longer wanted (in every rule for this variant).
    const wanted = new Map(decls);
    for (const r of rules)
      r.each((n) => {
        if (n.type === 'decl' && managed(n.prop, n.value) && (!wanted.has(n.prop) || r !== rule)) n.remove();
      });
    if (!decls.length) {
      for (const r of rules) if (!r.nodes.length) removeRule(r);
      continue;
    }
    if (!rule) rule = addRule(root, selector, v, ind);
    for (const [p, val] of decls) {
      const cur = rule.nodes.find((n): n is Declaration => n.type === 'decl' && n.prop === p);
      if (cur) {
        if (cur.value !== val) cur.value = val;
      } else rule.append(postcss.decl({ prop: p, value: val, raws: { before: `\n${rule.parent?.type === 'atrule' ? ind + ind : ind}`, between: ': ' } }));
    }
    rule.raws.after = `\n${rule.parent?.type === 'atrule' ? ind : ''}`;
    rule.raws.semicolon = true;
  }
  return root.toString();
}

function removeRule(r: Rule) {
  const parent = r.parent;
  r.remove();
  if (parent && parent.type === 'atrule' && !(parent as AtRule).nodes?.length) parent.remove();
}

function addRule(root: Root, selector: string, variant: string, ind: string): Rule {
  const { bp, state } = splitVariant(variant);
  const sel = state ? `${selector}${STATE_SUFFIX[state][0]}` : selector;
  const rule = postcss.rule({ selector: sel, raws: { before: '\n\n', between: ' ', after: '\n', semicolon: true } });
  if (!bp) {
    // After the selector's last base/state rule outside media queries, else at the end (before media blocks).
    const same = rulesFor(root, selector).filter((e) => !splitVariant(e.variant).bp);
    if (same.length) same[same.length - 1].rule.after(rule);
    else {
      const firstMedia = root.nodes.find((n) => n.type === 'atrule' && mediaBp(n as AtRule));
      if (firstMedia) {
        firstMedia.before(rule);
        rule.raws.before = root.first === rule ? '' : '\n\n';
        firstMedia.raws.before = '\n\n';
      } else root.append(rule);
    }
    if (root.first === rule) rule.raws.before = '';
    return rule;
  }
  let media = root.nodes.find((n): n is AtRule => n.type === 'atrule' && mediaBp(n as AtRule) === bp);
  if (!media) {
    media = postcss.atRule({ name: 'media', params: `(min-width: ${BREAKPOINT_PX[bp]}px)`, raws: { before: root.nodes.length ? '\n\n' : '', between: ' ', after: '\n' } });
    // Media blocks in breakpoint order, after everything else.
    const later = root.nodes.find((n) => n.type === 'atrule' && mediaBp(n as AtRule) && BREAKPOINTS.indexOf(mediaBp(n as AtRule)!) > BREAKPOINTS.indexOf(bp));
    if (later) later.before(media);
    else root.append(media);
  }
  rule.raws.before = `\n${ind}`;
  rule.raws.after = `\n${ind}`;
  media.append(rule);
  return rule;
}

/** Add an empty style (if the selector has none yet). */
export function addStyle(text: string, selector: string): string {
  const root = parseCss(text);
  if (rulesFor(root, selector).length) return text;
  addRule(root, selector.trim(), '', indentOf(text, root));
  const out = root.toString();
  return out.endsWith('\n') ? out : `${out}\n`;
}

/** Remove a style and all its variant rules. */
export function removeStyle(text: string, selector: string): string {
  const root = parseCss(text);
  for (const { rule } of rulesFor(root, selector)) removeRule(rule);
  return root.toString();
}

/** Declarations a variant shows, merged (for previews). */
export type { Decls };
