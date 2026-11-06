/** Results of the TypeScript check (kept apart from tsProject.ts so panels don't load Monaco). */
import { create } from 'zustand';
import type { Diagnostic } from '@cs/graph-core';

export interface FileProblem {
  path: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
  code: string;
}

interface TsCheckState {
  /** Problems in hand-written files. */
  files: FileProblem[];
  /** Problems in generated code, mapped to graph nodes. */
  nodes: Diagnostic[];
  checking: boolean;
}

export const useTsCheck = create<TsCheckState>()(() => ({ files: [], nodes: [], checking: false }));

