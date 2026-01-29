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
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('E2E Infrastructure (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
