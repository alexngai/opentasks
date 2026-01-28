/**
 * Test Flag Utilities
 *
 * Environment flags for gating slow/integration tests.
 */

/**
 * Whether slow integration tests should run.
 * Set RUN_SLOW_TESTS=1 to enable.
 */
export const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'

/**
 * Whether full agent E2E tests should run.
 * Set RUN_FULL_AGENT_TESTS=1 to enable.
 * Implies SLOW_TESTS.
 */
export const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'

/**
 * Skip message for slow tests
 */
export const SLOW_SKIP_MESSAGE = 'Skipping: RUN_SLOW_TESTS not set'

/**
 * Skip message for agent tests
 */
export const AGENT_SKIP_MESSAGE = 'Skipping: RUN_FULL_AGENT_TESTS not set'
