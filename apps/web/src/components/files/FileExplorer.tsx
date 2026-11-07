/**
 * File explorer: the workspace as a tree. Create, rename, move (drag), duplicate, delete,
 * upload and download files and folders. Every change is one WorkspaceOps batch (undoable).
 * Only visible rows are rendered, so large workspaces stay fast.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isDirectlyWritable } from '@cs/workspace';
import { formatFor } from '@cs/structured-data';
import { ChevronDown, ChevronRight, Cog, File, FileCode2, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Image, MoreHorizontal, Music, Upload, Workflow } from 'lucide-react';
import { basename, CONFIG_PATH, dirname, GRAPH_EXT, joinPath, type WorkspaceOp } from '@cs/workspace';
import { useEditor } from '@web/store/editor';
import { generatedFiles, useCompile } from '@web/compile/store';
import { useUI } from '@web/store/ui';
import { toast } from '@web/store/toasts';
import { createBackup } from '@web/db/projects';
import { buildTree, visibleRows, type TreeNode } from '@web/lib/fileTree';
import { downloadBytes } from '@web/lib/files';
import { GEN_PREFIX, mimeType, previewKind } from '@web/lib/fileTypes';
import { toolchainFor } from '@web/lib/toolchain';
import { useCompact, useTouch } from '@web/hooks/useLayout';
import { confirmDialog, cx, IconButton } from '../ui/primitives';

const ROW = 24;
const FILE_MIME = 'application/x-coding-studio-path';

export function iconFor(path: string, size = 13) {
  if (path.endsWith(GRAPH_EXT)) return <Workflow size={size} className="shrink-0 text-sky-300" />;
  if (path === CONFIG_PATH) return <Cog size={size} className="shrink-0 text-amber-300" />;
  const p = previewKind(path);
  if (p === 'image') return <Image size={size} className="shrink-0 text-emerald-300" />;
  if (p === 'audio' || p === 'video') return <Music size={size} className="shrink-0 text-pink-300" />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|gd|py|css|scss|html)$/i.test(path)) return <FileCode2 size={size} className="shrink-0 text-blue-300" />;
  if (/\.(md|txt|json|ya?ml|toml)$/i.test(path)) return <FileText size={size} className="shrink-0 text-slate-300" />;
  return <File size={size} className="shrink-0 text-muted" />;
}

/** Apply file ops with a toast on failure. */
export function fileOps(ops: WorkspaceOp[], label: string): boolean {
  try {
    useEditor.getState().applyFiles(ops, label);
    return true;
  } catch (e) {
    toast('error', e instanceof Error ? e.message.replace(/^Operation \d+ \([a-z_]+\): /, '') : String(e));
    return false;
  }
}

function toB64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function uploadInto(dir: string, files: FileList | File[]) {
  // Visual-only: code files aren't uploaded into a project (import a whole project instead).
  const all = Array.from(files);
  const refused = all.filter((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    return !isDirectlyWritable(rel) && !formatFor(rel);
  });
  if (refused.length) toast('warning', `Skipped ${refused.length} code file(s) (${refused.slice(0, 3).map((f) => f.name).join(', ')}${refused.length > 3 ? '…' : ''}): Coding Studio builds code from visual scripts. To bring in an existing code project, use Import project or Open from GitHub.`);
  files = all.filter((f) => !refused.includes(f));
  if (!files.length) return;
  const list = [...files];
  if (!list.length) return;
  const ops: WorkspaceOp[] = [];
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    ops.push({ op: 'write_file', path: joinPath(dir, rel), base64: toB64(new Uint8Array(await f.arrayBuffer())) });
  }
  if (fileOps(ops, `Upload ${list.length} file(s)`)) toast('success', `Added ${list.length} file(s)`);
}

