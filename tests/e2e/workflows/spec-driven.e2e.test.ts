/**
 * Context-Driven Development Workflow E2E Tests
 *
 * Tests the core workflow: context → task → implement → close
 * This is the fundamental pattern for how agents use OpenTasks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  setupE2ESystem,
  createTestAgent,
  // Assertions
  expectReady,
  expectNotReady,
  // Fixtures
  createTestContext,
  createTestTask,
  createContextWithTasks,
  resetFixtureCounter,
  type E2ESystemContext,
  type TestAgent,
} from '../helpers/index.js'

describe.skipIf(!AGENT_TESTS)('Context-Driven Development Workflow', () => {
  let system: E2ESystemContext
  let agent: TestAgent

  beforeEach(async () => {
    system = await setupE2ESystem({ testName: 'spec-driven' })
    agent = createTestAgent(system.client, {
      name: 'context-agent',
      provider: system.nativeProvider,
    })
    resetFixtureCounter()
  })

  afterEach(async () => {
    await system.stop()
  })

  describe('Basic Context→Task Workflow', () => {
    it('should complete full context→task→close cycle', async () => {
      // 1. Create context with title and content
      const context = await agent.createContext('Authentication Feature', {
        content: 'Implement OAuth2 login flow with Google provider',
        priority: 1,
      })
      expect(context.id).toMatch(/^c-/)
      expect(context.title).toBe('Authentication Feature')

      // 2. Create task
      const task = await agent.createTask('Implement OAuth2 flow')
      expect(task.id).toMatch(/^t-/)
      expect(task.status).toBe('open')

      // 3. Link task to context with 'implements'
      const linkResult = await agent.implements(task.id, context.id)
      expect(linkResult.success).toBe(true)
      expect(linkResult.edge_id).toBeDefined()

      // 4. Query ready → task appears
      await expectReady(agent, task.id)

      // 5. Close task
      const closed = await agent.closeTask(task.id)
      expect(closed.status).toBe('closed')

      // 6. Query ready → task gone (closed tasks not in ready queue)
      await expectNotReady(agent, task.id)
    })

    it('should handle standalone task without context', async () => {
      // Create task without implements link
      const task = await agent.createTask('Quick bug fix')

      // Verify in ready queue
      await expectReady(agent, task.id)

      // Close and verify removal
      await agent.closeTask(task.id)
      await expectNotReady(agent, task.id)
    })
  })

  describe('Multiple Tasks per Context', () => {
    it('should handle multiple tasks implementing one context', async () => {
      // Create context
      const context = await createTestContext(agent, 'Feature Context')

      // Create 3 tasks implementing the context
      const tasks = []
      for (let i = 1; i <= 3; i++) {
        const task = await createTestTask(agent, `Task ${i}`)
        await agent.implements(task.id, context.id)
        tasks.push(task)
      }

      // Verify all 3 in ready queue
      for (const task of tasks) {
        await expectReady(agent, task.id)
      }

      // Close one by one, verify queue shrinks
      await agent.closeTask(tasks[0].id)
      await expectNotReady(agent, tasks[0].id)
      await expectReady(agent, tasks[1].id)
      await expectReady(agent, tasks[2].id)

      await agent.closeTask(tasks[1].id)
      await expectNotReady(agent, tasks[1].id)
      await expectReady(agent, tasks[2].id)

      await agent.closeTask(tasks[2].id)
      await expectNotReady(agent, tasks[2].id)
    })

    it('should create context with tasks using fixture helper', async () => {
      const { context, tasks } = await createContextWithTasks(agent, 3, 'Multi-task Feature')

      expect(context.title).toContain('Multi-task Feature')
      expect(tasks).toHaveLength(3)

      // All tasks should be ready
      for (const task of tasks) {
        await expectReady(agent, task.id)
      }
    })
  })

  describe('Task Status Filtering', () => {
    it('should query tasks by status', async () => {
      // Create multiple tasks with different statuses
      const openTask = await agent.createTask('Open Task', { status: 'open' })
      const inProgressTask = await agent.createTask('In Progress Task', { status: 'in_progress' })
      const closedTask = await agent.createTask('Closed Task', { status: 'open' })
      await agent.closeTask(closedTask.id)

      // Query ready - returns only 'open' status tasks (not in_progress or closed)
      const ready = await agent.ready()
      const readyIds = ready.map(r => r.id)

      expect(readyIds).toContain(openTask.id)
      // Note: in_progress tasks are NOT in the ready queue - they're being worked on
      expect(readyIds).not.toContain(inProgressTask.id)
      expect(readyIds).not.toContain(closedTask.id)
    })

    it('should track task status changes', async () => {
      const task = await agent.createTask('Status Test')

      // Initial status
      let node = await agent.getNode(task.id)
      expect(node?.status).toBe('open')

      // Update to in_progress
      await agent.updateNode(task.id, { status: 'in_progress' })
      node = await agent.getNode(task.id)
      expect(node?.status).toBe('in_progress')

      // Update to closed
      await agent.closeTask(task.id)
      node = await agent.getNode(task.id)
      expect(node?.status).toBe('closed')
    })
  })

  describe('Task Priority', () => {
    it('should store and retrieve tasks with different priorities', async () => {
      // Create tasks with different priorities (0 = highest, 4 = lowest)
      const lowPriority = await agent.createTask('Low Priority', { priority: 4 })
      const highPriority = await agent.createTask('High Priority', { priority: 0 })
      const medPriority = await agent.createTask('Medium Priority', { priority: 2 })

      // Query ready - all tasks should be included
      const ready = await agent.ready()
      const readyIds = ready.map(r => r.id)

      expect(readyIds).toContain(lowPriority.id)
      expect(readyIds).toContain(highPriority.id)
      expect(readyIds).toContain(medPriority.id)

      // Verify priorities are preserved on retrieval
      const low = ready.find(r => r.id === lowPriority.id)
      const high = ready.find(r => r.id === highPriority.id)
      const med = ready.find(r => r.id === medPriority.id)

      expect(low?.priority).toBe(4)
      expect(high?.priority).toBe(0)
      expect(med?.priority).toBe(2)
    })

    it('should update task priority', async () => {
      const task = await agent.createTask('Priority Test', { priority: 2 })
      expect(task.priority).toBe(2)

      // Update priority
      const updated = await agent.updateNode(task.id, { priority: 0 })
      expect(updated.priority).toBe(0)
    })
  })

  describe('Context Content and Metadata', () => {
    it('should preserve context content through retrieval', async () => {
      const content = `
## Overview
This is a detailed specification.

## Requirements
- Requirement 1
- Requirement 2

## Acceptance Criteria
- [ ] Criteria 1
- [ ] Criteria 2
      `.trim()

      const context = await agent.createContext('Detailed Context', { content })
      const retrieved = await agent.getNode(context.id)

      expect(retrieved?.content).toBe(content)
    })

    it('should update context content', async () => {
      const context = await agent.createContext('Editable Context', {
        content: 'Initial content',
      })

      const updated = await agent.updateNode(context.id, {
        content: 'Updated content with more details',
      })

      expect(updated.content).toBe('Updated content with more details')
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('Context-Driven Development Workflow (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
