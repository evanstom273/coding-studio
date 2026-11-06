#!/usr/bin/env node
/**
 * Builds the MCP server as ONE self-contained file: dist/mcp/coding-studio-mcp.mjs.
 * The production editor build (apps/web/dist) is embedded, so the server can serve the IDE at
 * http://localhost:47831 — users need neither npm nor a hosted site.
 *
 *   node scripts/build-mcp.mjs            build the editor, then the server
 *   node scripts/build-mcp.mjs --no-web   reuse an existing apps/web/dist
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const webDist = join(root, 'apps/web/dist');
if (!process.argv.includes('--no-web') || !existsSync(webDist)) execSync('npm run build', { cwd: root, stdio: 'inherit' });

function collect(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name !== '_headers') out[relative(webDist, full).split(sep).join('/')] = readFileSync(full).toString('base64');
  }
  return out;
}
const assets = collect(webDist);

await build({
  entryPoints: [join(root, 'mcp/server/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(root, 'dist/mcp/coding-studio-mcp.mjs'),
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'warning',
  plugins: [
    {
      name: 'editor-assets',
      setup(b) {
        b.onResolve({ filter: /^virtual:editor-assets$/ }, () => ({ path: 'editor-assets', namespace: 'editor-assets' }));
        b.onLoad({ filter: /.*/, namespace: 'editor-assets' }, () => ({ contents: `export default ${JSON.stringify(assets)};`, loader: 'js' }));
      },
    },
  ],
});
const size = statSync(join(root, 'dist/mcp/coding-studio-mcp.mjs')).size;
console.log(`dist/mcp/coding-studio-mcp.mjs (${(size / 1024 / 1024).toFixed(1)} MB, editor: ${Object.keys(assets).length} files embedded)`);