function uniquePath(want: string, exists: (p: string) => boolean) {
  if (!exists(want)) return want;
  const dot = want.lastIndexOf('.');
  const slash = want.lastIndexOf('/');
  const [stem, ext] = dot > slash + 1 ? [want.slice(0, dot), want.slice(dot)] : [want, ''];
  for (let i = 2; ; i++) if (!exists(`${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
}

type Editing = { kind: 'new-file' | 'new-folder' | 'new-graph'; dir: string } | { kind: 'rename'; path: string } | null;
interface Menu {
  x: number;
  y: number;
  node: TreeNode | null;
}

export function FileExplorer() {
  const ws = useEditor((s) => s.workspace)!;
  const project = useEditor((s) => s.project)!;
  const activeTab = useEditor((s) => s.activeTab);
  const lastGood = useCompile((s) => s.lastGood);
  const extras = useCompile((s) => s.extras);
  const compact = useCompact();
  const touch = useTouch();
  const tree = useMemo(() => buildTree(ws.files.keys()), [ws.files]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const box = useRef<HTMLDivElement>(null);

  // Reveal the active file.
  useEffect(() => {
    if (!activeTab || activeTab.startsWith(GEN_PREFIX)) return;
    const parts = activeTab.split('/').slice(0, -1);
    if (!parts.length) return;
    setExpanded((e) => {
      const n = new Set(e);
      parts.forEach((_, i) => n.add(parts.slice(0, i + 1).join('/')));
      return n.size === e.size ? e : n;
    });
  }, [activeTab]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const r = visibleRows(tree, expanded);
    // The inline "new …" input appears as the first row inside its folder.
    if (editing && editing.kind !== 'rename') {
      const at = editing.dir ? r.findIndex((x) => x.node.path === editing.dir) : -1;
      const depth = editing.dir ? (r[at]?.depth ?? 0) + 1 : 0;
      r.splice(at + 1, 0, { node: { name: '', path: `\0new`, dir: editing.kind === 'new-folder', children: [] }, depth });
    }
    return r;
  }, [tree, expanded, editing]);

  const exists = (p: string) => ws.files.has(p) || [...ws.files.keys()].some((k) => k.startsWith(`${p}/`));
  const toggle = (p: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const open = (n: TreeNode) => {
    if (n.dir) return toggle(n.path);
    useEditor.getState().openTab(n.path);
    if (compact) useUI.getState().set({ drawer: null });
  };

  const commitEdit = (value: string) => {
    try {
      commitEditUnsafe(value);
    } catch (err) {
      setEditing(null);
      toast('error', err instanceof Error ? err.message : String(err));
    }
  };
  const commitEditUnsafe = (value: string) => {
    const e = editing;
    setEditing(null);
    const name = value.trim().replace(/^\/+|\/+$/g, '');
    if (!e || !name) return;
    if (e.kind === 'rename') {
      const to = joinPath(dirname(e.path), name);
      if (to === e.path) return;
      if (e.path.endsWith(GRAPH_EXT) && !to.endsWith(GRAPH_EXT)) return void toast('error', `Visual scripts must keep the ${GRAPH_EXT} extension`);
      fileOps([{ op: 'move', from: e.path, to }], `Rename ${basename(e.path)}`);
      return;
    }
    const path = joinPath(e.dir, name);
    if (e.kind === 'new-folder') {
      if (fileOps([{ op: 'create_dir', path }], `New folder ${name}`)) setExpanded((x) => new Set([...x, ...path.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))]));
      return;
    }
    if (e.kind === 'new-graph') {
      const id = name.replace(/\.vgraph$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
      const scriptPath = joinPath(e.dir, id.toLowerCase());
      const tc = toolchainFor(project.language);
      const r = useEditor.getState().tryDispatch([{ op: 'add_script', ref: 's', name: id, path: scriptPath, template: tc.adapter.templates[0]?.id }], `New visual script ${id}`);
      if (r) useEditor.getState().setActive(r.created.s);
      return;
    }
    if (exists(path)) return void toast('error', `"${path}" already exists`);
    if (path.endsWith(GRAPH_EXT)) return void toast('info', 'Use "New visual script" to create a graph file.');
    // Visual-only: a new file is a note, or a settings file filled in with the visual editor.
    if (!isDirectlyWritable(path) && !formatFor(path) && !/\.css$/i.test(path)) return void toast('error', `Code can't be typed in Coding Studio. Make a visual script for program logic ("New visual script"); new files can be notes (.md, .txt), settings files (.json, .yaml, .toml, .xml) or stylesheets (.css), which open in visual editors.`);
    if (fileOps([{ op: 'write_file', path, content: '', expectedHash: null }], `New file ${name}`)) useEditor.getState().openTab(path);
  };

  const remove = async (n: TreeNode) => {
    const count = n.dir ? [...ws.files.keys()].filter((k) => k.startsWith(`${n.path}/`) && !k.endsWith('/.gitkeep')).length : 1;
    if (!(await confirmDialog({ title: `Delete ${n.dir ? 'folder' : 'file'}?`, message: n.dir ? `"${n.path}" and the ${count} file(s) in it will be deleted. A backup is made first, and Ctrl+Z undoes it.` : `"${n.path}" will be deleted. Ctrl+Z undoes it.`, confirm: 'Delete', danger: true }))) return;
    if (n.dir && count > 0) await createBackup(useEditor.getState().workspace!, `Before deleting ${n.path}/`);
    fileOps([{ op: 'delete', path: n.path, recursive: true }], `Delete ${n.name}`);
  };

  const duplicate = (n: TreeNode) => {
    if (n.path.endsWith(GRAPH_EXT)) {
      const stem = n.path.slice(0, -GRAPH_EXT.length);
      const to = uniquePath(`${stem}_copy${GRAPH_EXT}`, exists);
      return fileOps([{ op: 'copy', from: n.path, to }], `Duplicate ${n.name}`);
    }
    fileOps([{ op: 'copy', from: n.path, to: uniquePath(n.dir ? `${n.path} copy` : n.path, exists) }], `Duplicate ${n.name}`);
  };

  const moveInto = (from: string, dir: string) => {
    const to = joinPath(dir, basename(from));
    if (to === from || dir === from || dir.startsWith(`${from}/`)) return;
    if (fileOps([{ op: 'move', from, to }], `Move ${basename(from)}`) && dir) setExpanded((x) => new Set([...x, dir]));
  };

  const download = (n: TreeNode) => {
    const f = ws.files.get(n.path);
    if (f) downloadBytes(n.name, f.data ?? f.text ?? '', mimeType(n.path));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = rows.find((r) => r.node.path === focus)?.node;
    if (!n || editing) return;
    if (e.key === 'F2' && n.path !== CONFIG_PATH) setEditing({ kind: 'rename', path: n.path });
    else if (e.key === 'Delete' && n.path !== CONFIG_PATH) void remove(n);
    else if (e.key === 'Enter') open(n);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = rows.findIndex((r) => r.node.path === focus) + (e.key === 'ArrowDown' ? 1 : -1);
      if (rows[i]) setFocus(rows[i].node.path);
    } else if (e.key === 'ArrowRight' && n.dir && !expanded.has(n.path)) toggle(n.path);
    else if (e.key === 'ArrowLeft' && n.dir && expanded.has(n.path)) toggle(n.path);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const first = Math.max(0, Math.floor(scroll / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 10);
  const gen = useMemo(() => generatedFiles({ lastGood, extras }).map(([, f]) => f), [lastGood, extras]);
  const targetDir = (n: TreeNode | null) => (n ? (n.dir ? n.path : dirname(n.path)) : '');

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]" data-testid="file-explorer">
      <div className="flex shrink-0 items-center gap-0.5 px-2 py-1">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Files</span>
        <IconButton label="New file" className="h-6 min-w-6" onClick={() => setEditing({ kind: 'new-file', dir: '' })} data-testid="new-file">
          <FilePlus size={14} />
        </IconButton>
        <IconButton label="New folder" className="h-6 min-w-6" onClick={() => setEditing({ kind: 'new-folder', dir: '' })} data-testid="new-folder">
          <FolderPlus size={14} />
        </IconButton>
        <IconButton label="New visual script" className="h-6 min-w-6" onClick={() => setEditing({ kind: 'new-graph', dir: '' })} data-testid="new-graph">
          <Workflow size={14} />
        </IconButton>
        <label className="inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-panel-2 hover:text-text" title="Upload files" aria-label="Upload files">
          <Upload size={14} />
          <input type="file" multiple className="hidden" data-testid="upload-files" onChange={(e) => void uploadInto('', e.target.files ?? []).then(() => (e.target.value = ''))} />
        </label>
      </div>
      <div
        ref={box}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        className={cx('relative min-h-0 flex-1 overflow-auto outline-none', dropTarget === '' && 'bg-accent/10')}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(FILE_MIME) || e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            if (e.target === e.currentTarget) setDropTarget('');
          }
        }}
        onDragLeave={(e) => e.target === e.currentTarget && setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          const dir = dropTarget ?? '';
          setDropTarget(null);
          const from = e.dataTransfer.getData(FILE_MIME);
          if (from) moveInto(from, dir);
          else if (e.dataTransfer.files.length) void uploadInto(dir, e.dataTransfer.files);
        }}
      >
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map(({ node: n, depth }, i) => {
            const top = (first + i) * ROW;
            const pad = 8 + depth * 14;
            if (n.path === '\0new' && editing && editing.kind !== 'rename')
              return (
                <div key="new" className="absolute left-0 right-0 flex items-center gap-1.5" style={{ top, height: ROW, paddingLeft: pad + 14 }}>
                  {editing.kind === 'new-folder' ? <Folder size={13} className="text-amber-200" /> : editing.kind === 'new-graph' ? <Workflow size={13} className="text-sky-300" /> : <File size={13} className="text-muted" />}
                  <NameInput placeholder={editing.kind === 'new-folder' ? 'folder name' : editing.kind === 'new-graph' ? 'ScriptName' : 'file name (e.g. src/app.ts)'} onDone={commitEdit} />
                </div>
              );
            const isActive = activeTab === n.path;
            const isOpen = n.dir && expanded.has(n.path);
            const renaming = editing?.kind === 'rename' && editing.path === n.path;
            const script = n.path.endsWith(GRAPH_EXT) ? project.scripts.find((s) => `${s.path}${GRAPH_EXT}` === n.path) : undefined;
            return (
              <div
                key={n.path}
                className={cx('group absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 pr-1', isActive ? 'bg-accent/20' : 'hover:bg-panel-2', focus === n.path && 'ring-1 ring-inset ring-accent/50', dropTarget === n.path && 'bg-accent/25')}
                style={{ top, height: ROW, paddingLeft: pad }}
                data-testid="file-row"
                data-path={n.path}
                data-dir={n.dir ? '1' : undefined}
                draggable={!renaming && n.path !== CONFIG_PATH}
                onDragStart={(e) => {
                  e.dataTransfer.setData(FILE_MIME, n.path);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(FILE_MIME) && !e.dataTransfer.types.includes('Files')) return;
                  e.preventDefault();
                  setDropTarget(targetDir(n));
                }}
                onClick={() => {
                  setFocus(n.path);
                  box.current?.focus();
                  if (!renaming) open(n);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFocus(n.path);
                  setMenu({ x: e.clientX, y: e.clientY, node: n });
                }}
              >
                {n.dir ? isOpen ? <ChevronDown size={12} className="shrink-0 text-muted" /> : <ChevronRight size={12} className="shrink-0 text-muted" /> : <span className="w-3 shrink-0" />}
                {n.dir ? isOpen ? <FolderOpen size={13} className="shrink-0 text-amber-200" /> : <Folder size={13} className="shrink-0 text-amber-200" /> : iconFor(n.path)}
                {renaming ? (
                  <NameInput initial={n.name} onDone={commitEdit} />
                ) : (
                  <>
                    <span className="truncate">{n.name}</span>
                    {script && <span className="truncate text-[10.5px] text-muted">{script.name}</span>}
                  </>
                )}
                <button
                  className={cx('ml-auto rounded p-0.5 text-muted hover:text-text', touch ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
                  aria-label={`Actions for ${n.name}`}
                  data-testid="file-row-menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom, node: n });
                  }}
                >
                  <MoreHorizontal size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {gen.length > 0 && (
        <div className="max-h-[30%] shrink-0 overflow-auto border-t border-border py-1">
          <div className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted" title="Compiled from your visual scripts. Read-only: edit the graph instead.">
            Generated (read-only)
          </div>
          {gen.map((f) => (
            <div
              key={f.path}
              className={cx('mx-1 flex cursor-pointer items-center gap-1.5 rounded px-2 py-[3px]', activeTab === GEN_PREFIX + f.path ? 'bg-accent/20' : 'hover:bg-panel-2')}
              onClick={() => {
                useEditor.getState().openTab(GEN_PREFIX + f.path);
                if (compact) useUI.getState().set({ drawer: null });
              }}
              data-testid="generated-row"
            >
              {iconFor(f.path)}
              <span className="truncate text-muted">{f.path}</span>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New file', run: () => (setEditing({ kind: 'new-file', dir: targetDir(menu.node) }), menu.node?.dir && setExpanded((x) => new Set([...x, menu.node!.path]))) },
            { label: 'New folder', run: () => (setEditing({ kind: 'new-folder', dir: targetDir(menu.node) }), menu.node?.dir && setExpanded((x) => new Set([...x, menu.node!.path]))) },
            { label: 'New visual script', run: () => setEditing({ kind: 'new-graph', dir: targetDir(menu.node) }) },
            ...(menu.node && menu.node.path !== CONFIG_PATH
              ? [
                  { label: 'Rename', run: () => setEditing({ kind: 'rename', path: menu.node!.path }), testId: 'menu-rename' },
                  { label: 'Duplicate', run: () => duplicate(menu.node!) },
                  ...(menu.node.dir ? [] : [{ label: 'Download', run: () => download(menu.node!) }]),
                  { label: 'Copy path', run: () => void navigator.clipboard?.writeText(menu.node!.path) },
                  { label: 'Delete', run: () => void remove(menu.node!), danger: true, testId: 'menu-delete' },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function NameInput({ initial = '', placeholder, onDone }: { initial?: string; placeholder?: string; onDone: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      data-testid="file-name-input"
      className="min-w-0 flex-1 rounded border border-accent bg-[#0f1218] px-1 text-[12px] focus:outline-none"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish(initial);
      }}
      onBlur={(e) => finish(e.currentTarget.value === '' ? '' : e.currentTarget.value)}
    />
  );
}

export function ContextMenu({ menu, items, onClose }: { menu: { x: number; y: number }; items: { label: string; run: () => unknown; danger?: boolean; testId?: string }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', off, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const x = Math.min(menu.x, window.innerWidth - 190);
  const y = Math.min(menu.y, window.innerHeight - items.length * 28 - 12);
  return (
    <div ref={ref} className="fixed z-50 min-w-[170px] rounded-md border border-border bg-panel-2 py-1 shadow-xl" style={{ left: x, top: y }} role="menu" data-testid="file-menu">
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          data-testid={it.testId}
          className={cx('block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-accent/20', it.danger && 'text-red-300')}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
