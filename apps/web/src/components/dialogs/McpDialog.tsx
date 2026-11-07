import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { BRIDGE_DEFAULT_PORT } from '@cs/shared-protocol';
import { connectorUrl, useBridge } from '@web/bridge/client';
import { confirmDialog } from '../ui/primitives';
import { Button, Dialog, Field, inputCls } from '../ui/primitives';

export function CopyLine({ text, testId }: { text: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-stretch gap-1">
      <code data-testid={testId} className="flex-1 overflow-x-auto whitespace-pre rounded border border-border bg-[#0d1016] px-2 py-1.5 font-mono text-[11px]">
        {text}
      </code>
      <Button
        onClick={async () => {
          await navigator.clipboard?.writeText(text).catch(() => undefined);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        aria-label="Copy command"
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}

export function McpDialog({ onClose }: { onClose: () => void }) {
  const b = useBridge();
  const origin = window.location.origin;
  // The connector lives in the site's Worker, so it isn't there on localhost dev/preview servers.
  // (Tests run the Worker locally and opt in with the coding-studio:connector-test flag.)
  const onDeployedSite = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) || localStorage.getItem('coding-studio:connector-test') === '1';
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  const env = [b.port !== BRIDGE_DEFAULT_PORT ? `-e CODING_STUDIO_PORT=${b.port}` : '', local ? '' : `-e CODING_STUDIO_ORIGINS=${origin}`].filter(Boolean).join(' ');
  const cmd = `claude mcp add coding-studio ${env ? `${env} ` : ''}-- node /path/to/coding-studio/dist/mcp/coding-studio-mcp.mjs`;
  return (
    <Dialog title="Claude" onClose={onClose} width={620}>
      <p className="mb-3 text-[12px] leading-relaxed text-[#c9ced8]">
        Let Claude inspect and edit your graphs. Claude's edits use the same validated operations as yours: each batch is atomic, can be undone, and is rejected if the project changed since Claude last read it. Both options are off until you switch them on.
      </p>

      <h3 className="mb-1.5 text-[13px] font-semibold">Claude connector (phone, claude.ai, anywhere)</h3>
      {onDeployedSite ? (
        <>
          <label className="mb-2 flex items-center gap-2 rounded border border-border bg-panel-2 p-2.5">
            <input type="checkbox" checked={b.remoteEnabled} onChange={(e) => b.setRemoteEnabled(e.target.checked)} data-testid="connector-enable" />
            <span className="text-[13px] font-medium">Claude connector: sync my projects so Claude can edit them from anywhere</span>
          </label>
          <div className="mb-2 rounded border border-border p-2.5 text-[12px]" data-testid="connector-status">
            <span className="font-medium">Status:</span> {b.remoteStatusText}
            {(b.remoteStatus === 'busy' || b.remoteStatus === 'revoked') && (
              <div className="mt-2">
                <Button onClick={b.takeOverRemote} data-testid="connector-takeover">
                  Use this tab instead
                </Button>
              </div>
            )}
          </div>
          <p className="mb-1 text-[12px] text-[#c9ced8]">
            While this is on, your projects are kept in sync with your Cloudflare site, and Claude edits them there directly, so <b>this page doesn't need to be open</b>. Changes show up here as soon as you open it (or live, if it's already open). Add this link once in Claude: <b>claude.ai → Settings → Connectors → Add custom connector</b>, paste it as the URL, leave the rest empty. It works in the Claude phone app too.
          </p>
          <CopyLine text={connectorUrl(b.remoteKey)} testId="connector-url" />
          <p className="mt-1 text-[11px] text-muted">
            Keep the link to yourself: it gives access to your synced projects.{' '}
            <button
              className="text-accent hover:underline"
              data-testid="connector-reset"
              onClick={async () => {
                if (await confirmDialog({ title: 'Make a new connector link?', message: 'The current link stops working. You will need to update it in Claude’s connector settings.', confirm: 'New link' })) b.resetRemoteKey();
              }}
            >
              Make a new link
            </button>
          </p>
        </>
      ) : (
        <p className="mb-2 text-[12px] text-muted">Available on the deployed site (your Cloudflare address), not on a local development server.</p>
      )}

      <h3 className="mb-1.5 mt-5 text-[13px] font-semibold">Claude on this computer (Claude Code / Claude desktop)</h3>
      {b.servedByMcp && <p className="mb-3 rounded bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">This editor is being served by the Coding Studio MCP server on your computer, so it connects to Claude automatically. Nothing else to set up.</p>}
      <label className="mb-3 flex items-center gap-2 rounded border border-border bg-panel-2 p-2.5">
        <input type="checkbox" checked={b.enabled} onChange={(e) => b.setEnabled(e.target.checked)} data-testid="mcp-enable" />
        <span className="text-[13px] font-medium">Allow Claude Code to control this editor</span>
      </label>
      <div className="mb-3 rounded border border-border p-2.5 text-[12px]" data-testid="mcp-status">
        <span className="font-medium">Status:</span> {b.statusText}
        {b.status === 'busy' && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-muted">Another Coding Studio tab is connected.</span>
            <Button onClick={b.takeOver} data-testid="mcp-takeover">
              Take over in this tab
            </Button>
          </div>
        )}
        {b.status === 'revoked' && (
          <div className="mt-2">
            <Button onClick={b.takeOver}>Reconnect this tab</Button>
          </div>
        )}
      </div>
      <h3 className="mb-1.5 text-[12px] font-semibold">1. Build the server (once, in the repository)</h3>
      <CopyLine text="npm install && npm run build:mcp" />
      <h3 className="mb-1.5 mt-3 text-[12px] font-semibold">2. Register it with Claude Code</h3>
      <CopyLine text={cmd} testId="mcp-command" />
      <p className="mt-1 text-[11px] text-muted">Replace /path/to/coding-studio with your checkout. {local ? '' : `The ${origin} origin is added to CODING_STUDIO_ORIGINS because this page is not on localhost.`}</p>
      <h3 className="mb-1.5 mt-3 text-[12px] font-semibold">3. Test</h3>
      <p className="text-[12px] text-muted">
        Start Claude Code and ask it to "check the coding-studio status". The indicator in the toolbar turns green when this tab is connected. If it stays amber, see docs/MCP.md → Troubleshooting (hosted pages may need the browser's local-network permission).
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="Port" hint="Must match CODING_STUDIO_PORT of the server.">
          <input className={inputCls} type="number" value={b.port} min={1025} max={65535} onChange={(e) => Number.isInteger(+e.target.value) && +e.target.value > 1024 && +e.target.value < 65536 && b.setPort(+e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
