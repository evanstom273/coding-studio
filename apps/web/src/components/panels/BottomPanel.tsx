import { lazy, useMemo, Suspense } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Code2, Info, Bot, XCircle } from 'lucide-react';
import type { Diagnostic } from '@cs/graph-core';
import { projectRevision } from '@cs/project-format';
import { useCompile } from '@web/compile/store';
import { useBridge } from '@web/bridge/client';
import { useEditor } from '@web/store/editor';
import { useUI, type BottomTab } from '@web/store/ui';
import { cx } from '../ui/primitives';

import { useTsCheck } from '@web/lib/tsCheckStore';

const CodeView = lazy(() => import('./CodeView'));

function DiagnosticList({ severity }: { severity: 'error' | 'warning' }) {
  const project = useEditor((s) => s.project)!;
  const compiled = useCompile((s) => s.diagnostics);
  const tsNodes = useTsCheck((s) => s.nodes);
  const tsFiles = useTsCheck((s) => s.files);
  const diagnostics = useMemo(() => [...compiled, ...tsNodes], [compiled, tsNodes]);
  const list = diagnostics.filter((d) => (severity === 'error' ? d.severity === 'error' : d.severity !== 'error'));
  const files = tsFiles.filter((d) => d.severity === severity);
  const where = (d: Diagnostic) => {
    const s = project.scripts.find((x) => x.id === d.scriptId);
    const f = s?.functions.find((x) => x.id === d.functionId);
    return [s?.name, f?.name].filter(Boolean).join(' › ');
  };
  if (!list.length && !files.length) return <div className="p-3 text-muted">{severity === 'error' ? 'No errors. The generated code is up to date.' : 'No warnings.'}</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid={`diagnostics-${severity}`}>
      {list.map((d, i) => (
        <button
          key={i}
          data-testid="diagnostic"
          className="flex w-full items-start gap-2 border-b border-border/40 px-3 py-1.5 text-left hover:bg-panel-2"
          onClick={() => {
            if (d.functionId && d.nodeId) useEditor.getState().focusNode(d.functionId, d.nodeId, d.scriptId);
            else if (d.functionId) useEditor.getState().setActive(d.scriptId, d.functionId);
            else if (d.scriptId) {
              useEditor.getState().setActive(d.scriptId);
              useUI.getState().set({ inspect: { kind: 'script', id: d.scriptId } });
            }
          }}
        >
          {d.severity === 'error' ? <XCircle size={14} className="mt-0.5 shrink-0 text-err" /> : d.severity === 'warning' ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> : <Info size={14} className="mt-0.5 shrink-0 text-muted" />}
          <span className="min-w-0 flex-1">
            <span className="text-[12px]">{d.message}</span>
            {d.suggestion && <span className="block text-[11px] text-muted">→ {d.suggestion}</span>}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted">{d.code}</span>
          <span className="w-40 shrink-0 truncate text-right text-[11px] text-muted">{where(d)}</span>
        </button>
      ))}
      {files.map((d, i) => (
        <button key={`f${i}`} data-testid="file-diagnostic" className="flex w-full items-start gap-2 border-b border-border/40 px-3 py-1.5 text-left hover:bg-panel-2" onClick={() => useEditor.getState().openTab(d.path, { line: d.line })}>
          {d.severity === 'error' ? <XCircle size={14} className="mt-0.5 shrink-0 text-err" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />}
          <span className="min-w-0 flex-1 text-[12px]">{d.message}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted">{d.code}</span>
          <span className="w-40 shrink-0 truncate text-right font-mono text-[11px] text-muted">
            {d.path}:{d.line}
          </span>
        </button>
      ))}
    </div>
  );
}

