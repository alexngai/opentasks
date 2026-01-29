/**
 * Materialization Strategies E2E Tests
 *
 * Tests different materialization behaviors to ensure external nodes can be
 * cached according to different strategies (on-demand, lazy, eager, none).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createBeadsTask,
  createBeadsWorkspace,
  isBdAvailable,
  type E2ESystemContext,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'
import {
  createMaterializationManager,
  type MaterializationManager,
} from '../../../../src/providers/materialization.js'

describe.skipIf(!AGENT_TESTS)('Materialization Strategies', () => {
  let system: E2ESystemContext
  let beadsAvailable: boolean
  let sharedWorkspace: BeadsWorkspaceContext | null = null

  // Create Beads workspace once for all tests in this describe block
  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-materialization-beads-'))
      sharedWorkspace = await createBeadsWorkspace(workspaceDir, 'bd')
    }
  })

  afterAll(async () => {
    // Clean up shared workspace after all tests
    if (sharedWorkspace) {
      await sharedWorkspace.cleanup()
    }
  })

  beforeEach(async () => {
    system = await setupE2ESystem({
      testName: 'materialization',
      enableBeads: true,
      cacheTTL: 60000,
      beadsWorkspacePath: sharedWorkspace?.path, // Reuse shared workspace
    })
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Lazy Strategy (Default)', () => {
    it('should materialize node on first resolve access', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create a Beads task
      const task = await createBeadsTask(system.beadsWorkspace!, 'Lazy Test Task')

      // Create manager with lazy strategy
      const manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 60000,
      })

      // Check if should materialize for resolve access
      const shouldMaterialize = manager.shouldMaterialize(task.uri, {
        accessType: 'resolve',
      })

      expect(shouldMaterialize).toBe(true)

      // Lazy should NOT materialize for edge-create access without explicit flag
      const shouldMaterializeOnEdge = manager.shouldMaterialize(task.uri, {
        accessType: 'edge-create',
      })

      expect(shouldMaterializeOnEdge).toBe(false)
    })

    it('should materialize when explicit flag is set', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(system.beadsWorkspace!, 'Explicit Materialize')

      const manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 60000,
      })

      // Should materialize when explicit flag is set, regardless of access type
      const shouldMaterialize = manager.shouldMaterialize(task.uri, {
        accessType: 'query',
        explicit: true,
      })

      expect(shouldMaterialize).toBe(true)
    })
  })

  describe('On-Demand Strategy', () => {
    it('should only materialize with explicit request', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(system.beadsWorkspace!, 'On-Demand Task')

      const manager = createMaterializationManager({
        default: 'on-demand',
        staleAfter: 60000,
      })

      // Should NOT materialize on resolve access without explicit flag
      const shouldOnResolve = manager.shouldMaterialize(task.uri, {
        accessType: 'resolve',
      })
      expect(shouldOnResolve).toBe(false)

      // Should NOT materialize on query access
      const shouldOnQuery = manager.shouldMaterialize(task.uri, {
        accessType: 'query',
      })
      expect(shouldOnQuery).toBe(false)

      // Should ONLY materialize with explicit flag
      const shouldExplicit = manager.shouldMaterialize(task.uri, {
        accessType: 'query',
        explicit: true,
      })
      expect(shouldExplicit).toBe(true)
    })
  })

  describe('Eager Strategy', () => {
    it('should always materialize regardless of access type', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(system.beadsWorkspace!, 'Eager Task')

      const manager = createMaterializationManager({
        default: 'eager',
        staleAfter: 60000,
      })

      // Should materialize on all access types
      const shouldOnResolve = manager.shouldMaterialize(task.uri, { accessType: 'resolve' })
      const shouldOnEdge = manager.shouldMaterialize(task.uri, { accessType: 'edge-create' })
      const shouldOnQuery = manager.shouldMaterialize(task.uri, { accessType: 'query' })

      expect(shouldOnResolve).toBe(true)
      expect(shouldOnEdge).toBe(true)
      expect(shouldOnQuery).toBe(true)
    })
  })

  describe('None Strategy', () => {
    it('should never materialize even with explicit flag', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(system.beadsWorkspace!, 'Never Materialize')

      const manager = createMaterializationManager({
        default: 'none',
        staleAfter: 60000,
      })

      // Should NEVER materialize
      const shouldOnResolve = manager.shouldMaterialize(task.uri, { accessType: 'resolve' })
      const shouldExplicit = manager.shouldMaterialize(task.uri, {
        accessType: 'resolve',
        explicit: true,
      })

      expect(shouldOnResolve).toBe(false)
      expect(shouldExplicit).toBe(false)
    })
  })

  describe('Per-Provider Strategy Override', () => {
    it('should use provider-specific strategy when configured', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(system.beadsWorkspace!, 'Provider Override')

      // Default is on-demand, but beads is eager
      const manager = createMaterializationManager({
        default: 'on-demand',
        providers: {
          beads: 'eager',
        },
        staleAfter: 60000,
      })

      // For beads URI, should use eager strategy
      const strategy = manager.getStrategyFor(task.uri)
      expect(strategy).toBe('eager')

      const shouldMaterialize = manager.shouldMaterialize(task.uri, {
        accessType: 'edge-create',
      })
      expect(shouldMaterialize).toBe(true)

      // For native URI, should use default on-demand strategy
      const nativeStrategy = manager.getStrategyFor('native://i-test123')
      expect(nativeStrategy).toBe('on-demand')

      const nativeShouldMaterialize = manager.shouldMaterialize('native://i-test123', {
        accessType: 'edge-create',
      })
      expect(nativeShouldMaterialize).toBe(false)
    })
  })

  describe('Staleness Detection', () => {
    it('should detect stale nodes based on TTL', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create manager with very short TTL for testing
      const shortTTL = 100 // 100ms
      const manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: shortTTL,
      })

      // Create a mock external node with cached_at just now
      const freshNode = {
        id: 'external-test1',
        uuid: 'test-uuid-1',
        type: 'external' as const,
        uri: 'beads://./bd-test',
        source: 'beads',
        title: 'Test Node',
        cached_at: new Date().toISOString(),
        materialized: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Should not be stale immediately
      expect(manager.isStale(freshNode)).toBe(false)

      // Create a node with old cached_at
      const staleNode = {
        ...freshNode,
        id: 'external-test2',
        cached_at: new Date(Date.now() - 200).toISOString(), // 200ms ago
      }

      // Should be stale (cached 200ms ago, TTL is 100ms)
      expect(manager.isStale(staleNode)).toBe(true)
    })

    it('should treat nodes without cached_at as stale', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 60000,
      })

      const nodeWithoutCachedAt = {
        id: 'external-test',
        uuid: 'test-uuid',
        type: 'external' as const,
        uri: 'beads://./bd-test',
        source: 'beads',
        title: 'Test Node',
        cached_at: undefined,
        materialized: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      expect(manager.isStale(nodeWithoutCachedAt)).toBe(true)
    })

    it('should treat nodes with stale flag as stale', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      const manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 60000,
      })

      const staleNode = {
        id: 'external-test',
        uuid: 'test-uuid',
        type: 'external' as const,
        uri: 'beads://./bd-test',
        source: 'beads',
        title: 'Test Node',
        cached_at: new Date().toISOString(),
        stale: true, // Explicit stale flag
        materialized: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      expect(manager.isStale(staleNode)).toBe(true)
    })
  })

  describe('Strategy for URI Extraction', () => {
    it('should extract correct source from various URI formats', async () => {
      const manager = createMaterializationManager({
        default: 'lazy',
        providers: {
          beads: 'eager',
          jira: 'on-demand',
          github: 'none',
        },
      })

      // Beads URI
      expect(manager.getStrategyFor('beads://./bd-123')).toBe('eager')
      expect(manager.getStrategyFor('beads://workspace/bd-abc')).toBe('eager')

      // Jira URI
      expect(manager.getStrategyFor('jira://project/PROJ-123')).toBe('on-demand')

      // GitHub URI
      expect(manager.getStrategyFor('github://repo/issue/42')).toBe('none')

      // Unknown URI falls back to default
      expect(manager.getStrategyFor('unknown://something')).toBe('lazy')
      expect(manager.getStrategyFor('native://i-123')).toBe('lazy')
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Materialization Strategies (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
