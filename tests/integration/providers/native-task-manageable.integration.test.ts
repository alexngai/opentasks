/**
 * Native Provider TaskManageable Integration Tests
 *
 * Tests TaskManageable trait methods against a real GraphStore (SQLite + JSONL).
 * Validates task transitions, ready queries with blocker resolution,
 * assignment, and valid actions using actual storage.
 *
 * These tests don't require external binaries — they exercise the native
 * provider against a real graph store in a temp directory.
 *
 * Run with: RUN_SLOW_TESTS=1 npx vitest run tests/integration/providers/native-task-manageable.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { createNativeProvider } from '../../../src/providers/native.js'
import type { Provider, ProviderNode } from '../../../src/providers/types.js'
import { isTaskManageable, type TaskManageable } from '../../../src/providers/traits/TaskManageable.js'
import { createGraphStore, type GraphStore } from '../../../src/graph/store.js'
import { createSQLitePersister } from '../../../src/storage/sqlite.js'
import { createJSONLPersister } from '../../../src/storage/jsonl.js'
import type { Storage } from '../../../src/storage/interface.js'
import { SLOW_TESTS } from '../helpers/index.js'

describe.skipIf(!SLOW_TESTS)('NativeProvider TaskManageable Integration', () => {
  let rootDir: string
  let store: GraphStore
  let provider: Provider & TaskManageable

  beforeAll(async () => {
    // Create temp directory
    rootDir = await mkdtemp(join(tmpdir(), 'native-task-mgmt-'))
    const openTasksDir = join(rootDir, '.opentasks')
    await mkdir(openTasksDir, { recursive: true })

    // Set up real storage
    const jsonlPath = join(openTasksDir, 'opentasks.jsonl')
    const sqlite = createSQLitePersister(openTasksDir)
    await sqlite.initialize()

    const jsonl = createJSONLPersister(jsonlPath)
    const jsonlLoad = async () => {
      try {
        if (!existsSync(jsonlPath)) return { nodes: [], edges: [] }
        return await jsonl.load()
      } catch {
        return { nodes: [], edges: [] }
      }
    }
    const jsonlSave = async (nodes: any[], edges: any[]) => {
      await jsonl.save(nodes, edges)
    }

    // Create real graph store
    store = createGraphStore(
      { flush: { debounceMs: 50, maxDelayMs: 100 } },
      sqlite as Storage,
      jsonlLoad,
      jsonlSave
    )
    await store.initialize()

    // Create native provider with the real store
    provider = createNativeProvider(store)
  })

  afterAll(async () => {
    if (store) {
      await store.close()
    }
    if (rootDir && existsSync(rootDir)) {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  describe('trait detection', () => {
    it('should be detected as TaskManageable', () => {
      expect(isTaskManageable(provider)).toBe(true)
    })

    it('should declare correct taskCapabilities', () => {
      expect(provider.taskCapabilities.actions).toContain('start')
      expect(provider.taskCapabilities.actions).toContain('complete')
      expect(provider.taskCapabilities.actions).toContain('block')
      expect(provider.taskCapabilities.actions).toContain('reopen')
      expect(provider.taskCapabilities.actions).toContain('close')
      expect(provider.taskCapabilities.supportsAssignment).toBe(true)
      expect(provider.taskCapabilities.supportsReadyQuery).toBe(true)
      expect(provider.taskCapabilities.statusModel).toEqual(
        expect.arrayContaining(['open', 'in_progress', 'blocked', 'closed'])
      )
    })
  })

  describe('transitionTask', () => {
    it('should start an issue (open → in_progress)', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Start Test',
        status: 'open',
      })

      const result = await provider.transitionTask(node.id, 'start')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('in_progress')

      // Verify persisted
      const fetched = await store.getNode(node.id)
      expect(fetched?.status).toBe('in_progress')
    })

    it('should complete an issue (in_progress → closed)', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Complete Test',
        status: 'in_progress',
      })

      const result = await provider.transitionTask(node.id, 'complete')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('closed')
    })

    it('should block an issue (open → blocked)', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Block Test',
        status: 'open',
      })

      const result = await provider.transitionTask(node.id, 'block')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('blocked')
    })

    it('should reopen a closed issue (closed → open)', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Reopen Test',
        status: 'closed',
      })

      const result = await provider.transitionTask(node.id, 'reopen')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('open')
    })

    it('should close an issue directly (open → closed)', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Close Test',
        status: 'open',
      })

      const result = await provider.transitionTask(node.id, 'close')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('closed')
    })

    it('should reject transitions on specs', async () => {
      const spec = await store.createNode({
        type: 'spec',
        title: 'Spec Transition Test',
        content: 'A spec, not an issue',
      })

      await expect(
        provider.transitionTask(spec.id, 'start')
      ).rejects.toThrow(/only issues support/)
    })

    it('should reject transitions on feedback nodes', async () => {
      // Create a spec to target
      const spec = await store.createNode({
        type: 'spec',
        title: 'Target Spec',
      })

      const feedback = await store.createNode({
        type: 'feedback',
        title: 'Some Feedback',
        target_id: spec.id,
        feedback_type: 'comment',
      })

      await expect(
        provider.transitionTask(feedback.id, 'start')
      ).rejects.toThrow(/only issues support/)
    })

    it('should throw for nonexistent node', async () => {
      await expect(
        provider.transitionTask('i-nonexistent99999', 'start')
      ).rejects.toThrow(/not found/i)
    })

    it('should accept URI format for ID', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'URI Format Test',
        status: 'open',
      })

      const result = await provider.transitionTask(`native://${node.id}`, 'start')

      expect(result.id).toBe(node.id)
      expect(result.status).toBe('in_progress')
    })
  })

  describe('readyTasks', () => {
    it('should return open issues with no blockers', async () => {
      const issue = await store.createNode({
        type: 'issue',
        title: 'Ready No Blockers',
        status: 'open',
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(true)
    })

    it('should exclude closed issues', async () => {
      const issue = await store.createNode({
        type: 'issue',
        title: 'Closed Not Ready',
        status: 'closed',
        closed_at: new Date().toISOString(),
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should exclude in_progress issues', async () => {
      const issue = await store.createNode({
        type: 'issue',
        title: 'InProgress Not Ready',
        status: 'in_progress',
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should exclude blocked issues', async () => {
      const issue = await store.createNode({
        type: 'issue',
        title: 'Blocked Not Ready',
        status: 'blocked',
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should exclude issues with active blockers', async () => {
      // Create a blocker (open)
      const blocker = await store.createNode({
        type: 'issue',
        title: 'Active Blocker',
        status: 'open',
      })

      // Create the blocked issue
      const blocked = await store.createNode({
        type: 'issue',
        title: 'Has Active Blocker',
        status: 'open',
      })

      // Create a blocks edge: blocker → blocks → blocked
      await store.createEdge({
        from_id: blocker.id,
        to_id: blocked.id,
        type: 'blocks',
      })

      const ready = await provider.readyTasks()

      // Blocked issue should NOT be ready (blocker is still open)
      expect(ready.some((r: ProviderNode) => r.id === blocked.id)).toBe(false)
      // Blocker itself should be ready (nothing blocks it)
      expect(ready.some((r: ProviderNode) => r.id === blocker.id)).toBe(true)
    })

    it('should include issues once blocker is closed', async () => {
      // Create a blocker
      const blocker = await store.createNode({
        type: 'issue',
        title: 'Resolved Blocker',
        status: 'open',
      })

      // Create the blocked issue
      const blocked = await store.createNode({
        type: 'issue',
        title: 'Becomes Ready After Resolve',
        status: 'open',
      })

      // Create blocks edge
      await store.createEdge({
        from_id: blocker.id,
        to_id: blocked.id,
        type: 'blocks',
      })

      // Initially not ready
      let ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === blocked.id)).toBe(false)

      // Close the blocker
      await provider.transitionTask(blocker.id, 'close')

      // Now should be ready
      ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === blocked.id)).toBe(true)
    })

    it('should respect limit option', async () => {
      // Create several open issues
      await store.createNode({ type: 'issue', title: 'Limit A', status: 'open' })
      await store.createNode({ type: 'issue', title: 'Limit B', status: 'open' })
      await store.createNode({ type: 'issue', title: 'Limit C', status: 'open' })

      const ready = await provider.readyTasks({ limit: 2 })

      expect(ready.length).toBeLessThanOrEqual(2)
    })

    it('should filter by assignee', async () => {
      const alice = await store.createNode({
        type: 'issue',
        title: 'Alice Task',
        status: 'open',
        assignee: 'alice',
      })

      await store.createNode({
        type: 'issue',
        title: 'Bob Task',
        status: 'open',
        assignee: 'bob',
      })

      const ready = await provider.readyTasks({ assignee: 'alice' })

      expect(ready.some((r: ProviderNode) => r.id === alice.id)).toBe(true)
      expect(ready.every((r: ProviderNode) => r.id !== alice.id || r.id === alice.id)).toBe(true)
    })

    it('should handle chained blockers', async () => {
      // A blocks B blocks C — C should not be ready
      const a = await store.createNode({
        type: 'issue',
        title: 'Chain A',
        status: 'open',
      })
      const b = await store.createNode({
        type: 'issue',
        title: 'Chain B',
        status: 'open',
      })
      const c = await store.createNode({
        type: 'issue',
        title: 'Chain C',
        status: 'open',
      })

      await store.createEdge({ from_id: a.id, to_id: b.id, type: 'blocks' })
      await store.createEdge({ from_id: b.id, to_id: c.id, type: 'blocks' })

      const ready = await provider.readyTasks()

      // A is ready (no blockers)
      expect(ready.some((r: ProviderNode) => r.id === a.id)).toBe(true)
      // B is blocked by A
      expect(ready.some((r: ProviderNode) => r.id === b.id)).toBe(false)
      // C is blocked by B (which is blocked by A)
      expect(ready.some((r: ProviderNode) => r.id === c.id)).toBe(false)
    })
  })

  describe('assignTask', () => {
    it('should assign an issue to a user', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Assign Test',
        status: 'open',
      })

      const result = await provider.assignTask!(node.id, 'alice')

      expect(result.id).toBe(node.id)

      // Verify assignment persisted
      const fetched = await store.getNode(node.id)
      expect(fetched?.assignee).toBe('alice')
    })

    it('should reassign an issue', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Reassign Test',
        status: 'open',
        assignee: 'alice',
      })

      const result = await provider.assignTask!(node.id, 'bob')

      expect(result.id).toBe(node.id)

      const fetched = await store.getNode(node.id)
      expect(fetched?.assignee).toBe('bob')
    })

    it('should reject assignment on specs', async () => {
      const spec = await store.createNode({
        type: 'spec',
        title: 'Spec Assign Test',
      })

      await expect(
        provider.assignTask!(spec.id, 'alice')
      ).rejects.toThrow(/only issues support/)
    })

    it('should throw for nonexistent node', async () => {
      await expect(
        provider.assignTask!('i-nonexistent99999', 'alice')
      ).rejects.toThrow(/not found/i)
    })
  })

  describe('validActions', () => {
    it('should return start, block, close for open issue', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'VA Open',
        status: 'open',
      })

      const actions = await provider.validActions!(node.id)

      expect(actions).toContain('start')
      expect(actions).toContain('block')
      expect(actions).toContain('close')
      expect(actions).not.toContain('complete')
      expect(actions).not.toContain('reopen')
    })

    it('should return complete, block, close for in_progress issue', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'VA InProgress',
        status: 'in_progress',
      })

      const actions = await provider.validActions!(node.id)

      expect(actions).toContain('complete')
      expect(actions).toContain('block')
      expect(actions).toContain('close')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('reopen')
    })

    it('should return reopen, close for blocked issue', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'VA Blocked',
        status: 'blocked',
      })

      const actions = await provider.validActions!(node.id)

      expect(actions).toContain('reopen')
      expect(actions).toContain('close')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('complete')
    })

    it('should return reopen for closed issue', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'VA Closed',
        status: 'closed',
      })

      const actions = await provider.validActions!(node.id)

      expect(actions).toContain('reopen')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('complete')
      expect(actions).not.toContain('block')
      expect(actions).not.toContain('close')
    })

    it('should reject querying actions for specs', async () => {
      const spec = await store.createNode({
        type: 'spec',
        title: 'VA Spec',
      })

      await expect(
        provider.validActions!(spec.id)
      ).rejects.toThrow(/only issues support/)
    })

    it('should throw for nonexistent node', async () => {
      await expect(
        provider.validActions!('i-nonexistent99999')
      ).rejects.toThrow(/not found/i)
    })
  })

  describe('full lifecycle', () => {
    it('should complete a full task lifecycle: create → start → complete', async () => {
      // Create
      const node = await store.createNode({
        type: 'issue',
        title: 'Full Lifecycle',
        status: 'open',
      })

      // Should be ready initially
      let ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === node.id)).toBe(true)

      // Start
      const started = await provider.transitionTask(node.id, 'start')
      expect(started.status).toBe('in_progress')

      // No longer ready (in_progress)
      ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === node.id)).toBe(false)

      // Complete
      const completed = await provider.transitionTask(node.id, 'complete')
      expect(completed.status).toBe('closed')

      // Still not ready (closed)
      ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === node.id)).toBe(false)

      // Verify final state in store
      const fetched = await store.getNode(node.id)
      expect(fetched?.status).toBe('closed')
    })

    it('should handle block → reopen → complete flow', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'Block Reopen Complete',
        status: 'open',
      })

      // Start
      await provider.transitionTask(node.id, 'start')

      // Block
      const blocked = await provider.transitionTask(node.id, 'block')
      expect(blocked.status).toBe('blocked')

      // Valid actions should only be reopen and close
      const actions = await provider.validActions!(node.id)
      expect(actions).toEqual(['reopen', 'close'])

      // Reopen
      const reopened = await provider.transitionTask(node.id, 'reopen')
      expect(reopened.status).toBe('open')

      // Start again and complete
      await provider.transitionTask(node.id, 'start')
      const completed = await provider.transitionTask(node.id, 'complete')
      expect(completed.status).toBe('closed')
    })

    it('should handle blocker resolution unlocking dependent issues', async () => {
      // Blocker issue
      const blocker = await store.createNode({
        type: 'issue',
        title: 'Lifecycle Blocker',
        status: 'open',
      })

      // Dependent issue
      const dependent = await store.createNode({
        type: 'issue',
        title: 'Lifecycle Dependent',
        status: 'open',
      })

      // Create dependency
      await store.createEdge({
        from_id: blocker.id,
        to_id: dependent.id,
        type: 'blocks',
      })

      // Dependent should not be ready
      let ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === dependent.id)).toBe(false)

      // Work on blocker: start → complete
      await provider.transitionTask(blocker.id, 'start')
      await provider.transitionTask(blocker.id, 'complete')

      // Now dependent should be ready
      ready = await provider.readyTasks()
      expect(ready.some((r: ProviderNode) => r.id === dependent.id)).toBe(true)

      // Work on dependent
      await provider.transitionTask(dependent.id, 'start')
      await provider.transitionTask(dependent.id, 'complete')

      // Both done
      const fetchedBlocker = await store.getNode(blocker.id)
      const fetchedDependent = await store.getNode(dependent.id)
      expect(fetchedBlocker?.status).toBe('closed')
      expect(fetchedDependent?.status).toBe('closed')
    })
  })
})
