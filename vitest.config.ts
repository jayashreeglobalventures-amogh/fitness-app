import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Starting/stopping an embedded PostgreSQL per test file can exceed the 10 s default on a busy runner.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
