/** State of each declared dependency's types (kept apart so panels don't load Monaco). */
import { create } from 'zustand';

export interface DepState {
  name: string;
  range: string;
  dev: boolean;
  state: 'loading' | 'types' | 'no-types' | 'error';
  version?: string;
  source?: 'bundled' | 'definitelytyped' | 'none';
  typesPackage?: string;
  files?: number;
  message?: string;
}

export const useDeps = create<{ deps: DepState[] }>()(() => ({ deps: [] }));
