/**
 * Worktree Management for OpenTasks (Phase 3)
 *
 * Manages worktree registration, setup, and teardown.
 * Registry lives at .git/opentasks/worktrees.json.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { generateLocationHash, generateLocationHashFallback, getGitRemoteUrl, getGitRoot } from './location.js'
import { installMergeDriver } from './merge-driver.js'
import type { Connection } from './connections.js'

/**
 * Registered worktree entry
 */
export interface WorktreeEntry {
  /** Filesystem path to worktree root */
  path: string
  /** Path to .opentasks directory */
  opentasksPath: string
  /** Location hash */
  hash: string
  /** Git branch */
  branch?: string
  /** Role (manager or worker) */
  role: 'manager' | 'worker' | 'standalone'
  /** Redirect target hash (for workers) */
  redirectTarget?: string
}

/**
 * Worktree registry stored at .git/opentasks/worktrees.json
 */
export interface WorktreeRegistry {
  worktrees: WorktreeEntry[]
}

/**
 * Options for worktree setup
 */
export interface WorktreeSetupOptions {
  /** Git branch name */
  branch?: string
  /** Role for the new worktree */
  role?: 'manager' | 'worker'
  /** Location hash to redirect to (or "." for current location) */
  redirectTo?: string
  /** Don't create git worktree, just configure opentasks */
  noGitWorktree?: boolean
}

/**
 * Options for worktree teardown
 */
export interface WorktreeTeardownOptions {
  /** Also run git worktree remove */
  removeGitWorktree?: boolean
  /** Keep .opentasks data */
  keepData?: boolean
}

/**
 * Get the path to the git common dir (shared by all worktrees)
 */
export function getGitCommonDir(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return path.resolve(cwd, result)
  } catch {
    return null
  }
}

/**
 * Get the current git branch
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result === 'HEAD' ? null : result
  } catch {
    return null
  }
}

/**
 * Get the path to the worktree registry
 */
export function getRegistryPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, 'opentasks', 'worktrees.json')
}

/**
 * Read the worktree registry
 */
