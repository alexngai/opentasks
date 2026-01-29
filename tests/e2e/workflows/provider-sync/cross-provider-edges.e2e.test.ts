/**
 * Cross-Provider Edges E2E Tests
 *
 * Tests edge resolution across NativeProvider and BeadsProvider.
 * Validates that blocking relationships work correctly across provider boundaries.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createTestAgent,
  isBdAvailable,
  createBeadsTask,
  createBeadsWorkspace,
  updateBeadsStatus,
  type E2ESystemContext,
  type TestAgent,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Cross-Provider Edges', () => {
  let system: E2ESystemContext
  let agent: TestAgent
  let beadsAvailable: boolean
  let sharedWorkspace: BeadsWorkspaceContext | null = null

  // Create Beads workspace once for all tests in this describe block
  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-cross-provider-beads-'))
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
      testName: 'cross-provider',
      enableBeads: true,
      cacheTTL: 60000,
      beadsWorkspacePath: sharedWorkspace?.path, // Reuse shared workspace
    })
    agent = createTestAgent(system.client, {
      name: 'cross-provider-agent',
      provider: system.nativeProvider,
    })
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Native to External Edges', () => {
    it('should create edge from native issue to external Beads task', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create native issue
      const nativeIssue = await agent.createIssue('Native Blocker')

      // Create Beads task
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Blocked by Native')

      // Hydrate the Beads task into our graph
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create blocking edge: native blocks beads
      const result = await agent.link({
        from_id: nativeIssue.id,
        to_id: beadsTask.uri,
        type: 'blocks',
      })

      expect(result.success).toBe(true)
      expect(result.edge_id).toBeDefined()
    })

    it('should query blockers for external node blocked by native', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create native issue
      const nativeIssue = await agent.createIssue('Native Blocker for Query')

      // Create Beads task
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Beads Blocked')

      // Hydrate and create edge
      await system.hydratingGraph.hydrate(beadsTask.uri)
      await agent.link({
        from_id: nativeIssue.id,
        to_id: beadsTask.uri,
        type: 'blocks',
      })

      // Query blockers for the Beads task
      const blockers = await agent.blockers(beadsTask.uri)

      expect(blockers.length).toBeGreaterThanOrEqual(1)
      expect(blockers.some((b) => b.id === nativeIssue.id)).toBe(true)
    })
  })

  describe('External to Native Edges', () => {
    it('should create edge from external Beads task to native issue', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create Beads task
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Beads Blocker')

      // Hydrate the Beads task
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create native issue
      const nativeIssue = await agent.createIssue('Blocked by Beads')

      // Create blocking edge: beads blocks native
      const result = await agent.link({
        from_id: beadsTask.uri,
        to_id: nativeIssue.id,
        type: 'blocks',
      })

      expect(result.success).toBe(true)
    })

    it('should query what external node blocks', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create Beads task as blocker
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Beads Blocker Query')

      // Hydrate
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create native issue
      const nativeIssue = await agent.createIssue('Native Blocked')

      // Create edge: beads blocks native
      await agent.link({
        from_id: beadsTask.uri,
        to_id: nativeIssue.id,
        type: 'blocks',
      })

      // Query what the Beads task blocks (forward direction)
      const blocking = await agent.blocking(beadsTask.uri)

      expect(blocking.length).toBeGreaterThanOrEqual(1)
      expect(blocking.some((b) => b.id === nativeIssue.id)).toBe(true)
    })
  })

  describe('Bidirectional Traversal', () => {
    it('should traverse edges in both directions via federated graph', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create native issue
      const nativeIssue = await agent.createIssue('Native in Chain')
      const nativeUri = `native://${nativeIssue.id}`

      // Add native issue to graphology adapter (daemon doesn't sync to in-memory graph)
      system.graphologyAdapter.hydrateNode(nativeUri, {
        id: nativeIssue.id,
        uuid: '',
        type: 'issue',
        title: nativeIssue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create Beads task
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Beads in Chain')
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create edge: native blocks beads (stored in SQLite)
      const linkResult = await agent.link({
        from_id: nativeIssue.id,
        to_id: beadsTask.uri,
        type: 'blocks',
      })
      expect(linkResult.success).toBe(true)

      // Add edge to graphology for in-memory traversal
      system.graphologyAdapter.hydrateEdges(nativeUri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: nativeUri,
          to_id: beadsTask.uri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Query "what does native block?" using federated graph (for cross-provider)
      const blockingUris = system.hydratingGraph.related(nativeUri, {
        edgeType: 'blocks',
        direction: 'out',
      })
      expect(blockingUris).toContain(beadsTask.uri)

      // Query "what blocks beads?" using federated graph
      const blockerUris = system.hydratingGraph.related(beadsTask.uri, {
        edgeType: 'blocks',
        direction: 'in',
      })
      expect(blockerUris).toContain(nativeUri)
    })
  })

  describe('Transitive Cross-Provider Chains', () => {
    it('should resolve transitive chain: Native → Beads → Native', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create chain: Native A → Beads B → Native C
      const nativeA = await agent.createIssue('Native A')
      const nativeAUri = `native://${nativeA.id}`
      const beadsB = await createBeadsTask(system.beadsWorkspace!, 'Beads B')
      await system.hydratingGraph.hydrate(beadsB.uri)
      const nativeC = await agent.createIssue('Native C')
      const nativeCUri = `native://${nativeC.id}`

      // Add native nodes to graphology adapter
      system.graphologyAdapter.hydrateNode(nativeAUri, {
        id: nativeA.id,
        uuid: '',
        type: 'issue',
        title: nativeA.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      system.graphologyAdapter.hydrateNode(nativeCUri, {
        id: nativeC.id,
        uuid: '',
        type: 'issue',
        title: nativeC.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edges via daemon (stored in SQLite)
      const linkAB = await agent.link({ from_id: nativeA.id, to_id: beadsB.uri, type: 'blocks' })
      const linkBC = await agent.link({ from_id: beadsB.uri, to_id: nativeC.id, type: 'blocks' })

      expect(linkAB.success).toBe(true)
      expect(linkBC.success).toBe(true)

      // Sync edges to graphology for in-memory traversal
      system.graphologyAdapter.hydrateEdges(nativeAUri, [
        {
          id: linkAB.edge_id!,
          uuid: '',
          from_id: nativeAUri,
          to_id: beadsB.uri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])
      system.graphologyAdapter.hydrateEdges(beadsB.uri, [
        {
          id: linkBC.edge_id!,
          uuid: '',
          from_id: beadsB.uri,
          to_id: nativeCUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Query transitive blockers using federated graph's reachable() method
      const transitiveBlockers = system.hydratingGraph.reachable(nativeCUri, {
        edgeType: 'blocks',
        direction: 'in',
        maxDepth: 10,
      })

      // Should include both A and B (but not C itself)
      expect(transitiveBlockers.length).toBeGreaterThanOrEqual(2)
      expect(transitiveBlockers).toContain(nativeAUri)
      expect(transitiveBlockers).toContain(beadsB.uri)
    })
  })

  describe('Ready Query with Cross-Provider Blockers', () => {
    it('should not be ready when blocked by open external node', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create open Beads task as blocker
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'Open Beads Blocker', {
        status: 'open',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Create native issue blocked by Beads
      const nativeIssue = await agent.createIssue('Blocked Native')
      const nativeUri = `native://${nativeIssue.id}`

      // Add native issue to graphology adapter
      system.graphologyAdapter.hydrateNode(nativeUri, {
        id: nativeIssue.id,
        uuid: '',
        type: 'issue',
        title: nativeIssue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const linkResult = await agent.link({
        from_id: beadsBlocker.uri,
        to_id: nativeIssue.id,
        type: 'blocks',
      })
      expect(linkResult.success).toBe(true)

      // Sync edge to graphology for federated ready query
      system.graphologyAdapter.hydrateEdges(beadsBlocker.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsBlocker.uri,
          to_id: nativeUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Query ready using federated graph - native issue should NOT be ready
      const readyUris = await system.hydratingGraph.ready()
      const isReady = readyUris.includes(nativeUri)
      expect(isReady).toBe(false)
    })

    it('should detect when external blocker status changes', { timeout: 60000 }, async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create open Beads task as blocker
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'Will Close Blocker', {
        status: 'open',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Verify initial status is 'open'
      let resolved = await system.hydratingGraph.resolve(beadsBlocker.uri)
      expect(resolved).not.toBeNull()
      expect(resolved!.data.status).toBe('open')

      // Close the Beads blocker via CLI (using 'closed' - the valid bd status)
      await updateBeadsStatus(system.beadsWorkspace!, beadsBlocker.id, 'closed')

      // Invalidate cache and re-hydrate to get new status
      await system.hydratingGraph.invalidateCache('beads')
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Verify status is now 'closed'
      resolved = await system.hydratingGraph.resolve(beadsBlocker.uri)
      expect(resolved).not.toBeNull()
      const status = resolved!.data.external_status ?? resolved!.data.status
      expect(status).toBe('closed')
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Cross-Provider Edges (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
