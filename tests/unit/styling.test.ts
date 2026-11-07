/** Visual styling: Tailwind and CSS both round-trip, and nothing the user wrote is lost. */
import { describe, expect, it } from 'vitest';
import { addStyle, effective, fromTailwind, listStyles, mergeClasses, readStyle, removeStyle, toCss, toTailwind, writeStyle, type StyleSpec } from '@cs/styling';

describe('Tailwind', () => {
  it('generates scale classes where possible and arbitrary values otherwise, variants included', () => {
    const spec: StyleSpec = {
      '': { display: 'flex', justifyContent: 'between', gap: 8, padding: { top: 16, bottom: 16, left: 24, right: 24 }, fontSize: 18, fontWeight: 600, color: 'slate-800', backgroundColor: '#ff8800', borderRadius: 12, shadow: 'md', maxWidth: '448px', width: '100%' },
      hover: { backgroundColor: 'indigo-500', scale: 105 },
      md: { padding: { top: 13, right: 13, bottom: 13, left: 13 } },
      'md:hover': { opacity: 90 },
    };
    expect(toTailwind(spec).join(' ')).toBe('flex justify-between gap-2 py-4 px-6 w-full max-w-md text-lg font-semibold text-slate-800 bg-[#ff8800] rounded-xl shadow-md hover:bg-indigo-500 hover:scale-105 md:p-[13px] md:hover:opacity-90');
    expect(toTailwind({ '': { gradient: { dir: 'r', from: 'pink-500', to: 'violet-600' } } }, { v3: true })).toEqual(['bg-gradient-to-r', 'from-pink-500', 'to-violet-600']);
  });

  it('reads classes back (including the starter button) and keeps the ones it does not model', () => {
    const r = fromTailwind('mt-3 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500 group peer-checked:line-through animate-bounce -mx-2');
    expect(r.spec).toEqual({ '': { margin: { top: 12, left: -8, right: -8 }, borderRadius: 4, backgroundColor: 'indigo-600', padding: { left: 16, right: 16, top: 8, bottom: 8 }, color: 'white' }, hover: { backgroundColor: 'indigo-500' } });
    expect(r.other).toEqual(['group', 'peer-checked:line-through', 'animate-bounce']);
    // edit one thing: everything else stays, unknown classes stay at the end
    const edited = { ...r.spec, '': { ...r.spec[''], borderRadius: 'full' as const } };
    expect(mergeClasses(edited, r.other)).toBe('py-2 px-4 mt-3 -mx-2 text-white bg-indigo-600 rounded-full hover:bg-indigo-500 group peer-checked:line-through animate-bounce');
    // generated classes read back to the same spec
    const again = fromTailwind(toTailwind(edited).join(' '));
    expect(again.spec).toEqual(edited);
    expect(again.other).toEqual([]);
  });

  it('works out what a variant looks like (base → breakpoint → state)', () => {
    const spec: StyleSpec = { '': { color: 'black', fontSize: 14 }, md: { fontSize: 18 }, hover: { color: 'red-500' } };
    expect(effective(spec, 'md:hover')).toEqual({ color: 'red-500', fontSize: 18 });
    expect(effective(spec, 'sm')).toEqual({ color: 'black', fontSize: 14 });
  });
});

describe('CSS', () => {
  it('writes a rule set with states and media queries', () => {
    expect(toCss({ '': { padding: { top: 8, right: 16, bottom: 8, left: 16 }, backgroundColor: 'indigo-600', borderRadius: 'full' }, hover: { opacity: 80 }, md: { fontSize: 18 } }, '.btn')).toBe(
      '.btn {\n  padding: 8px 16px;\n  background-color: var(--color-indigo-600, #4f46e5);\n  border-radius: 9999px;\n}\n\n.btn:hover {\n  opacity: 0.8;\n}\n\n@media (min-width: 768px) {\n  .btn {\n    font-size: 18px;\n  }\n}',
    );
  });

  it('edits a stylesheet in place: owned declarations change, everything else (comments, unknown props, other rules) stays', () => {
    const css = `/* Buttons */
.btn {
    color: #333;
    -webkit-tap-highlight-color: transparent;
    padding: 4px;
}

.btn:hover {
    color: red;
}

.card { margin: 0 auto; }
`;
    expect(listStyles(css)).toEqual([{ selector: '.btn', variants: ['', 'hover'], line: 2 }, { selector: '.card', variants: [''], line: 12 }]);
    const r = readStyle(css, '.btn');
    expect(r.spec).toEqual({ '': { color: '#333', padding: { top: 4, right: 4, bottom: 4, left: 4 } }, hover: { color: 'red' } });
    expect(r.other).toEqual({ '': [['-webkit-tap-highlight-color', 'transparent']] });
    const out = writeStyle(css, '.btn', { '': { color: '#333', padding: { top: 8, right: 8, bottom: 8, left: 8 }, borderRadius: 6 }, md: { fontSize: 20 } });
    expect(out).toBe(`/* Buttons */
.btn {
    color: #333;
    -webkit-tap-highlight-color: transparent;
    padding: 8px;
    border-radius: 6px;
}

.card { margin: 0 auto; }

@media (min-width: 768px) {
    .btn {
        font-size: 20px;
    }
}
`);
    expect(readStyle(out, '.btn').spec).toEqual({ '': { color: '#333', padding: { top: 8, right: 8, bottom: 8, left: 8 }, borderRadius: 6 }, md: { fontSize: 20 } });
    const added = addStyle(out, '.title');
    expect(listStyles(added).map((s) => s.selector)).toEqual(['.btn', '.card', '.title']);
    expect(removeStyle(added, '.btn')).not.toContain('.btn');
    expect(removeStyle(added, '.btn')).toContain('/* Buttons */');
  });
});

describe('CSS through MCP', () => {
  it('css_set_style merges, removes properties with null, and keeps everything else', async () => {
    const { cssSetStyle, cssStylesView } = await import('@cs/project-service');
    const css = '/* site */\n.btn {\n  color: red;\n  will-change: transform;\n}\n';
    const out = cssSetStyle('a.css', css, '.btn', { '': { padding: { top: 8, right: 8, bottom: 8, left: 8 }, color: null }, hover: { opacity: 80 } }, {});
    expect(out).toBe('/* site */\n.btn {\n  will-change: transform;\n  padding: 8px;\n}\n\n.btn:hover {\n  opacity: 0.8;\n}\n');
    expect(cssStylesView('a.css', out).styles).toEqual([{ selector: '.btn', spec: { '': { padding: { top: 8, right: 8, bottom: 8, left: 8 } }, hover: { opacity: 80 } }, other: { '': [['will-change', 'transform']] } }]);
    expect(cssSetStyle('a.css', out, '.btn', undefined, { remove: true })).toBe('/* site */\n');
    expect(() => cssSetStyle('a.ts', out, '.btn', {}, {})).toThrow(/isn't a .css file/);
  });
});
