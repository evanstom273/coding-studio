#!/usr/bin/env node
/**
 * Coding Studio MCP server.
 *
 * Claude Code launches this over stdio. Tool calls are relayed to the Coding Studio editor tab
 * through a WebSocket on 127.0.0.1; the editor executes them with the same validated edit
 * operations as the mouse (atomic batches, undo, autosave, revision checks). This process holds
 * no project state and only touches the filesystem in export_script / export_project.
 *
 * Environment:
 *   CODING_STUDIO_PORT          WebSocket port (default 47831; must match the editor's MCP setting)
 *   CODING_STUDIO_ORIGINS       comma-separated extra allowed origins (e.g. https://studio.example.workers.dev)
 *   CODING_STUDIO_EXPORT_ROOTS  optional ':'-separated directories exports must stay inside
 *
 * stdout carries the MCP protocol — logs go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { BRIDGE_DEFAULT_PORT } from '@cs/shared-protocol';
import { BridgeRequestError, EditorBridge, log, parseOrigins, type EditorAssets } from './bridge';
import { buildServer as buildTools, type ToolHost } from './tools';
import { ExportError, parseRoots, planExport, writePlan } from './export';
import { LocalHost } from './host';

/** The local server's host functions: open the built-in editor, write exports to disk safely. */
export function localHost(bridge: EditorBridge, exportRoots: string[]): ToolHost {
  const local = new LocalHost((method, params, timeout) => bridge.request(method as never, params, timeout));
  bridge.hostHandler = (method, params) => local.fromEditor(method, params);
  return {
    local,
    openEditorDescription: `Open Coding Studio in the user's default browser. The editor is served by this MCP server itself at http://localhost:<port> and connects to Claude automatically. Use this when status says Coding Studio isn't open.`,
    async openEditor() {
      const url = bridge.editorUrl;
      try {
        openInBrowser(url);
      } catch (e) {
        throw new BridgeRequestError('E_OPEN_FAILED', `Could not open a browser (${e instanceof Error ? e.message : String(e)}). Ask the user to open ${url} in any browser.`);
      }
      return { opened: url, note: 'Give the page a few seconds to load, then call status. If no browser window appeared, ask the user to open the URL themselves.' };
    },
    async writeFiles(outputDir, files, overwrite, relay) {
      const plan = planExport(outputDir, files, exportRoots);
      const conflicts = plan.targets.filter((t) => t.exists).map((t) => t.path);
      if (conflicts.length) {
        if (!overwrite) throw new ExportError('E_FILE_EXISTS', `These files already exist and overwrite is false, so nothing was written:\n${conflicts.join('\n')}\nRe-run with overwrite: true; the user will be asked to approve it in Coding Studio.`, { conflicts });
        const ok = (await relay.request('confirm_overwrite', { dir: plan.root, files: conflicts }, 300_000)) as { approved: boolean };
        if (!ok.approved) throw new ExportError('E_DECLINED', 'The user declined overwriting the existing files. Nothing was written.', { conflicts });
      }
      return { outputDir: plan.root, written: writePlan(plan, files), overwritten: conflicts };
    },
  };
}

export function buildServer(bridge: EditorBridge, exportRoots: string[] = []) {
  return buildTools(bridge, localHost(bridge, exportRoots));
}

/** Open a URL in the user's default browser (fixed command per OS; the URL is always our own localhost address). */
function openInBrowser(url: string) {
  if (!/^http:\/\/localhost:\d+\/?$/.test(url)) throw new Error('refusing to open a non-local URL');
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => log(`could not open browser: ${e.message}`));
  child.unref();
}

export async function main(assets: EditorAssets = {}) {
  const port = Number(process.env.CODING_STUDIO_PORT) || BRIDGE_DEFAULT_PORT;
  const origins = parseOrigins(process.env.CODING_STUDIO_ORIGINS);
  const bridge = new EditorBridge(port, origins, assets);
  await bridge.start();
  const server = buildServer(bridge, parseRoots(process.env.CODING_STUDIO_EXPORT_ROOTS));
  await server.connect(new StdioServerTransport());
  log(`MCP server ready (allowed origins: localhost${origins.length ? ', ' + origins.join(', ') : ''})`);
  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
