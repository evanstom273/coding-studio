/**
 * Cloudflare deploy credentials: entered once, then put into each repository's GitHub Actions
 * secrets by Coding Studio (automatically when the deploy workflow is added, or with one tap).
 */
import { useEffect, useState } from 'react';
import { Cloud, KeyRound } from 'lucide-react';
import type { GitState } from '@cs/git';
import { cloudflareStatus, forgetCloudflare, saveCloudflare, setCloudflareSecrets } from '@web/lib/git';
import { toast } from '@web/store/toasts';
import { Button, inputCls } from '../ui/primitives';

const err = (e: unknown) => toast('error', e instanceof Error ? e.message : String(e));

export function CloudflareCard({ st, usesCloudflare }: { st: GitState; usesCloudflare: boolean }) {
  const [status, setStatus] = useState<{ configured: boolean; accountId?: string } | null>(null);
  const [token, setToken] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    cloudflareStatus().then(setStatus, () => setStatus({ configured: false }));
  }, []);
  if (!status) return null;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-3 mt-3 rounded border border-border p-2.5" data-testid="cloudflare-card">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <Cloud size={13} className="text-orange-300" /> Cloudflare deploys
      </div>
      {status.configured && !editing ? (
        <div className="space-y-2">
          <p className="text-[11.5px] text-muted" data-testid="cloudflare-connected">
            Connected (account …{status.accountId?.slice(-6)}). Adding the “Deploy to Cloudflare” workflow puts the token into that repository’s secrets for you.
          </p>
          {usesCloudflare && (
            <Button
              className="h-8 w-full"
              disabled={busy}
              data-testid="cloudflare-set-secrets"
              onClick={() =>
                run(async () => {
                  const r = await setCloudflareSecrets(st.owner, st.repo);
                  toast('success', `Deploy secrets set on ${r.repository}`);
                })
              }
            >
              <KeyRound size={13} /> Set deploy secrets on {st.repo}
            </Button>
          )}
          <div className="flex gap-3 text-[11px]">
            <button className="text-accent hover:underline" onClick={() => setEditing(true)}>
              Change token
            </button>
            <button className="text-muted hover:text-red-300" onClick={() => run(async () => setStatus(await forgetCloudflare()))}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="cloudflare-form">
          <p className="text-[11.5px] leading-snug text-muted">
            Once, for all your projects: in the Cloudflare dashboard go to <b>My Profile → API Tokens → Create Token</b>, use the <b>“Edit Cloudflare Workers”</b> template, and paste it here with your <b>Account ID</b> (Workers &amp; Pages page, right-hand side). It’s kept in your own Coding Studio cloud storage and only ever written into your repositories’ secrets.
          </p>
          <input className={inputCls} type="password" autoComplete="off" placeholder="Cloudflare API token" value={token} onChange={(e) => setToken(e.target.value)} data-testid="cloudflare-token" />
          <input className={inputCls} autoComplete="off" placeholder="Account ID (32 characters)" value={account} onChange={(e) => setAccount(e.target.value)} data-testid="cloudflare-account" />
          <div className="flex gap-1">
            <Button
              className="h-8 flex-1"
              variant="primary"
              disabled={busy || !token.trim() || !account.trim()}
              data-testid="cloudflare-save"
              onClick={() =>
                run(async () => {
                  setStatus(await saveCloudflare(token, account));
                  setToken('');
                  setAccount('');
                  setEditing(false);
                  toast('success', 'Cloudflare connected');
                  if (usesCloudflare) {
                    const r = await setCloudflareSecrets(st.owner, st.repo);
                    toast('success', `Deploy secrets set on ${r.repository}`);
                  }
                })
              }
            >
              Save
            </Button>
            {editing && (
              <Button className="h-8" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
