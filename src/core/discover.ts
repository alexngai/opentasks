/**
 * Location Discovery for OpenTasks (Phase 3)
 *
 * Finds nearby OpenTasks locations by walking the filesystem
 * in configurable directions from the current working directory.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Discovered OpenTasks location
 */
export interface DiscoveredLocation {
  /** Absolute path to the .opentasks directory */
  opentasksPath: string
  /** Location hash (from config.json) */
  hash: string
  /** Human-readable name */
  name: string
  /** Relative direction from search origin */
  direction: 'up' | 'down' | 'self'
  /** Filesystem depth from search origin */
  depth: number
}

/**
 * Discovery options
 */
export interface DiscoverOptions {
  /** Search direction: 'up' (parents), 'down' (children), 'both' */
  direction?: 'up' | 'down' | 'both'
  /** Maximum depth to traverse (default: 5) */
  maxDepth?: number
}

/**
 * Read location identity from a .opentasks/config.json file
 */
function readLocationConfig(
  opentasksDir: string
): { hash: string; name: string } | null {
  const configPath = path.join(opentasksDir, 'config.json')
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content)
    if (config.location?.hash) {
      return {
        hash: config.location.hash,
        name: config.location.name || '',
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Walk upward from a directory looking for .opentasks locations
 */
function discoverUp(
  startDir: string,
  maxDepth: number
): DiscoveredLocation[] {
  const results: DiscoveredLocation[] = []
  let currentDir = path.dirname(startDir) // Start from parent
  let depth = 1

  while (depth <= maxDepth) {
    // Check if this directory has a .opentasks
    const opentasksDir = path.join(currentDir, '.opentasks')
    if (fs.existsSync(opentasksDir)) {
      const config = readLocationConfig(opentasksDir)
      if (config) {
        results.push({
          opentasksPath: opentasksDir,
          hash: config.hash,
          name: config.name,
          direction: 'up',
          depth,
        })
      }
    }

    // Move to parent
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) break // Reached filesystem root
    currentDir = parentDir
    depth++
  }

  return results
}

/**
 * Walk downward from a directory looking for .opentasks locations
 */
function discoverDown(
  startDir: string,
  maxDepth: number
): DiscoveredLocation[] {
  const results: DiscoveredLocation[] = []

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Skip hidden directories (except .opentasks itself) and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const childDir = path.join(dir, entry.name)
      const opentasksDir = path.join(childDir, '.opentasks')

      if (fs.existsSync(opentasksDir)) {
        const config = readLocationConfig(opentasksDir)
        if (config) {
          results.push({
            opentasksPath: opentasksDir,
            hash: config.hash,
            name: config.name,
            direction: 'down',
            depth,
          })
        }
      }

      // Continue walking into subdirectories
      walk(childDir, depth + 1)
    }
  }

  walk(startDir, 1)
  return results
}

/**
 * Discover OpenTasks locations near the given directory
 *
 * @param startDir - Directory to start searching from
 * @param options - Discovery options
 * @returns Array of discovered locations
 */
export function discoverLocations(
  startDir: string,
  options: DiscoverOptions = {}
): DiscoveredLocation[] {
  const direction = options.direction ?? 'both'
  const maxDepth = options.maxDepth ?? 5
  const resolvedStart = path.resolve(startDir)

  const results: DiscoveredLocation[] = []

  // Check self first
  const selfOpentasks = path.join(resolvedStart, '.opentasks')
  if (fs.existsSync(selfOpentasks)) {
    const config = readLocationConfig(selfOpentasks)
    if (config) {
      results.push({
        opentasksPath: selfOpentasks,
        hash: config.hash,
        name: config.name,
        direction: 'self',
        depth: 0,
      })
    }
  }

  if (direction === 'up' || direction === 'both') {
    results.push(...discoverUp(resolvedStart, maxDepth))
  }

  if (direction === 'down' || direction === 'both') {
    results.push(...discoverDown(resolvedStart, maxDepth))
  }

  return results
}
