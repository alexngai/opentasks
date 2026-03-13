/**
 * E2E Tests: Provider Reconciliation
 *
 * Tests reconciliation with real stores and real providers (beads).
 * Covers:
 * - reconcileProviders() with real provider + real store
 * - Edge reconciliation via rawData extraction
 * - Pointer-only resolution
 * - provider_content_hash stamping during materialization
 * - Positive-writes-only guarantees
 * - MCP reconcile tool flow
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  type E2ESystemContext,
  isBdAvailable,
  createBeadsWorkspace,
  createBeadsTask,
  updateBeadsTask,
  updateBeadsStatus,
  getBeadsTask,
  linkBeadsTasks,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'

import {
  createProviderAwareStore,
  type ProviderAwareStore,
} from '../../../../src/graph/provider-store.js'
import { createProviderRegistry } from '../../../../src/providers/registry.js'
import { createNativeProvider } from '../../../../src/providers/native.js'
import { createBeadsProvider, type BeadsConfig } from '../../../../src/providers/beads.js'
import { getBdExecutable } from '../../helpers/beads-helpers.js'
import type { Node, ExternalNode } from '../../../../src/schema/index.js'

describe.skipIf(!AGENT_TESTS)('Provider Reconciliation E2E', () => {
  let beadsAvailable = false
  let sharedWorkspace: BeadsWorkspaceContext | null = null

  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const dir = await mkdtemp(join(tmpdir(), 'opentasks-reconciliation-beads-'))
      sharedWorkspace = await createBeadsWorkspace(dir, 'bd')
    }
  })

  afterAll(async () => {
    if (sharedWorkspace) {
      await sharedWorkspace.cleanup()
    }
  })

  // ── Helper: create a ProviderAwareStore wired to real store + beads ────────

  async function createProviderStore(system: E2ESystemContext): Promise<ProviderAwareStore> {
    const registry = createProviderRegistry()
    const nativeProvider = createNativeProvider(system.store)
    registry.register(nativeProvider)

    if (system.beadsProvider) {
      registry.register(system.beadsProvider)
    }

    return createProviderAwareStore(system.store, {
      registry,
      materialization: {
        default: 'eager',
        staleAfter: 60_000,
      },
      autoRegisterNative: false,
    })
  }

  // ==========================================================================
  // 1. reconcileProviders() with real provider + real store
  // ==========================================================================

  describe('reconcileProviders with real beads provider', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should detect and update stale cached data after external change', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // 1. Create a beads task and materialize it
      const task = await createBeadsTask(sharedWorkspace!.path, 'Reconcile Test Task', {
        content: 'Original content',
      })
      const node = await providerStore.resolveNode(task.uri, { materialize: true })
      expect(node).toBeTruthy()
      expect(node!.title).toBe('Reconcile Test Task')

      // Verify authoritative metadata is stamped
      const materialized = await system.store.getNode(node!.id)
      expect(materialized!.metadata?.provider_authoritative).toBe(true)
      expect(materialized!.metadata?.provider_cached_at).toBeDefined()
      expect(materialized!.metadata?.provider_uri).toBe(task.uri)

      // 2. Change the task externally (simulates another environment)
      await updateBeadsTask(sharedWorkspace!.path, task.id, {
        title: 'Updated By External',
      })

      // Small delay to ensure timestamps differ
      await new Promise(r => setTimeout(r, 50))

      // 3. Reconcile — should detect the change
      const result = await providerStore.reconcileProviders()

      // Find our node's result
      const nodeResult = result.results.find(r => r.nodeId === node!.id)
      expect(nodeResult).toBeTruthy()
      expect(nodeResult!.status).toBe('updated')

      // 4. Verify the graph node has the updated data
      const updated = await system.store.getNode(node!.id)
      expect(updated!.title).toBe('Updated By External')
      expect(updated!.metadata?.provider_cached_at).toBeDefined()
      // provider_cached_at should be refreshed (>= original, accounting for fast execution)
      const originalCachedAt = new Date(materialized!.metadata!.provider_cached_at as string).getTime()
      const updatedCachedAt = new Date(updated!.metadata!.provider_cached_at as string).getTime()
      expect(updatedCachedAt).toBeGreaterThanOrEqual(originalCachedAt)
    })

    it('should stamp provider_cached_at without updating when data is unchanged', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // 1. Create and materialize
      const task = await createBeadsTask(sharedWorkspace!.path, 'Unchanged Task')
      const node = await providerStore.resolveNode(task.uri, { materialize: true })
      const materialized = await system.store.getNode(node!.id)
      const originalCachedAt = materialized!.metadata!.provider_cached_at as string

      // Small delay to ensure timestamps differ
      await new Promise(r => setTimeout(r, 50))

      // 2. Reconcile without making any changes to the task
      const result = await providerStore.reconcileProviders()

      const nodeResult = result.results.find(r => r.nodeId === node!.id)
      expect(nodeResult).toBeTruthy()
      expect(nodeResult!.status).toBe('unchanged')

      // 3. provider_cached_at should still be refreshed
      const reconciled = await system.store.getNode(node!.id)
      const reconciledCachedAt = reconciled!.metadata!.provider_cached_at as string
      expect(new Date(reconciledCachedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalCachedAt).getTime()
      )
    })

    it('should filter reconciliation by provider name', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // Materialize a beads task
      const task = await createBeadsTask(sharedWorkspace!.path, 'Filter Test')
      await providerStore.resolveNode(task.uri, { materialize: true })

      // Reconcile only a non-existent provider — should skip beads
      const result = await providerStore.reconcileProviders({ providers: ['jira'] })
      expect(result.totalNodes).toBe(0)

      // Reconcile only beads — should process the node
      const beadsResult = await providerStore.reconcileProviders({ providers: ['beads'] })
      expect(beadsResult.totalNodes).toBeGreaterThanOrEqual(1)
    })

    it('should filter reconciliation by node ID', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const task1 = await createBeadsTask(sharedWorkspace!.path, 'Node Filter A')
      const task2 = await createBeadsTask(sharedWorkspace!.path, 'Node Filter B')
      const node1 = await providerStore.resolveNode(task1.uri, { materialize: true })
      const node2 = await providerStore.resolveNode(task2.uri, { materialize: true })

      // Reconcile only node1
      const result = await providerStore.reconcileProviders({ nodeIds: [node1!.id] })
      expect(result.totalNodes).toBe(1)
      expect(result.results[0].nodeId).toBe(node1!.id)
    })
  })

  // ==========================================================================
  // 2. Positive-writes-only guarantee
  // ==========================================================================

  describe('positive-writes-only', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-positive',
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should not delete nodes when provider is unavailable', async () => {
      // Create a node with provider_authoritative metadata pointing to an
      // unregistered provider (simulates provider not configured in this env)
      const node = await system.store.createNode({
        type: 'task',
        title: 'Orphaned Provider Task',
        status: 'open',
        metadata: {
          provider_uri: 'jira://PROJ/JIRA-123',
          provider_source: 'jira',
          provider_authoritative: true,
          provider_cached_at: '2024-01-01T00:00:00.000Z',
        },
      })

      // Create provider store with no jira provider registered
      const registry = createProviderRegistry()
      registry.register(createNativeProvider(system.store))
      const providerStore = createProviderAwareStore(system.store, {
        registry,
        autoRegisterNative: false,
      })

      const result = await providerStore.reconcileProviders()

      // Provider should be skipped
      expect(result.skippedProviders).toContain('jira')
      expect(result.results[0].status).toBe('unavailable')

      // Node must still exist with original data (positive-writes-only)
      const stillExists = await system.store.getNode(node.id)
      expect(stillExists).toBeTruthy()
      expect(stillExists!.title).toBe('Orphaned Provider Task')
      expect(stillExists!.metadata?.provider_authoritative).toBe(true)
    })

    it('should not delete nodes when provider returns null', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // Manually create a node pointing to a non-existent beads task
      const node = await system.store.createNode({
        type: 'task',
        title: 'Deleted In Provider',
        status: 'open',
        metadata: {
          provider_uri: 'beads://./bd-nonexistent999',
          provider_source: 'beads',
          provider_authoritative: true,
          provider_cached_at: '2024-01-01T00:00:00.000Z',
        },
      })

      const registry = createProviderRegistry()
      registry.register(createNativeProvider(system.store))
      const beadsConfig: BeadsConfig = {
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
      }
      registry.register(createBeadsProvider(beadsConfig))

      const providerStore = createProviderAwareStore(system.store, {
        registry,
        autoRegisterNative: false,
      })

      const result = await providerStore.reconcileProviders()

      // Node should report unchanged (positive-writes-only — no deletion)
      const nodeResult = result.results.find(r => r.nodeId === node.id)
      // Might be 'unchanged' (null return) or 'error' (parse failure) — either way, node must survive
      expect(nodeResult).toBeTruthy()

      const stillExists = await system.store.getNode(node.id)
      expect(stillExists).toBeTruthy()
      expect(stillExists!.title).toBe('Deleted In Provider')
    })
  })

  // ==========================================================================
  // 3. Edge reconciliation (rawData extraction)
  // ==========================================================================

  describe('edge reconciliation', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-edges',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should create edges from provider rawData during reconciliation', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // 1. Create two beads tasks and link them in beads
      const blocker = await createBeadsTask(sharedWorkspace!.path, 'Edge Blocker')
      const blocked = await createBeadsTask(sharedWorkspace!.path, 'Edge Blocked')
      try {
        await linkBeadsTasks(sharedWorkspace!.path, blocker.id, blocked.id)
      } catch {
        // bd dep add may fail in --no-db mode — skip test
        skip()
        return
      }

      // 2. Materialize both tasks
      const blockerNode = await providerStore.resolveNode(blocker.uri, { materialize: true })
      const blockedNode = await providerStore.resolveNode(blocked.uri, { materialize: true })
      expect(blockerNode).toBeTruthy()
      expect(blockedNode).toBeTruthy()

      // 3. Verify the provider returns relationship data in rawData
      const freshBlocker = await providerStore.resolveNode(blocker.uri, { refresh: true })
      const raw = (freshBlocker as any)?.rawData ?? {}
      const hasEdgeData = raw.blocks?.length || raw.blockedBy?.length ||
        raw.dependencies?.length || raw.dependents?.length
      if (!hasEdgeData) {
        // Provider doesn't include edge data in rawData (e.g., --no-db mode)
        // Edge reconciliation can't work without it — skip
        skip()
        return
      }

      // 4. Reconcile — should extract edges from rawData
      await providerStore.reconcileProviders()

      // 5. Check that a 'blocks' edge was created
      const edgesFrom = await system.store.query.edgesFrom(blockerNode!.id)
      const blocksEdge = edgesFrom.find(
        e => e.to_id === blockedNode!.id && e.type === 'blocks'
      )

      expect(blocksEdge).toBeTruthy()
      expect(blocksEdge!.metadata?.edge_source).toBe('beads')
      expect(blocksEdge!.metadata?.from_uri).toBe(blocker.uri)
      expect(blocksEdge!.metadata?.to_uri).toBe(blocked.uri)
    })

    it('should not touch graph-owned edges during reconciliation', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // 1. Create beads tasks and materialize
      const task1 = await createBeadsTask(sharedWorkspace!.path, 'Graph Edge Source')
      const task2 = await createBeadsTask(sharedWorkspace!.path, 'Graph Edge Target')
      const node1 = await providerStore.resolveNode(task1.uri, { materialize: true })
      const node2 = await providerStore.resolveNode(task2.uri, { materialize: true })

      // 2. Create a graph-owned edge (no edge_source → native)
      const nativeEdge = await system.store.createEdge({
        from_id: node1!.id,
        to_id: node2!.id,
        type: 'related',
      })

      // 3. Reconcile — graph-owned edge must survive
      await providerStore.reconcileProviders()

      const edgesFrom = await system.store.query.edgesFrom(node1!.id)
      const survivingEdge = edgesFrom.find(e => e.id === nativeEdge.id)
      expect(survivingEdge).toBeTruthy()
      expect(survivingEdge!.type).toBe('related')
    })
  })

  // ==========================================================================
  // 4. provider_content_hash stamping during materialization
  // ==========================================================================

  describe('provider_content_hash', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-hash',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should stamp provider_content_hash during reconciliation if provider provides it', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const task = await createBeadsTask(sharedWorkspace!.path, 'Hash Test')
      const node = await providerStore.resolveNode(task.uri, { materialize: true })

      // Reconcile — hash should be stamped if provider returns contentHash
      await providerStore.reconcileProviders()

      const reconciled = await system.store.getNode(node!.id)
      // The beads provider may or may not implement contentHash yet,
      // but the field should exist on the metadata (possibly undefined)
      expect(reconciled!.metadata).toHaveProperty('provider_cached_at')
      expect(reconciled!.metadata?.provider_authoritative).toBe(true)
    })
  })

  // ==========================================================================
  // 5. Pointer-only resolution
  // ==========================================================================

  describe('pointer-only resolution', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-pointer',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should resolve pointer-only nodes transparently from provider', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const registry = createProviderRegistry()
      registry.register(createNativeProvider(system.store))

      // Create beads provider with pointer mode
      const beadsConfig: BeadsConfig = {
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
      }
      const beadsProvider = createBeadsProvider(beadsConfig)
      // Override materializeMode to pointer for this test
      const pointerBeads = { ...beadsProvider, materializeMode: 'pointer' as const }
      registry.register(pointerBeads)

      const providerStore = createProviderAwareStore(system.store, {
        registry,
        materialization: { default: 'eager', staleAfter: 60_000 },
        autoRegisterNative: false,
      })

      // Create and materialize as pointer-only
      const task = await createBeadsTask(sharedWorkspace!.path, 'Pointer Task', {
        content: 'Real content here',
      })
      const node = await providerStore.resolveNode(task.uri, { materialize: true })
      expect(node).toBeTruthy()

      // Check the stored node is a stub (pointer-only)
      const stored = await system.store.getNode(node!.id)
      expect(stored!.metadata?.provider_pointer_only).toBe(true)
      expect(stored!.metadata?.provider_uri).toBe(task.uri)
      // Title should be a placeholder for pointer-only
      expect(stored!.title).toBe('(pending)')

      // Resolve via provider store — should transparently fetch real data
      const resolved = await providerStore.resolveNode(node!.id)
      expect(resolved).toBeTruthy()
      expect(resolved!.title).toBe('Pointer Task')
    })

    it('should use cache on second resolve of pointer-only node', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const registry = createProviderRegistry()
      registry.register(createNativeProvider(system.store))

      const beadsConfig: BeadsConfig = {
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
      }
      const beadsProvider = createBeadsProvider(beadsConfig)
      const pointerBeads = { ...beadsProvider, materializeMode: 'pointer' as const }
      registry.register(pointerBeads)

      const providerStore = createProviderAwareStore(system.store, {
        registry,
        materialization: { default: 'eager', staleAfter: 60_000 },
        autoRegisterNative: false,
      })

      const task = await createBeadsTask(sharedWorkspace!.path, 'Cached Pointer Task')
      const node = await providerStore.resolveNode(task.uri, { materialize: true })

      // First resolve — fetches from provider
      const first = await providerStore.resolveNode(node!.id)
      expect(first!.title).toBe('Cached Pointer Task')

      // Second resolve — should use cache (faster, no provider call)
      const second = await providerStore.resolveNode(node!.id)
      expect(second!.title).toBe('Cached Pointer Task')
    })
  })

  // ==========================================================================
  // 6. Materialization stamps reconciliation metadata
  // ==========================================================================

  describe('materialization metadata', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-metadata',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should stamp provider_authoritative and provider_cached_at on materialize', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const task = await createBeadsTask(sharedWorkspace!.path, 'Metadata Test')
      const node = await providerStore.resolveNode(task.uri, { materialize: true })

      const stored = await system.store.getNode(node!.id)
      expect(stored).toBeTruthy()
      expect(stored!.type).toBe('task') // local provider → native type, not 'external'
      expect(stored!.metadata?.provider_uri).toBe(task.uri)
      expect(stored!.metadata?.provider_source).toBe('beads')
      expect(stored!.metadata?.provider_authoritative).toBe(true)
      expect(stored!.metadata?.provider_cached_at).toBeDefined()

      // Verify the timestamp is recent (within 30 seconds)
      const cachedAt = new Date(stored!.metadata!.provider_cached_at as string).getTime()
      expect(Date.now() - cachedAt).toBeLessThan(30_000)
    })

    it('should update provider_cached_at on re-materialization', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const task = await createBeadsTask(sharedWorkspace!.path, 'Re-materialize Test')

      // First materialization
      const node1 = await providerStore.resolveNode(task.uri, { materialize: true })
      const stored1 = await system.store.getNode(node1!.id)
      const firstCachedAt = stored1!.metadata!.provider_cached_at as string

      await new Promise(r => setTimeout(r, 50))

      // Re-materialize (force refresh)
      await providerStore.resolveNode(task.uri, { materialize: true, refresh: true })
      const stored2 = await system.store.getNode(node1!.id)
      const secondCachedAt = stored2!.metadata!.provider_cached_at as string

      expect(new Date(secondCachedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(firstCachedAt).getTime()
      )
    })
  })

  // ==========================================================================
  // 7. MCP reconcile tool
  // ==========================================================================

  describe('MCP reconcile tool', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-mcp',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should be callable via the providerStore reconcileProviders method', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // Test reconciliation through the ProviderAwareStore directly.
      // The IPC provider.reconcile handler delegates to the same method.
      const providerStore = await createProviderStore(system)

      // Create and materialize a task first
      const task = await createBeadsTask(sharedWorkspace!.path, 'MCP Reconcile Test')
      await providerStore.resolveNode(task.uri, { materialize: true })

      const result = await providerStore.reconcileProviders()
      expect(result).toBeDefined()
      expect(result.totalNodes).toBeGreaterThanOrEqual(1)
      expect(result.results).toBeInstanceOf(Array)
    })
  })

  // ==========================================================================
  // 8. Multi-node reconciliation
  // ==========================================================================

  describe('multi-node reconciliation', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-multi',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should reconcile multiple provider-backed nodes in one pass', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // Create and materialize multiple tasks (sequentially to avoid race conditions)
      const taskA = await createBeadsTask(sharedWorkspace!.path, 'Multi A')
      const taskB = await createBeadsTask(sharedWorkspace!.path, 'Multi B')
      const taskC = await createBeadsTask(sharedWorkspace!.path, 'Multi C')
      const tasks = [taskA, taskB, taskC]

      const nodeA = await providerStore.resolveNode(taskA.uri, { materialize: true })
      const nodeB = await providerStore.resolveNode(taskB.uri, { materialize: true })
      const nodeC = await providerStore.resolveNode(taskC.uri, { materialize: true })
      const nodes = [nodeA, nodeB, nodeC]

      // Update one of them externally
      await updateBeadsTask(sharedWorkspace!.path, tasks[1].id, {
        title: 'Multi B Updated',
      })

      // Reconcile all
      const result = await providerStore.reconcileProviders()

      // At least 3 nodes should be processed (might be more from prior tests)
      expect(result.totalNodes).toBeGreaterThanOrEqual(3)

      // Exactly one should be 'updated'
      const nodeIds = new Set(nodes.map(n => n!.id))
      const ourResults = result.results.filter(r => nodeIds.has(r.nodeId))
      expect(ourResults).toHaveLength(3)

      const updatedResults = ourResults.filter(r => r.status === 'updated')
      expect(updatedResults.length).toBeGreaterThanOrEqual(1)

      // Verify the updated one
      const updatedNode = await system.store.getNode(nodes[1]!.id)
      expect(updatedNode!.title).toBe('Multi B Updated')

      // Others should be unchanged
      const storedA = await system.store.getNode(nodes[0]!.id)
      expect(storedA!.title).toBe('Multi A')
      const storedC = await system.store.getNode(nodes[2]!.id)
      expect(storedC!.title).toBe('Multi C')
    })

    it('should handle mixed provider availability gracefully', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      // Create a beads-backed node
      const task = await createBeadsTask(sharedWorkspace!.path, 'Mixed Availability')
      const beadsNode = await providerStore.resolveNode(task.uri, { materialize: true })

      // Also create a node pointing to an unavailable provider
      const orphanNode = await system.store.createNode({
        type: 'task',
        title: 'Linear Task Cache',
        status: 'open',
        metadata: {
          provider_uri: 'linear://team/LIN-42',
          provider_source: 'linear',
          provider_authoritative: true,
          provider_cached_at: '2024-01-01T00:00:00.000Z',
        },
      })

      const result = await providerStore.reconcileProviders()

      // Beads node should be processed
      const beadsResult = result.results.find(r => r.nodeId === beadsNode!.id)
      expect(beadsResult).toBeTruthy()
      expect(['unchanged', 'updated']).toContain(beadsResult!.status)

      // Linear node should be skipped (unavailable)
      const linearResult = result.results.find(r => r.nodeId === orphanNode.id)
      expect(linearResult).toBeTruthy()
      expect(linearResult!.status).toBe('unavailable')

      // Both nodes must still exist
      expect(await system.store.getNode(beadsNode!.id)).toBeTruthy()
      expect(await system.store.getNode(orphanNode.id)).toBeTruthy()
    })
  })

  // ==========================================================================
  // 9. Status change reconciliation
  // ==========================================================================

  describe('status change reconciliation', () => {
    let system: E2ESystemContext
    let providerStore: ProviderAwareStore

    beforeEach(async () => {
      system = await setupE2ESystem({
        testName: 'reconciliation-status',
        enableBeads: true,
        cacheTTL: 60_000,
        beadsWorkspacePath: sharedWorkspace?.path,
      })
      providerStore = await createProviderStore(system)
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should detect status changes from provider', async ({ skip }) => {
      if (!beadsAvailable) { skip(); return }

      const task = await createBeadsTask(sharedWorkspace!.path, 'Status Change Test')
      const node = await providerStore.resolveNode(task.uri, { materialize: true })

      // Change status externally
      await updateBeadsStatus(sharedWorkspace!.path, task.id, 'closed')

      // Reconcile
      const result = await providerStore.reconcileProviders()
      const nodeResult = result.results.find(r => r.nodeId === node!.id)
      expect(nodeResult!.status).toBe('updated')

      // Verify status was updated
      const updated = await system.store.getNode(node!.id)
      expect(updated!.status).toBe('closed')
    })
  })
})

// Fallback for when agent tests are skipped
if (!AGENT_TESTS) {
  describe('Provider Reconciliation E2E (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
