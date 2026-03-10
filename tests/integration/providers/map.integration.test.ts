/**
 * MAP Provider & Event Bridge Integration Tests
 *
 * Tests the MAP provider and event bridge against a real in-memory task store
 * (no mocking of the MAPTaskClient). Validates:
 *
 * - Full CRUD lifecycle through the MAP provider
 * - TaskManageable trait (transitions, ready queries, assignment, valid actions)
 * - Watchable trait (task events flow through to watchers)
 * - Event bridge emission from provider changes
 * - Bidirectional flow: provider changes → bridge → MAP events
 * - Echo prevention and origin stamping
 * - Status mapping between OpenTasks and MAP
 *
 * Run with: RUN_SLOW_TESTS=1 npx vitest run tests/integration/providers/map.integration.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createMAPProvider, type MAPTaskClient, type MAPTask, type MAPTaskStatus, type MAPTaskEvent } from '../../../src/providers/map.js'
import { createMAPEventBridge, type MAPEventBridge } from '../../../src/providers/map-event-bridge.js'
import { isTaskManageable } from '../../../src/providers/traits/TaskManageable.js'
import { isWatchable } from '../../../src/providers/traits/Watchable.js'
import type { ProviderChangeEvent } from '../../../src/providers/traits/Watchable.js'
import { SLOW_TESTS } from '../helpers/index.js'

// ============================================================================
// In-Memory MAP Task Store
//
// A real task store that behaves like a MAP server. No mocking — actual
// state management, ID generation, and event emission.
// ============================================================================

let nextId = 1

function createInMemoryTaskStore(): {
  client: MAPTaskClient
  tasks: Map<string, MAPTask>
  events: MAPTaskEvent[]
} {
  const tasks = new Map<string, MAPTask>()
  const eventCallbacks: Array<(event: MAPTaskEvent) => void> = []
  const events: MAPTaskEvent[] = []

  function emitEvent(event: MAPTaskEvent) {
    events.push(event)
    for (const cb of eventCallbacks) {
      cb(event)
    }
  }

  const client: MAPTaskClient = {
    async createTask(params) {
      const id = params.task.id ?? `task-${nextId++}`
      const task: MAPTask = {
        id,
        title: params.task.title,
        status: params.task.status ?? 'open',
        description: params.task.description,
        assignee: params.task.assignee,
        meta: params.task.meta,
      }
      tasks.set(id, task)

      emitEvent({
        type: 'task.created',
        data: { task: { ...task } },
      })

      return { task: { ...task } }
    },

    async assignTask(taskId, agentId) {
      const task = tasks.get(taskId)
      if (!task) throw new Error(`Task not found: ${taskId}`)

      task.assignee = agentId
      tasks.set(taskId, task)

      emitEvent({
        type: 'task.assigned',
        data: { taskId, agentId },
      })

      return { task: { ...task } }
    },

    async updateTask(params) {
      const task = tasks.get(params.taskId)
      if (!task) throw new Error(`Task not found: ${params.taskId}`)

      const previousStatus = task.status

      if (params.title !== undefined) task.title = params.title
      if (params.description !== undefined) task.description = params.description
      if (params.status !== undefined) task.status = params.status
      if (params.assignee !== undefined) task.assignee = params.assignee
      if (params.meta !== undefined) task.meta = { ...task.meta, ...params.meta }
      tasks.set(params.taskId, task)

      if (params.status !== undefined && params.status !== previousStatus) {
        emitEvent({
          type: 'task.status',
          data: {
            taskId: params.taskId,
            previous: previousStatus ?? 'open',
            current: params.status,
          },
        })

        if (params.status === 'completed' || params.status === 'failed') {
          emitEvent({
            type: 'task.completed',
            data: { taskId: params.taskId },
          })
        }
      }

      return { task: { ...task } }
    },

    async listTasks(params) {
      let result = Array.from(tasks.values())

      if (params?.filter?.status) {
        const statuses = Array.isArray(params.filter.status)
          ? params.filter.status
          : [params.filter.status]
        result = result.filter((t) => statuses.includes(t.status!))
      }
      if (params?.filter?.assignee) {
        result = result.filter((t) => t.assignee === params.filter!.assignee)
      }
      if (params?.limit) {
        result = result.slice(0, params.limit)
      }

      return {
        tasks: result.map((t) => ({ ...t })),
        hasMore: false,
      }
    },

    onTaskEvent(callback) {
      eventCallbacks.push(callback)
      return () => {
        const idx = eventCallbacks.indexOf(callback)
        if (idx >= 0) eventCallbacks.splice(idx, 1)
      }
    },
  }

  return { client, tasks, events }
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!SLOW_TESTS)('MAP Provider Integration', () => {
  let store: ReturnType<typeof createInMemoryTaskStore>
  let provider: ReturnType<typeof createMAPProvider>

  beforeEach(() => {
    nextId = 1
    store = createInMemoryTaskStore()
    provider = createMAPProvider({ client: store.client, systemId: 'test' })
  })

  // ==========================================================================
  // Provider Metadata
  // ==========================================================================

  describe('metadata', () => {
    it('should have correct name and schemes', () => {
      expect(provider.name).toBe('map')
      expect(provider.schemes).toEqual(['map'])
    })

    it('should have correct capabilities', () => {
      expect(provider.capabilities.read).toBe(true)
      expect(provider.capabilities.write).toBe(true)
      expect(provider.capabilities.search).toBe(false)
      expect(provider.capabilities.watch).toBe(true)
    })

    it('should be detected as TaskManageable', () => {
      expect(isTaskManageable(provider)).toBe(true)
    })

    it('should be detected as Watchable when client supports events', () => {
      expect(isWatchable(provider as any)).toBe(true)
    })

    it('should not be Watchable when client lacks onTaskEvent', () => {
      const { onTaskEvent, ...clientWithoutEvents } = store.client
      const p = createMAPProvider({ client: clientWithoutEvents as MAPTaskClient })
      expect(isWatchable(p as any)).toBe(false)
    })
  })

  // ==========================================================================
  // URI Operations
  // ==========================================================================

  describe('URI operations', () => {
    it('should parse map:// URIs with system ID', () => {
      const parsed = provider.parseUri('map://test/task-123')
      expect(parsed).toEqual({
        scheme: 'map',
        workspace: 'test',
        id: 'task-123',
        isRelative: true,
      })
    })

    it('should parse map:// URIs with different system ID', () => {
      const parsed = provider.parseUri('map://other-system/task-456')
      expect(parsed).toEqual({
        scheme: 'map',
        workspace: 'other-system',
        id: 'task-456',
        isRelative: false,
      })
    })

    it('should build canonical URIs', () => {
      expect(provider.buildUri('task-abc')).toBe('map://test/task-abc')
    })

    it('should validate URIs', () => {
      expect(provider.isValidUri('map://test/task-1')).toBe(true)
      expect(provider.isValidUri('native://task-1')).toBe(false)
      expect(provider.isValidUri('not-a-uri')).toBe(false)
    })
  })

  // ==========================================================================
  // CRUD Operations
  // ==========================================================================

  describe('CRUD', () => {
    it('should create a task and return a ProviderNode', async () => {
      const node = await provider.create({
        type: 'issue',
        title: 'Test Task',
        content: 'Do the thing',
        status: 'open',
        priority: 1,
      })

      expect(node.id).toBeDefined()
      expect(node.uri).toMatch(/^map:\/\/test\//)
      expect(node.type).toBe('task')
      expect(node.title).toBe('Test Task')
      expect(node.content).toBe('Do the thing')
      expect(node.status).toBe('open')

      // Verify in the underlying store
      expect(store.tasks.size).toBe(1)
    })

    it('should list tasks', async () => {
      await provider.create({ type: 'issue', title: 'Task A', status: 'open' })
      await provider.create({ type: 'issue', title: 'Task B', status: 'open' })
      await provider.create({ type: 'issue', title: 'Task C', status: 'in_progress' })

      const all = await provider.list()
      expect(all).toHaveLength(3)

      const openOnly = await provider.list({ status: 'open' })
      expect(openOnly).toHaveLength(2)
      expect(openOnly.every((n) => n.status === 'open')).toBe(true)
    })

    it('should get a task by ID', async () => {
      const created = await provider.create({ type: 'issue', title: 'Find Me' })

      const found = await provider.get(created.id)
      expect(found).not.toBeNull()
      expect(found!.title).toBe('Find Me')
    })

    it('should get a task by URI', async () => {
      const created = await provider.create({ type: 'issue', title: 'By URI' })

      const found = await provider.get(created.uri)
      expect(found).not.toBeNull()
      expect(found!.title).toBe('By URI')
    })

    it('should return null for nonexistent task', async () => {
      const found = await provider.get('nonexistent-id')
      expect(found).toBeNull()
    })

    it('should update a task', async () => {
      const created = await provider.create({ type: 'issue', title: 'Original', status: 'open' })

      const updated = await provider.update(created.id, {
        title: 'Updated',
        status: 'in_progress',
      })

      expect(updated.title).toBe('Updated')
      expect(updated.status).toBe('in_progress')

      // Verify underlying store
      const raw = store.tasks.get(created.id)!
      expect(raw.title).toBe('Updated')
      expect(raw.status).toBe('in_progress')
    })

    it('should delete a task by marking as failed', async () => {
      const created = await provider.create({ type: 'issue', title: 'To Delete', status: 'open' })

      await provider.delete(created.id)

      const raw = store.tasks.get(created.id)!
      expect(raw.status).toBe('failed')
      expect(raw.meta?.deleted).toBe(true)
    })
  })

  // ==========================================================================
  // Status Mapping
  // ==========================================================================

  describe('status mapping', () => {
    it('should map OpenTasks closed → MAP completed on create', async () => {
      await provider.create({ type: 'issue', title: 'Closed', status: 'closed' })
      const raw = Array.from(store.tasks.values())[0]
      expect(raw.status).toBe('completed')
    })

    it('should map MAP completed → OpenTasks closed on list', async () => {
      await store.client.createTask({ task: { title: 'Done', status: 'completed' } })
      const nodes = await provider.list()
      expect(nodes[0].status).toBe('closed')
    })

    it('should map MAP failed → OpenTasks closed on list', async () => {
      await store.client.createTask({ task: { title: 'Failed', status: 'failed' } })
      const nodes = await provider.list()
      expect(nodes[0].status).toBe('closed')
    })

    it('should preserve open, in_progress, blocked status', async () => {
      for (const status of ['open', 'in_progress', 'blocked'] as const) {
        await store.client.createTask({ task: { title: status, status } })
      }
      const nodes = await provider.list()
      const statuses = nodes.map((n) => n.status).sort()
      expect(statuses).toEqual(['blocked', 'in_progress', 'open'])
    })
  })

  // ==========================================================================
  // TaskManageable Trait
  // ==========================================================================

  describe('TaskManageable', () => {
    it('should declare correct capabilities', () => {
      expect(provider.taskCapabilities.actions).toEqual(
        expect.arrayContaining(['start', 'complete', 'block', 'reopen', 'close']),
      )
      expect(provider.taskCapabilities.supportsAssignment).toBe(true)
      expect(provider.taskCapabilities.supportsReadyQuery).toBe(true)
    })

    describe('transitionTask', () => {
      it('should start a task (open → in_progress)', async () => {
        const node = await provider.create({ type: 'issue', title: 'Start Me', status: 'open' })
        const result = await provider.transitionTask(node.id, 'start')
        expect(result.status).toBe('in_progress')

        const raw = store.tasks.get(node.id)!
        expect(raw.status).toBe('in_progress')
      })

      it('should complete a task (in_progress → completed)', async () => {
        const node = await provider.create({ type: 'issue', title: 'Complete Me', status: 'in_progress' })
        const result = await provider.transitionTask(node.id, 'complete')
        expect(result.status).toBe('closed') // mapped from completed

        const raw = store.tasks.get(node.id)!
        expect(raw.status).toBe('completed')
      })

      it('should block a task (open → blocked)', async () => {
        const node = await provider.create({ type: 'issue', title: 'Block Me', status: 'open' })
        const result = await provider.transitionTask(node.id, 'block')
        expect(result.status).toBe('blocked')
      })

      it('should reopen a task', async () => {
        await store.client.createTask({ task: { id: 'reopen-1', title: 'Reopen', status: 'completed' } })
        const result = await provider.transitionTask('reopen-1', 'reopen')
        expect(result.status).toBe('open')
      })

      it('should close a task', async () => {
        const node = await provider.create({ type: 'issue', title: 'Close Me', status: 'open' })
        const result = await provider.transitionTask(node.id, 'close')
        expect(result.status).toBe('closed') // mapped from completed
      })

      it('should accept URI format for task ID', async () => {
        const node = await provider.create({ type: 'issue', title: 'URI Transition', status: 'open' })
        const result = await provider.transitionTask(node.uri, 'start')
        expect(result.status).toBe('in_progress')
      })
    })

    describe('readyTasks', () => {
      it('should return open tasks', async () => {
        await provider.create({ type: 'issue', title: 'Ready', status: 'open' })
        await provider.create({ type: 'issue', title: 'Not Ready', status: 'in_progress' })

        const ready = await provider.readyTasks()
        expect(ready).toHaveLength(1)
        expect(ready[0].title).toBe('Ready')
      })

      it('should filter by assignee', async () => {
        await store.client.createTask({ task: { title: 'Alice', status: 'open', assignee: 'alice' } })
        await store.client.createTask({ task: { title: 'Bob', status: 'open', assignee: 'bob' } })

        const ready = await provider.readyTasks({ assignee: 'alice' })
        expect(ready).toHaveLength(1)
        expect(ready[0].title).toBe('Alice')
      })

      it('should filter by priority', async () => {
        await store.client.createTask({ task: { title: 'High', status: 'open', meta: { priority: 3 } } })
        await store.client.createTask({ task: { title: 'Low', status: 'open', meta: { priority: 1 } } })

        const ready = await provider.readyTasks({ priority: 2 })
        expect(ready).toHaveLength(1)
        expect(ready[0].title).toBe('High')
      })

      it('should respect limit', async () => {
        for (let i = 0; i < 5; i++) {
          await provider.create({ type: 'issue', title: `Task ${i}`, status: 'open' })
        }

        const ready = await provider.readyTasks({ limit: 3 })
        expect(ready).toHaveLength(3)
      })
    })

    describe('assignTask', () => {
      it('should assign a task to an agent', async () => {
        const node = await provider.create({ type: 'issue', title: 'Assign Me' })
        const result = await provider.assignTask!(node.id, 'agent-alice')

        expect(result.rawData?.assignee).toBe('agent-alice')

        const raw = store.tasks.get(node.id)!
        expect(raw.assignee).toBe('agent-alice')
      })

      it('should reassign a task', async () => {
        await store.client.createTask({
          task: { id: 'reassign-1', title: 'Reassign', assignee: 'alice' },
        })

        const result = await provider.assignTask!('reassign-1', 'bob')
        expect(result.rawData?.assignee).toBe('bob')
      })
    })

    describe('validActions', () => {
      it('should return correct actions for open task', async () => {
        await store.client.createTask({ task: { id: 'va-open', title: 'Open', status: 'open' } })
        const actions = await provider.validActions!('va-open')
        expect(actions).toContain('start')
        expect(actions).toContain('block')
        expect(actions).toContain('close')
      })

      it('should return correct actions for in_progress task', async () => {
        await store.client.createTask({ task: { id: 'va-ip', title: 'IP', status: 'in_progress' } })
        const actions = await provider.validActions!('va-ip')
        expect(actions).toContain('complete')
        expect(actions).toContain('block')
      })

      it('should return correct actions for completed task', async () => {
        await store.client.createTask({ task: { id: 'va-done', title: 'Done', status: 'completed' } })
        const actions = await provider.validActions!('va-done')
        expect(actions).toContain('reopen')
        expect(actions).not.toContain('start')
      })

      it('should return empty for nonexistent task', async () => {
        const actions = await provider.validActions!('nonexistent')
        expect(actions).toEqual([])
      })
    })
  })

  // ==========================================================================
  // Watchable Trait
  // ==========================================================================

  describe('Watchable', () => {
    it('should emit created events', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      await store.client.createTask({ task: { title: 'Watched Create', status: 'open' } })

      expect(events).toHaveLength(1)
      expect(events[0].kind).toBe('node')
      expect(events[0].event.type).toBe('created')
      expect(events[0].event.node?.title).toBe('Watched Create')

      watchable.stopWatching()
    })

    it('should emit status change events', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      await store.client.createTask({ task: { id: 'watched-1', title: 'Watched', status: 'open' } })
      await store.client.updateTask({ taskId: 'watched-1', status: 'in_progress' })

      // created + status change
      expect(events.length).toBeGreaterThanOrEqual(2)
      const statusEvent = events.find(
        (e) => e.kind === 'node' && e.event.type === 'updated',
      )
      expect(statusEvent).toBeDefined()

      watchable.stopWatching()
    })

    it('should emit completed events', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      await store.client.createTask({ task: { id: 'watch-complete', title: 'WC', status: 'in_progress' } })
      await store.client.updateTask({ taskId: 'watch-complete', status: 'completed' })

      // created + status + completed
      const completedEvents = events.filter(
        (e) => e.kind === 'node' && e.event.type === 'updated' && e.event.changedFields?.includes('status'),
      )
      expect(completedEvents.length).toBeGreaterThanOrEqual(1)

      watchable.stopWatching()
    })

    it('should stop emitting after stopWatching', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      await store.client.createTask({ task: { title: 'Before Stop' } })
      expect(events).toHaveLength(1)

      watchable.stopWatching()

      await store.client.createTask({ task: { title: 'After Stop' } })
      expect(events).toHaveLength(1) // No new events
    })
  })

  // ==========================================================================
  // Full Lifecycle
  // ==========================================================================

  describe('full lifecycle', () => {
    it('should handle create → start → complete flow', async () => {
      // Create
      const node = await provider.create({
        type: 'issue',
        title: 'Full Lifecycle Task',
        status: 'open',
      })

      // Verify it appears in ready list
      let ready = await provider.readyTasks()
      expect(ready.some((r) => r.id === node.id)).toBe(true)

      // Start
      const started = await provider.transitionTask(node.id, 'start')
      expect(started.status).toBe('in_progress')

      // No longer ready
      ready = await provider.readyTasks()
      expect(ready.some((r) => r.id === node.id)).toBe(false)

      // Complete
      const completed = await provider.transitionTask(node.id, 'complete')
      expect(completed.status).toBe('closed')

      // Verify underlying MAP status
      const raw = store.tasks.get(node.id)!
      expect(raw.status).toBe('completed')
    })

    it('should handle create → assign → start → block → reopen → complete', async () => {
      const node = await provider.create({
        type: 'issue',
        title: 'Complex Lifecycle',
        status: 'open',
      })

      // Assign
      await provider.assignTask!(node.id, 'agent-alice')

      // Start
      await provider.transitionTask(node.id, 'start')
      expect(store.tasks.get(node.id)!.status).toBe('in_progress')

      // Block
      await provider.transitionTask(node.id, 'block')
      expect(store.tasks.get(node.id)!.status).toBe('blocked')

      // Reopen
      await provider.transitionTask(node.id, 'reopen')
      expect(store.tasks.get(node.id)!.status).toBe('open')

      // Start and complete
      await provider.transitionTask(node.id, 'start')
      await provider.transitionTask(node.id, 'complete')
      expect(store.tasks.get(node.id)!.status).toBe('completed')

      // Assignment should persist through transitions
      expect(store.tasks.get(node.id)!.assignee).toBe('agent-alice')
    })

    it('should track events through full lifecycle with Watchable', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      // Create via provider (triggers MAP client which emits events)
      const node = await provider.create({ type: 'issue', title: 'Watched Lifecycle', status: 'open' })

      // Transition via provider → goes to MAP client → emits event → Watchable fires
      await provider.transitionTask(node.id, 'start')
      await provider.transitionTask(node.id, 'complete')

      // Should have: created + status(open→in_progress) + status(in_progress→completed) + completed
      expect(events.length).toBeGreaterThanOrEqual(3)

      const created = events.filter((e) => e.kind === 'node' && e.event.type === 'created')
      const updated = events.filter((e) => e.kind === 'node' && e.event.type === 'updated')
      expect(created).toHaveLength(1)
      expect(updated.length).toBeGreaterThanOrEqual(2)

      watchable.stopWatching()
    })
  })
})

// ============================================================================
// MAP Event Bridge Integration
// ============================================================================

describe.skipIf(!SLOW_TESTS)('MAP Event Bridge Integration', () => {
  let store: ReturnType<typeof createInMemoryTaskStore>
  let provider: ReturnType<typeof createMAPProvider>

  beforeEach(() => {
    nextId = 100
    store = createInMemoryTaskStore()
    provider = createMAPProvider({ client: store.client, systemId: 'test' })
  })

  // ==========================================================================
  // Bridge + Provider Combined Flow
  // ==========================================================================

  describe('provider → bridge → MAP events', () => {
    it('should emit task.created when provider creates a task', async () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
        agentId: 'test-agent',
      })

      // Use the bridge to emit when we create via provider
      const node = await provider.create({ type: 'issue', title: 'Bridge Test', status: 'open' })
      bridge.emitTaskCreated({
        id: node.id,
        title: 'Bridge Test',
        status: 'open',
      })

      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.created')
      expect(sentEvents[0].data.task).toMatchObject({
        id: node.id,
        title: 'Bridge Test',
        status: 'open',
      })
      expect(sentEvents[0].data._origin).toBe('test-agent')

      bridge.stop()
    })

    it('should emit task.status on transitions', async () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const node = await provider.create({ type: 'issue', title: 'Status Bridge', status: 'open' })
      await provider.transitionTask(node.id, 'start')

      // Agent emits the status change
      bridge.emitTaskStatus(node.id, 'open', 'in_progress')

      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.status')
      expect(sentEvents[0].data).toMatchObject({
        taskId: node.id,
        previous: 'open',
        current: 'in_progress',
      })

      bridge.stop()
    })

    it('should emit task.completed on terminal transitions', async () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const node = await provider.create({ type: 'issue', title: 'Complete Bridge', status: 'in_progress' })
      await provider.transitionTask(node.id, 'complete')

      // Agent emits
      bridge.emitTaskStatus(node.id, 'in_progress', 'completed')

      // Should emit both task.status and task.completed
      expect(sentEvents).toHaveLength(2)
      expect(sentEvents[0].type).toBe('task.status')
      expect(sentEvents[1].type).toBe('task.completed')

      bridge.stop()
    })

    it('should emit task.assigned on assignment', async () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const node = await provider.create({ type: 'issue', title: 'Assign Bridge' })
      await provider.assignTask!(node.id, 'agent-bob')

      bridge.emitTaskAssigned(node.id, 'agent-bob')

      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.assigned')
      expect(sentEvents[0].data).toMatchObject({
        taskId: node.id,
        agentId: 'agent-bob',
      })

      bridge.stop()
    })
  })

  // ==========================================================================
  // Watchable → Bridge Integration
  //
  // The most interesting flow: provider's Watchable trait fires events from
  // the underlying MAP client, and those events feed into the bridge's
  // handleProviderChange to emit outbound MAP events.
  //
  // But we need to verify echo prevention — changes from the MAP provider
  // itself should NOT be re-emitted (would cause loops).
  // ==========================================================================

  describe('Watchable → bridge echo prevention', () => {
    it('should skip events from the map provider', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      // Simulate a change event from the map provider
      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-1',
          uri: 'map://test/task-1',
          node: {
            id: 'task-1',
            uri: 'map://test/task-1',
            type: 'task',
            title: 'MAP Origin',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('map', event)

      // Should be empty — echo prevention
      expect(sentEvents).toHaveLength(0)

      bridge.stop()
    })

    it('should forward events from non-map providers', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-native-1',
          uri: 'native://task-native-1',
          node: {
            id: 'task-native-1',
            uri: 'native://task-native-1',
            type: 'task',
            title: 'Native Task',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', event)

      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.created')

      bridge.stop()
    })
  })

  // ==========================================================================
  // Bridge with Shared Connection
  // ==========================================================================

  describe('bridge with shared MAPConnection', () => {
    it('should route events through the shared connection', async () => {
      const sent: Array<{ to: unknown; payload: unknown }> = []

      const connection = {
        send: async (to: unknown, payload: unknown) => {
          sent.push({ to, payload })
        },
      }

      const bridge = createMAPEventBridge({
        connection,
        scope: 'swarm:test',
        agentId: 'agent-alice',
      })

      bridge.emitTaskCreated({ id: 'task-1', title: 'Shared Conn', status: 'open' })

      expect(sent).toHaveLength(1)
      expect(sent[0].to).toEqual({ scope: 'swarm:test' })
      expect(sent[0].payload).toMatchObject({
        type: 'task.created',
        task: { id: 'task-1', title: 'Shared Conn', status: 'open' },
        _origin: 'agent-alice',
      })

      bridge.stop()
    })

    it('should handle full lifecycle through shared connection', async () => {
      const sent: Array<{ to: unknown; payload: unknown }> = []

      const connection = {
        send: async (to: unknown, payload: unknown) => {
          sent.push({ to, payload })
        },
      }

      const bridge = createMAPEventBridge({
        connection,
        scope: 'swarm:test',
      })

      // Full lifecycle
      bridge.emitTaskCreated({ id: 'task-lc', title: 'Lifecycle', status: 'open' })
      bridge.emitTaskAssigned('task-lc', 'agent-bob')
      bridge.emitTaskStatus('task-lc', 'open', 'in_progress')
      bridge.emitTaskStatus('task-lc', 'in_progress', 'completed')

      // created + assigned + status + status + completed (auto from terminal)
      expect(sent).toHaveLength(5)
      expect(sent.map((s) => (s.payload as any).type)).toEqual([
        'task.created',
        'task.assigned',
        'task.status',
        'task.status',
        'task.completed',
      ])

      bridge.stop()
    })

    it('should handle connection send failures gracefully', async () => {
      const connection = {
        send: async () => {
          throw new Error('Connection lost')
        },
      }

      const bridge = createMAPEventBridge({ connection, scope: 'test' })

      // Should not throw
      expect(() => {
        bridge.emitTaskCreated({ id: 'task-1', title: 'Fail Gracefully' })
      }).not.toThrow()

      bridge.stop()
    })
  })

  // ==========================================================================
  // Bridge Filter
  // ==========================================================================

  describe('bridge filtering', () => {
    it('should apply filter to all events', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []

      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
        filter: (eventType) => eventType === 'task.created',
      })

      bridge.emitTaskCreated({ id: 'task-1', title: 'Pass' })
      bridge.emitTaskStatus('task-1', 'open', 'in_progress')
      bridge.emitTaskAssigned('task-1', 'agent')
      bridge.emitTaskCompleted('task-1')

      // Only task.created should pass the filter
      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.created')

      bridge.stop()
    })

    it('should filter handleProviderChange events', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []

      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
        filter: (_eventType, data) => {
          // Only emit events for specific tasks
          const task = data.task as Record<string, unknown> | undefined
          return task?.id === 'task-allowed'
        },
      })

      const allowed: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-allowed',
          uri: 'native://task-allowed',
          node: {
            id: 'task-allowed',
            uri: 'native://task-allowed',
            type: 'task',
            title: 'Allowed',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      const blocked: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-blocked',
          uri: 'native://task-blocked',
          node: {
            id: 'task-blocked',
            uri: 'native://task-blocked',
            type: 'task',
            title: 'Blocked',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', allowed)
      bridge.handleProviderChange('native', blocked)

      expect(sentEvents).toHaveLength(1)
      expect((sentEvents[0].data.task as any).id).toBe('task-allowed')

      bridge.stop()
    })
  })

  // ==========================================================================
  // Bridge Lifecycle
  // ==========================================================================

  describe('bridge lifecycle', () => {
    it('should be active after creation', () => {
      const bridge = createMAPEventBridge({
        send: () => {},
      })
      expect(bridge.active).toBe(true)
      bridge.stop()
    })

    it('should be inactive after stop', () => {
      const bridge = createMAPEventBridge({
        send: () => {},
      })
      bridge.stop()
      expect(bridge.active).toBe(false)
    })

    it('should not emit events after stop', () => {
      const sentEvents: Array<{ type: string }> = []
      const bridge = createMAPEventBridge({
        send: (type) => sentEvents.push({ type }),
      })

      bridge.emitTaskCreated({ id: 'before-stop', title: 'Before' })
      expect(sentEvents).toHaveLength(1)

      bridge.stop()

      bridge.emitTaskCreated({ id: 'after-stop', title: 'After' })
      bridge.emitTaskStatus('x', 'open', 'closed')
      bridge.emitTaskAssigned('x', 'agent')
      bridge.emitTaskCompleted('x')

      // Still only 1 from before stop
      expect(sentEvents).toHaveLength(1)
    })

    it('should not handle provider changes after stop', () => {
      const sentEvents: Array<{ type: string }> = []
      const bridge = createMAPEventBridge({
        send: (type) => sentEvents.push({ type }),
      })

      bridge.stop()

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'After Stop',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', event)

      expect(sentEvents).toHaveLength(0)
    })
  })

  // ==========================================================================
  // End-to-End: Provider + Watchable + Bridge
  // ==========================================================================

  describe('end-to-end: provider Watchable → bridge handleProviderChange', () => {
    it('should bridge native provider changes to MAP events', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
        agentId: 'daemon',
      })

      // Simulate what the daemon would do: watch native provider changes
      // and feed them to the bridge
      const nativeCreated: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'i-abc',
          uri: 'native://i-abc',
          node: {
            id: 'i-abc',
            uri: 'native://i-abc',
            type: 'task',
            title: 'Native Task Created',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      const nativeUpdated: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'i-abc',
          uri: 'native://i-abc',
          changedFields: ['status'],
          previousValues: { status: 'open' },
          node: {
            id: 'i-abc',
            uri: 'native://i-abc',
            type: 'task',
            title: 'Native Task Created',
            status: 'in_progress',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      const nativeCompleted: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'i-abc',
          uri: 'native://i-abc',
          changedFields: ['status'],
          previousValues: { status: 'in_progress' },
          node: {
            id: 'i-abc',
            uri: 'native://i-abc',
            type: 'task',
            title: 'Native Task Created',
            status: 'closed',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', nativeCreated)
      bridge.handleProviderChange('native', nativeUpdated)
      bridge.handleProviderChange('native', nativeCompleted)

      // created + status(open→in_progress) + status(in_progress→completed) + completed(auto)
      expect(sentEvents).toHaveLength(4)
      expect(sentEvents[0].type).toBe('task.created')
      expect(sentEvents[1].type).toBe('task.status')
      expect(sentEvents[1].data).toMatchObject({
        taskId: 'i-abc',
        previous: 'open',
        current: 'in_progress',
      })
      expect(sentEvents[2].type).toBe('task.status')
      expect(sentEvents[2].data).toMatchObject({
        taskId: 'i-abc',
        previous: 'in_progress',
        current: 'completed',
      })
      expect(sentEvents[3].type).toBe('task.completed')
      expect(sentEvents[3].data).toMatchObject({ taskId: 'i-abc' })

      // All should have origin stamp
      expect(sentEvents.every((e) => e.data._origin === 'daemon')).toBe(true)

      bridge.stop()
    })

    it('should include description and assignee in created events', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'i-with-desc',
          uri: 'native://i-with-desc',
          node: {
            id: 'i-with-desc',
            uri: 'native://i-with-desc',
            type: 'task',
            title: 'Task With Description',
            content: 'Detailed description of the task',
            status: 'open',
            rawData: { assignee: 'agent-alice' },
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', event)

      expect(sentEvents).toHaveLength(1)
      const task = sentEvents[0].data.task as Record<string, unknown>
      expect(task.description).toBe('Detailed description of the task')
      expect(task.assignee).toBe('agent-alice')

      bridge.stop()
    })

    it('should handle deleted nodes as failed status', () => {
      const sentEvents: Array<{ type: string; data: Record<string, unknown> }> = []
      const bridge = createMAPEventBridge({
        send: (type, data) => sentEvents.push({ type, data }),
      })

      const deleted: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'deleted',
          nodeId: 'i-deleted',
          uri: 'native://i-deleted',
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', deleted)

      // Deleted → status change to failed
      expect(sentEvents).toHaveLength(1)
      expect(sentEvents[0].type).toBe('task.status')
      expect(sentEvents[0].data).toMatchObject({
        taskId: 'i-deleted',
        previous: 'open',
        current: 'failed',
      })

      bridge.stop()
    })

    it('should ignore edge events', () => {
      const sentEvents: Array<{ type: string }> = []
      const bridge = createMAPEventBridge({
        send: (type) => sentEvents.push({ type }),
      })

      const edgeEvent: ProviderChangeEvent = {
        kind: 'edge',
        event: {
          type: 'created',
          edge: { from: 'a', to: 'b', type: 'blocks' } as any,
          sourceUri: 'native://a',
          targetUri: 'native://b',
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', edgeEvent)

      expect(sentEvents).toHaveLength(0)

      bridge.stop()
    })

    it('should ignore non-task node types', () => {
      const sentEvents: Array<{ type: string }> = []
      const bridge = createMAPEventBridge({
        send: (type) => sentEvents.push({ type }),
      })

      const specEvent: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'c-spec',
          uri: 'native://c-spec',
          node: {
            id: 'c-spec',
            uri: 'native://c-spec',
            type: 'spec' as any,
            title: 'A Spec',
            status: 'open',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      }

      bridge.handleProviderChange('native', specEvent)

      expect(sentEvents).toHaveLength(0)

      bridge.stop()
    })
  })

  // ==========================================================================
  // Configuration Validation
  // ==========================================================================

  describe('configuration', () => {
    it('should throw when neither send nor connection provided', () => {
      expect(() => createMAPEventBridge({} as any)).toThrow(
        'MAPEventBridgeConfig requires either `send` or `connection`',
      )
    })

    it('should prefer send over connection when both provided', () => {
      const sendEvents: string[] = []
      const connEvents: string[] = []

      const bridge = createMAPEventBridge({
        send: (type) => sendEvents.push(type),
        connection: {
          send: async () => { connEvents.push('conn') },
        },
        scope: 'test',
      })

      bridge.emitTaskCreated({ id: 'task-1', title: 'Test' })

      expect(sendEvents).toHaveLength(1)
      expect(connEvents).toHaveLength(0)

      bridge.stop()
    })
  })
})

// ============================================================================
// claude-code-swarm Interaction Simulation
//
// Simulates the real flows that claude-code-swarm performs:
//
// 1. Sidecar connects to MAP server as an AgentConnection
// 2. Hooks fire on Claude Code events (agent-spawning, agent-completed, etc.)
// 3. Hooks build sidecar commands (task-create, task-update, task-assign)
// 4. Sidecar dispatches commands to conn.createTask(), conn.updateTask(), etc.
// 5. MAP server state changes, events fire
// 6. OpenTasks MAP provider reads from the same MAP server
// 7. Event bridge optionally emits outbound events for non-MAP providers
//
// These tests use the in-memory task store as the "MAP server" and exercise
// the full chain from swarm hook patterns through to OpenTasks provider reads.
// ============================================================================

describe.skipIf(!SLOW_TESTS)('claude-code-swarm Simulation', () => {
  let taskStore: ReturnType<typeof createInMemoryTaskStore>
  let provider: ReturnType<typeof createMAPProvider>

  // Simulates what the sidecar does when it receives commands from hooks
  let sidecar: {
    handleCommand: (command: Record<string, unknown>) => Promise<Record<string, unknown>>
  }

  beforeEach(() => {
    nextId = 1000
    taskStore = createInMemoryTaskStore()
    provider = createMAPProvider({ client: taskStore.client, systemId: 'swarm' })

    // Build a minimal sidecar command handler (mirrors sidecar-server.mjs)
    const conn = taskStore.client
    sidecar = {
      async handleCommand(command) {
        switch (command.action) {
          case 'task-create': {
            const result = await conn.createTask({ task: command.task as any })
            return { ok: true, task: result.task }
          }
          case 'task-assign': {
            const result = await conn.assignTask(
              command.taskId as string,
              command.agentId as string,
            )
            return { ok: true, task: result.task }
          }
          case 'task-update': {
            const result = await conn.updateTask(command.params as any)
            return { ok: true, task: result.task }
          }
          case 'task-list': {
            const result = await conn.listTasks((command.params as any) || {})
            return { ok: true, ...result }
          }
          default:
            return { ok: false, error: `Unknown action: ${command.action}` }
        }
      },
    }
  })

  // =====================================================================
  // Simulated hook builders (mirrors map-events.mjs from claude-code-swarm)
  // =====================================================================

  function buildTaskCreateCommand(
    hookData: { tool_input?: { prompt?: string; description?: string }; tool_use_id?: string },
    teamName: string,
    matchedRole: string | null,
    agentName: string,
  ) {
    const prompt = hookData.tool_input?.prompt || hookData.tool_input?.description || ''
    const agentId = matchedRole ? `${teamName}-${matchedRole}` : agentName

    return {
      action: 'task-create',
      task: {
        title: prompt.substring(0, 300),
        description: prompt,
        status: 'open',
        assignee: agentId,
        meta: {
          source: 'claude-code-swarm',
          teamName,
          role: matchedRole || 'internal',
          toolUseId: hookData.tool_use_id || undefined,
        },
      },
    }
  }

  function buildTaskCompletedCommand(
    hookData: { tool_use_id?: string; task_id?: string },
    teamName: string,
    matchedRole: string | null,
    agentName: string,
  ) {
    const agentId = matchedRole ? `${teamName}-${matchedRole}` : agentName
    const taskId = hookData.tool_use_id || hookData.task_id || ''

    return {
      action: 'task-update',
      params: {
        taskId,
        status: 'completed',
        meta: {
          completedBy: agentId,
          source: 'claude-code-swarm',
        },
      },
    }
  }

  function buildTaskStatusCommand(
    hookData: { teammate_name?: string; task_id?: string; task_subject?: string; task_description?: string; team_name?: string },
    teamName: string,
    matchedRole: string | null,
  ) {
    const agentId = hookData.teammate_name || ''
    const taskId = hookData.task_id || ''

    return {
      action: 'task-update',
      params: {
        taskId,
        status: 'completed',
        title: hookData.task_subject || undefined,
        description: (hookData.task_description || '').substring(0, 300) || undefined,
        meta: {
          completedBy: agentId,
          teamName: hookData.team_name || teamName,
          role: matchedRole || 'unknown',
          isTeamRole: !!matchedRole,
          source: 'claude-code-swarm',
        },
      },
    }
  }

  function buildTaskAssignCommand(taskId: string, agentId: string) {
    return {
      action: 'task-assign',
      taskId,
      agentId,
    }
  }

  // =====================================================================
  // Scenario: Agent spawning (PreToolUse hook)
  //
  // When Claude Code spawns an agent via the Agent tool:
  // 1. map-hook.mjs agent-spawning fires
  // 2. Builds a task-create command with the agent's prompt
  // 3. Sidecar calls conn.createTask()
  // 4. Task appears in MAP server, visible via OpenTasks MAP provider
  // =====================================================================

  describe('scenario: agent spawning', () => {
    it('should create a MAP task when an agent is spawned', async () => {
      const hookData = {
        tool_input: {
          prompt: 'Implement OAuth2 authentication flow',
          name: 'auth-implementer',
        },
        tool_use_id: 'tu-abc123',
      }

      const command = buildTaskCreateCommand(hookData, 'gsd', 'implementer', 'auth-implementer')
      const result = await sidecar.handleCommand(command)

      expect(result.ok).toBe(true)
      const task = result.task as MAPTask
      expect(task.title).toBe('Implement OAuth2 authentication flow')
      expect(task.assignee).toBe('gsd-implementer')
      expect(task.status).toBe('open')
      expect(task.meta?.source).toBe('claude-code-swarm')
      expect(task.meta?.role).toBe('implementer')

      // Task should now be visible via the OpenTasks MAP provider
      const nodes = await provider.list()
      expect(nodes).toHaveLength(1)
      expect(nodes[0].title).toBe('Implement OAuth2 authentication flow')
      expect(nodes[0].status).toBe('open')
      expect(nodes[0].uri).toMatch(/^map:\/\/swarm\//)
    })

    it('should assign to raw agent name when no role match', async () => {
      const hookData = {
        tool_input: { prompt: 'Quick research task' },
        tool_use_id: 'tu-xyz',
      }

      const command = buildTaskCreateCommand(hookData, 'gsd', null, 'subagent-12345')
      const result = await sidecar.handleCommand(command)

      expect(result.ok).toBe(true)
      expect((result.task as MAPTask).assignee).toBe('subagent-12345')
      expect((result.task as MAPTask).meta?.role).toBe('internal')
    })
  })

  // =====================================================================
  // Scenario: Agent completed (PostToolUse hook)
  //
  // When a spawned agent finishes:
  // 1. map-hook.mjs agent-completed fires
  // 2. Builds a task-update command with status: completed
  // 3. Sidecar calls conn.updateTask()
  // 4. Task status changes in MAP, visible via OpenTasks
  // =====================================================================

  describe('scenario: agent completed', () => {
    it('should mark task completed when agent finishes', async () => {
      // First, spawn creates the task
      const spawnHook = {
        tool_input: { prompt: 'Write unit tests for auth module' },
        tool_use_id: 'tu-test1',
      }
      const createCmd = buildTaskCreateCommand(spawnHook, 'gsd', 'tester', 'test-agent')
      const createResult = await sidecar.handleCommand(createCmd)
      const taskId = (createResult.task as MAPTask).id

      // Then agent completes
      const completeHook = { tool_use_id: taskId, task_id: taskId }
      const completeCmd = buildTaskCompletedCommand(completeHook, 'gsd', 'tester', 'test-agent')
      const completeResult = await sidecar.handleCommand(completeCmd)

      expect(completeResult.ok).toBe(true)
      expect((completeResult.task as MAPTask).status).toBe('completed')
      expect((completeResult.task as MAPTask).meta?.completedBy).toBe('gsd-tester')

      // Verify via provider: task shows as closed (MAP completed → OT closed)
      const node = await provider.get(taskId)
      expect(node).not.toBeNull()
      expect(node!.status).toBe('closed')
    })
  })

  // =====================================================================
  // Scenario: TaskCompleted hook
  //
  // When a Claude Code task is marked completed (TaskCompleted hook):
  // 1. map-hook.mjs task-completed fires
  // 2. Builds a richer task-update command with title, description, metadata
  // 3. Sidecar calls conn.updateTask()
  // =====================================================================

  describe('scenario: task completed hook', () => {
    it('should update task with rich metadata from TaskCompleted', async () => {
      // Pre-create the task
      const createCmd = buildTaskCreateCommand(
        { tool_input: { prompt: 'Fix login bug' }, tool_use_id: 'tu-fix' },
        'gsd', 'fixer', 'fix-agent',
      )
      const createResult = await sidecar.handleCommand(createCmd)
      const taskId = (createResult.task as MAPTask).id

      // TaskCompleted hook fires with richer data
      const taskCompletedHook = {
        teammate_name: 'fixer',
        task_id: taskId,
        task_subject: 'Login bug fixed',
        task_description: 'Fixed the null pointer in session handler',
        team_name: 'gsd',
      }
      const statusCmd = buildTaskStatusCommand(taskCompletedHook, 'gsd', 'fixer')
      const result = await sidecar.handleCommand(statusCmd)

      expect(result.ok).toBe(true)
      const task = result.task as MAPTask
      expect(task.status).toBe('completed')
      expect(task.title).toBe('Login bug fixed')
      expect(task.description).toBe('Fixed the null pointer in session handler')
      expect(task.meta?.completedBy).toBe('fixer')
      expect(task.meta?.isTeamRole).toBe(true)
    })
  })

  // =====================================================================
  // Scenario: Multi-agent swarm
  //
  // Full swarm simulation: coordinator spawns multiple agents, each
  // creates tasks, works on them, completes them. Verifies the MAP
  // provider shows the correct aggregate state at each stage.
  // =====================================================================

  describe('scenario: multi-agent swarm', () => {
    it('should handle concurrent agents with separate tasks', async () => {
      // Coordinator spawns 3 agents with different roles
      const agents = [
        { role: 'researcher', prompt: 'Research authentication best practices' },
        { role: 'implementer', prompt: 'Implement OAuth2 flow' },
        { role: 'tester', prompt: 'Write integration tests for auth' },
      ]

      const taskIds: string[] = []
      for (const agent of agents) {
        const cmd = buildTaskCreateCommand(
          { tool_input: { prompt: agent.prompt } },
          'gsd', agent.role, `${agent.role}-agent`,
        )
        const result = await sidecar.handleCommand(cmd)
        taskIds.push((result.task as MAPTask).id)
      }

      // All 3 tasks visible via provider
      let nodes = await provider.list()
      expect(nodes).toHaveLength(3)

      // All 3 are ready (open status)
      let ready = await provider.readyTasks()
      expect(ready).toHaveLength(3)

      // Researcher completes first
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskIds[0], status: 'completed' },
      })

      ready = await provider.readyTasks()
      expect(ready).toHaveLength(2)

      // Implementer gets blocked
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskIds[1], status: 'blocked' },
      })

      ready = await provider.readyTasks()
      expect(ready).toHaveLength(1) // Only tester

      // Unblock and complete remaining
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskIds[1], status: 'open' },
      })
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskIds[1], status: 'completed' },
      })
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskIds[2], status: 'completed' },
      })

      // All done
      ready = await provider.readyTasks()
      expect(ready).toHaveLength(0)

      nodes = await provider.list()
      expect(nodes.every((n) => n.status === 'closed')).toBe(true)
    })

    it('should filter tasks by assignee across agents', async () => {
      // Two agents create tasks
      await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Alice task 1' } }, 'gsd', 'alice', 'alice',
      ))
      await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Alice task 2' } }, 'gsd', 'alice', 'alice',
      ))
      await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Bob task 1' } }, 'gsd', 'bob', 'bob',
      ))

      // Provider can filter by assignee
      const aliceTasks = await provider.readyTasks({ assignee: 'gsd-alice' })
      expect(aliceTasks).toHaveLength(2)

      const bobTasks = await provider.readyTasks({ assignee: 'gsd-bob' })
      expect(bobTasks).toHaveLength(1)
    })

    it('should list tasks via sidecar task-list command', async () => {
      await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Task A' } }, 'gsd', 'worker', 'w',
      ))
      await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Task B' } }, 'gsd', 'worker', 'w',
      ))

      const result = await sidecar.handleCommand({
        action: 'task-list',
        params: {},
      })

      expect(result.ok).toBe(true)
      expect((result as any).tasks).toHaveLength(2)
    })
  })

  // =====================================================================
  // Scenario: Task reassignment
  //
  // Agent is reassigned mid-flight — coordinator moves task from one
  // agent to another.
  // =====================================================================

  describe('scenario: task reassignment', () => {
    it('should reassign a task between agents', async () => {
      // Create and assign to alice
      const createResult = await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Design API schema' } }, 'gsd', 'alice', 'alice',
      ))
      const taskId = (createResult.task as MAPTask).id

      // Verify initial assignment
      let node = await provider.get(taskId)
      expect(node!.rawData?.assignee).toBe('gsd-alice')

      // Reassign to bob
      await sidecar.handleCommand(buildTaskAssignCommand(taskId, 'gsd-bob'))

      node = await provider.get(taskId)
      expect(node!.rawData?.assignee).toBe('gsd-bob')
    })
  })

  // =====================================================================
  // Scenario: Event bridge observability
  //
  // Swarm uses a shared connection for both task operations (sidecar)
  // and observability events (bridge). The bridge emits events for
  // tasks created/completed by the swarm hooks.
  // =====================================================================

  describe('scenario: bridge observability alongside sidecar', () => {
    it('should emit bridge events for the full swarm lifecycle', async () => {
      const observedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

      // Bridge shares the same "connection" as the sidecar
      const sharedConnection = {
        send: async (_to: unknown, payload: unknown) => {
          observedEvents.push(payload as any)
        },
      }

      const bridge = createMAPEventBridge({
        connection: sharedConnection,
        scope: 'swarm:gsd',
        agentId: 'sidecar',
      })

      // Agent spawning hook: create task + emit bridge event
      const createResult = await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Implement feature X' } }, 'gsd', 'implementer', 'impl',
      ))
      const task = createResult.task as MAPTask

      bridge.emitTaskCreated({
        id: task.id,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        meta: task.meta,
      })

      // Agent working: status update
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: task.id, status: 'in_progress' },
      })
      bridge.emitTaskStatus(task.id, 'open', 'in_progress')

      // Agent completed hook: complete task + emit bridge event
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: task.id, status: 'completed' },
      })
      bridge.emitTaskStatus(task.id, 'in_progress', 'completed')

      // Verify observed events match the swarm lifecycle
      const types = observedEvents.map((e) => e.type)
      expect(types).toEqual([
        'task.created',
        'task.status',
        'task.status',
        'task.completed', // auto-emitted by bridge for terminal status
      ])

      // Verify the created event has full task data
      expect(observedEvents[0]).toMatchObject({
        type: 'task.created',
        task: {
          id: task.id,
          title: 'Implement feature X',
          status: 'open',
          assignee: 'gsd-implementer',
        },
        _origin: 'sidecar',
      })

      // Verify MAP provider shows final state
      const node = await provider.get(task.id)
      expect(node!.status).toBe('closed') // MAP completed → OT closed

      bridge.stop()
    })

    it('should handle multi-agent swarm with bridge observability', async () => {
      const observedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

      const bridge = createMAPEventBridge({
        send: (type, data) => observedEvents.push({ type, data }),
        agentId: 'swarm-sidecar',
      })

      // Coordinator spawns 2 agents
      const agentA = await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Research task' } }, 'gsd', 'researcher', 'r',
      ))
      const taskA = (agentA.task as MAPTask)
      bridge.emitTaskCreated({ id: taskA.id, title: taskA.title, status: 'open', assignee: taskA.assignee })

      const agentB = await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Implementation task' } }, 'gsd', 'implementer', 'i',
      ))
      const taskB = (agentB.task as MAPTask)
      bridge.emitTaskCreated({ id: taskB.id, title: taskB.title, status: 'open', assignee: taskB.assignee })

      // Agent A completes
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskA.id, status: 'completed' },
      })
      bridge.emitTaskStatus(taskA.id, 'open', 'completed')

      // Agent B completes
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: taskB.id, status: 'completed' },
      })
      bridge.emitTaskStatus(taskB.id, 'open', 'completed')

      // Count events per task
      const taskAEvents = observedEvents.filter((e) =>
        e.data.taskId === taskA.id || (e.data.task as any)?.id === taskA.id,
      )
      const taskBEvents = observedEvents.filter((e) =>
        e.data.taskId === taskB.id || (e.data.task as any)?.id === taskB.id,
      )

      // Each task: created + status + completed(auto)
      expect(taskAEvents).toHaveLength(3)
      expect(taskBEvents).toHaveLength(3)

      // All events stamped with origin
      expect(observedEvents.every((e) => e.data._origin === 'swarm-sidecar')).toBe(true)

      // Provider shows all completed
      const nodes = await provider.list()
      expect(nodes).toHaveLength(2)
      expect(nodes.every((n) => n.status === 'closed')).toBe(true)

      bridge.stop()
    })
  })

  // =====================================================================
  // Scenario: Sidecar error recovery
  //
  // Sidecar handles errors gracefully — invalid task IDs, missing
  // connections, etc. Mirrors the try/catch patterns in sidecar-server.mjs.
  // =====================================================================

  describe('scenario: error handling', () => {
    it('should return error for updating nonexistent task', async () => {
      const result = await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId: 'nonexistent-task', status: 'completed' },
      }).catch((e) => ({ ok: false, error: e.message }))

      // The in-memory store throws for missing tasks, like a real MAP server would
      expect(result.ok).toBe(false)
    })

    it('should return error for assigning nonexistent task', async () => {
      const result = await sidecar.handleCommand({
        action: 'task-assign',
        taskId: 'nonexistent',
        agentId: 'agent-1',
      }).catch((e) => ({ ok: false, error: e.message }))

      expect(result.ok).toBe(false)
    })

    it('should return error for unknown command', async () => {
      const result = await sidecar.handleCommand({ action: 'unknown-action' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Unknown action')
    })
  })

  // =====================================================================
  // Scenario: Watchable events from swarm task operations
  //
  // When the sidecar creates/updates tasks, the MAP server emits events.
  // The MAP provider's Watchable trait picks these up and fires them as
  // ProviderChangeEvents. An external observer (e.g., the OpenTasks daemon)
  // could watch these to keep the graph in sync.
  // =====================================================================

  describe('scenario: watching swarm task events', () => {
    it('should receive Watchable events for sidecar task operations', async () => {
      const watchable = provider as any
      const events: ProviderChangeEvent[] = []
      watchable.startWatching((event: ProviderChangeEvent) => events.push(event))

      // Sidecar creates a task (agent-spawning hook)
      const result = await sidecar.handleCommand(buildTaskCreateCommand(
        { tool_input: { prompt: 'Watch me work' } }, 'gsd', 'worker', 'w',
      ))
      const taskId = (result.task as MAPTask).id

      // Sidecar updates task (agent-completed hook)
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId, status: 'in_progress' },
      })
      await sidecar.handleCommand({
        action: 'task-update',
        params: { taskId, status: 'completed' },
      })

      // Watchable should have received events for the full lifecycle
      const createdEvents = events.filter((e) => e.kind === 'node' && e.event.type === 'created')
      const updatedEvents = events.filter((e) => e.kind === 'node' && e.event.type === 'updated')

      expect(createdEvents).toHaveLength(1)
      expect(createdEvents[0].event.node?.title).toBe('Watch me work')

      // status changes: open→in_progress, in_progress→completed, plus completed event
      expect(updatedEvents.length).toBeGreaterThanOrEqual(2)

      watchable.stopWatching()
    })
  })
})
