/**
 * Beads Provider Integration Tests
 *
 * Tests BeadsProvider against real bd CLI in a temp directory.
 * Requires @beads/bd package to be installed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { createBeadsProvider, type BeadsConfig } from '../../../src/providers/beads.js'
import type { Provider } from '../../../src/providers/types.js'
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
  // Initialize git repo first (bd requires git)
  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })

  // Create initial commit (bd may need this)
  await execAsync('touch .gitkeep && git add . && git commit -m "init"', { cwd: dir })

  // Initialize bd with sandbox mode (no daemon, no auto-sync)
  await execAsync(`npx bd init --prefix ${prefix} --sandbox --skip-hooks --skip-merge-driver`, { cwd: dir, timeout: 30000 })
}

describe.skipIf(!SLOW_TESTS)('BeadsProvider Integration', () => {
  describe('CRUD operations', () => {
    let tempDir: TempDirContext
    let provider: Provider
    let bdAvailable: boolean

    beforeAll(async () => {
      bdAvailable = await checkBdAvailable()
      if (!bdAvailable) {
        console.log('Skipping BeadsProvider CRUD tests: bd CLI not available')
        return
      }

      tempDir = await withTempDir('beads-test-')
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

    it('should create an issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const result = await provider.create({
        title: 'Test Issue',
        content: 'This is a test issue description',
        type: 'issue',
      })

      expect(result.id).toMatch(/^bd-/)
      expect(result.title).toBe('Test Issue')
      expect(result.uri).toMatch(/^beads:\/\//)
    })

    it('should get an issue by ID', async ({ skip }) => {
      if (!bdAvailable) skip()

      // First create an issue
      const created = await provider.create({
        title: 'Get Test',
        content: 'Description for get test',
        type: 'issue',
      })

      // Then get it
      const result = await provider.get(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
      expect(result?.title).toBe('Get Test')
    })

    it('should return null for non-existent issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const result = await provider.get('bd-nonexistent99999')

      expect(result).toBeNull()
    })

    it('should list issues', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create a couple of issues
      await provider.create({ title: 'List Test 1', type: 'issue' })
      await provider.create({ title: 'List Test 2', type: 'issue' })

      const results = await provider.list()

      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.some(r => r.title === 'List Test 1')).toBe(true)
      expect(results.some(r => r.title === 'List Test 2')).toBe(true)
    })

    it('should update an issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Update Test Original',
        content: 'Original description',
        type: 'issue',
      })

      const updated = await provider.update(created.id, {
        title: 'Update Test Modified',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.title).toBe('Update Test Modified')
    })

    it('should delete an issue', async ({ skip }) => {
      if (!bdAvailable) skip()

      const created = await provider.create({
        title: 'Delete Test',
        type: 'issue',
      })

      await provider.delete(created.id)

      const result = await provider.get(created.id)
      expect(result).toBeNull()
    })
  })

  describe('search operations', () => {
    let tempDir: TempDirContext
    let provider: Provider
    let bdAvailable: boolean

    beforeAll(async () => {
      bdAvailable = await checkBdAvailable()
      if (!bdAvailable) {
        console.log('Skipping BeadsProvider search tests: bd CLI not available')
        return
      }

      tempDir = await withTempDir('beads-search-')
      await initBeadsWorkspace(tempDir.path, 'bd')

      const config: BeadsConfig = {
        executable: 'npx bd',
        cwd: tempDir.path,
        timeout: 30000,
      }
      provider = createBeadsProvider(config)

      // Create test issues for search
      await provider.create({ title: 'Authentication Feature', content: 'Implement OAuth login', type: 'issue' })
      await provider.create({ title: 'Database Migration', content: 'Migrate to PostgreSQL', type: 'issue' })
      await provider.create({ title: 'API Documentation', content: 'Write OAuth docs', type: 'issue' })
    })

    afterAll(async () => {
      if (tempDir) {
        await tempDir.cleanup()
      }
    })

    it('should search issues by query', async ({ skip }) => {
      if (!bdAvailable) skip()

      const results = await provider.search('OAuth')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some(r => r.title.includes('Authentication') || r.content?.includes('OAuth'))).toBe(true)
    })

    it('should return empty array for no matches', async ({ skip }) => {
      if (!bdAvailable) skip()

      const results = await provider.search('xyznonexistenttermxyz')

      expect(results).toEqual([])
    })
  })

  describe('URI handling', () => {
    let provider: Provider

    beforeAll(() => {
      provider = createBeadsProvider()
    })

    it('should parse beads:// URI', () => {
      const parsed = provider.parseUri('beads://workspace/bd-abc123')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('beads')
      expect(parsed?.workspace).toBe('workspace')
      expect(parsed?.id).toBe('bd-abc123')
    })

    it('should parse bd:// URI', () => {
      const parsed = provider.parseUri('bd://./bd-xyz789')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('bd')
      expect(parsed?.id).toBe('bd-xyz789')
    })

    it('should parse bare Beads ID', () => {
      const parsed = provider.parseUri('bd-abc123')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('beads')
      expect(parsed?.id).toBe('bd-abc123')
      expect(parsed?.isRelative).toBe(true)
    })

    it('should build URI from ID', () => {
      const uri = provider.buildUri('bd-abc123', { workspace: 'myworkspace' })

      expect(uri).toBe('beads://myworkspace/bd-abc123')
    })

    it('should validate URIs correctly', () => {
      expect(provider.isValidUri('beads://workspace/bd-abc123')).toBe(true)
      expect(provider.isValidUri('bd://./bd-xyz')).toBe(true)
      expect(provider.isValidUri('bd-abc123')).toBe(true)
      expect(provider.isValidUri('invalid://something')).toBe(false)
      expect(provider.isValidUri('random-string')).toBe(false)
    })
  })

  describe('error handling', () => {
    it('should throw error when bd CLI not found', async () => {
      const provider = createBeadsProvider({
        executable: 'nonexistent-bd-cli-12345',
      })

      await expect(provider.list()).rejects.toThrow('not found')
    })
  })

  describe('concurrent operations', () => {
    let tempDir: TempDirContext
    let provider: Provider
    let bdAvailable: boolean

    beforeAll(async () => {
      bdAvailable = await checkBdAvailable()
      if (!bdAvailable) {
        console.log('Skipping BeadsProvider concurrent tests: bd CLI not available')
        return
      }

      tempDir = await withTempDir('beads-concurrent-')
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

    it('should handle concurrent creates', async ({ skip }) => {
      if (!bdAvailable) skip()

      const promises = Array.from({ length: 5 }, (_, i) =>
        provider.create({ title: `Concurrent Issue ${i}`, type: 'issue' })
      )

      const results = await Promise.all(promises)

      expect(results).toHaveLength(5)
      const ids = new Set(results.map(r => r.id))
      expect(ids.size).toBe(5) // All unique IDs
    })

    it('should handle concurrent reads', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create an issue first
      const created = await provider.create({ title: 'Concurrent Read Test', type: 'issue' })

      // Read it concurrently
      const promises = Array.from({ length: 10 }, () => provider.get(created.id))
      const results = await Promise.all(promises)

      expect(results.every(r => r?.id === created.id)).toBe(true)
    })
  })

  describe('workspace isolation', () => {
    let tempDir1: TempDirContext
    let tempDir2: TempDirContext
    let provider1: Provider
    let provider2: Provider
    let bdAvailable: boolean

    beforeAll(async () => {
      bdAvailable = await checkBdAvailable()
      if (!bdAvailable) {
        console.log('Skipping BeadsProvider workspace tests: bd CLI not available')
        return
      }

      tempDir1 = await withTempDir('beads-ws1-')
      tempDir2 = await withTempDir('beads-ws2-')

      await initBeadsWorkspace(tempDir1.path, 'ws1')
      await initBeadsWorkspace(tempDir2.path, 'ws2')

      provider1 = createBeadsProvider({ executable: 'npx bd', cwd: tempDir1.path })
      provider2 = createBeadsProvider({ executable: 'npx bd', cwd: tempDir2.path })
    })

    afterAll(async () => {
      if (tempDir1) await tempDir1.cleanup()
      if (tempDir2) await tempDir2.cleanup()
    })

    it('should isolate issues between workspaces', async ({ skip }) => {
      if (!bdAvailable) skip()

      // Create issue in workspace 1
      await provider1.create({ title: 'Workspace 1 Issue', type: 'issue' })

      // Create issue in workspace 2
      await provider2.create({ title: 'Workspace 2 Issue', type: 'issue' })

      // List from each workspace
      const list1 = await provider1.list()
      const list2 = await provider2.list()

      // Each workspace should only see its own issues
      expect(list1.some(i => i.title === 'Workspace 1 Issue')).toBe(true)
      expect(list1.some(i => i.title === 'Workspace 2 Issue')).toBe(false)

      expect(list2.some(i => i.title === 'Workspace 2 Issue')).toBe(true)
      expect(list2.some(i => i.title === 'Workspace 1 Issue')).toBe(false)
    })
  })
})
