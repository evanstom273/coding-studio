/**
 * The TypeScript project behind the editor. Monaco's TypeScript worker type-checks every model,
 * so we keep one model per TS/JS file in the workspace plus one per file generated from a graph
 * (same path as it will have on disk). Hand-written code and graphs can then import each other
 * with full checking, and errors in generated code are mapped back to the node that produced them.
 */
import type { Diagnostic } from '@cs/graph-core';
import { useTsCheck, type FileProblem } from './tsCheckStore';
import type { Workspace } from '@cs/workspace';
import { monaco, tsLanguage, type TsDiagnostic } from './monaco';
import { useEditor } from '@web/store/editor';
import { useCompile } from '@web/compile/store';

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const MAX_SIZE = 2 * 1024 * 1024;

/** Paths currently owned by an open text editor (it updates its own model while typing). */
export const editorOwned = new Set<string>();

export const uriFor = (path: string) => monaco.Uri.parse(`file:///${path.split('/').map(encodeURIComponent).join('/')}`);
const pathOf = (uri: { path: string }) => decodeURIComponent(uri.path.replace(/^\//, ''));

const managed = new Map<string, 'file' | 'generated'>();

const watched = new WeakSet<object>();
function watch(m: ReturnType<typeof monaco.editor.createModel>) {
  if (watched.has(m)) return;
  watched.add(m);
  m.onDidChangeContent(() => scheduleCheck());
}

function setModel(path: string, text: string, kind: 'file' | 'generated') {
  const uri = uriFor(path);
  const m = monaco.editor.getModel(uri);
  if (!m) {
    watch(monaco.editor.createModel(text, undefined, uri));
  } else if (!(kind === 'file' && editorOwned.has(path)) && m.getValue() !== text) {
    m.setValue(text);
  }
  if (m) watch(m);
  managed.set(path, kind);
}

/** Bring Monaco's models in line with the workspace and the latest generated code. */
export function syncModels(ws: Workspace | null, generated: { path: string; content: string }[]) {
  const want = new Set<string>();
  if (ws) {
    for (const f of ws.files.values()) {
      if (f.kind !== 'text' || !TS_FILE.test(f.path) || f.size > MAX_SIZE) continue;
      want.add(f.path);
      setModel(f.path, f.text ?? '', 'file');
    }
    for (const g of generated) {
      if (!TS_FILE.test(g.path) || want.has(g.path)) continue; // a real file wins
      want.add(g.path);
      setModel(g.path, g.content, 'generated');
    }
  }
  for (const [path] of managed) {
    if (want.has(path)) continue;
    managed.delete(path);
    if (!editorOwned.has(path)) monaco.editor.getModel(uriFor(path))?.dispose();
  }
  scheduleCheck();
}

const message = (m: TsDiagnostic['messageText']): string => (typeof m === 'string' ? m : m.messageText);

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;

export function scheduleCheck(delay = 700) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runCheck(), delay);
}

/** Ask the TypeScript worker for every managed file's diagnostics. */
export async function runCheck() {
  if (running) {
    await running;
    return scheduleCheck(50);
  }
  const paths = [...managed.keys()];
  if (!paths.length) {
    useTsCheck.setState({ files: [], nodes: [], checking: false });
    return;
  }
  running = (async () => {
    useTsCheck.setState({ checking: true });
    try {
      const getWorker = await tsLanguage.getTypeScriptWorker();
      const uris = paths.map(uriFor);
      const worker = await getWorker(...uris);
      const files: FileProblem[] = [];
      const nodes: Diagnostic[] = [];
      const project = useEditor.getState().project;
      const lastGood = Object.entries(useCompile.getState().lastGood);
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const model = monaco.editor.getModel(uris[i]);
        if (!model) continue;
        const name = uris[i].toString();
        const diags = [...(await worker.getSyntacticDiagnostics(name)), ...(await worker.getSemanticDiagnostics(name))];
        for (const d of diags) {
          if (d.category !== 0 && d.category !== 1) continue;
          const pos = model.getPositionAt(d.start ?? 0);
          const severity = d.category === 1 ? 'error' : 'warning';
          const text = message(d.messageText);
          if (managed.get(path) === 'generated') {
            const gen = lastGood.find(([, f]) => f.path === path);
            const map = gen?.[1].sourceMap ?? [];
            // The statement that produced this line: exact, else the nearest one above it.
            const hit = [...map].filter((e) => e.nodeId && e.line <= pos.lineNumber).sort((a, b) => b.line - a.line)[0];
            const fn = hit && project?.scripts.flatMap((s) => s.functions).find((f) => f.graph.id === hit.graphId);
            nodes.push({ severity, code: `TS${d.code}`, message: `TypeScript: ${text}`, scriptId: gen?.[0] ?? '', ...(fn ? { functionId: fn.id, graphId: fn.graph.id } : {}), ...(hit?.nodeId ? { nodeId: hit.nodeId } : {}), suggestion: `Line ${pos.lineNumber} of ${path}.` });
          } else files.push({ path, line: pos.lineNumber, column: pos.column, message: text, severity, code: `TS${d.code}` });
        }
      }
      useTsCheck.setState({ files, nodes, checking: false });
    } catch {
      useTsCheck.setState({ checking: false });
    }
  })();
  await running;
  running = null;
}

/** Keep models in sync while a project is open. Returns a stop function. */
export function startTsProject(): () => void {
  const generated = () => Object.values(useCompile.getState().lastGood).map((f) => ({ path: f.path, content: f.content }));
  const sync = () => syncModels(useEditor.getState().workspace, generated());
  sync();
  const a = useEditor.subscribe((s, p) => {
    if (s.workspace !== p.workspace) sync();
  });
  const b = useCompile.subscribe((s, p) => {
    if (s.lastGood !== p.lastGood) sync();
  });
  // Go to definition / references in another file: open it in a tab.
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const path = pathOf(resource);
      const ws = useEditor.getState().workspace;
      const line = selection && 'startLineNumber' in selection ? selection.startLineNumber : selection && 'lineNumber' in selection ? selection.lineNumber : undefined;
      if (ws?.files.has(path)) {
        useEditor.getState().openTab(path, line ? { line } : {});
        return true;
      }
      if (managed.get(path) === 'generated') {
        useEditor.getState().openTab(`gen:${path}`);
        return true;
      }
      return false;
    },
  });
  return () => {
    a();
    b();
    opener.dispose();
    syncModels(null, []);
  };
}
