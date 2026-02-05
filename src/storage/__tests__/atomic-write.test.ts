/**
 * Tests for Atomic Write Utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  atomicWrite,
  appendToFile,
  fileExists,
  readFileOrEmpty,
} from '../atomic-write.js'

describe('atomic-write', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-atomic-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('atomicWrite', () => {
    it('should write content to file', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      const content = 'Hello, World!'

      await atomicWrite(filePath, content)

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe(content)
    })

    it('should overwrite existing file', async () => {
      const filePath = path.join(tempDir, 'test.txt')

      await atomicWrite(filePath, 'First content')
      await atomicWrite(filePath, 'Second content')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('Second content')
    })

    it('should create parent directories if they do not exist', async () => {
      const filePath = path.join(tempDir, 'nested', 'dir', 'test.txt')
      const content = 'Nested content'

      await atomicWrite(filePath, content)

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe(content)
    })

    it('should not leave temp file on success', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      await atomicWrite(filePath, 'content')

      const files = await fs.readdir(tempDir)
      expect(files).toEqual(['test.txt'])
    })

    it.skipIf(process.getuid?.() === 0)('should clean up temp file on write failure', async () => {
      const readOnlyDir = path.join(tempDir, 'readonly')
      await fs.mkdir(readOnlyDir)

      // Create a subdirectory that we'll make read-only
      const filePath = path.join(readOnlyDir, 'subdir', 'test.txt')

      // Make the directory read-only (can't create files in it)
      await fs.chmod(readOnlyDir, 0o444)

      try {
        await expect(atomicWrite(filePath, 'content')).rejects.toThrow()

        // Check no temp files left (the directory itself should be clean)
        await fs.chmod(readOnlyDir, 0o755)
        const files = await fs.readdir(readOnlyDir)
        expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(readOnlyDir, 0o755)
      }
    })

    it('should handle unicode content', async () => {
      const filePath = path.join(tempDir, 'unicode.txt')
      const content = '你好世界 🌍 Привет мир'

      await atomicWrite(filePath, content)

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe(content)
    })

    it('should handle empty content', async () => {
      const filePath = path.join(tempDir, 'empty.txt')

      await atomicWrite(filePath, '')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('')
    })

    it('should handle large content', async () => {
      const filePath = path.join(tempDir, 'large.txt')
      const content = 'x'.repeat(1024 * 1024) // 1MB

      await atomicWrite(filePath, content)

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result.length).toBe(content.length)
    })
  })

  describe('appendToFile', () => {
    it('should append content to existing file', async () => {
      const filePath = path.join(tempDir, 'append.txt')
      await fs.writeFile(filePath, 'Line 1\n')

      await appendToFile(filePath, 'Line 2\n')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('Line 1\nLine 2\n')
    })

    it('should create file if it does not exist', async () => {
      const filePath = path.join(tempDir, 'new.txt')

      await appendToFile(filePath, 'First line\n')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('First line\n')
    })

    it('should create parent directories', async () => {
      const filePath = path.join(tempDir, 'nested', 'append.txt')

      await appendToFile(filePath, 'content')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('content')
    })

    it('should handle multiple appends', async () => {
      const filePath = path.join(tempDir, 'multi.txt')

      await appendToFile(filePath, 'A')
      await appendToFile(filePath, 'B')
      await appendToFile(filePath, 'C')

      const result = await fs.readFile(filePath, 'utf-8')
      expect(result).toBe('ABC')
    })
  })

  describe('fileExists', () => {
    it('should return true for existing file', async () => {
      const filePath = path.join(tempDir, 'exists.txt')
      await fs.writeFile(filePath, 'content')

      const result = await fileExists(filePath)

      expect(result).toBe(true)
    })

    it('should return false for non-existing file', async () => {
      const filePath = path.join(tempDir, 'nonexistent.txt')

      const result = await fileExists(filePath)

      expect(result).toBe(false)
    })

    it('should return true for existing directory', async () => {
      const result = await fileExists(tempDir)

      expect(result).toBe(true)
    })

    it('should return false for non-existing directory', async () => {
      const dirPath = path.join(tempDir, 'nonexistent-dir')

      const result = await fileExists(dirPath)

      expect(result).toBe(false)
    })
  })

  describe('readFileOrEmpty', () => {
    it('should return file content for existing file', async () => {
      const filePath = path.join(tempDir, 'read.txt')
      await fs.writeFile(filePath, 'Hello')

      const result = await readFileOrEmpty(filePath)

      expect(result).toBe('Hello')
    })

    it('should return empty string for non-existing file', async () => {
      const filePath = path.join(tempDir, 'nonexistent.txt')

      const result = await readFileOrEmpty(filePath)

      expect(result).toBe('')
    })

    it.skipIf(process.getuid?.() === 0)('should throw for permission errors', async () => {
      const filePath = path.join(tempDir, 'noperm.txt')
      await fs.writeFile(filePath, 'content')
      await fs.chmod(filePath, 0o000)

      try {
        await expect(readFileOrEmpty(filePath)).rejects.toThrow()
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(filePath, 0o644)
      }
    })

    it('should throw for directory path', async () => {
      await expect(readFileOrEmpty(tempDir)).rejects.toThrow()
    })
  })
})
