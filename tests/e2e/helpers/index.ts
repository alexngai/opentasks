/**
 * E2E Test Helpers
 *
 * Shared utilities for end-to-end tests.
 */

// Test flags
export {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  SLOW_TESTS,
} from './system-setup.js'

// System setup
export type {
  StorageType,
  E2ESystemOptions,
  E2ESystemContext,
  MultiE2ESystemContext,
} from './system-setup.js'

export {
  setupE2ESystem,
  withE2ESystem,
  setupMultiE2ESystems,
} from './system-setup.js'

// Re-export GraphStore for direct access
export type { GraphStore } from '../../../src/graph/store.js'

// Test agent
export type {
  TestAgentOptions,
  ExtendedLinkParams,
  QuickCreateSpecParams,
  QuickCreateIssueParams,
  TestAgent,
  MultiAgentContext,
} from './test-agent.js'

export {
  createTestAgent,
  createMultiAgents,
} from './test-agent.js'

// Re-export integration helpers that are useful for E2E tests
export {
  sleep,
  waitFor,
  retry,
  type WaitOptions,
} from '../../integration/helpers/index.js'
