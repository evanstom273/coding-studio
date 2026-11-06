/**
 * Browser preview: bundle the project's files with esbuild (WebAssembly in the browser, native in
 * tests) and run the result in a sandboxed iframe. npm packages aren't bundled: an import map
 * points them at esm.sh, at the versions package.json declares, with every package's own
 * dependencies routed through the same map so React & co. exist once.
 */
import type * as esbuildTypes from 'esbuild';

type Esbuild = Pick<typeof esbuildTypes, 'build'>;

export interface PreviewFile {
  path: string;
  text?: string;
  data?: Uint8Array;
}

export interface BuildProblem {
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface PreviewBuild {
  js: string;
  css: string;
  errors: BuildProblem[];
  warnings: BuildProblem[];
  entry?: string;
  ms: number;
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const LOADERS: Record<string, esbuildTypes.Loader> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', css: 'css', svg: 'dataurl', png: 'dataurl', jpg: 'dataurl', jpeg: 'dataurl', gif: 'dataurl', webp: 'dataurl', ico: 'dataurl', woff: 'dataurl', woff2: 'dataurl', ttf: 'dataurl', mp3: 'dataurl', wav: 'dataurl', ogg: 'dataurl', txt: 'text', md: 'text', html: 'text' };

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isBare = (spec: string) => !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z]+:/i.test(spec);

/** The module script an index.html loads ("/src/main.tsx"), if any. */
export function entryFromHtml(html: string): string | undefined {
  const m = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i.exec(html) ?? /<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["'][^>]*>\s*<\/script>/i.exec(html);
  return m ? normalize(m[1].replace(/^\.\//, '')) : undefined;
}

export function findEntry(files: Map<string, PreviewFile>): string | undefined {
  const html = files.get('index.html')?.text;
  const fromHtml = html ? entryFromHtml(html) : undefined;
  if (fromHtml && files.has(fromHtml)) return fromHtml;
  for (const c of ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx', 'src/index.ts', 'main.tsx', 'main.ts', 'main.js', 'index.ts', 'index.js']) if (files.has(c)) return c;
  return undefined;
}

export async function bundle(esbuild: Esbuild, files: Map<string, PreviewFile>, entry = findEntry(files)): Promise<PreviewBuild> {
  const t0 = Date.now();
  if (!entry) return { js: '', css: '', errors: [{ message: 'Nothing to run: add an index.html with <script type="module" src="/src/main.tsx">, or a src/main.ts(x).' }], warnings: [], ms: 0 };
  const resolveIn = (spec: string, importer: string): string | undefined => {
    const base = spec.startsWith('/') ? normalize(spec) : normalize(`${dirOf(importer)}/${spec}`);
    for (const ext of EXTS) if (files.has(base + ext)) return base + ext;
    // "./x.js" written for a .ts file (TypeScript style)
    const noJs = base.replace(/\.(m?js|jsx)$/, '');
    if (noJs !== base) for (const ext of ['.ts', '.tsx', '.mts']) if (files.has(noJs + ext)) return noJs + ext;
    return undefined;
  };
  const plugin: esbuildTypes.Plugin = {
    name: 'workspace',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === 'entry-point') return { path: a.path, namespace: 'ws' };
        if (isBare(a.path)) return { path: a.path, external: true };
        if (/^[a-z]+:/i.test(a.path)) return { path: a.path, external: true };
        const hit = resolveIn(a.path, a.importer);
        if (!hit) return { errors: [{ text: `Can't find "${a.path}" (imported from ${a.importer})` }] };
        return { path: hit, namespace: 'ws' };
      });
      b.onLoad({ filter: /.*/, namespace: 'ws' }, (a) => {
        const f = files.get(a.path)!;
        const ext = a.path.split('.').pop()!.toLowerCase();
        const loader = LOADERS[ext] ?? (f.data ? 'dataurl' : 'text');
        return { contents: f.data ?? f.text ?? '', loader, resolveDir: dirOf(a.path) };
      });
    },
  };
  const loc = (m: esbuildTypes.Message): BuildProblem => ({ message: m.text, ...(m.location ? { path: m.location.file.replace(/^ws:/, ''), line: m.location.line, column: m.location.column + 1 } : {}) });
  try {
    const r = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      outdir: 'out',
      sourcemap: 'inline',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.MODE': '"development"' },
      plugins: [plugin],
    });
    const js = r.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\n');
    const css = r.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
    return { js, css, errors: [], warnings: r.warnings.map(loc), entry, ms: Date.now() - t0 };
  } catch (e) {
    const fail = e as { errors?: esbuildTypes.Message[]; warnings?: esbuildTypes.Message[] };
    return { js: '', css: '', errors: fail.errors?.map(loc) ?? [{ message: e instanceof Error ? e.message : String(e) }], warnings: fail.warnings?.map(loc) ?? [], entry, ms: Date.now() - t0 };
  }
}

/** Import map sending every dependency (and its sub-paths) to esm.sh, with deps shared via the map. */
export function importMap(deps: Record<string, string>): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    const v = /^(workspace:|file:|link:|git|https?:)/.test(range) ? 'latest' : range.trim() || 'latest';
    // "*" asks esm.sh to leave the package's own imports bare, so they resolve through this map too.
    const url = `https://esm.sh/*${name}@${encodeURIComponent(v).replace(/%2F/g, '/')}`;
    imports[name] = url;
    imports[`${name}/`] = `${url}/`;
  }
  // Packages that libraries import without the app declaring them.
  if (imports.react && !imports['react-dom']) {
    imports['react-dom'] = imports.react.replace('*react@', '*react-dom@');
    imports['react-dom/'] = `${imports['react-dom']}/`;
  }
  return { imports };
}

/** Reports console output and errors from the iframe to the editor. */
const BRIDGE = `<script>(function(){var send=function(level,args){try{parent.postMessage({source:'coding-studio-preview',level:level,args:args.map(function(a){if(a instanceof Error)return a.stack||String(a);if(typeof a==='object'){try{return JSON.stringify(a)}catch(e){return String(a)}}return String(a)})},'*')}catch(e){}};['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,[].slice.call(arguments));o.apply(console,arguments)}});addEventListener('error',function(e){send('error',[e.error||e.message])});addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: ',e.reason])});})();</script>`;

const escapeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');

/** The iframe document: the project's index.html (or a minimal one) with the bundle inlined. */
export function previewHtml(build: PreviewBuild, indexHtml: string | undefined, deps: Record<string, string>, extraHead = ''): string {
  const head = `<meta charset="utf-8">${BRIDGE}<script type="importmap">${JSON.stringify(importMap(deps))}</script>${extraHead}${build.css ? `<style>${build.css}</style>` : ''}`;
  const script = `<script type="module">${escapeScript(build.js)}</script>`;
  let html = indexHtml ?? '<!doctype html><html><head></head><body><div id="root"></div><div id="app"></div></body></html>';
  // The app's own module script is replaced by the bundle; other local scripts/styles can't load in a srcdoc.
  html = html.replace(/<script[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi, '').replace(/<link[^>]+href=["']\/[^"']*\.css["'][^>]*>/gi, '');
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
  return html;
}
