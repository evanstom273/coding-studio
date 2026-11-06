/**
 * The MCP server serves the editor itself: no dev server, no hosted site, no setup toggle.
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 47997;
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

test('editor served by the MCP server connects to Claude on its own', async ({ page, request }) => {
  const c = new Client({ name: 'e2e', version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp/coding-studio-mcp.mjs'], env: { ...process.env, CODING_STUDIO_PORT: String(PORT) } as Record<string, string>, stderr: 'ignore' }));
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;
    // Before the page is open, Claude is told how to open it.
    const before = await call('status');
    expect(before.isError).toBe(true);
    expect(before.content[0].text).toContain('open_editor');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('open_editor');

    // Requests with a foreign Host header (DNS rebinding) are refused.
    expect((await request.get(`http://127.0.0.1:${PORT}/`, { headers: { Host: 'evil.example' } })).status()).toBe(403);

    await page.goto(`http://localhost:${PORT}/`);
    await expect(page.getByTestId('mcp-indicator')).toContainText('Claude connected', { timeout: 15_000 });

    const status = await call('status');
    expect(status.isError).toBeFalsy();
    const created = JSON.parse((await call('create_project', { name: 'Served Editor Test', template: 'node' })).content[0].text!);
    expect(created.name).toBe('Served Editor Test');
    await expect(page.getByTestId('project-title')).toHaveText('Served Editor Test');

    // Deep links work (client-side routing) and the code view renders under the server's CSP.
    await page.reload();
    await expect(page.getByTestId('project-title')).toHaveText('Served Editor Test');
    await page.getByTestId('bottom-tab-code').click();
    await expect(page.getByTestId('code-text')).toContainText('extends Node');
  } finally {
    await c.close();
  }
});