export function readWorktreeRegistry(gitCommonDir: string): WorktreeRegistry {
  const registryPath = getRegistryPath(gitCommonDir)
  try {
    const content = fs.readFileSync(registryPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return { worktrees: [] }
  }
}

/**
 * Write the worktree registry
 */
export function writeWorktreeRegistry(
  gitCommonDir: string,
  registry: WorktreeRegistry
): void {
  const registryPath = getRegistryPath(gitCommonDir)
  const dir = path.dirname(registryPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
}

/**
 * Register a worktree in the registry
 */
export function registerWorktree(
  gitCommonDir: string,
  entry: WorktreeEntry
): void {
  const registry = readWorktreeRegistry(gitCommonDir)

  // Remove existing entry with same hash
  registry.worktrees = registry.worktrees.filter((w) => w.hash !== entry.hash)
  registry.worktrees.push(entry)

  writeWorktreeRegistry(gitCommonDir, registry)
}

/**
 * Unregister a worktree from the registry
 */
export function unregisterWorktree(
  gitCommonDir: string,
  hash: string
): WorktreeEntry | null {
  const registry = readWorktreeRegistry(gitCommonDir)
  const entry = registry.worktrees.find((w) => w.hash === hash)

  if (!entry) return null

  registry.worktrees = registry.worktrees.filter((w) => w.hash !== hash)
  writeWorktreeRegistry(gitCommonDir, registry)

  return entry
}

/**
 * Find a worktree by hash or path
 */
export function findWorktree(
  gitCommonDir: string,
  hashOrPath: string
): WorktreeEntry | null {
  const registry = readWorktreeRegistry(gitCommonDir)

  return (
    registry.worktrees.find((w) => w.hash === hashOrPath) ||
    registry.worktrees.find((w) => path.resolve(w.path) === path.resolve(hashOrPath)) ||
    null
  )
}

/**
 * List all registered worktrees with status
 */
export function listWorktrees(
  gitCommonDir: string
): Array<WorktreeEntry & { status: 'active' | 'unreachable' }> {
  const registry = readWorktreeRegistry(gitCommonDir)

  return registry.worktrees.map((entry) => {
    const status = fs.existsSync(entry.opentasksPath) ? 'active' : 'unreachable'
    return { ...entry, status }
  })
}

/**
 * Setup a new worktree
 *
 * @param targetPath - Where to create the worktree
 * @param managerOpentasksPath - Path to manager's .opentasks directory
 * @param options - Setup options
 */
export function worktreeSetup(
  targetPath: string,
  managerOpentasksPath: string,
  options: WorktreeSetupOptions = {}
): WorktreeEntry {
  const resolvedTarget = path.resolve(targetPath)
  const managerDir = path.dirname(managerOpentasksPath)
  const gitRoot = getGitRoot(managerDir)

  if (!gitRoot) {
    throw new Error('Not in a git repository')
  }

  const gitCommonDir = getGitCommonDir(managerDir)
  if (!gitCommonDir) {
    throw new Error('Cannot determine git common dir')
  }

  // 1. Create git worktree (unless --no-git-worktree)
  if (!options.noGitWorktree) {
    const branch = options.branch ?? `worker-${Date.now()}`
    try {
      execSync(`git worktree add "${resolvedTarget}" -b "${branch}"`, {
        cwd: managerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      // Branch might already exist, try without -b
      try {
        execSync(`git worktree add "${resolvedTarget}" "${branch}"`, {
          cwd: managerDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        throw new Error(`Failed to create git worktree: ${(error as Error).message}`)
      }
    }
  }

  // 2. Initialize .opentasks in worktree
  const workerOpentasksDir = path.join(resolvedTarget, '.opentasks')
  fs.mkdirSync(workerOpentasksDir, { recursive: true })

  // 3. Generate location hash
  const remoteUrl = getGitRemoteUrl(gitRoot)
  const relativePath = path.relative(gitRoot, resolvedTarget)
  const workerHash = remoteUrl
    ? generateLocationHash(remoteUrl, relativePath)
    : generateLocationHashFallback(workerOpentasksDir)

  // Read manager's identity
  let managerHash: string
  try {
    const managerConfig = JSON.parse(
      fs.readFileSync(path.join(managerOpentasksPath, 'config.json'), 'utf-8')
    )
    managerHash = managerConfig.location?.hash
  } catch {
    throw new Error('Cannot read manager location identity')
  }

  // 4. Write worker config
  const role = options.role ?? 'worker'
  const redirectTarget = options.redirectTo === '.'
    ? managerHash
    : (options.redirectTo ?? managerHash)

  const workerConfig: Record<string, unknown> = {
    version: '1.0',
    location: {
      hash: workerHash,
      uuid: randomUUID(),
      name: path.basename(resolvedTarget),
    },
    role,
    connections: [
      {
        hash: managerHash,
        path: path.relative(workerOpentasksDir, managerOpentasksPath),
        role: 'parent',
        name: path.basename(managerDir),
      },
    ],
    redirects:
      role === 'worker'
        ? [
            {
              operations: ['read', 'write'],
              pattern: '*',
              target: `opentasks://${redirectTarget}/`,
              priority: 100,
              fallback: 'error',
            },
          ]
        : [],
  }

  fs.writeFileSync(
    path.join(workerOpentasksDir, 'config.json'),
    JSON.stringify(workerConfig, null, 2) + '\n',
    'utf-8'
  )

  // 5. Create empty graph.jsonl
  const graphPath = path.join(workerOpentasksDir, 'graph.jsonl')
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, '', 'utf-8')
  }

  // 6. Create .gitignore
  const gitignorePath = path.join(workerOpentasksDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      ['cache.db', 'cache.db-wal', 'cache.db-shm', 'write.lock', 'daemon.sock', 'daemon.lock', ''].join('\n'),
      'utf-8'
    )
  }

  // 7. Install merge driver
  try {
    installMergeDriver(resolvedTarget)
  } catch {
    // Non-fatal: merge driver installation might fail
  }

  // 8. Register worktree
  const branch = options.branch ?? getCurrentBranch(resolvedTarget) ?? undefined
  const entry: WorktreeEntry = {
    path: resolvedTarget,
    opentasksPath: workerOpentasksDir,
    hash: workerHash,
    branch,
    role,
    redirectTarget: role === 'worker' ? redirectTarget : undefined,
  }
  registerWorktree(gitCommonDir, entry)

  // 9. Add connection in manager's config
  const managerConfigPath = path.join(managerOpentasksPath, 'config.json')
  try {
    const managerConfig = JSON.parse(fs.readFileSync(managerConfigPath, 'utf-8'))
    const connections = (managerConfig.connections || []) as Connection[]
    const newConn: Connection = {
      hash: workerHash,
      path: path.relative(managerOpentasksPath, workerOpentasksDir),
      role: 'child',
      name: path.basename(resolvedTarget),
    }
    managerConfig.connections = [
      ...connections.filter((c: Connection) => c.hash !== workerHash),
      newConn,
    ]
    fs.writeFileSync(managerConfigPath, JSON.stringify(managerConfig, null, 2) + '\n', 'utf-8')
  } catch {
    // Non-fatal: manager config update failed
  }

  return entry
}

/**
 * Teardown a worktree
 *
 * @param pathOrHash - Path or hash of the worktree to remove
 * @param managerOpentasksPath - Path to manager's .opentasks directory
 * @param options - Teardown options
 */
export function worktreeTeardown(
  pathOrHash: string,
  managerOpentasksPath: string,
  options: WorktreeTeardownOptions = {}
): WorktreeEntry | null {
  const managerDir = path.dirname(managerOpentasksPath)
  const gitCommonDir = getGitCommonDir(managerDir)
  if (!gitCommonDir) {
    throw new Error('Cannot determine git common dir')
  }

  const entry = findWorktree(gitCommonDir, pathOrHash)
  if (!entry) {
    throw new Error(`Worktree not found: ${pathOrHash}`)
  }

  // 1. Unregister from registry
  unregisterWorktree(gitCommonDir, entry.hash)

  // 2. Remove connection from manager
  const managerConfigPath = path.join(managerOpentasksPath, 'config.json')
  try {
    const managerConfig = JSON.parse(fs.readFileSync(managerConfigPath, 'utf-8'))
    managerConfig.connections = (managerConfig.connections || []).filter(
      (c: Connection) => c.hash !== entry.hash
    )
    fs.writeFileSync(managerConfigPath, JSON.stringify(managerConfig, null, 2) + '\n', 'utf-8')
  } catch {
    // Non-fatal
  }

  // 3. Remove .opentasks data
  if (!options.keepData && fs.existsSync(entry.opentasksPath)) {
    fs.rmSync(entry.opentasksPath, { recursive: true, force: true })
  }

  // 4. Remove git worktree
  if (options.removeGitWorktree) {
    try {
      execSync(`git worktree remove "${entry.path}" --force`, {
        cwd: managerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      // Non-fatal: git worktree remove might fail
    }
  }

  return entry
}
