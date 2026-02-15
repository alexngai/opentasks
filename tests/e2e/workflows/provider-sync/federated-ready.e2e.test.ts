/**
 * Federated Ready Query E2E Tests
 *
 * Tests the ready query with mixed native and external blockers.
 * Validates that the "ready to work on" calculation correctly handles
 * cross-provider blocking dependencies.
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
  createBeadsTask,
  createBeadsWorkspace,
  updateBeadsStatus,
  isBdAvailable,
  type E2ESystemContext,
  type TestAgent,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Federated Ready Query', () => {
  let system: E2ESystemContext
  let agent: TestAgent
  let beadsAvailable: boolean
  let sharedWorkspace: BeadsWorkspaceContext | null = null

  // Create Beads workspace once for all tests in this describe block
  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-federated-ready-beads-'))
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
      testName: 'federated-ready',
      enableBeads: true,
      cacheTTL: 60000,
      beadsWorkspacePath: sharedWorkspace?.path, // Reuse shared workspace
    })
    agent = createTestAgent(system.client, {
      name: 'ready-query-agent',
      provider: system.nativeProvider,
    })
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Basic Ready Query', () => {
    it('should include task with no blockers in ready list', async () => {
      // Create a native task with no blockers
      const task = await agent.createTask('Unblocked Task')

      // Query ready tasks via daemon (native-only query)
      const ready = await agent.ready()

      // Should find the unblocked task
      expect(ready.some((r) => r.id === task.id)).toBe(true)
    })

    it('should include task blocked by closed native blocker', async () => {
      // Create a closed native blocker
      const blocker = await agent.createTask('Closed Blocker')
      await agent.closeTask(blocker.id)

      // Create task blocked by the closed blocker
      const task = await agent.createTask('Blocked Task')
      await agent.blocks(blocker.id, task.id)

      // Query ready tasks
      const ready = await agent.ready()

      // Should find the task (blocker is closed)
      expect(ready.some((r) => r.id === task.id)).toBe(true)
    })

    it('should exclude task blocked by open native blocker', async () => {
      // Create an open native blocker
      const blocker = await agent.createTask('Open Blocker')

      // Create task blocked by the blocker
      const task = await agent.createTask('Blocked Task')
      await agent.blocks(blocker.id, task.id)

      // Query ready tasks
      const ready = await agent.ready()

      // Should NOT find the blocked task
      expect(ready.some((r) => r.id === task.id)).toBe(false)
    })
  })

  describe('Cross-Provider Blockers', () => {
    it('should exclude task blocked by open external node', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create open Beads task as blocker
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'External Blocker', {
        status: 'open',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Create native task
      const nativeTask = await agent.createTask('Blocked by External')
      const nativeUri = `native://${nativeTask.id}`

      // Add native task to graphology adapter
      system.graphologyAdapter.hydrateNode(nativeUri, {
        id: nativeTask.id,
        uuid: '',
        type: 'task',
        title: nativeTask.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create blocking edge
      const linkResult = await agent.link({
        from_id: beadsBlocker.uri,
        to_id: nativeTask.id,
        type: 'blocks',
      })
      expect(linkResult.success).toBe(true)

      // Sync edge to graphology
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

      // Query ready using federated graph
      const readyUris = await system.hydratingGraph.ready()

      // Should NOT include the blocked task
      expect(readyUris.includes(nativeUri)).toBe(false)
    })

    it('should include task with closed external blocker', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create a Beads task with 'done' status (closed)
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'Closed External', {
        status: 'closed',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Create native task
      const nativeTask = await agent.createTask('Blocked by Closed External')
      const nativeUri = `native://${nativeTask.id}`

      // Add native task to graphology adapter
      system.graphologyAdapter.hydrateNode(nativeUri, {
        id: nativeTask.id,
        uuid: '',
        type: 'task',
        title: nativeTask.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create blocking edge
      const linkResult = await agent.link({
        from_id: beadsBlocker.uri,
        to_id: nativeTask.id,
        type: 'blocks',
      })
      expect(linkResult.success).toBe(true)

      // Sync edge to graphology
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

      // Query ready using federated graph
      const readyUris = await system.hydratingGraph.ready()

      // Should include the task (blocker is closed)
      expect(readyUris.includes(nativeUri)).toBe(true)
    })
  })

  describe('Multiple Blockers', () => {
    it('should require all native blockers to be closed', async () => {
      // Create two blockers
      const blocker1 = await agent.createTask('Blocker 1')
      const blocker2 = await agent.createTask('Blocker 2')

      // Create task blocked by both
      const task = await agent.createTask('Multi-Blocked Task')
      await agent.blocks(blocker1.id, task.id)
      await agent.blocks(blocker2.id, task.id)

      // Query ready - should NOT include task
      let ready = await agent.ready()
      expect(ready.some((r) => r.id === task.id)).toBe(false)

      // Close first blocker
      await agent.closeTask(blocker1.id)

      // Still not ready (second blocker open)
      ready = await agent.ready()
      expect(ready.some((r) => r.id === task.id)).toBe(false)

      // Close second blocker
      await agent.closeTask(blocker2.id)

      // Now should be ready
      ready = await agent.ready()
      expect(ready.some((r) => r.id === task.id)).toBe(true)
    })

    it('should require all mixed blockers to be closed', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create a native blocker (open) and external blocker (closed)
      const nativeBlocker = await agent.createTask('Native Blocker')
      const externalBlocker = await createBeadsTask(system.beadsWorkspace!, 'External Blocker', {
        status: 'closed', // Already closed
      })
      await system.hydratingGraph.hydrate(externalBlocker.uri)

      // Create task
      const task = await agent.createTask('Mixed Blocked Task')
      const taskUri = `native://${task.id}`

      // Add nodes to graphology
      system.graphologyAdapter.hydrateNode(taskUri, {
        id: task.id,
        uuid: '',
        type: 'task',
        title: task.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const nativeBlockerUri = `native://${nativeBlocker.id}`
      system.graphologyAdapter.hydrateNode(nativeBlockerUri, {
        id: nativeBlocker.id,
        uuid: '',
        type: 'task',
        title: nativeBlocker.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create blocking edges
      const link1 = await agent.blocks(nativeBlocker.id, task.id)
      const link2 = await agent.link({
        from_id: externalBlocker.uri,
        to_id: task.id,
        type: 'blocks',
      })

      // Sync edges to graphology
      system.graphologyAdapter.hydrateEdges(nativeBlockerUri, [
        {
          id: link1.edge_id!,
          uuid: '',
          from_id: nativeBlockerUri,
          to_id: taskUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])
      system.graphologyAdapter.hydrateEdges(externalBlocker.uri, [
        {
          id: link2.edge_id!,
          uuid: '',
          from_id: externalBlocker.uri,
          to_id: taskUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Not ready - native blocker still open (even though external is closed)
      let readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(taskUri)).toBe(false)

      // Close the native blocker (update in storage and graphology)
      await agent.closeTask(nativeBlocker.id)
      system.graphologyAdapter.hydrateNode(nativeBlockerUri, {
        id: nativeBlocker.id,
        uuid: '',
        type: 'task',
        title: nativeBlocker.title,
        status: 'closed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Now should be ready (both blockers closed)
      readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(taskUri)).toBe(true)
    })
  })

  describe('External Status Mapping', () => {
    // Note: bd CLI only supports: open, closed, blocked, in_progress
    // 'closed' is the only valid "closed" status in bd
    // Our CLOSED_STATUSES list includes: closed, done, resolved, completed, cancelled
    // but we can only test 'closed' with real bd

    it('should treat external status "closed" as closed', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create Beads task with 'closed' status
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Closed Blocker', {
        status: 'closed',
      })
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create native task blocked by this Beads task
      const task = await agent.createTask('Blocked by closed')
      const taskUri = `native://${task.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(taskUri, {
        id: task.id,
        uuid: '',
        type: 'task',
        title: task.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: task.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: taskUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should be ready (blocker has a "closed" status)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(taskUri)).toBe(true)
    })

    it('should treat "open" external status as active blocker', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create Beads task with 'open' status
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'Open Blocker', {
        status: 'open',
      })
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create native task blocked by this Beads task
      const task = await agent.createTask('Blocked by open')
      const taskUri = `native://${task.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(taskUri, {
        id: task.id,
        uuid: '',
        type: 'task',
        title: task.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: task.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: taskUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should NOT be ready (blocker is open)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(taskUri)).toBe(false)
    })

    it('should treat "in_progress" external status as active blocker', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create Beads task with 'in_progress' status
      const beadsTask = await createBeadsTask(system.beadsWorkspace!, 'In Progress Blocker', {
        status: 'in_progress',
      })
      await system.hydratingGraph.hydrate(beadsTask.uri)

      // Create native task blocked by this Beads task
      const task = await agent.createTask('Blocked by in_progress')
      const taskUri = `native://${task.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(taskUri, {
        id: task.id,
        uuid: '',
        type: 'task',
        title: task.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: task.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: taskUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should NOT be ready (blocker is in_progress)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(taskUri)).toBe(false)
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Federated Ready Query (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
