/**
 * Temporary Directory Utilities for Integration Tests
 *
 * Helpers for creating and cleaning up temp directories.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Create a temporary directory for tests
 */
export async function createTempDir(prefix = 'opentasks-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * Remove a directory recursively
 */
export async function removeTempDir(dirPath: string): Promise<void> {
  if (existsSync(dirPath)) {
    await rm(dirPath, { recursive: true, force: true })
  }
}

/**
 * Context manager for temporary directories
 */
export interface TempDirContext {
  /** Path to the temp directory */
  path: string
  /** Create a file in the temp directory */
  writeFile(relativePath: string, content: string): Promise<string>
  /** Read a file from the temp directory */
  readFile(relativePath: string): Promise<string>
  /** Create a subdirectory in the temp directory */
  mkdir(relativePath: string): Promise<string>
  /** Get absolute path for a relative path */
  resolve(relativePath: string): string
  /** Check if a file exists in the temp directory */
  exists(relativePath: string): boolean
  /** Clean up the temp directory */
  cleanup(): Promise<void>
}

/**
 * Create a temp directory context for easier file management in tests
 */
export async function withTempDir(prefix = 'opentasks-test-'): Promise<TempDirContext> {
  const path = await createTempDir(prefix)

  return {
    path,

    resolve(relativePath: string): string {
      return join(path, relativePath)
    },

    exists(relativePath: string): boolean {
      return existsSync(join(path, relativePath))
    },

    async writeFile(relativePath: string, content: string): Promise<string> {
      const fullPath = join(path, relativePath)
      const dir = join(fullPath, '..')
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true })
      }
      await writeFile(fullPath, content, 'utf-8')
      return fullPath
    },

    async readFile(relativePath: string): Promise<string> {
      return readFile(join(path, relativePath), 'utf-8')
    },

    async mkdir(relativePath: string): Promise<string> {
      const fullPath = join(path, relativePath)
      await mkdir(fullPath, { recursive: true })
      return fullPath
    },

    async cleanup(): Promise<void> {
      await removeTempDir(path)
    },
  }
}

/**
 * Generate a unique socket path for testing
 */
export function uniqueSocketPath(prefix = 'opentasks'): string {
  const random = Math.random().toString(36).substring(2, 10)
  return join(tmpdir(), `${prefix}-${random}.sock`)
}

/**
 * Generate a unique file path for testing
 */
export function uniqueFilePath(dir: string, ext = '.jsonl'): string {
  const random = Math.random().toString(36).substring(2, 10)
  return join(dir, `test-${random}${ext}`)
}
