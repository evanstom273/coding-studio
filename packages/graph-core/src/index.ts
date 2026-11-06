export * from './model';
export * from './algorithms';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id with a readable prefix: "n_k3j9x0a2p1". 10 base-36 chars ≈ 51 bits. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

/** Deep clone for JSON-compatible documents. */
export function cloneJson<T>(v: T): T {
  return structuredClone(v);
}

/** Stable stringify (sorted keys) used for revisions and determinism checks. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** FNV-1a 64-bit-ish hash (two 32-bit lanes) → 16 hex chars. Not cryptographic; used for revisions. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
