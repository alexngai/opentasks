/**
 * E2E Infrastructure Smoke Tests
 *
 * Verifies that the E2E test infrastructure is working correctly.
 * These tests ensure system setup, client connection, and teardown work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  withE2ESystem,
  createTestAgent,
  createMultiAgents,
  // Assertions
  expectReady,
  expectNotReady,
  expectBlocks,
  expectBlockers,
  // Fixtures
  createTestContext,
  createTestTask,
  createBlockingChain,
  createDiamondDependency,
  createContextWithTasks,
  resetFixtureCounter,
  type E2ESystemContext,
  type TestAgent,
} from './helpers/index.js'

describe.skipIf(!AGENT_TESTS)('E2E Infrastructure', () => {
  describe('System Setup/Teardown', () => {
    it('should create and stop a system successfully', async () => {
      const system = await setupE2ESystem({ testName: 'infra-basic' })

      expect(system.rootDir).toBeDefined()
      expect(system.openTasksDir).toContain('.opentasks')
      expect(system.socketPath).toContain('daemon.sock')
      expect(system.server).toBeDefined()
      expect(system.store).toBeDefined()
      expect(system.client).toBeDefined()
      expect(system.client.connected).toBe(true)

      await system.stop()

      // After stop, client should be disconnected
      expect(system.client.connected).toBe(false)
    })

    it('should work with withE2ESystem helper', async () => {
      let capturedSystem: E2ESystemContext | null = null

      await withE2ESystem({ testName: 'infra-with' }, async (system) => {
        capturedSystem = system
        expect(system.client.connected).toBe(true)
      })

      // System should be cleaned up after withE2ESystem returns
      expect(capturedSystem!.client.connected).toBe(false)
    })

    it('should have storage paths configured', async () => {
      await withE2ESystem({ testName: 'infra-paths' }, async (system) => {
        expect(system.storagePath).toContain('.db')
        expect(system.jsonlPath).toContain('.jsonl')
      })
    })
  })

  describe('Client Connection', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-client' })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should connect a client successfully', async () => {
      expect(system.client.connected).toBe(true)
    })

    it('should support creating additional clients', async () => {
      const client2 = await system.createClient('client2')

      expect(client2.connected).toBe(true)
      expect(system.client.connected).toBe(true)

      client2.disconnect()
      expect(client2.connected).toBe(false)
      expect(system.client.connected).toBe(true) // Original still connected
    })

    it('should handle multiple concurrent clients', async () => {
      const clients = await Promise.all([
        system.createClient('c1'),
        system.createClient('c2'),
        system.createClient('c3'),
      ])

      expect(clients).toHaveLength(3)
      expect(clients.every(c => c.connected)).toBe(true)

      // Clean up
      clients.forEach(c => c.disconnect())
    })
  })

  describe('TestAgent', () => {
    let system: E2ESystemContext
    let agent: TestAgent

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-agent' })
      agent = createTestAgent(system.client, { name: 'test-agent' })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should create agent with name', () => {
      expect(agent.name).toBe('test-agent')
    })

    it('should expose underlying client', () => {
      expect(agent.client).toBe(system.client)
    })

    it('should support query operations', async () => {
      // Query for ready items (empty system should have none)
      const ready = await agent.ready()
      expect(Array.isArray(ready)).toBe(true)
    })

    it('should support verbose mode', async () => {
      // This just ensures verbose mode doesn't break anything
      const verboseAgent = createTestAgent(system.client, {
        name: 'verbose-agent',
        verbose: false // Set to true manually for debugging
      })

      const ready = await verboseAgent.ready()
      expect(Array.isArray(ready)).toBe(true)
    })
  })

  describe('TestAgent with Provider', () => {
    let system: E2ESystemContext
    let agent: TestAgent

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-agent-provider' })
      agent = createTestAgent(system.client, {
        name: 'provider-agent',
        provider: system.nativeProvider,
      })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should create context via provider', async () => {
      const context = await agent.createContext('Test Context', {
        content: 'This is the context content',
        priority: 2,
      })

      expect(context.id).toMatch(/^c-/)
      expect(context.title).toBe('Test Context')
      expect(context.type).toBe('context')
      expect(context.content).toBe('This is the context content')
      expect(context.priority).toBe(2)
    })

    it('should create task via provider with default status', async () => {
      const task = await agent.createTask('Test Task')

      expect(task.id).toMatch(/^t-/)
      expect(task.title).toBe('Test Task')
      expect(task.type).toBe('task')
      expect(task.status).toBe('open')
    })

    it('should create task with custom status', async () => {
      const task = await agent.createTask('In Progress Task', {
        status: 'in_progress',
        priority: 1,
      })

      expect(task.status).toBe('in_progress')
      expect(task.priority).toBe(1)
    })

    it('should get node by ID', async () => {
      const created = await agent.createContext('Get Test Context')
      const retrieved = await agent.getNode(created.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
      expect(retrieved!.title).toBe('Get Test Context')
    })

    it('should update node via provider', async () => {
      const context = await agent.createContext('Original Title')
      const updated = await agent.updateNode(context.id, {
        title: 'Updated Title',
        content: 'New content',
      })

      expect(updated.title).toBe('Updated Title')
      expect(updated.content).toBe('New content')
    })

    it('should close task via convenience method', async () => {
      const task = await agent.createTask('Task to Close')
      expect(task.status).toBe('open')

      const closed = await agent.closeTask(task.id)
      expect(closed.status).toBe('closed')
    })

    it('should throw error when provider not configured', async () => {
      const agentWithoutProvider = createTestAgent(system.client, { name: 'no-provider' })

      await expect(agentWithoutProvider.createContext('Should Fail')).rejects.toThrow(
        "Agent 'no-provider' requires a provider for node operations"
      )
    })
  })

  describe('Multi-Agent Setup', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-multi' })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should create multiple named agents', async () => {
      const { agents, get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['planner', 'implementer', 'reviewer']
      )

      expect(agents.size).toBe(3)
      expect(get('planner').name).toBe('planner')
      expect(get('implementer').name).toBe('implementer')
      expect(get('reviewer').name).toBe('reviewer')

      disconnectAll()
    })

    it('should throw for unknown agent name', async () => {
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['agent1']
      )

      expect(() => get('unknown')).toThrow("Agent 'unknown' not found")

      disconnectAll()
    })

    it('should allow agents to operate independently', async () => {
      const { get, disconnectAll } = await createMultiAgents(
        () => system.createClient(),
        ['agent1', 'agent2']
      )

      // Both agents can query independently
      const [ready1, ready2] = await Promise.all([
        get('agent1').ready(),
        get('agent2').ready(),
      ])

      expect(Array.isArray(ready1)).toBe(true)
      expect(Array.isArray(ready2)).toBe(true)

      disconnectAll()
    })
  })

  describe('IPC Server', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-ipc' })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should track connection count', async () => {
      const initialCount = system.server.getConnectionCount()
      expect(initialCount).toBeGreaterThanOrEqual(1) // Main client

      const client2 = await system.createClient()
      expect(system.server.getConnectionCount()).toBe(initialCount + 1)

      client2.disconnect()
      // Give time for disconnect to propagate
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(system.server.getConnectionCount()).toBe(initialCount)
    })
  })

  describe('Provider Registry', () => {
    let system: E2ESystemContext

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-provider' })
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should expose provider registry', () => {
      expect(system.providerRegistry).toBeDefined()
      expect(system.providerRegistry.list()).toHaveLength(1)
    })

    it('should expose native provider', () => {
      expect(system.nativeProvider).toBeDefined()
      expect(system.nativeProvider.name).toBe('native')
      expect(system.nativeProvider.capabilities.read).toBe(true)
      expect(system.nativeProvider.capabilities.write).toBe(true)
    })

    it('should resolve native IDs via registry', () => {
      const provider = system.providerRegistry.resolveProvider('c-test1')
      expect(provider).toBe(system.nativeProvider)
    })

    it('should create contexts via native provider', async () => {
      const context = await system.nativeProvider.create({
        type: 'context',
        title: 'Test Context',
        content: 'Test content',
      })

      expect(context.id).toMatch(/^c-/)
      expect(context.title).toBe('Test Context')
      expect(context.type).toBe('context')
    })

    it('should create tasks via native provider', async () => {
      const task = await system.nativeProvider.create({
        type: 'task',
        title: 'Test Task',
        status: 'open',
      })

      expect(task.id).toMatch(/^t-/)
      expect(task.title).toBe('Test Task')
      expect(task.type).toBe('task')
    })

    it('should update nodes via native provider', async () => {
      const task = await system.nativeProvider.create({
        type: 'task',
        title: 'Original Title',
        status: 'open',
      })

      const updated = await system.nativeProvider.update(task.id, {
        title: 'Updated Title',
        status: 'closed',
      })

      expect(updated.title).toBe('Updated Title')
      expect(updated.status).toBe('closed')
    })

    it('should get nodes via native provider', async () => {
      const created = await system.nativeProvider.create({
        type: 'context',
        title: 'Get Test',
      })

      const retrieved = await system.nativeProvider.get(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
      expect(retrieved!.title).toBe('Get Test')
    })
  })

  describe('Fixture Helpers', () => {
    let system: E2ESystemContext
    let agent: TestAgent

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-fixtures' })
      agent = createTestAgent(system.client, {
        name: 'fixture-agent',
        provider: system.nativeProvider,
      })
      resetFixtureCounter()
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should create test context with unique name', async () => {
      const context1 = await createTestContext(agent, 'Feature A')
      const context2 = await createTestContext(agent, 'Feature B')

      expect(context1.title).toContain('Feature A')
      expect(context2.title).toContain('Feature B')
      expect(context1.id).not.toBe(context2.id)
    })

    it('should create test task with unique name', async () => {
      const task1 = await createTestTask(agent)
      const task2 = await createTestTask(agent)

      expect(task1.id).not.toBe(task2.id)
      expect(task1.status).toBe('open')
    })

    it('should create blocking chain', async () => {
      const [a, b, c] = await createBlockingChain(agent, 3)

      // Verify chain structure
      const aBlocking = await agent.blocking(a.id)
      expect(aBlocking.some(n => n.id === b.id)).toBe(true)

      const bBlocking = await agent.blocking(b.id)
      expect(bBlocking.some(n => n.id === c.id)).toBe(true)
    })

    it('should create diamond dependency', async () => {
      const { top, left, right, bottom } = await createDiamondDependency(agent)

      // Verify diamond structure
      const topBlocking = await agent.blocking(top.id)
      expect(topBlocking.length).toBe(2)

      const bottomBlockers = await agent.blockers(bottom.id)
      expect(bottomBlockers.length).toBe(2)
    })

    it('should create context with implementing tasks', async () => {
      const { context, tasks } = await createContextWithTasks(agent, 3, 'Auth')

      expect(context.title).toContain('Auth')
      expect(tasks).toHaveLength(3)
    })
  })

  describe('Assertion Helpers', () => {
    let system: E2ESystemContext
    let agent: TestAgent

    beforeEach(async () => {
      system = await setupE2ESystem({ testName: 'infra-assertions' })
      agent = createTestAgent(system.client, {
        name: 'assertion-agent',
        provider: system.nativeProvider,
      })
      resetFixtureCounter()
    })

    afterEach(async () => {
      await system.stop()
    })

    it('should pass expectReady for unblocked task', async () => {
      const task = await createTestTask(agent)
      await expectReady(agent, task.id)
    })

    it('should pass expectNotReady for blocked task', async () => {
      const [blocker, blocked] = await createBlockingChain(agent, 2)
      await expectNotReady(agent, blocked.id)
    })

    it('should fail expectReady for blocked task', async () => {
      const [_, blocked] = await createBlockingChain(agent, 2)

      await expect(expectReady(agent, blocked.id)).rejects.toThrow(
        /Expected issue.*to be ready/
      )
    })

    it('should pass expectBlocks for existing edge', async () => {
      const [blocker, blocked] = await createBlockingChain(agent, 2)
      await expectBlocks(agent, blocker.id, blocked.id)
    })

    it('should pass expectBlockers for correct blockers', async () => {
      const { top, left } = await createDiamondDependency(agent)
      await expectBlockers(agent, left.id, [top.id])
    })

    it('should fail expectBlockers for wrong blockers', async () => {
      const task = await createTestTask(agent)

      await expect(expectBlockers(agent, task.id, ['c-fake'])).rejects.toThrow(
        /Missing blockers/
      )
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('E2E Infrastructure (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
