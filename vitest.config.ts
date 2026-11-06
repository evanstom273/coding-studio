import { defineConfig } from 'vitest/config';
import { aliases } from "./aliases.ts";

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
