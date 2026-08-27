import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/gates/**/*.test.ts'],
    // Gates spawn the compiled server; give slow CI machines room.
    testTimeout: 20000,
  },
});
