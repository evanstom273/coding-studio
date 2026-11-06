#!/usr/bin/env node
// Entry point Claude Code launches: `node dist/mcp/coding-studio-mcp.mjs`
import { main } from './server';

main().catch((e) => {
  console.error('[coding-studio-mcp] fatal:', e);
  process.exit(1);
});
