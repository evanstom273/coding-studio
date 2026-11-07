/**
 * Cloudflare deploy credentials, kept once (next to the GitHub token, in the user's own Durable
 * Object) and written into a repository's GitHub Actions secrets when a deploy workflow needs them.
 * Values never go to the browser: GitHub secrets are sealed here with the repository's public key.
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import type { GitHub } from '../packages/git/src/github';
import type { KvLike } from './cloud-service';

const KEY = 'cloudflare:deploy';
const CF_API = 'https://api.cloudflare.com/client/v4';

/** libsodium's crypto_box_seal (what GitHub expects for secrets): ephemeral key + XSalsa20-Poly1305. */
export function sealedBox(message: Uint8Array, recipient: Uint8Array): Uint8Array {
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(64);
  nonceIn.set(eph.publicKey, 0);
  nonceIn.set(recipient, 32);
  const nonce = blake2b(nonceIn, undefined, 24);
  const ct = nacl.box(message, nonce, recipient, eph.secretKey);
  const out = new Uint8Array(32 + ct.length);
  out.set(eph.publicKey, 0);
  out.set(ct, 32);
  return out;
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const SECRET_NAMES = { token: 'CLOUDFLARE_API_TOKEN', account: 'CLOUDFLARE_ACCOUNT_ID' } as const;

type Fetch = typeof fetch;

export class CloudflareVault {
  constructor(
    private readonly kv: KvLike,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
  ) {}

  async status() {
    const v = await this.kv.get<{ accountId: string; at: number }>(KEY);
    return v ? { configured: true, accountId: v.accountId, since: v.at } : { configured: false };
  }

  /** Check the token with Cloudflare, then keep it with the account id. */
  async set(token: string, accountId: string) {
    const t = token.trim();
    const a = accountId.trim().toLowerCase();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw Object.assign(new Error("That doesn't look like a Cloudflare API token."), { code: 'E_INVALID' });
    if (!/^[0-9a-f]{32}$/i.test(a)) throw Object.assign(new Error('The account ID is 32 letters and digits (Cloudflare dashboard → Workers & Pages, right-hand side).'), { code: 'E_INVALID' });
    const ok = async (url: string) => {
      const r = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${t}` } }).catch(() => null);
      if (!r || !r.ok) return false;
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: { status?: string } };
      return j.success === true && (j.result?.status ?? 'active') === 'active';
    };
    // User tokens verify at /user/tokens/verify, account-owned tokens under the account.
    if (!(await ok(`${CF_API}/user/tokens/verify`)) && !(await ok(`${CF_API}/accounts/${a}/tokens/verify`))) throw Object.assign(new Error('Cloudflare did not accept that token (expired, or not an API token?). Make one with the "Edit Cloudflare Workers" template.'), { code: 'E_INVALID' });
    await this.kv.put(KEY, { token: t, accountId: a.toLowerCase(), at: Date.now() });
    return { configured: true, accountId: a.toLowerCase() };
  }

  async clear() {
    await this.kv.delete(KEY);
    return { configured: false };
  }

  /** Write CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID into a repository's Actions secrets. */
  async setRepoSecrets(gh: GitHub, owner: string, repo: string) {
    const v = await this.kv.get<{ token: string; accountId: string }>(KEY);
    if (!v) throw Object.assign(new Error('Cloudflare is not connected yet: add your Cloudflare API token and account ID in Git → Actions.'), { code: 'E_CLOUDFLARE_NOT_CONNECTED' });
    const pk = await gh.actionsPublicKey(owner, repo);
    const key = unb64(pk.key);
    const enc = new TextEncoder();
    for (const [name, value] of [[SECRET_NAMES.token, v.token], [SECRET_NAMES.account, v.accountId]] as const) await gh.putActionsSecret(owner, repo, name, b64(sealedBox(enc.encode(value), key)), pk.key_id);
    return { repository: `${owner}/${repo}`, secrets: [SECRET_NAMES.token, SECRET_NAMES.account] };
  }
}
