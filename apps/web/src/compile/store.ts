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
  /** scriptId → further files from the last good build (entry launcher, Godot scene…). */
  extras: Record<string, GeneratedFile[]>;
  stale: Record<string, boolean>;
  running: boolean;
  ms: number;
  error?: string;
}

export const useCompile = create<CompileState>()(() => ({ result: null, diagnostics: [], lastGood: {}, extras: {}, stale: {}, running: false, ms: 0 }));

/** Every generated file: [scriptId, file] pairs, main files first. */
export function generatedFiles(s: Pick<CompileState, 'lastGood' | 'extras'> = useCompile.getState()): [string, GeneratedFile][] {
  return [...Object.entries(s.lastGood), ...Object.entries(s.extras).flatMap(([id, fs]) => fs.map((f) => [id, f] as [string, GeneratedFile]))];
}

let worker: Worker | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastProjectId: string | null = null;

function apply(project: Project, r: ProjectCompileResult, ms: number) {
  const prev = lastProjectId === project.id ? useCompile.getState().lastGood : {};
  const prevExtras = lastProjectId === project.id ? useCompile.getState().extras : {};
  const extras: Record<string, GeneratedFile[]> = {};
  lastProjectId = project.id;
  const lastGood: Record<string, GeneratedFile> = {};
  const stale: Record<string, boolean> = {};
  for (const s of r.scripts) {
    if (s.ok && s.files[0]) {
      lastGood[s.scriptId] = s.files[0];
      if (s.files.length > 1) extras[s.scriptId] = s.files.slice(1);
    } else if (prevExtras[s.scriptId] && !s.ok) extras[s.scriptId] = prevExtras[s.scriptId];
    else if (prev[s.scriptId]) {
      lastGood[s.scriptId] = prev[s.scriptId];
      stale[s.scriptId] = true;
    }
  }
  useCompile.setState({ result: r, diagnostics: r.diagnostics, lastGood, extras, stale, running: false, ms, error: undefined });
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
