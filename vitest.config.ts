import { defineConfig } from 'vitest/config'

// Include integration tests when RUN_SLOW_TESTS is set
const slowTests = process.env.RUN_SLOW_TESTS === '1'
const agentTests = process.env.RUN_FULL_AGENT_TESTS === '1'

const include = ['src/**/*.test.ts']

if (slowTests || agentTests) {
  include.push('tests/integration/**/*.test.ts')
}

if (agentTests) {
  include.push('tests/e2e/**/*.test.ts')
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include,
    watch: false,
    // Increase timeouts when running slow/e2e tests
    testTimeout: slowTests || agentTests ? 30000 : 5000,
    hookTimeout: slowTests || agentTests ? 60000 : 10000,
  },
})
