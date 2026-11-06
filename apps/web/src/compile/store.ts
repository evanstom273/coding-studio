/**
 * Live compilation. The project is compiled in a Web Worker 250 ms after the last change, so the
 * editor stays responsive with large graphs. The last successful output per script is kept so the
 * code view doesn't go blank while the user is mid-edit.
 */
import { create } from 'zustand';
import type { Diagnostic } from '@cs/graph-core';
import type { GeneratedFile } from '@cs/language-sdk';
import { compileProject, type ProjectCompileResult } from '@cs/compiler-core';
import { toolchainFor } from '@cs/toolchain';
import type { Project } from '@cs/project-format';
import { useEditor } from '@web/store/editor';
import type { CompileRequest, CompileResponse } from './worker';

interface CompileState {
  result: ProjectCompileResult | null;
  diagnostics: Diagnostic[];
  /** scriptId → last good file (may be stale). */
  lastGood: Record<string, GeneratedFile>;
  stale: Record<string, boolean>;
  running: boolean;
  ms: number;
  error?: string;
}

export const useCompile = create<CompileState>()(() => ({ result: null, diagnostics: [], lastGood: {}, stale: {}, running: false, ms: 0 }));

let worker: Worker | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastProjectId: string | null = null;

function apply(project: Project, r: ProjectCompileResult, ms: number) {
  const prev = lastProjectId === project.id ? useCompile.getState().lastGood : {};
  lastProjectId = project.id;
  const lastGood: Record<string, GeneratedFile> = {};
  const stale: Record<string, boolean> = {};
  for (const s of r.scripts) {
    if (s.ok && s.files[0]) lastGood[s.scriptId] = s.files[0];
    else if (prev[s.scriptId]) {
      lastGood[s.scriptId] = prev[s.scriptId];
      stale[s.scriptId] = true;
    }
  }
  useCompile.setState({ result: r, diagnostics: r.diagnostics, lastGood, stale, running: false, ms, error: undefined });
}

function ensureWorker(): Worker | null {
  if (worker || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<CompileResponse>) => {
      if (ev.data.seq !== seq) return; // a newer request is in flight
      const p = useEditor.getState().project;
      if (!p) return;
      if (ev.data.result) apply(p, ev.data.result, ev.data.ms);
      else useCompile.setState({ running: false, error: ev.data.error });
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Compile synchronously (used by export and MCP, which need a guaranteed-fresh result). */
export function compileNow(project: Project): ProjectCompileResult {
  const t0 = performance.now();
  const r = compileProject(toolchainFor(project.language), project);
  apply(project, r, performance.now() - t0);
  return r;
}

export function scheduleCompile(project: Project, delay = 250) {
  if (timer) clearTimeout(timer);
  useCompile.setState({ running: true });
  timer = setTimeout(() => {
    timer = null;
    const w = ensureWorker();
    seq++;
    if (w) w.postMessage({ seq, project } satisfies CompileRequest);
    else compileNow(project);
  }, delay);
}

/** Wire the compile loop to the editor store (call once). */
export function startCompileLoop() {
  let lastVersion = -1;
  return useEditor.subscribe((s) => {
    if (!s.project) return;
    if (s.version === lastVersion) return;
    lastVersion = s.version;
    scheduleCompile(s.project);
  });
}
