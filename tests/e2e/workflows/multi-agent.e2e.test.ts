/**
 * Multi-Agent Coordination E2E Tests
 *
 * Tests coordination patterns between multiple agents using blocking dependencies.
 * This validates the core multi-agent use case of OpenTasks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createTestAgent,
  createMultiAgents,
  // Assertions
  expectReady,
  expectNotReady,
  expectBlocks,
  expectBlockers,
  // Fixtures
  createTestTask,
  createBlockingChain,
  createDiamondDependency,
  resetFixtureCounter,
  type E2ESystemContext,
  type TestAgent,
} from '../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Multi-Agent Coordination', () => {
  let system: E2ESystemContext

  beforeEach(async () => {
    system = await setupE2ESystem({ testName: 'multi-agent' })
    resetFixtureCounter()
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Sequential Blocking', () => {
    it('should coordinate via sequential blocking', async () => {
      // Create two agents
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['agent1', 'agent2'],
        { provider: system.nativeProvider }
      )

      const agent1 = get('agent1')
      const agent2 = get('agent2')

      // Agent1 creates foundation task
      const foundation = await agent1.createTask('Foundation Work')

      // Agent1 creates dependent task blocked by foundation
      const dependent = await agent1.createTask('Dependent Work')
      await agent1.blocks(foundation.id, dependent.id)

      // Agent2 queries ready → sees only foundation
      await expectReady(agent2, foundation.id)
      await expectNotReady(agent2, dependent.id)

      // Agent1 closes foundation
      await agent1.closeTask(foundation.id)

      // Agent2 queries ready → now sees dependent
      await expectReady(agent2, dependent.id)

      disconnectAll()
    })

    it('should allow cross-agent blocking', async () => {
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['agent1', 'agent2'],
        { provider: system.nativeProvider }
      )

      const agent1 = get('agent1')
      const agent2 = get('agent2')

      // Agent1 creates task X
      const taskX = await agent1.createTask('Task X')

      // Agent2 creates task Y, then blocks Y with X
      const taskY = await agent2.createTask('Task Y')
      await agent2.blocks(taskX.id, taskY.id)

      // Agent2 queries ready → Y not present (blocked by X)
      await expectNotReady(agent2, taskY.id)

      // Agent1 closes X
      await agent1.closeTask(taskX.id)

      // Agent2 queries ready → Y now present
      await expectReady(agent2, taskY.id)

      disconnectAll()
    })
  })

  describe('Diamond Dependency', () => {
    it('should handle diamond dependency correctly', async () => {
      const agent = createTestAgent(system.client, {
        name: 'diamond-agent',
        provider: system.nativeProvider,
      })

      // Create diamond using fixture helper
      const { top, left, right, bottom } = await createDiamondDependency(agent)

      // Verify only top (A) is ready initially
      await expectReady(agent, top.id)
      await expectNotReady(agent, left.id)
      await expectNotReady(agent, right.id)
      await expectNotReady(agent, bottom.id)

      // Close A → B and C become ready
      await agent.closeTask(top.id)
      await expectReady(agent, left.id)
      await expectReady(agent, right.id)
      await expectNotReady(agent, bottom.id)

      // Close B → D still blocked (waiting for C)
      await agent.closeTask(left.id)
      await expectNotReady(agent, bottom.id)

      // Close C → D becomes ready
      await agent.closeTask(right.id)
      await expectReady(agent, bottom.id)
    })

    it('should track multiple blockers correctly', async () => {
      const agent = createTestAgent(system.client, {
        name: 'blocker-agent',
        provider: system.nativeProvider,
      })

      const { top, left, right, bottom } = await createDiamondDependency(agent)

      // Bottom should have both left and right as blockers
      await expectBlockers(agent, bottom.id, [left.id, right.id])

      // Left and right should each have top as blocker
      await expectBlockers(agent, left.id, [top.id])
      await expectBlockers(agent, right.id, [top.id])

      // Top should have no blockers
      await expectBlockers(agent, top.id, [])
    })
  })

  describe('Concurrent Operations', () => {
    it('should handle concurrent task creation', async () => {
      // 3 agents create tasks simultaneously via Promise.all
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['agent1', 'agent2', 'agent3'],
        { provider: system.nativeProvider }
      )

      const tasks = await Promise.all([
        get('agent1').createTask('Task from Agent 1'),
        get('agent2').createTask('Task from Agent 2'),
        get('agent3').createTask('Task from Agent 3'),
      ])

      // Verify all tasks have unique IDs
      const ids = tasks.map(i => i.id)
      expect(new Set(ids).size).toBe(3)

      // Verify all appear in ready queue
      const agent = get('agent1')
      for (const task of tasks) {
        await expectReady(agent, task.id)
      }

      disconnectAll()
    })

    it('should handle concurrent blocking operations', async () => {
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['creator', 'blocker'],
        { provider: system.nativeProvider }
      )

      const creator = get('creator')
      const blocker = get('blocker')

      // Creator creates multiple tasks
      const tasks = await Promise.all([
        creator.createTask('Task A'),
        creator.createTask('Task B'),
        creator.createTask('Task C'),
      ])

      // Blocker creates blocking relationships concurrently
      // A blocks B, B blocks C (chain)
      await Promise.all([
        blocker.blocks(tasks[0].id, tasks[1].id),
        blocker.blocks(tasks[1].id, tasks[2].id),
      ])

      // Verify chain structure
      await expectReady(blocker, tasks[0].id)
      await expectNotReady(blocker, tasks[1].id)
      await expectNotReady(blocker, tasks[2].id)

      disconnectAll()
    })
  })

  describe('Transitive Blocking Queries', () => {
    it('should support transitive blocking queries', async () => {
      const agent = createTestAgent(system.client, {
        name: 'transitive-agent',
        provider: system.nativeProvider,
      })

      // Create chain: A blocks B blocks C
      const [a, b, c] = await createBlockingChain(agent, 3)

      // Query blockers for C with transitive=true
      const transitiveBlockers = await agent.blockers(c.id, { transitive: true })
      const transitiveIds = transitiveBlockers.map(n => n.id)

      // Should include both A and B
      expect(transitiveIds).toContain(a.id)
      expect(transitiveIds).toContain(b.id)

      // Query blockers for C with transitive=false (default)
      const directBlockers = await agent.blockers(c.id, { transitive: false })
      const directIds = directBlockers.map(n => n.id)

      // Should only include B (direct blocker)
      expect(directIds).toContain(b.id)
      expect(directIds).not.toContain(a.id)
    })

    it('should support transitive blocking (what node blocks)', async () => {
      const agent = createTestAgent(system.client, {
        name: 'blocking-agent',
        provider: system.nativeProvider,
      })

      // Create chain: A blocks B blocks C
      const [a, b, c] = await createBlockingChain(agent, 3)

      // Query what A is blocking with transitive=true
      const transitiveBlocking = await agent.blocking(a.id, { transitive: true })
      const transitiveIds = transitiveBlocking.map(n => n.id)

      // Should include both B and C
      expect(transitiveIds).toContain(b.id)
      expect(transitiveIds).toContain(c.id)

      // Query what A is blocking with transitive=false (default)
      const directBlocking = await agent.blocking(a.id, { transitive: false })
      const directIds = directBlocking.map(n => n.id)

      // Should only include B (direct)
      expect(directIds).toContain(b.id)
      expect(directIds).not.toContain(c.id)
    })
  })

  describe('Agent Isolation', () => {
    it('should maintain agent isolation with shared state', async () => {
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['reader', 'writer'],
        { provider: system.nativeProvider }
      )

      const reader = get('reader')
      const writer = get('writer')

      // Writer creates a task
      const task = await writer.createTask('Shared Task')

      // Reader can see it immediately (shared state)
      const ready = await reader.ready()
      expect(ready.some(r => r.id === task.id)).toBe(true)

      // Writer closes it
      await writer.closeTask(task.id)

      // Reader sees the update
      const readyAfter = await reader.ready()
      expect(readyAfter.some(r => r.id === task.id)).toBe(false)

      disconnectAll()
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('Multi-Agent Coordination (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
