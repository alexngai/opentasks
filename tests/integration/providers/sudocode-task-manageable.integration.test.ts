/**
 * Sudocode Provider TaskManageable Integration Tests
 *
 * Tests TaskManageable trait methods against real sudocode CLI in a temp directory.
 * Validates task transitions, ready queries, assignment, and valid actions
 * using actual Sudocode workspaces.
 *
 * Requires sudocode package to be installed.
 * Run with: RUN_SLOW_TESTS=1 npx vitest run tests/integration/providers/sudocode-task-manageable.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { createSudocodeProvider, type SudocodeConfig } from '../../../src/providers/sudocode.js'
import type { Provider, ProviderNode } from '../../../src/providers/types.js'
import { isTaskManageable, type TaskManageable } from '../../../src/providers/traits/TaskManageable.js'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'

const execAsync = promisify(execCallback)

/**
 * Check if sudocode CLI is available (cached result)
 */
let _sudocodeAvailable: boolean | null = null

async function checkSudocodeAvailable(): Promise<boolean> {
  if (_sudocodeAvailable !== null) return _sudocodeAvailable

  try {
    await execAsync('npx sudocode --version', { timeout: 30000 })
    _sudocodeAvailable = true
    return true
  } catch {
    _sudocodeAvailable = false
    return false
  }
}

/**
 * Initialize a Sudocode workspace in a temp directory
 */
async function initSudocodeWorkspace(dir: string): Promise<void> {
  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })
  await execAsync('git config commit.gpgSign false', { cwd: dir })
  await execAsync('touch .gitkeep && git add . && git commit --no-gpg-sign -m "init"', { cwd: dir })
  await execAsync('npx sudocode init', { cwd: dir, timeout: 30000 })
}

describe.skipIf(!SLOW_TESTS)('SudocodeProvider TaskManageable Integration', () => {
  let tempDir: TempDirContext
  let provider: Provider & TaskManageable
  let sudocodeAvailable: boolean

  beforeAll(async () => {
    sudocodeAvailable = await checkSudocodeAvailable()
    if (!sudocodeAvailable) {
      console.log('Skipping SudocodeProvider TaskManageable tests: sudocode CLI not available')
      return
    }

    tempDir = await withTempDir('sudocode-task-mgmt-')
    await initSudocodeWorkspace(tempDir.path)

    const config: SudocodeConfig = {
      executable: 'npx sudocode',
      cwd: tempDir.path,
      timeout: 30000,
    }
    provider = createSudocodeProvider(config)
  })

  afterAll(async () => {
    if (tempDir) {
      await tempDir.cleanup()
    }
  })

  describe('trait detection', () => {
    it('should be detected as TaskManageable', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      expect(isTaskManageable(provider)).toBe(true)
    })

    it('should declare correct taskCapabilities', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

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
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'Start Test',
        content: 'Test starting an issue',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'start')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('in_progress')
    })

    it('should complete an issue (in_progress → closed)', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

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
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'Block Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'block')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('blocked')
    })

    it('should reopen a closed issue (closed → open)', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

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
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'Close Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(created.id, 'close')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('closed')
    })

    it('should reject transitions on specs', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const spec = await provider.create({
        title: 'Spec Transition Test',
        content: 'Specs should not support task lifecycle',
        type: 'spec',
      })

      await expect(
        provider.transitionTask(spec.id, 'start')
      ).rejects.toThrow(/only issues support/)
    })

    it('should accept URI format for ID', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'URI Format Test',
        type: 'issue',
      })

      const result = await provider.transitionTask(`sudocode://./${created.id}`, 'start')

      expect(result.id).toBe(created.id)
      expect(result.status).toBe('in_progress')
    })
  })

  describe('readyTasks', () => {
    it('should return open issues with no blockers', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const issue = await provider.create({
        title: 'Ready Issue SC',
        type: 'issue',
      })

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(true)
    })

    it('should exclude closed issues', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const issue = await provider.create({
        title: 'Closed For Ready SC',
        type: 'issue',
      })
      await provider.transitionTask(issue.id, 'close')

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should exclude in_progress issues', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const issue = await provider.create({
        title: 'InProgress For Ready SC',
        type: 'issue',
      })
      await provider.transitionTask(issue.id, 'start')

      const ready = await provider.readyTasks()

      expect(ready.some((r: ProviderNode) => r.id === issue.id)).toBe(false)
    })

    it('should respect limit option', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      await provider.create({ title: 'SC Limit Test 1', type: 'issue' })
      await provider.create({ title: 'SC Limit Test 2', type: 'issue' })
      await provider.create({ title: 'SC Limit Test 3', type: 'issue' })

      const ready = await provider.readyTasks({ limit: 2 })

      expect(ready.length).toBeLessThanOrEqual(2)
    })
  })

  describe('assignTask', () => {
    it('should assign an issue to a user', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'SC Assign Test',
        type: 'issue',
      })

      const result = await provider.assignTask!(created.id, 'bob')

      expect(result.id).toBe(created.id)
    })

    it('should reject assignment on specs', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const spec = await provider.create({
        title: 'SC Spec Assign Test',
        type: 'spec',
      })

      await expect(
        provider.assignTask!(spec.id, 'bob')
      ).rejects.toThrow(/only issues support/)
    })
  })

  describe('validActions', () => {
    it('should return start, block, close for open issue', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'SC Valid Actions Open',
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
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'SC Valid Actions InProgress',
        type: 'issue',
      })
      await provider.transitionTask(created.id, 'start')

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('complete')
      expect(actions).toContain('block')
      expect(actions).toContain('close')
    })

    it('should return reopen for closed issue', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'SC Valid Actions Closed',
        type: 'issue',
      })
      await provider.transitionTask(created.id, 'close')

      const actions = await provider.validActions!(created.id)

      expect(actions).toContain('reopen')
      expect(actions).not.toContain('start')
    })

    it('should reject querying actions for specs', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const spec = await provider.create({
        title: 'SC Spec Valid Actions',
        type: 'spec',
      })

      await expect(
        provider.validActions!(spec.id)
      ).rejects.toThrow(/only issues support/)
    })
  })

  describe('full lifecycle', () => {
    it('should complete a full task lifecycle: create → start → complete', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      // Create
      const issue = await provider.create({
        title: 'SC Full Lifecycle',
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
      if (!sudocodeAvailable) skip()

      const issue = await provider.create({
        title: 'SC Block Reopen Lifecycle',
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
