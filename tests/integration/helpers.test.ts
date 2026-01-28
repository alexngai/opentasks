/**
 * Tests for Integration Test Helpers
 *
 * Verifies that the helper utilities work correctly.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  SLOW_TESTS,
  withTempDir,
  waitFor,
  sleep,
  retry,
  uniqueSocketPath,
  uniqueFilePath,
  type TempDirContext,
} from './helpers/index.js'

describe.skipIf(!SLOW_TESTS)('Integration Test Helpers', () => {
  let tempDir: TempDirContext | null = null

  afterEach(async () => {
    if (tempDir) {
      await tempDir.cleanup()
      tempDir = null
    }
  })

  describe('withTempDir', () => {
    it('should create a temporary directory', async () => {
      tempDir = await withTempDir('test-')
      expect(tempDir.path).toBeTruthy()
      expect(tempDir.exists('.')).toBe(true)
    })

    it('should write and read files', async () => {
      tempDir = await withTempDir('test-')
      await tempDir.writeFile('test.txt', 'hello world')
      const content = await tempDir.readFile('test.txt')
      expect(content).toBe('hello world')
    })

    it('should create subdirectories', async () => {
      tempDir = await withTempDir('test-')
      await tempDir.mkdir('sub/dir')
      expect(tempDir.exists('sub/dir')).toBe(true)
    })

    it('should resolve relative paths', async () => {
      tempDir = await withTempDir('test-')
      const resolved = tempDir.resolve('foo/bar.txt')
      expect(resolved).toContain(tempDir.path)
      expect(resolved).toContain('foo/bar.txt')
    })
  })

  describe('waitFor', () => {
    it('should resolve when condition becomes true', async () => {
      let value = false
      setTimeout(() => { value = true }, 100)

      await waitFor(() => value, { timeout: 1000 })
      expect(value).toBe(true)
    })

    it('should reject on timeout', async () => {
      await expect(
        waitFor(() => false, { timeout: 100, message: 'test timeout' })
      ).rejects.toThrow('test timeout')
    })
  })

  describe('sleep', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now()
      await sleep(100)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(90)
    })
  })

  describe('retry', () => {
    it('should retry until success', async () => {
      let attempts = 0
      const result = await retry(async () => {
        attempts++
        if (attempts < 3) throw new Error('not yet')
        return 'success'
      }, { timeout: 1000, interval: 50 })

      expect(result).toBe('success')
      expect(attempts).toBe(3)
    })

    it('should fail after timeout', async () => {
      await expect(
        retry(async () => { throw new Error('always fails') }, { timeout: 100 })
      ).rejects.toThrow('always fails')
    })
  })

  describe('uniqueSocketPath', () => {
    it('should generate unique paths', () => {
      const path1 = uniqueSocketPath()
      const path2 = uniqueSocketPath()
      expect(path1).not.toBe(path2)
      expect(path1).toContain('.sock')
    })
  })

  describe('uniqueFilePath', () => {
    it('should generate unique paths with extension', async () => {
      tempDir = await withTempDir('test-')
      const path1 = uniqueFilePath(tempDir.path, '.jsonl')
      const path2 = uniqueFilePath(tempDir.path, '.jsonl')
      expect(path1).not.toBe(path2)
      expect(path1).toContain('.jsonl')
    })
  })
})
