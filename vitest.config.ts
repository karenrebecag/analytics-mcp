import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Gates run against the compiled build via `pnpm gates`, never in the unit pass.
    exclude: ['tests/gates/**', 'node_modules/**'],
  },
});
