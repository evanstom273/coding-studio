/** Builds the project for the Preview tab with esbuild-wasm (loaded the first time it's needed). */
import * as esbuild from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import { bundle, entryFromHtml, findEntry, previewHtml, type PreviewBuild, type PreviewFile } from '@cs/preview';
import { parseManifest } from '@cs/dependencies';
import type { Workspace } from '@cs/workspace';

let ready: Promise<void> | null = null;
const init = () => (ready ??= esbuild.initialize({ wasmURL, worker: true }));

export interface PreviewResult {
  build: PreviewBuild;
  html: string;
}

export async function buildPreview(ws: Workspace, generated: { path: string; content: string }[]): Promise<PreviewResult> {
  await init();
  const files = new Map<string, PreviewFile>();
  // Code generated from graphs first; real files win on the same path.
  for (const g of generated) files.set(g.path, { path: g.path, text: g.content });
  for (const f of ws.files.values()) files.set(f.path, f.kind === 'binary' ? { path: f.path, data: f.data } : { path: f.path, text: f.text });
  // index.html's own script wins; otherwise the program's entry point launcher; otherwise src/main…
  const html = ws.files.get('index.html')?.text;
  const fromHtml = html ? entryFromHtml(html) : undefined;
  const launcher = generated.find((g) => /\.entry\.(ts|tsx|js|jsx)$/.test(g.path))?.path;
  const build = await bundle(esbuild, files, fromHtml && files.has(fromHtml) ? fromHtml : (launcher ?? findEntry(files)));
  let deps: Record<string, string> = {};
  try {
    const m = parseManifest(ws.files.get('package.json')?.text);
    deps = { ...m.dependencies };
  } catch {
    /* no or bad package.json: no npm imports */
  }
  // Tailwind: the browser build reads the classes in the page (fine for a preview).
  const tw = deps.tailwindcss ?? ws.files.get('package.json')?.text?.match(/"tailwindcss"\s*:\s*"([^"]+)"/)?.[1];
  const extraHead = tw ? (/^[\^~]?3/.test(tw) ? '<script src="https://cdn.tailwindcss.com"></script>' : '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>') : '';
  delete deps.tailwindcss;
  delete deps['@tailwindcss/vite'];
  // Tailwind's browser build styles the page; the bare `@import "tailwindcss"` would 404.
  if (tw) build.css = build.css.replace(/@import\s+["']tailwindcss["'][^;]*;?/g, '');
  return { build, html: previewHtml(build, ws.files.get('index.html')?.text, deps, extraHead) };
}
