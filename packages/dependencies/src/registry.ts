/**
 * npm registry search and version resolution (registry.npmjs.org and jsDelivr both allow
 * browser requests). `fetchJson` is injected so the same code runs in the browser, the Worker
 * and tests.
 */
export type FetchJson = (url: string) => Promise<unknown>;
export type FetchText = (url: string) => Promise<string>;

export const REGISTRY = 'https://registry.npmjs.org';
export const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1';
export const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';

export interface SearchResult {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  weeklyDownloads?: number;
  hasTypes?: boolean;
}

export async function searchPackages(fetchJson: FetchJson, text: string, size = 20): Promise<SearchResult[]> {
  if (!text.trim()) return [];
  const r = (await fetchJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(text.trim())}&size=${size}`)) as {
    objects: { package: { name: string; version: string; description?: string; keywords?: string[] }; downloads?: { weekly?: number }; flags?: Record<string, unknown> }[];
  };
  return r.objects.map((o) => ({ name: o.package.name, version: o.package.version, ...(o.package.description ? { description: o.package.description } : {}), ...(o.package.keywords ? { keywords: o.package.keywords } : {}), ...(o.downloads?.weekly !== undefined ? { weeklyDownloads: o.downloads.weekly } : {}) }));
}

/** Exact version a range resolves to ("^4" → "4.4.7"), or undefined if nothing matches. */
export async function resolveVersion(fetchJson: FetchJson, name: string, range = 'latest'): Promise<string | undefined> {
  try {
    const r = (await fetchJson(`${JSDELIVR_DATA}/package/resolve/npm/${name}@${encodeURIComponent(range)}`)) as { version?: string | null };
    return r.version ?? undefined;
  } catch {
    return undefined;
  }
}

export async function packageInfo(fetchJson: FetchJson, name: string): Promise<{ latest?: string; versions: string[] }> {
  const r = (await fetchJson(`${JSDELIVR_DATA}/package/npm/${name}`)) as { tags?: { latest?: string }; versions?: (string | { version: string })[] };
  return { ...(r.tags?.latest ? { latest: r.tags.latest } : {}), versions: (r.versions ?? []).map((v) => (typeof v === 'string' ? v : v.version)) };
}
