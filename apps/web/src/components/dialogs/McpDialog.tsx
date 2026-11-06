import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { BRIDGE_DEFAULT_PORT } from '@cs/shared-protocol';
import { useBridge } from '@web/bridge/client';
import { Button, Dialog, Field, inputCls } from '../ui/primitives';

function CopyLine({ text, testId }: { text: string; testId?: string }) {
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
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  const env = [b.port !== BRIDGE_DEFAULT_PORT ? `-e CODING_STUDIO_PORT=${b.port}` : '', local ? '' : `-e CODING_STUDIO_ORIGINS=${origin}`].filter(Boolean).join(' ');
  const cmd = `claude mcp add coding-studio ${env ? `${env} ` : ''}-- node /path/to/coding-studio/dist/mcp/coding-studio-mcp.mjs`;
  return (
    <Dialog title="Claude Code (MCP)" onClose={onClose} width={620}>
      <p className="mb-3 text-[12px] leading-relaxed text-[#c9ced8]">
        Let Claude Code inspect and edit your graphs through a local MCP server. Claude's edits use the same validated operations as yours: each batch is atomic, can be undone with Ctrl+Z, and is rejected if the project changed since Claude last read it.
        Nothing is sent to any server — the connection is between this tab and a process on your own machine (127.0.0.1).
      </p>
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
