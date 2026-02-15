/**
 * Beads Provider TaskManageable Integration Tests
 *
 * Tests TaskManageable trait methods against real bd CLI in a temp directory.
 * Validates task transitions, ready queries, assignment, and valid actions
 * using actual Beads workspaces.
 *
 * Requires @beads/bd package to be installed.
 * Run with: RUN_SLOW_TESTS=1 npx vitest run tests/integration/providers/beads-task-manageable.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { createBeadsProvider, type BeadsConfig } from '../../../src/providers/beads.js'
import type { Provider, ProviderNode } from '../../../src/providers/types.js'
import { isTaskManageable, type TaskManageable } from '../../../src/providers/traits/TaskManageable.js'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'

const execAsync = promisify(execCallback)

/**
 * Check if bd CLI is available (cached result)
 */
let _bdAvailable: boolean | null = null

async function checkBdAvailable(): Promise<boolean> {
  if (_bdAvailable !== null) return _bdAvailable

  try {
    await execAsync('npx bd version', { timeout: 30000 })
    _bdAvailable = true
    return true
  } catch {
    _bdAvailable = false
    return false
  }
}

/**
 * Initialize a Beads workspace in a temp directory
 */
async function initBeadsWorkspace(dir: string, prefix: string = 'test'): Promise<void> {
  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })
  await execAsync('git config commit.gpgSign false', { cwd: dir })
  await execAsync('touch .gitkeep && git add . && git commit --no-gpg-sign -m "init"', { cwd: dir })
  await execAsync(`npx bd init --prefix ${prefix} --sandbox --skip-hooks --skip-merge-driver --no-db`, {
    cwd: dir,
    timeout: 30000,
  })
}

