/**
 * Same projects on every device: this device's sync space as a QR code / link. Scanning it on
 * another device (or pasting the link there) makes that device use the same space; the projects
 * already on it are merged in, nothing is deleted. No accounts or tokens.
 */
import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Smartphone } from 'lucide-react';
import { keyFromLink, pairUrl, useBridge } from '@web/bridge/client';
import { toast } from '@web/store/toasts';
import { Button, confirmDialog, Dialog, inputCls } from '../ui/primitives';
import { CopyLine } from './McpDialog';

function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  }, [text]);
  // White background so phone cameras read it on the dark theme.
  return <div className="mx-auto w-56 max-w-full rounded bg-white p-1 [&>svg]:h-auto [&>svg]:w-full" data-testid="pair-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const b = useBridge();
  const [paste, setPaste] = useState('');
  const onSite = !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const url = pairUrl(b.remoteKey);
  return (
    <Dialog title="Your projects on all your devices" onClose={onClose}>
      <div className="space-y-3 text-[12.5px] leading-relaxed text-[#c9ced8]" data-testid="devices-dialog">
        {!onSite && <p className="rounded bg-amber-400/10 px-2 py-1.5 text-amber-200">Syncing works on your deployed site (your Cloudflare address), not on a local development server.</p>}
        <label className="flex items-center gap-2 rounded border border-border bg-panel-2 p-2.5">
          <input type="checkbox" checked={b.remoteEnabled} onChange={(e) => b.setRemoteEnabled(e.target.checked)} data-testid="sync-enable" />
          <span className="font-medium text-text">Keep this device's projects in sync</span>
        </label>
        <p className="text-[11.5px] text-muted">
          Status: <span data-testid="sync-status">{b.remoteEnabled ? b.remoteStatusText : 'off — projects stay only in this browser'}</span>
        </p>
        <div>
          <h3 className="mb-1 font-semibold text-text">Add another device</h3>
          <p className="mb-2">Scan this with your phone's camera (or open the link on the other device) and tap “Use these projects”. Both devices then share the same projects — and the same GitHub connection — from then on. Anything already on the other device is added, not deleted.</p>
          <QrCode text={url} />
          <div className="mt-2">
            <CopyLine text={url} testId="pair-url" />
          </div>
          <p className="mt-1 text-[11px] text-muted">Anyone with this code or link can open your synced projects, so only scan it on your own devices.</p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold text-text">Or use another device's projects here</h3>
          <div className="flex gap-1">
            <input className={inputCls} placeholder="Paste the link from your other device" value={paste} onChange={(e) => setPaste(e.target.value)} data-testid="pair-paste" />
            <Button
              disabled={!paste.trim()}
              data-testid="pair-paste-use"
              onClick={async () => {
                const key = keyFromLink(paste);
                if (!key) return toast('error', "That isn't a Coding Studio device link.");
                if (key === b.remoteKey) return toast('info', 'This device already uses those projects.');
                if (await confirmUse()) {
                  b.adoptRemoteKey(key);
                  setPaste('');
                  toast('success', 'Linked: this device now shares projects with your other device.');
                }
              }}
            >
              Use
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

const confirmUse = () =>
  confirmDialog({
    title: 'Use these projects on this device?',
    message: "This device will share projects with the other one. Projects already here are added to them (nothing is deleted). If you set up the Claude / ChatGPT connector with this device's old link, update it to the new one shown in Claude settings afterwards.",
    confirm: 'Use these projects',
  });

/** The screen a scanned code opens: link this device to the other one's projects. */
export function PairScreen({ pairKey, onDone }: { pairKey: string; onDone: () => void }) {
  const b = useBridge();
  const already = b.remoteKey === pairKey && b.remoteEnabled;
  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="pair-screen">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-panel p-5 text-center">
        <Smartphone size={28} className="mx-auto text-accent" />
        <h1 className="text-[16px] font-semibold">{already ? 'This device is already linked' : 'Use your projects on this device?'}</h1>
        <p className="text-[12.5px] text-[#c9ced8]">{already ? 'It shares projects with your other device.' : 'This device will share projects with the device that showed the code. Projects already here are added to them, nothing is deleted.'}</p>
        <div className="flex flex-col gap-2">
          {!already && (
            <Button
              variant="primary"
              className="h-11 text-[14px]"
              data-testid="pair-confirm"
              onClick={() => {
                b.adoptRemoteKey(pairKey);
                toast('success', 'Linked. Your projects will appear in a moment.');
                onDone();
              }}
            >
              Use these projects
            </Button>
          )}
          <Button variant="ghost" className="h-11" onClick={onDone} data-testid="pair-cancel">
            {already ? 'Go to my projects' : 'Not now'}
          </Button>
        </div>
      </div>
    </div>
  );
}
