import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    // E2E tests require full system setup and may take longer
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 300000, // 5 minutes for setup/teardown
    // Run tests sequentially - E2E tests share system state
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Reduce concurrency for E2E
    maxConcurrency: 1,
  },
})
