import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { bundle, entryFromHtml, findEntry, importMap, previewHtml, type PreviewFile } from '@cs/preview';

const ws = (files: Record<string, string>) => new Map<string, PreviewFile>(Object.entries(files).map(([path, text]) => [path, { path, text }]));

describe('preview bundling', () => {
  it('finds the entry from index.html, bundles TS/TSX/CSS/JSON across folders, leaves npm imports to the import map', async () => {
    const files = ws({
      'index.html': '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/src/x.css"></head><body><div id="root"></div><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': "import './style.css';\nimport { greet } from './lib/greet.js';\nimport data from '../data.json';\nimport { format } from 'date-fns';\ndocument.getElementById('root')!.textContent = greet(data.name);\nexport { format };\n",
      'src/lib/greet.ts': 'export const greet = (n: string): string => `Hello ${n}`;\n',
      'src/style.css': 'body { color: red; }\n',
      'data.json': '{ "name": "Lyra" }',
    });
    expect(entryFromHtml(files.get('index.html')!.text!)).toBe('src/main.ts');
    expect(findEntry(files)).toBe('src/main.ts');
    const r = await bundle(esbuild, files);
    expect(r.errors).toEqual([]);
    expect(r.js).toContain('Hello ${n}');
    expect(r.js).toContain('from "date-fns"');
    expect(r.css).toContain('color: red');
    const html = previewHtml(r, files.get('index.html')!.text, { 'date-fns': '^4.1.0', react: '^19.1.0' });
    expect(html).toContain('"date-fns":"https://esm.sh/date-fns@%5E4.1.0&external=react,react-dom"');
    expect(html).toContain('"react-dom/":"https://esm.sh/react-dom@%5E19.1.0&external=date-fns,react/"');
    expect(html).not.toContain('src="/src/main.ts"');
    expect(html).not.toContain('href="/src/x.css"');
    expect(html.indexOf('importmap')).toBeLessThan(html.indexOf('<script type="module">'));
  });

  it('reports errors with file and line, and runs plain output', async () => {
    const bad = await bundle(esbuild, ws({ 'src/main.ts': "import { x } from './missing';\nconst y: number = ;\n" }));
    expect(bad.errors[0]).toMatchObject({ path: 'src/main.ts', line: 2 });
    const ok = await bundle(esbuild, ws({ 'main.ts': "import { n } from './n';\n(globalThis as any).result = n * 2;\n", 'n.ts': 'export const n = 21;' }));
    const g = globalThis as { result?: number };
    await import(`data:text/javascript;base64,${Buffer.from(ok.js).toString('base64')}`);
    expect(g.result).toBe(42);
    expect(importMap({ x: 'workspace:*' }).imports.x).toBe('https://esm.sh/x@latest');
  });

  it('JSX compiles with the automatic runtime (react/jsx-runtime from the import map)', async () => {
    const r = await bundle(esbuild, ws({ 'src/main.tsx': "import { createRoot } from 'react-dom/client';\nfunction App() { return <h1 className=\"t\">Hi</h1>; }\ncreateRoot(document.getElementById('root')!).render(<App />);\n" }));
    expect(r.errors).toEqual([]);
    expect(r.js).toContain('from "react/jsx-runtime"');
  });
});
