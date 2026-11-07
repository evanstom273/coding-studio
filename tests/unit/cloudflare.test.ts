/** Cloudflare deploy credentials: stored once, sealed into repository secrets the way GitHub expects. */
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { GitHub } from '@cs/git';
import { CloudflareVault, sealedBox } from '../../worker/cloudflare';
import { memoryKv } from '../fixtures/cloud-backend';

/** libsodium crypto_box_seal_open, from the spec: what GitHub does with our secret. */
function sealOpen(sealed: Uint8Array, pk: Uint8Array, sk: Uint8Array) {
  const epk = sealed.subarray(0, 32);
  const n = new Uint8Array(64);
  n.set(epk, 0);
  n.set(pk, 32);
  return nacl.box.open(sealed.subarray(32), blake2b(n, undefined, 24), epk, sk);
}

describe('Cloudflare deploy secrets', () => {
  it('seals a value so the repository key opens it', () => {
    const kp = nacl.box.keyPair();
    const opened = sealOpen(sealedBox(new TextEncoder().encode('cf-token-123'), kp.publicKey), kp.publicKey, kp.secretKey);
    expect(new TextDecoder().decode(opened!)).toBe('cf-token-123');
  });

  it('checks the token with Cloudflare, keeps it, and writes both secrets to a repository', async () => {
    const kv = memoryKv();
    const cfFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      const ok = init?.headers?.Authorization === 'Bearer good_token_1234567890abcdef' && String(url).endsWith('/accounts/0123456789abcdef0123456789abcdef/tokens/verify');
      return new Response(JSON.stringify(ok ? { success: true, result: { status: 'active' } } : { success: false }), { status: ok ? 200 : 401 });
    }) as unknown as typeof fetch;
    const vault = new CloudflareVault(kv, cfFetch);
    await expect(vault.set('bad_token_1234567890abcdef', '0123456789abcdef0123456789abcdef')).rejects.toMatchObject({ code: 'E_INVALID' });
    await expect(vault.set('good_token_1234567890abcdef', 'nope')).rejects.toMatchObject({ code: 'E_INVALID' });
    expect(await vault.set('good_token_1234567890abcdef', '0123456789ABCDEF0123456789abcdef')).toEqual({ configured: true, accountId: '0123456789abcdef0123456789abcdef' });
    expect(JSON.stringify(await vault.status())).not.toContain('good_token');
    // GitHub side: public key, then two sealed secrets
    const repoKey = nacl.box.keyPair();
    const put: Record<string, string> = {};
    const gh = new GitHub(async (path, init) => {
      if (path === '/repos/lyra/game/actions/secrets/public-key') return { status: 200, body: { key_id: 'k1', key: btoa(String.fromCharCode(...repoKey.publicKey)) } };
      const m = /^\/repos\/lyra\/game\/actions\/secrets\/(\w+)$/.exec(path);
      if (m && init?.method === 'PUT') {
        const b = init.body as { encrypted_value: string; key_id: string };
        expect(b.key_id).toBe('k1');
        put[m[1]] = new TextDecoder().decode(sealOpen(Uint8Array.from(atob(b.encrypted_value), (c) => c.charCodeAt(0)), repoKey.publicKey, repoKey.secretKey)!);
        return { status: 201, body: null };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });
    expect(await vault.setRepoSecrets(gh, 'lyra', 'game')).toEqual({ repository: 'lyra/game', secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] });
    expect(put).toEqual({ CLOUDFLARE_API_TOKEN: 'good_token_1234567890abcdef', CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' });
    await vault.clear();
    await expect(vault.setRepoSecrets(gh, 'lyra', 'game')).rejects.toMatchObject({ code: 'E_CLOUDFLARE_NOT_CONNECTED' });
  });
});
