/**
 * Beads Watchable Trait E2E Tests
 *
 * Tests the Watchable trait implementation on the Beads provider
 * with real bd CLI operations. Verifies that file-system changes
 * made via the bd CLI are detected and emitted as ProviderChangeEvents.
 *
 * Requires: bd CLI available in PATH (set AGENT_TESTS=1)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  isBdAvailable,
  createBeadsWorkspace,
  createBeadsTask,
  updateBeadsTask,
  deleteBeadsTask,
  linkBeadsTasks,
  getBdExecutable,
  sleep,
  waitFor,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'
import { createBeadsProvider, type BeadsConfig } from '../../../../src/providers/beads.js'
import { isWatchable } from '../../../../src/providers/traits/Watchable.js'
import type {
  ProviderChangeEvent,
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from '../../../../src/providers/traits/Watchable.js'

describe.skipIf(!AGENT_TESTS)('Beads Watchable Trait', () => {
  let beadsAvailable: boolean
  let sharedWorkspace: BeadsWorkspaceContext | null = null

  // Create Beads workspace once for all tests
  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-watchable-beads-'))
      sharedWorkspace = await createBeadsWorkspace(workspaceDir, 'bd')
    }
  })

  afterAll(async () => {
    if (sharedWorkspace) {
      await sharedWorkspace.cleanup()
    }
  })

  describe('isWatchable type guard', () => {
    it('should detect Beads provider as watchable when watchPath is configured', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
      })

      expect(isWatchable(provider)).toBe(true)
    })

    it('should still pass isWatchable even without watchPath (methods exist, startWatching is no-op)', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      // Even without watchPath, the provider object has watchGranularity/startWatching/stopWatching
      // properties set — isWatchable checks for method existence, not config
      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        extraArgs: ['--no-db'],
      })

      expect(isWatchable(provider)).toBe(true)
    })

    it('should report correct watchGranularity', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      expect(provider.watchGranularity).toEqual({
        reportsChangedFields: false,
        reportsPreviousValues: false,
        reportsEdgeChanges: true,
        mechanism: 'file-watch',
      })
    })
  })

  describe('Node change detection', () => {
    let provider: ReturnType<typeof createBeadsProvider>
    let events: ProviderChangeEvent[]

    beforeEach(async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      events = []
      provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
        watchDebounceMs: 100,
      })
    })

    afterEach(async () => {
      if (provider && isWatchable(provider) && provider.isWatching) {
        provider.stopWatching()
      }
    })

    it('should detect task creation', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Start watching and collect events
      provider.startWatching((event) => {
        events.push(event)
      })

      // Wait for watcher to initialize (seedCache + chokidar ready)
      await sleep(500)

      // Create a task via CLI
      const task = await createBeadsTask(sharedWorkspace!.path, 'Watch Create Test')

      // Wait for events to arrive (debounce + file write + diff)
      await waitFor(() => events.some(
        (e) => e.kind === 'node' && e.event.type === 'created' && e.event.nodeId === task.id
      ), {
        timeout: 10000,
        interval: 100,
        message: `Expected 'created' event for task ${task.id}`,
      })

      // Verify the event
      const createEvent = events.find(
        (e) => e.kind === 'node' && e.event.type === 'created' && e.event.nodeId === task.id
      )
      expect(createEvent).toBeDefined()
      expect(createEvent!.kind).toBe('node')

      const nodeEvent = createEvent!.event as ProviderNodeChangeEvent
      expect(nodeEvent.uri).toBe(`beads://./${task.id}`)
      expect(nodeEvent.node).toBeDefined()
      expect(nodeEvent.node!.title).toBe('Watch Create Test')
      expect(nodeEvent.timestamp).toBeTruthy()

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, task.id)
      await sleep(500) // Let the watcher process the delete
    })

    it('should detect task update', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Create a task first, before starting the watcher
      const task = await createBeadsTask(sharedWorkspace!.path, 'Watch Update Test')

      // Start watching (seeds cache including the newly created task)
      provider.startWatching((event) => {
        events.push(event)
      })

      // Wait for watcher to initialize
      await sleep(500)

      // Update the task via CLI
      await updateBeadsTask(sharedWorkspace!.path, task.id, {
        title: 'Updated Watch Test',
        status: 'in-progress',
      })

      // Wait for the update event
      await waitFor(() => events.some(
        (e) => e.kind === 'node' && e.event.type === 'updated' && e.event.nodeId === task.id
      ), {
        timeout: 10000,
        interval: 100,
        message: `Expected 'updated' event for task ${task.id}`,
      })

      const updateEvent = events.find(
        (e) => e.kind === 'node' && e.event.type === 'updated' && e.event.nodeId === task.id
      )
      expect(updateEvent).toBeDefined()

      const nodeEvent = updateEvent!.event as ProviderNodeChangeEvent
      expect(nodeEvent.node).toBeDefined()
      expect(nodeEvent.node!.title).toBe('Updated Watch Test')

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, task.id)
      await sleep(500)
    })

    it('should detect task deletion', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Create a task first
      const task = await createBeadsTask(sharedWorkspace!.path, 'Watch Delete Test')

      // Start watching (seeds cache including the task)
      provider.startWatching((event) => {
        events.push(event)
      })

      // Wait for watcher to initialize
      await sleep(500)

      // Delete the task via CLI
      await deleteBeadsTask(sharedWorkspace!.path, task.id)

      // Wait for the delete event
      await waitFor(() => events.some(
        (e) => e.kind === 'node' && e.event.type === 'deleted' && e.event.nodeId === task.id
      ), {
        timeout: 10000,
        interval: 100,
        message: `Expected 'deleted' event for task ${task.id}`,
      })

      const deleteEvent = events.find(
        (e) => e.kind === 'node' && e.event.type === 'deleted' && e.event.nodeId === task.id
      )
      expect(deleteEvent).toBeDefined()

      const nodeEvent = deleteEvent!.event as ProviderNodeChangeEvent
      expect(nodeEvent.uri).toBe(`beads://./${task.id}`)
      // Deleted events don't include full node data
      expect(nodeEvent.node).toBeUndefined()
    })
  })

  describe('Edge change detection', () => {
    let provider: ReturnType<typeof createBeadsProvider>
    let events: ProviderChangeEvent[]

    beforeEach(async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      events = []
      provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
        watchDebounceMs: 100,
      })
    })

    afterEach(async () => {
      if (provider && isWatchable(provider) && provider.isWatching) {
        provider.stopWatching()
      }
    })

    it('should detect blocking relationship creation', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Create two tasks before watching
      const blocker = await createBeadsTask(sharedWorkspace!.path, 'Blocker Task')
      const blocked = await createBeadsTask(sharedWorkspace!.path, 'Blocked Task')

      // Start watching
      provider.startWatching((event) => {
        events.push(event)
      })

      // Wait for watcher to initialize
      await sleep(500)

      // Link tasks via CLI
      await linkBeadsTasks(sharedWorkspace!.path, blocker.id, blocked.id)

      // Wait for edge event
      await waitFor(() => events.some(
        (e) => e.kind === 'edge' && e.event.type === 'created'
      ), {
        timeout: 10000,
        interval: 100,
        message: 'Expected edge "created" event for blocking relationship',
      })

      const edgeEvent = events.find(
        (e) => e.kind === 'edge' && e.event.type === 'created'
      )
      expect(edgeEvent).toBeDefined()

      const edge = edgeEvent!.event as ProviderEdgeChangeEvent
      expect(edge.edge.from).toBe(blocker.id)
      expect(edge.edge.to).toBe(blocked.id)
      expect(edge.edge.type).toBe('blocks')
      expect(edge.sourceUri).toBe(`beads://./${blocker.id}`)
      expect(edge.targetUri).toBe(`beads://./${blocked.id}`)

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, blocked.id)
      await deleteBeadsTask(sharedWorkspace!.path, blocker.id)
      await sleep(500)
    })
  })

  describe('Watch lifecycle', () => {
    it('should not emit events after stopWatching', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const events: ProviderChangeEvent[] = []
      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
        watchDebounceMs: 100,
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Start then stop watching
      provider.startWatching((event) => {
        events.push(event)
      })
      await sleep(500)

      provider.stopWatching()
      expect(provider.isWatching).toBe(false)

      // Create a task — should not trigger any events
      const task = await createBeadsTask(sharedWorkspace!.path, 'After Stop Test')
      await sleep(1000)

      // No events should have been emitted
      const relevantEvents = events.filter(
        (e) => e.kind === 'node' && e.event.nodeId === task.id
      )
      expect(relevantEvents).toHaveLength(0)

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, task.id)
    })

    it('should support replacing callback via repeated startWatching calls', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const events1: ProviderChangeEvent[] = []
      const events2: ProviderChangeEvent[] = []
      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
        watchDebounceMs: 100,
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Start with first callback
      provider.startWatching((event) => {
        events1.push(event)
      })
      await sleep(500)

      // Replace with second callback
      provider.startWatching((event) => {
        events2.push(event)
      })

      // Create a task — should only trigger events2
      const task = await createBeadsTask(sharedWorkspace!.path, 'Callback Replace Test')

      await waitFor(() => events2.some(
        (e) => e.kind === 'node' && e.event.type === 'created' && e.event.nodeId === task.id
      ), {
        timeout: 10000,
        interval: 100,
        message: `Expected event in second callback for task ${task.id}`,
      })

      // events1 should NOT have the event (callback was replaced)
      const events1ForTask = events1.filter(
        (e) => e.kind === 'node' && e.event.nodeId === task.id
      )
      expect(events1ForTask).toHaveLength(0)

      provider.stopWatching()

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, task.id)
    })

    it('should be safe to call stopWatching when not watching', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Should not throw
      expect(() => provider.stopWatching()).not.toThrow()
      expect(provider.isWatching).toBe(false)
    })

    it('should silently no-op startWatching without watchPath', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const events: ProviderChangeEvent[] = []
      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        extraArgs: ['--no-db'],
        // No watchPath
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      // Should not throw
      expect(() => provider.startWatching((e) => events.push(e))).not.toThrow()
      expect(provider.isWatching).toBe(false) // No watcher created without watchPath
    })
  })

  describe('Multiple rapid changes', () => {
    it('should detect multiple sequential changes (debounced)', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const events: ProviderChangeEvent[] = []
      const provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: sharedWorkspace!.path,
        timeout: 30000,
        extraArgs: ['--no-db'],
        watchPath: join(sharedWorkspace!.path, '.beads'),
        watchDebounceMs: 100,
      })

      if (!isWatchable(provider)) {
        throw new Error('Provider should be watchable')
      }

      provider.startWatching((event) => {
        events.push(event)
      })
      await sleep(500)

      // Create two tasks in sequence
      const task1 = await createBeadsTask(sharedWorkspace!.path, 'Rapid Change 1')
      const task2 = await createBeadsTask(sharedWorkspace!.path, 'Rapid Change 2')

      // Wait for both creation events
      await waitFor(() => {
        const nodeEvents = events.filter((e) => e.kind === 'node' && e.event.type === 'created')
        return nodeEvents.some((e) => (e.event as ProviderNodeChangeEvent).nodeId === task1.id) &&
               nodeEvents.some((e) => (e.event as ProviderNodeChangeEvent).nodeId === task2.id)
      }, {
        timeout: 15000,
        interval: 200,
        message: `Expected 'created' events for both tasks (${task1.id}, ${task2.id})`,
      })

      const createdIds = events
        .filter((e) => e.kind === 'node' && e.event.type === 'created')
        .map((e) => (e.event as ProviderNodeChangeEvent).nodeId)

      expect(createdIds).toContain(task1.id)
      expect(createdIds).toContain(task2.id)

      provider.stopWatching()

      // Clean up
      await deleteBeadsTask(sharedWorkspace!.path, task1.id)
      await deleteBeadsTask(sharedWorkspace!.path, task2.id)
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Beads Watchable Trait (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
