/** What kind of viewer a file gets, and which Monaco language highlights it. */
import { basename, extname } from '@cs/workspace';

const LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'javascript', '.jsonc': 'javascript',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.htm': 'html', '.svg': 'xml', '.xml': 'xml',
  '.md': 'markdown', '.mdx': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.py': 'python', '.sh': 'shell', '.bash': 'shell',
  '.ini': 'ini', '.toml': 'ini', '.cfg': 'ini', '.godot': 'ini', '.tscn': 'ini', '.tres': 'ini', '.import': 'ini', '.sql': 'sql',
  '.gd': 'gdscript',
};

export function monacoLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  if (name === 'dockerfile') return 'shell';
  return LANG[extname(path).toLowerCase()] ?? 'plaintext';
}

export type Preview = 'image' | 'audio' | 'video' | 'font' | 'none';
const PREVIEW: Record<string, Preview> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.ico': 'image', '.avif': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.m4a': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
};
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

export const previewKind = (path: string): Preview => PREVIEW[extname(path).toLowerCase()] ?? 'none';
export const mimeType = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Tab ids: workspace paths, or `gen:<output path>` for generated (read-only) files. */
export const GEN_PREFIX = 'gen:';
export const isGenTab = (id: string) => id.startsWith(GEN_PREFIX);
/** `diff:<path>`: the file compared with the last version on GitHub. */
export const DIFF_PREFIX = 'diff:';
export const isDiffTab = (id: string) => id.startsWith(DIFF_PREFIX);
/** Tabs that aren't workspace files. */
/** `log:<runId>:<jobId>`: a GitHub Actions job log. */
export const LOG_PREFIX = 'log:';
export const isLogTab = (id: string) => id.startsWith(LOG_PREFIX);
/** The running app. */
export const PREVIEW_TAB = 'preview:app';
export const isPreviewTab = (id: string) => id === PREVIEW_TAB;
export const isVirtualTab = (id: string) => isGenTab(id) || isDiffTab(id) || isLogTab(id) || isPreviewTab(id);
