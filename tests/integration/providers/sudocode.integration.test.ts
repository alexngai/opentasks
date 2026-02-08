/**
 * Sudocode Provider Integration Tests
 *
 * Tests SudocodeProvider against real sudocode CLI in a temp directory.
 * Requires sudocode package to be installed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { createSudocodeProvider, type SudocodeConfig } from '../../../src/providers/sudocode.js'
import type { Provider } from '../../../src/providers/types.js'
import { isRelationshipQueryable } from '../../../src/providers/traits/RelationshipQueryable.js'
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
  // Initialize git repo first (sudocode is git-native)
  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })
  await execAsync('touch .gitkeep && git add . && git commit -m "init"', { cwd: dir })

  // Initialize sudocode
  await execAsync('npx sudocode init', { cwd: dir, timeout: 30000 })
}

describe.skipIf(!SLOW_TESTS)('SudocodeProvider Integration', () => {
  describe('CRUD operations', () => {
    let tempDir: TempDirContext
    let provider: Provider
    let sudocodeAvailable: boolean

    beforeAll(async () => {
      sudocodeAvailable = await checkSudocodeAvailable()
      if (!sudocodeAvailable) {
        console.log('Skipping SudocodeProvider CRUD tests: sudocode CLI not available')
        return
      }

      tempDir = await withTempDir('sudocode-test-')
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

    it('should create an issue', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const result = await provider.create({
        title: 'Test Issue',
        content: 'This is a test issue description',
        type: 'issue',
      })

      expect(result.id).toBeTruthy()
      expect(result.title).toBe('Test Issue')
      expect(result.uri).toMatch(/^sudocode:\/\//)
      expect(result.type).toBe('issue')
    })

    it('should create a spec', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const result = await provider.create({
        title: 'Test Spec',
        content: 'This is a test spec description',
        type: 'spec',
      })

      expect(result.id).toBeTruthy()
      expect(result.title).toBe('Test Spec')
      expect(result.uri).toMatch(/^sudocode:\/\//)
      expect(result.type).toBe('spec')
    })

    it('should get an issue by ID', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'Get Test',
        content: 'Description for get test',
        type: 'issue',
      })

      const result = await provider.get(created.id)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(created.id)
      expect(result?.title).toBe('Get Test')
    })

    it('should return null for non-existent entity', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      const result = await provider.get('i-nonexistent99999')

      expect(result).toBeNull()
    })

    it('should list issues', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

      await provider.create({ title: 'List Test 1', type: 'issue' })
      await provider.create({ title: 'List Test 2', type: 'issue' })

      const results = await provider.list({ type: 'issue' })

      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.some(r => r.title === 'List Test 1')).toBe(true)
      expect(results.some(r => r.title === 'List Test 2')).toBe(true)
    })

    it('should update an issue', async ({ skip }) => {
      if (!sudocodeAvailable) skip()

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
      if (!sudocodeAvailable) skip()

      const created = await provider.create({
        title: 'Delete Test',
        type: 'issue',
      })

      await provider.delete(created.id)

      const result = await provider.get(created.id)
      expect(result).toBeNull()
    })
  })

  describe('URI handling', () => {
    let provider: ReturnType<typeof createSudocodeProvider>

    beforeAll(() => {
      provider = createSudocodeProvider()
    })

    it('should parse sudocode:// URI', () => {
      const parsed = provider.parseUri('sudocode://workspace/i-abc123')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sudocode')
      expect(parsed?.workspace).toBe('workspace')
      expect(parsed?.id).toBe('i-abc123')
    })

    it('should parse sc:// URI', () => {
      const parsed = provider.parseUri('sc://./s-xyz789')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sc')
      expect(parsed?.id).toBe('s-xyz789')
    })

    it('should parse bare issue ID', () => {
      const parsed = provider.parseUri('i-abc123')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sudocode')
      expect(parsed?.id).toBe('i-abc123')
      expect(parsed?.isRelative).toBe(true)
    })

    it('should parse bare spec ID', () => {
      const parsed = provider.parseUri('s-abc123')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sudocode')
      expect(parsed?.id).toBe('s-abc123')
      expect(parsed?.isRelative).toBe(true)
    })

    it('should parse ISSUE-NNN format', () => {
      const parsed = provider.parseUri('ISSUE-001')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sudocode')
      expect(parsed?.id).toBe('ISSUE-001')
    })

    it('should parse SPEC-NNN format', () => {
      const parsed = provider.parseUri('SPEC-001')

      expect(parsed).not.toBeNull()
      expect(parsed?.scheme).toBe('sudocode')
      expect(parsed?.id).toBe('SPEC-001')
    })

    it('should build URI from ID', () => {
      const uri = provider.buildUri('i-abc123', { workspace: 'myworkspace' })

      expect(uri).toBe('sudocode://myworkspace/i-abc123')
    })

    it('should build relative URI', () => {
      const uri = provider.buildUri('i-abc123', { relative: true })

      expect(uri).toBe('i-abc123')
    })

    it('should validate URIs correctly', () => {
      expect(provider.isValidUri('sudocode://workspace/i-abc123')).toBe(true)
      expect(provider.isValidUri('sc://./s-xyz')).toBe(true)
      expect(provider.isValidUri('i-abc123')).toBe(true)
      expect(provider.isValidUri('s-abc123')).toBe(true)
      expect(provider.isValidUri('ISSUE-001')).toBe(true)
      expect(provider.isValidUri('SPEC-001')).toBe(true)
      expect(provider.isValidUri('invalid://something')).toBe(false)
      expect(provider.isValidUri('random-string')).toBe(false)
    })

    it('should not parse non-sudocode URIs', () => {
      expect(provider.parseUri('beads://./bd-abc')).toBeNull()
      expect(provider.parseUri('native://i-abc')).toBeNull()
      expect(provider.parseUri('bd-abc123')).toBeNull()
    })
  })

  describe('RelationshipQueryable', () => {
    it('should implement RelationshipQueryable trait', () => {
      const provider = createSudocodeProvider()
      expect(isRelationshipQueryable(provider)).toBe(true)
    })

    it('should declare supported edge types with query-only capabilities', () => {
      const provider = createSudocodeProvider()
      const types = provider.supportedEdgeTypes()

      expect(types.length).toBeGreaterThan(0)
      expect(types.some(t => t.type === 'blocks')).toBe(true)
      expect(types.some(t => t.type === 'implements')).toBe(true)
      expect(types.some(t => t.type === 'depends-on')).toBe(true)
      expect(types.some(t => t.type === 'related')).toBe(true)

      // All edge types should be query-only (no create/delete methods implemented)
      for (const edgeType of types) {
        expect(edgeType.canQuery).toBe(true)
        expect(edgeType.canCreate).toBe(false)
        expect(edgeType.canDelete).toBe(false)
      }
    })
  })

  describe('error handling', () => {
    it('should throw error when sudocode CLI not found for create', async () => {
      const provider = createSudocodeProvider({
        executable: 'nonexistent-sudocode-cli-12345',
      })

      await expect(
        provider.create({ title: 'Test', type: 'issue' })
      ).rejects.toThrow()
    })

    it('should return empty list when sudocode CLI not found for list', async () => {
      const provider = createSudocodeProvider({
        executable: 'nonexistent-sudocode-cli-12345',
      })

      // list() is resilient — returns empty when CLI fails per entity type
      const results = await provider.list()
      expect(results).toEqual([])
    })
  })

  describe('provider metadata', () => {
    it('should have correct name', () => {
      const provider = createSudocodeProvider()
      expect(provider.name).toBe('sudocode')
    })

    it('should have correct schemes', () => {
      const provider = createSudocodeProvider()
      expect(provider.schemes).toEqual(['sudocode', 'sc'])
    })

    it('should have correct capabilities', () => {
      const provider = createSudocodeProvider()
      expect(provider.capabilities.read).toBe(true)
      expect(provider.capabilities.write).toBe(true)
      expect(provider.capabilities.search).toBe(true)
      expect(provider.capabilities.watch).toBe(false)
    })

    it('should enable watch when watchPath is set', () => {
      const provider = createSudocodeProvider({ watchPath: '/tmp/test/.sudocode' })
      expect(provider.capabilities.watch).toBe(true)
    })
  })
})
