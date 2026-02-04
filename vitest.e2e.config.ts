/**
 * Vitest Configuration for E2E Tests
 *
 * E2E tests run with RUN_FULL_AGENT_TESTS=1 flag.
 * They test complete agent workflows with a real daemon, storage, and IPC.
 *
 * Run with: npm run test:e2e
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    // E2E test files use .e2e.test.ts naming convention
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // E2E tests require full system setup and may take longer
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 300000, // 5 minutes for setup/teardown
    // Run tests sequentially - E2E tests share system resources (Vitest 4 syntax)
    isolate: false,
    fileParallelism: false,
    // Reduce concurrency for E2E
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
    },
    // Fail fast - E2E tests are expensive
    bail: 1,
    // Verbose reporter for E2E
    reporters: ["verbose"],
  },
});
