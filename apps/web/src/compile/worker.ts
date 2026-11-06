/// <reference lib="webworker" />
import { compileProject, type ProjectCompileResult } from '@cs/compiler-core';
import { toolchainFor } from '@cs/toolchain';
import type { Project } from '@cs/project-format';

export interface CompileRequest {
  seq: number;
  project: Project;
}
export interface CompileResponse {
  seq: number;
  result?: ProjectCompileResult;
  error?: string;
  ms: number;
}

self.onmessage = (ev: MessageEvent<CompileRequest>) => {
  const t0 = performance.now();
  try {
    const p = ev.data.project;
    const result = compileProject(toolchainFor(p.language), p);
    (self as unknown as Worker).postMessage({ seq: ev.data.seq, result, ms: performance.now() - t0 } satisfies CompileResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ seq: ev.data.seq, error: e instanceof Error ? e.message : String(e), ms: performance.now() - t0 } satisfies CompileResponse);
  }
};
