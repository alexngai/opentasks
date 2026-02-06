/**
 * Location Identity for OpenTasks (Phase 2)
 *
 * Generates deterministic location hashes from git remote URL + path.
 * Used for cross-location references in opentasks:// URIs.
 */

import { createHash, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { hexToBase36 } from './id.js'

/**
 * Location identity stored in config.json
 */
export interface LocationIdentity {
  /** 8-char base36 hash (deterministic from git remote + path) */
  hash: string
  /** UUID v4 (uniqueness guarantee) */
  uuid: string
  /** Human-readable name */
  name: string
}

/**
 * Get the git remote URL for a repository
 *
 * @param repoRoot - Path to the repository root
 * @returns The remote URL or null if no remote is configured
 */
export function getGitRemoteUrl(repoRoot: string): string | null {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return url || null
  } catch {
    return null
  }
}

/**
 * Get the git repository root directory
 *
 * @param cwd - Working directory to start from
 * @returns The repository root or null if not in a git repo
 */
export function getGitRoot(cwd: string): string | null {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return root || null
  } catch {
    return null
  }
}

/**
 * Generate a deterministic location hash from git remote URL and relative path
 *
 * The hash is stable across machines for the same repo + path combination.
 *
 * @param remoteUrl - Git remote URL (e.g., "git@github.com:user/repo.git")
 * @param relativePath - Path relative to repo root (e.g., "." or "packages/app")
 * @returns 8-character base36 hash
 */
export function generateLocationHash(remoteUrl: string, relativePath: string): string {
  const normalized = relativePath === '.' ? '' : relativePath
  const input = `${remoteUrl}:${normalized}`
  const hash = createHash('sha256').update(input).digest('hex')
  return hexToBase36(hash).slice(0, 8)
}

/**
 * Generate a fallback location hash from an absolute path
 *
 * Used when the repository has no remote configured.
 * NOT stable across machines.
 *
 * @param absolutePath - Absolute path to the .opentasks directory
 * @returns 8-character base36 hash
 */
export function generateLocationHashFallback(absolutePath: string): string {
  const hash = createHash('sha256').update(absolutePath).digest('hex')
  return hexToBase36(hash).slice(0, 8)
}

/**
 * Generate a complete location identity
 *
 * Attempts deterministic hash from git remote URL first,
 * falls back to absolute path hash if no remote is available.
 *
 * @param opentasksDir - Path to the .opentasks directory
 * @param name - Optional human-readable name (defaults to directory name)
 * @returns Location identity object
 */
export function generateLocationIdentity(
  opentasksDir: string,
  name?: string
): LocationIdentity {
  const parentDir = path.dirname(opentasksDir)
  const resolvedDir = path.resolve(parentDir)
  const gitRoot = getGitRoot(resolvedDir)

  let hash: string

  if (gitRoot) {
    const remoteUrl = getGitRemoteUrl(gitRoot)
    if (remoteUrl) {
      const relativePath = path.relative(gitRoot, resolvedDir)
      hash = generateLocationHash(remoteUrl, relativePath || '.')
    } else {
      hash = generateLocationHashFallback(path.resolve(opentasksDir))
    }
  } else {
    hash = generateLocationHashFallback(path.resolve(opentasksDir))
  }

  const locationName = name || path.basename(resolvedDir)

  return {
    hash,
    uuid: randomUUID(),
    name: locationName,
  }
}

/**
 * Validate a location hash format
 *
 * @param hash - The hash to validate
 * @returns true if the hash is a valid 8-char base36 string
 */
export function isValidLocationHash(hash: string): boolean {
  return /^[a-z0-9]{8}$/.test(hash)
}
