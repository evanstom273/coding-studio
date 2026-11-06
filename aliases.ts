import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Workspace package aliases shared by Vite, Vitest and esbuild (kept in sync with tsconfig paths). */
export const aliases: Record<string, string> = {
  '@cs/node-registry/core-nodes': r('./packages/node-registry/src/core-nodes.ts'),
  '@cs/type-system': r('./packages/type-system/src/index.ts'),
  '@cs/graph-core': r('./packages/graph-core/src/index.ts'),
  '@cs/intermediate-representation': r('./packages/intermediate-representation/src/index.ts'),
  '@cs/node-registry': r('./packages/node-registry/src/index.ts'),
  '@cs/language-sdk': r('./packages/language-sdk/src/index.ts'),
  '@cs/compiler-core': r('./packages/compiler-core/src/index.ts'),
  '@cs/language-gdscript': r('./packages/language-gdscript/src/index.ts'),
  '@cs/toolchain': r('./packages/toolchain/src/index.ts'),
  '@cs/project-format': r('./packages/project-format/src/index.ts'),
  '@cs/shared-protocol': r('./packages/shared-protocol/src/index.ts'),
  '@cs/examples': r('./packages/examples/src/index.ts'),
  '@cs/project-service': r('./packages/project-service/src/index.ts'),
  '@cs/workspace': r('./packages/workspace/src/index.ts'),
  '@cs/git': r('./packages/git/src/index.ts'),
  '@web': r('./apps/web/src'),
};
