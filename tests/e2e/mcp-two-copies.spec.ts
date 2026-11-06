/**
 * Some MCP hosts (e.g. the Claude desktop app) start the same server twice. Both copies must work:
 * the one that can't bind the port relays through the one that can.
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freshStart } from './helpers';

const PORT = 47998;
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

async function launch() {
  const c = new Client({ name: 'e2e', version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/coding-studio-mcp.mjs'], env: { ...process.env, CODING_STUDIO_PORT: String(PORT) } as Record<string, string>, stderr: 'ignore' }));
  return c;
}
const status = async (c: Client) => (await c.callTool({ name: 'status', arguments: {} })) as ToolResult;

test('two copies of the server both reach the editor', async ({ page }) => {
  const a = await launch();
  const b = await launch();
  try {
    // before the editor connects: a clear message from both, not "port in use" / "[object Object]"
    for (const c of [a, b]) {
      const r = await status(c);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('E_NOT_CONNECTED');
      expect(r.content[0].text).not.toContain('object Object');
    }
    await freshStart(page);
    await page.evaluate((port) => localStorage.setItem('coding-studio:bridge', JSON.stringify({ enabled: true, port })), PORT);
    await page.reload();
    await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected');
    for (const c of [a, b]) {
      const r = await status(c);
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(r.content[0].text!).app).toBe('Coding Studio');
    }
  } finally {
    await a.close();
    await b.close();
  }
});
