/** Node catalogs built from each dependency's types (see apiCatalog.ts). */
import { create } from 'zustand';
import type { JsonValue } from '@cs/graph-core';

export interface CatalogEntry {
  /** Palette title, e.g. "format()", "new Dexie", "Dexie.table()". */
  title: string;
  /** Palette category, e.g. "Library/date-fns", "Library/dexie/Dexie". */
  category: string;
  description: string;
  type: 'ts.call' | 'ts.call_method' | 'ts.new' | 'ts.get_field';
  props: Record<string, JsonValue>;
}

export const useCatalog = create<{ byPackage: Record<string, CatalogEntry[]> }>()(() => ({ byPackage: {} }));
