/**
 * Atomic file write utilities
 *
 * Prevents partial writes on crash by writing to temp file then renaming.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Write content to a file atomically
 *
 * Uses temp file + rename strategy to prevent partial writes.
 *
 * @param filePath - Target file path
 * @param content - Content to write
 */
export async function atomicWrite(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath)
  const tempPath = `${filePath}.${process.pid}.tmp`

  try {
    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true })

    // Write to temp file
    await fs.writeFile(tempPath, content, 'utf-8')

    // Atomic rename
    await fs.rename(tempPath, filePath)
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempPath)
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Append content to a file
 *
 * Creates file if it doesn't exist.
 *
 * @param filePath - Target file path
 * @param content - Content to append (should include newline if needed)
 */
export async function appendToFile(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(filePath, content, 'utf-8')
}

/**
 * Check if a file exists
 *
 * @param filePath - Path to check
 * @returns true if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Read file content, returning empty string if file doesn't exist
 *
 * @param filePath - Path to read
 * @returns File content or empty string
 */
export async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    throw error
  }
}