function McpActivity() {
  const { log, statusText, clearLog } = useBridge();
  const history = useEditor((s) => s.history.past.filter((h) => h.source === 'mcp').length);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1 text-[11.5px] text-muted">
        <span>{statusText}</span>
        <span>{history} undoable Claude edit(s)</span>
        <button className="ml-auto text-accent hover:underline" onClick={clearLog}>
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px]" data-testid="mcp-log">
        {log.length === 0 && <div className="p-3 font-sans text-muted">No MCP activity yet.</div>}
        {log.map((l, i) => (
          <div key={i} className="flex gap-3 border-b border-border/30 px-3 py-0.5">
            <span className="text-muted">{new Date(l.at).toLocaleTimeString()}</span>
            <span className={l.ok ? 'text-emerald-300' : 'text-red-300'}>{l.method}</span>
            <span className="min-w-0 flex-1 truncate text-[#c3c9d4]" title={l.text}>
              {l.text}
            </span>
            <span className="text-muted">{Math.round(l.ms)} ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectInfo() {
  const project = useEditor((s) => s.project)!;
  const { ms, result } = useCompile();
  const nodes = project.scripts.reduce((a, s) => a + s.functions.reduce((b, f) => b + f.graph.nodes.length, 0), 0);
  const edges = project.scripts.reduce((a, s) => a + s.functions.reduce((b, f) => b + f.graph.edges.length, 0), 0);
  const rows: [string, string][] = [
    ['Project', project.name],
    ['Id', project.id],
    ['Language', `${project.language} (target ${project.languageVersion})`],
    ['Scripts', String(project.scripts.length)],
    ['Functions / events', String(project.scripts.reduce((a, s) => a + s.functions.length, 0))],
    ['Nodes / connections', `${nodes} / ${edges}`],
    ['Revision', projectRevision(project)],
    ['Last compile', `${Math.round(ms)} ms, ${result?.files.length ?? 0} file(s)`],
    ['Created', new Date(project.createdAt).toLocaleString()],
    ['Saved in', 'this browser (IndexedDB)'],
  ];
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <table className="text-[12px]" data-testid="project-info">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="pr-6 text-muted">{k}</td>
              <td className="font-mono text-[11.5px]">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BottomPanel() {
  const { bottomTab, bottomOpen, set } = useUI();
  const diagnostics = useCompile((s) => s.diagnostics);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const tabs: [BottomTab, string, React.ReactNode, number?][] = [
    ['code', 'Generated Code', <Code2 key="c" size={13} />],
    ['errors', 'Errors', <XCircle key="e" size={13} />, errors],
    ['warnings', 'Warnings', <AlertTriangle key="w" size={13} />, warnings],
    ['mcp', 'MCP Activity', <Bot key="m" size={13} />],
    ['info', 'Project', <Info key="i" size={13} />],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center overflow-x-auto border-b border-border [scrollbar-width:none]" role="tablist">
        {tabs.map(([id, label, icon, count]) => (
          <button key={id} role="tab" aria-selected={bottomTab === id && bottomOpen} data-testid={`bottom-tab-${id}`} onClick={() => set({ bottomTab: id, bottomOpen: true })} className={cx('flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-[12px]', bottomTab === id && bottomOpen ? 'border-b-2 border-accent text-text' : 'text-muted hover:text-text')}>
            {icon} {label}
            {!!count && <span className={cx('rounded px-1 text-[10.5px]', id === 'errors' ? 'bg-red-500/20 text-red-300' : 'bg-amber-400/15 text-amber-200')}>{count}</span>}
          </button>
        ))}
        <button className="ml-auto px-2 text-muted hover:text-text" aria-label={bottomOpen ? 'Collapse panel' : 'Expand panel'} onClick={() => set({ bottomOpen: !bottomOpen })}>
          {bottomOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      {bottomOpen && (
        <div className="flex min-h-0 flex-1 flex-col">
          {bottomTab === 'code' && (
            <Suspense fallback={<div className="p-3 text-muted">Loading code view…</div>}>
              <CodeView />
            </Suspense>
          )}
          {bottomTab === 'errors' && <DiagnosticList severity="error" />}
          {bottomTab === 'warnings' && <DiagnosticList severity="warning" />}
          {bottomTab === 'mcp' && <McpActivity />}
          {bottomTab === 'info' && <ProjectInfo />}
        </div>
      )}
    </div>
  );
}
