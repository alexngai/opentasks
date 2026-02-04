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

// Re-export provider types for E2E tests
export type {
  Provider,
  ProviderRegistry,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
} from '../../../src/providers/types.js'

// Re-export graph types for E2E tests
export type { GraphologyAdapter } from '../../../src/graph/GraphologyAdapter.js'
export type { HydratingFederatedGraph, CacheConfig } from '../../../src/graph/HydratingFederatedGraph.js'
export type { MaterializationManager } from '../../../src/providers/materialization.js'

// Test agent
export type {
  TestAgentOptions,
  ExtendedLinkParams,
  QuickCreateSpecParams,
  QuickCreateIssueParams,
  CreateSpecOptions,
  CreateIssueOptions,
  TestAgent,
  MultiAgentContext,
} from './test-agent.js'

export {
  createTestAgent,
  createMultiAgents,
} from './test-agent.js'

// Assertions
export type {
  ExpectFeedbackOptions,
} from './assertions.js'

export {
  expectReady,
  expectNotReady,
  expectBlocks,
  expectBlockers,
  expectFeedback,
  expectStatus,
  expectTitle,
} from './assertions.js'

// Fixtures
export type {
  DiamondDependency,
  SpecWithIssues,
} from './fixtures.js'

export {
  resetFixtureCounter,
  createTestSpec,
  createTestIssue,
  createBlockingChain,
  createDiamondDependency,
  createSpecWithIssues,
  createBlockedIssue,
} from './fixtures.js'

// Re-export integration helpers that are useful for E2E tests
export {
  sleep,
  waitFor,
  retry,
  type WaitOptions,
} from '../../integration/helpers/index.js'

// Beads helpers for provider sync tests
export type {
  CreateBeadsTaskOptions,
  UpdateBeadsTaskOptions,
  BeadsTask,
  BeadsWorkspaceContext,
} from './beads-helpers.js'

export {
  isBdAvailable,
  getBdExecutable,
  resetBdAvailableCache,
  BD_SKIP_MESSAGE,
  createBeadsWorkspace,
  createBeadsTask,
  getBeadsTask,
  updateBeadsStatus,
  updateBeadsTask,
  deleteBeadsTask,
  linkBeadsTasks,
  listBeadsTasks,
} from './beads-helpers.js'
