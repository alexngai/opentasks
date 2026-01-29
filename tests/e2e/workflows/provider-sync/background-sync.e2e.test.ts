/**
 * Background Sync E2E Tests
 *
 * Tests periodic refresh of stale materialized nodes, ensuring the background
 * sync process properly refreshes cached external nodes and handles failures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  type E2ESystemContext,
} from '../../helpers/index.js'
import {
  createMaterializationManager,
  type MaterializationManager,
} from '../../../../src/providers/materialization.js'

describe.skipIf(!AGENT_TESTS)('Background Sync', () => {
  let system: E2ESystemContext
  let manager: MaterializationManager

  beforeEach(async () => {
    system = await setupE2ESystem({
      testName: 'background-sync',
      enableBeads: false, // Tests use mock URIs, don't need real Beads workspace
      cacheTTL: 60000,
    })
  })

  afterEach(async () => {
    // Ensure sync is stopped before cleanup
    if (manager?.isBackgroundSyncRunning()) {
      manager.stopBackgroundSync()
    }
    await system.stop()
  })

  describe('Start/Stop Lifecycle', () => {
    it('should report not running before start', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })

    it('should report running after start', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)

      expect(manager.isBackgroundSyncRunning()).toBe(true)
    })

    it('should report not running after stop', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)
      expect(manager.isBackgroundSyncRunning()).toBe(true)

      manager.stopBackgroundSync()
      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })

    it('should not start if interval is 0', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 0,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)

      // Should NOT be running because interval is 0
      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })

    it('should not start if interval is negative', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: -1000,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)

      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })

    it('should not start twice when called multiple times', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)
      manager.startBackgroundSync(system.store, system.providerRegistry)
      manager.startBackgroundSync(system.store, system.providerRegistry)

      // Should still be running (not error)
      expect(manager.isBackgroundSyncRunning()).toBe(true)

      // Stopping once should be enough
      manager.stopBackgroundSync()
      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })
  })

  describe('Configuration', () => {
    it('should respect custom staleAfter threshold', async () => {
      const shortThreshold = 100 // 100ms

      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: shortThreshold,
      })

      expect(manager.config.staleAfter).toBe(shortThreshold)

      // Create a mock node
      const freshNode = {
        id: 'external-test',
        uuid: 'test-uuid',
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

      // After threshold, should be stale
      const oldNode = {
        ...freshNode,
        cached_at: new Date(Date.now() - 200).toISOString(), // 200ms ago
      }

      expect(manager.isStale(oldNode)).toBe(true)
    })

    it('should respect per-provider strategy in config', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        providers: {
          beads: 'eager',
          jira: 'none',
        },
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      expect(manager.getStrategyFor('beads://./bd-123')).toBe('eager')
      expect(manager.getStrategyFor('jira://proj/ISSUE-1')).toBe('none')
      expect(manager.getStrategyFor('native://i-123')).toBe('lazy')
    })
  })

  describe('Materialization Context', () => {
    it('should handle different access types correctly', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 500,
      })

      const uri = 'beads://./bd-test'

      // Lazy: resolve triggers, others don't (unless explicit)
      expect(manager.shouldMaterialize(uri, { accessType: 'resolve' })).toBe(true)
      expect(manager.shouldMaterialize(uri, { accessType: 'edge-create' })).toBe(false)
      expect(manager.shouldMaterialize(uri, { accessType: 'query' })).toBe(false)

      // Explicit flag always triggers (for non-none strategies)
      expect(manager.shouldMaterialize(uri, { accessType: 'query', explicit: true })).toBe(true)
    })

    it('should handle eager strategy for all access types', async () => {
      manager = createMaterializationManager({
        default: 'eager',
        staleAfter: 500,
      })

      const uri = 'beads://./bd-test'

      expect(manager.shouldMaterialize(uri, { accessType: 'resolve' })).toBe(true)
      expect(manager.shouldMaterialize(uri, { accessType: 'edge-create' })).toBe(true)
      expect(manager.shouldMaterialize(uri, { accessType: 'query' })).toBe(true)
    })

    it('should handle on-demand strategy requiring explicit flag', async () => {
      manager = createMaterializationManager({
        default: 'on-demand',
        staleAfter: 500,
      })

      const uri = 'beads://./bd-test'

      expect(manager.shouldMaterialize(uri, { accessType: 'resolve' })).toBe(false)
      expect(manager.shouldMaterialize(uri, { accessType: 'resolve', explicit: true })).toBe(true)
    })

    it('should handle none strategy blocking all materialization', async () => {
      manager = createMaterializationManager({
        default: 'none',
        staleAfter: 500,
      })

      const uri = 'beads://./bd-test'

      expect(manager.shouldMaterialize(uri, { accessType: 'resolve' })).toBe(false)
      expect(manager.shouldMaterialize(uri, { accessType: 'resolve', explicit: true })).toBe(false)
    })
  })

  describe('Stop Behavior', () => {
    it('should handle stop when not running', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      // Should not throw
      expect(() => manager.stopBackgroundSync()).not.toThrow()
      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })

    it('should handle multiple stops gracefully', async () => {
      manager = createMaterializationManager({
        default: 'lazy',
        backgroundSyncInterval: 1000,
        staleAfter: 500,
      })

      manager.startBackgroundSync(system.store, system.providerRegistry)
      expect(manager.isBackgroundSyncRunning()).toBe(true)

      manager.stopBackgroundSync()
      manager.stopBackgroundSync()
      manager.stopBackgroundSync()

      expect(manager.isBackgroundSyncRunning()).toBe(false)
    })
  })

  describe('Default Configuration', () => {
    it('should have sensible defaults', async () => {
      // Create with no config
      manager = createMaterializationManager({})

      // Should have defaults
      expect(manager.config.default).toBe('on-demand')
      expect(manager.config.backgroundSyncInterval).toBe(0)
      expect(manager.config.staleAfter).toBe(5 * 60 * 1000) // 5 minutes
    })

    it('should merge partial config with defaults', async () => {
      manager = createMaterializationManager({
        staleAfter: 1000, // Override only staleAfter
      })

      expect(manager.config.default).toBe('on-demand') // Default
      expect(manager.config.backgroundSyncInterval).toBe(0) // Default
      expect(manager.config.staleAfter).toBe(1000) // Overridden
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Background Sync (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
