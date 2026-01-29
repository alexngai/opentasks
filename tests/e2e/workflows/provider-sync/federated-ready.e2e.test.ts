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
    it('should include issue with no blockers in ready list', async () => {
      // Create a native issue with no blockers
      const issue = await agent.createIssue('Unblocked Issue')

      // Query ready issues via daemon (native-only query)
      const ready = await agent.ready()

      // Should find the unblocked issue
      expect(ready.some((r) => r.id === issue.id)).toBe(true)
    })

    it('should include issue blocked by closed native blocker', async () => {
      // Create a closed native blocker
      const blocker = await agent.createIssue('Closed Blocker')
      await agent.closeIssue(blocker.id)

      // Create issue blocked by the closed blocker
      const issue = await agent.createIssue('Blocked Issue')
      await agent.blocks(blocker.id, issue.id)

      // Query ready issues
      const ready = await agent.ready()

      // Should find the issue (blocker is closed)
      expect(ready.some((r) => r.id === issue.id)).toBe(true)
    })

    it('should exclude issue blocked by open native blocker', async () => {
      // Create an open native blocker
      const blocker = await agent.createIssue('Open Blocker')

      // Create issue blocked by the blocker
      const issue = await agent.createIssue('Blocked Issue')
      await agent.blocks(blocker.id, issue.id)

      // Query ready issues
      const ready = await agent.ready()

      // Should NOT find the blocked issue
      expect(ready.some((r) => r.id === issue.id)).toBe(false)
    })
  })

  describe('Cross-Provider Blockers', () => {
    it('should exclude issue blocked by open external node', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create open Beads task as blocker
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'External Blocker', {
        status: 'open',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Create native issue
      const nativeIssue = await agent.createIssue('Blocked by External')
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

      // Create blocking edge
      const linkResult = await agent.link({
        from_id: beadsBlocker.uri,
        to_id: nativeIssue.id,
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

      // Should NOT include the blocked issue
      expect(readyUris.includes(nativeUri)).toBe(false)
    })

    it('should include issue with closed external blocker', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create a Beads task with 'done' status (closed)
      const beadsBlocker = await createBeadsTask(system.beadsWorkspace!, 'Closed External', {
        status: 'closed',
      })
      await system.hydratingGraph.hydrate(beadsBlocker.uri)

      // Create native issue
      const nativeIssue = await agent.createIssue('Blocked by Closed External')
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

      // Create blocking edge
      const linkResult = await agent.link({
        from_id: beadsBlocker.uri,
        to_id: nativeIssue.id,
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

      // Should include the issue (blocker is closed)
      expect(readyUris.includes(nativeUri)).toBe(true)
    })
  })

  describe('Multiple Blockers', () => {
    it('should require all native blockers to be closed', async () => {
      // Create two blockers
      const blocker1 = await agent.createIssue('Blocker 1')
      const blocker2 = await agent.createIssue('Blocker 2')

      // Create issue blocked by both
      const issue = await agent.createIssue('Multi-Blocked Issue')
      await agent.blocks(blocker1.id, issue.id)
      await agent.blocks(blocker2.id, issue.id)

      // Query ready - should NOT include issue
      let ready = await agent.ready()
      expect(ready.some((r) => r.id === issue.id)).toBe(false)

      // Close first blocker
      await agent.closeIssue(blocker1.id)

      // Still not ready (second blocker open)
      ready = await agent.ready()
      expect(ready.some((r) => r.id === issue.id)).toBe(false)

      // Close second blocker
      await agent.closeIssue(blocker2.id)

      // Now should be ready
      ready = await agent.ready()
      expect(ready.some((r) => r.id === issue.id)).toBe(true)
    })

    it('should require all mixed blockers to be closed', async ({ skip }) => {
      if (!system.beadsAvailable) {
        skip()
        return
      }

      // Create a native blocker (open) and external blocker (closed)
      const nativeBlocker = await agent.createIssue('Native Blocker')
      const externalBlocker = await createBeadsTask(system.beadsWorkspace!, 'External Blocker', {
        status: 'closed', // Already closed
      })
      await system.hydratingGraph.hydrate(externalBlocker.uri)

      // Create issue
      const issue = await agent.createIssue('Mixed Blocked Issue')
      const issueUri = `native://${issue.id}`

      // Add nodes to graphology
      system.graphologyAdapter.hydrateNode(issueUri, {
        id: issue.id,
        uuid: '',
        type: 'issue',
        title: issue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const nativeBlockerUri = `native://${nativeBlocker.id}`
      system.graphologyAdapter.hydrateNode(nativeBlockerUri, {
        id: nativeBlocker.id,
        uuid: '',
        type: 'issue',
        title: nativeBlocker.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create blocking edges
      const link1 = await agent.blocks(nativeBlocker.id, issue.id)
      const link2 = await agent.link({
        from_id: externalBlocker.uri,
        to_id: issue.id,
        type: 'blocks',
      })

      // Sync edges to graphology
      system.graphologyAdapter.hydrateEdges(nativeBlockerUri, [
        {
          id: link1.edge_id!,
          uuid: '',
          from_id: nativeBlockerUri,
          to_id: issueUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])
      system.graphologyAdapter.hydrateEdges(externalBlocker.uri, [
        {
          id: link2.edge_id!,
          uuid: '',
          from_id: externalBlocker.uri,
          to_id: issueUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Not ready - native blocker still open (even though external is closed)
      let readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(issueUri)).toBe(false)

      // Close the native blocker (update in storage and graphology)
      await agent.closeIssue(nativeBlocker.id)
      system.graphologyAdapter.hydrateNode(nativeBlockerUri, {
        id: nativeBlocker.id,
        uuid: '',
        type: 'issue',
        title: nativeBlocker.title,
        status: 'closed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Now should be ready (both blockers closed)
      readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(issueUri)).toBe(true)
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

      // Create native issue blocked by this task
      const issue = await agent.createIssue('Blocked by closed')
      const issueUri = `native://${issue.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(issueUri, {
        id: issue.id,
        uuid: '',
        type: 'issue',
        title: issue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: issue.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: issueUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should be ready (blocker has a "closed" status)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(issueUri)).toBe(true)
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

      // Create native issue blocked by this task
      const issue = await agent.createIssue('Blocked by open')
      const issueUri = `native://${issue.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(issueUri, {
        id: issue.id,
        uuid: '',
        type: 'issue',
        title: issue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: issue.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: issueUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should NOT be ready (blocker is open)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(issueUri)).toBe(false)
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

      // Create native issue blocked by this task
      const issue = await agent.createIssue('Blocked by in_progress')
      const issueUri = `native://${issue.id}`

      // Add to graphology
      system.graphologyAdapter.hydrateNode(issueUri, {
        id: issue.id,
        uuid: '',
        type: 'issue',
        title: issue.title,
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Create edge
      const linkResult = await agent.link({
        from_id: beadsTask.uri,
        to_id: issue.id,
        type: 'blocks',
      })

      system.graphologyAdapter.hydrateEdges(beadsTask.uri, [
        {
          id: linkResult.edge_id!,
          uuid: '',
          from_id: beadsTask.uri,
          to_id: issueUri,
          type: 'blocks',
          created_at: new Date().toISOString(),
        },
      ])

      // Should NOT be ready (blocker is in_progress)
      const readyUris = await system.hydratingGraph.ready()
      expect(readyUris.includes(issueUri)).toBe(false)
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Federated Ready Query (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