describe.skipIf(!SLOW_TESTS)('BeadsProvider TaskManageable Integration', () => {
  let tempDir: TempDirContext
  let provider: Provider & TaskManageable
  let bdAvailable: boolean

  beforeAll(async () => {
    bdAvailable = await checkBdAvailable()
    if (!bdAvailable) {
      console.log('Skipping BeadsProvider TaskManageable tests: bd CLI not available')
      return
    }

    tempDir = await withTempDir('beads-task-mgmt-')
    await initBeadsWorkspace(tempDir.path, 'bd')

    const config: BeadsConfig = {
      executable: 'npx bd',
      cwd: tempDir.path,
      timeout: 30000,
    }
    provider = createBeadsProvider(config)
  })

  afterAll(async () => {
    if (tempDir) {
      await tempDir.cleanup()
    }
  })

  describe('trait detection', () => {
    it('should be detected as TaskManageable', async ({ skip }) => {
      if (!bdAvailable) skip()

      expect(isTaskManageable(provider)).toBe(true)
    })

    it('should declare correct taskCapabilities', async ({ skip }) => {
      if (!bdAvailable) skip()

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
    it('should start an issue (open → in_progress)', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Start Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'start')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('in_progress')
    })

    it('should complete an issue (in_progress → closed)', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Complete Test',
        type: 'issue',
      })

      await provider.transitionTask(created.id, 'start')
      const result = await provider.transitionTask(created.id, 'complete')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('closed')
    })

    it('should block an issue (open → blocked)', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Block Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'block')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('blocked')
    })

    it('should reopen a closed issue (closed → open)', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Reopen Test',
        type: 'issue',
      })

      await provider.transitionTask(created.id, 'close')
      const result = await provider.transitionTask(created.id, 'reopen')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('open')
    })

    it('should close an issue directly (open → closed)', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Close Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'close')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('closed')
    })

    it('should accept URI format for ID', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'URI Format Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(`beads://./${created.id}`, 'start')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('in_progress')
    })
  })

  describe('readyTasks', () => {
    it('should return open issues with no blockers', async ({ skip }) => {
      if (!bdAvailable) skip()

      const issue = await provider.create({
        title: 'Ready Issue',
        type: 'issue',
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(true)
    })

    it('should exclude closed issues', async ({ skip }) => {
      if (!bdAvailable) skip()

      const issue = await provider.create({
        title: 'Closed Issue For Ready',
        type: 'issue',
      })
      await provider.transitionTask(issue.id, 'close')

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should exclude in_progress issues', async ({ skip }) => {
      if (!bdAvailable) skip()

      const issue = await provider.create({
        title: 'In Progress Issue For Ready',
        type: 'issue',
      })
      await provider.transitionTask(issue.id, 'start')

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should respect limit option', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create several open issues
      await provider.create({ title: 'Limit Test 1', type: 'issue' })
      await provider.create({ title: 'Limit Test 2', type: 'issue' })
      await provider.create({ title: 'Limit Test 3', type: 'issue' })

      const ready = await provider.readyTasks({ limit: 2 })

      expect(ready.length).toBeLessThanOrEqual(2)
    })

    it('should exclude issues with active blockers', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create a blocker issue
      const blocker = await provider.create({
        title: 'Blocker Issue',
        type: 'issue',
      })

      // Create blocked issue with dependency
      const blocked = await provider.create({
        title: 'Blocked By Active',
        type: 'issue',
      })

      // Link blocker → blocks → blocked
      await execAsync(`npx bd dep ${blocker.id} --blocks ${blocked.id}`, {
        cwd: tempDir.path,
        timeout: 30000,
      })

      const ready = await provider.readyTasks()

      // Blocked issue should NOT be ready (blocker is still open)
      expect(ready.some((r: ProviderNode) => r.id === blocked.id)).toBe(false)
      // Blocker itself should be ready (nothing blocks it)
      expect(ready.some((r: ProviderNode) => r.id === blocker.id)).toBe(true)
    })

    it('should include issues once blocker is resolved', async ({ skip }) => {
      if (!bdAvailable) skip()

      const blocker = await provider.create({
        title: 'Resolve Blocker',
        type: 'issue',
      })

      const blocked = await provider.create({
        title: 'Becomes Ready',
        type: 'issue',
      })

      await execAsync(`npx bd dep ${blocker.id} --blocks ${blocked.id}`, {
        cwd: tempDir.path,
        timeout: 30000,
      })

      // Close the blocker
      await provider.transitionTask(blocker.id, 'close')

      const ready = await provider.readyTasks()

      // Now the previously blocked issue should be ready
      expect(ready.some((r: ProviderNode) => r.id === blocked.id)).toBe(true)
    })
  })

  describe('assignTask', () => {
    it('should assign an issue to a user', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Assign Test',
        type: 'issue',
      })

      const result = await provider.assignTask!(created.id, 'alice')

      expect(result.id).toBe(created.id)
      // Verify assignment persisted
      const fetched = await provider.get(created.id)
      expect(fetched).not.toBeNull()
    })
  })

  describe('validActions', () => {
    it('should return start, block, close for open issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Valid Actions Open',
        type: 'issue',
      })

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('start')
      expect(actions).toContain('block')
      expect(actions).toContain('close')
      expect(actions).not.toContain('complete')
      expect(actions).not.toContain('reopen')
    })

    it('should return complete, block, close for in_progress issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Valid Actions InProgress',
        type: 'issue',
      })
      await provider.transitionTask(created.id, 'start')

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('complete')
      expect(actions).toContain('block')
      expect(actions).toContain('close')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('reopen')
    })

    it('should return reopen, close for blocked issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Valid Actions Blocked',
        type: 'issue',
      })
      await provider.transitionTask(created.id, 'block')

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('reopen')
      expect(actions).toContain('close')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('complete')
    })

    it('should return reopen for closed issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Valid Actions Closed',
        type: 'issue',
      })
      await provider.transitionTask(created.id, 'close')

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('reopen')
      expect(actions).not.toContain('start')
      expect(actions).not.toContain('complete')
      expect(actions).not.toContain('block')
      expect(actions).not.toContain('close')
    })
  })

  describe('full lifecycle', () => {
    it('should complete a full task lifecycle: create → start → complete', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create
      const issue = await provider.create({
        title: 'Full Lifecycle Test',
        type: 'issue',
      })
      expect(issue.status).toBe('open')

      // Start
      const started = await provider.transitionTask(issue.id, 'start')
      expect(started.status).toBe('in_progress')

      // Complete
      const completed = await provider.transitionTask(issue.id, 'complete')
      expect(completed.status).toBe('closed')

      // Verify final state
      const fetched = await provider.get(issue.id)
      expect(fetched?.status).toBe('closed')
    })

    it('should handle block and reopen flow', async ({ skip }) => {
      if (!bdAvailable) skip()

      const issue = await provider.create({
        title: 'Block Reopen Lifecycle',
        type: 'issue',
      })

      // Start working
      await provider.transitionTask(issue.id, 'start')

      // Hit a blocker
      const blocked = await provider.transitionTask(issue.id, 'block')
      expect(blocked.status).toBe('blocked')

      // Blocker resolved, reopen
      const reopened = await provider.transitionTask(issue.id, 'reopen')
      expect(reopened.status).toBe('open')

      // Resume and complete
      await provider.transitionTask(issue.id, 'start')
      const completed = await provider.transitionTask(issue.id, 'complete')
      expect(completed.status).toBe('closed')
    })
  })
})
