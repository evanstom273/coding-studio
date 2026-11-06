#!/usr/bin/env node
// Entry point Claude launches: `node coding-studio-mcp.mjs`
// The built editor is embedded by scripts/build-mcp.mjs, so this one file is everything a user needs.
import editorAssets from 'virtual:editor-assets';
import { main } from './server';

main(editorAssets).catch((e) => {
  console.error('[coding-studio-mcp] fatal:', e);
  process.exit(1);
});
