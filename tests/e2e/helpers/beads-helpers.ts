/**
 * Beads E2E Test Helpers
 *
 * CLI wrappers and workspace setup for testing cross-provider functionality.
 * All functions handle errors gracefully and support test isolation.
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const execAsync = promisify(execCallback)

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a Beads task
 */
export interface CreateBeadsTaskOptions {
  /** Task description/content */
  content?: string

  /** Task status (default: 'open') */
  status?: string

  /** Task priority (0-4) */
  priority?: number

  /** IDs of tasks this task blocks */
  blocks?: string[]

  /** IDs of tasks that block this task */
  blockedBy?: string[]
}

/**
 * Options for updating a Beads task
 */
export interface UpdateBeadsTaskOptions {
  /** New title */
  title?: string

  /** New content */
  content?: string

  /** New status */
  status?: string

  /** New priority */
  priority?: number
}

/**
 * Beads task returned from CLI
 */
export interface BeadsTask {
  id: string
  title: string
  uri: string
  status?: string
  content?: string
  priority?: number
}

/**
 * Beads workspace context
 */
export interface BeadsWorkspaceContext {
  /** Workspace directory path */
  path: string

  /** ID prefix used for this workspace */
  prefix: string

  /** Clean up the workspace */
  cleanup(): Promise<void>
}

// ============================================================================
// BD CLI Availability
// ============================================================================

/** Cached result of bd availability check */
let _bdAvailable: boolean | null = null

/** Cached bd executable path (either 'bd' or 'npx bd') */
let _bdExecutable: string | null = null

/**
 * Check if bd CLI is available in PATH
 *
 * Result is cached for performance. Prefers direct 'bd' over 'npx bd' for speed.
 *
 * @returns true if bd CLI is available
 *
 * @example
 * ```typescript
 * if (await isBdAvailable()) {
 *   // Run Beads tests
 * } else {
 *   console.log('Skipping: bd CLI not available')
 * }
 * ```
 */
export async function isBdAvailable(): Promise<boolean> {
  if (_bdAvailable !== null) return _bdAvailable

  // First try direct 'bd' command (faster, no npx overhead)
  try {
    await execAsync('bd version', { timeout: 10000 })
    _bdAvailable = true
    _bdExecutable = 'bd'
    return true
  } catch {
    // Fall back to 'npx bd'
    try {
      await execAsync('npx bd version', { timeout: 30000 })
      _bdAvailable = true
      _bdExecutable = 'npx bd'
      return true
    } catch {
      _bdAvailable = false
      _bdExecutable = null
      return false
    }
  }
}

/**
 * Get the bd executable path (either 'bd' or 'npx bd')
 * Must call isBdAvailable() first.
 */
export function getBdExecutable(): string {
  return _bdExecutable ?? 'npx bd'
}

/**
 * Reset the cached bd availability (useful for testing)
 */
export function resetBdAvailableCache(): void {
  _bdAvailable = null
  _bdExecutable = null
}

/**
 * Skip message for tests when bd is not available
 */
export const BD_SKIP_MESSAGE = 'Skipping: bd CLI not available (install @anthropic/beads)'

// ============================================================================
// Workspace Management
// ============================================================================

/**
 * Create an isolated Beads workspace for testing
 *
 * Initializes git repo and bd workspace in the specified directory.
 * Each workspace is isolated and can be cleaned up after tests.
 *
 * @param dir - Directory to create workspace in
 * @param prefix - ID prefix for beads in this workspace (default: 'bd')
 * @returns Workspace context with cleanup function
 *
 * @example
 * ```typescript
 * const workspace = await createBeadsWorkspace('/tmp/test-workspace', 'test')
 * try {
 *   const uri = await createBeadsTask(workspace.path, 'My Task')
 *   // ... run tests
 * } finally {
 *   await workspace.cleanup()
 * }
 * ```
 */
export async function createBeadsWorkspace(
  dir: string,
  prefix: string = 'bd'
): Promise<BeadsWorkspaceContext> {
  // Create directory if it doesn't exist
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  // Initialize git repo (bd requires git)
  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })
  await execAsync('git config commit.gpgSign false', { cwd: dir })

  // Create initial commit (bd may need this)
  await execAsync('touch .gitkeep && git add . && git commit --no-gpg-sign -m "init"', { cwd: dir })

  // Initialize bd with sandbox mode (no daemon, no auto-sync)
  // Use --no-db for JSONL-only mode (avoids SQLite WAL issues on v9fs/overlay filesystems)
  const bdExec = getBdExecutable()
  await execAsync(
    `${bdExec} init --prefix ${prefix} --sandbox --skip-hooks --skip-merge-driver --no-db`,
    { cwd: dir, timeout: 30000 }
  )

  return {
    path: dir,
    prefix,
    async cleanup(): Promise<void> {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

// ============================================================================
// Task Operations
// ============================================================================

/**
 * Shell-escape a single argument
 */
function shellEscape(arg: string): string {
  if (/['\s"\\$`!]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`
  }
  return arg
}

/**
 * Execute a bd CLI command
 */
async function execBd(
  workspace: string,
  args: string[],
  timeout: number = 30000
): Promise<string> {
  const bdExec = getBdExecutable()
  const command = [bdExec, '--no-db', ...args.map(shellEscape)].join(' ')

  try {
    const { stdout } = await execAsync(command, {
      cwd: workspace,
      timeout,
      env: { ...process.env },
    })
    return stdout.trim()
  } catch (error) {
    const err = error as { code?: string; message?: string; killed?: boolean; stderr?: string }

    if (err.code === 'ENOENT') {
      throw new Error(`Beads CLI not found`)
    }

    if (err.killed) {
      throw new Error(`Command timed out: ${command}`)
    }

    throw new Error(`Beads CLI error: ${err.message || err.stderr || 'Unknown error'}`)
  }
}

/**
 * Create a Beads task via CLI
 *
 * @param workspace - Path to Beads workspace
 * @param title - Task title
 * @param options - Additional task options
 * @returns The created task with beads:// URI
 *
 * @example
 * ```typescript
 * const task = await createBeadsTask(workspace.path, 'Implement feature', {
 *   content: 'Detailed description',
 *   status: 'open',
 *   priority: 1,
 * })
 * console.log(task.uri) // beads://./bd-xxx
 * ```
 */
export async function createBeadsTask(
  workspace: string,
  title: string,
  options: CreateBeadsTaskOptions = {}
): Promise<BeadsTask> {
  const args = ['create', title]

  if (options.content) {
    args.push('--description', options.content)
  }
  // Note: bd create doesn't support --status, so we set it via update
  if (options.priority !== undefined) {
    args.push('--priority', String(options.priority))
  }

  args.push('--json')

  const output = await execBd(workspace, args)
  const task = JSON.parse(output) as { id: string; title: string; status?: string; description?: string; priority?: number }

  // Set status via update if specified (bd create doesn't support --status)
  if (options.status) {
    await execBd(workspace, ['update', task.id, '--status', options.status])
  }

  const result: BeadsTask = {
    id: task.id,
    title: task.title,
    uri: `beads://./${task.id}`,
    status: options.status || task.status,
    content: task.description,
    priority: task.priority,
  }

  // Handle blocking relationships after creation
  if (options.blocks && options.blocks.length > 0) {
    for (const blockedId of options.blocks) {
      await execBd(workspace, ['dep', task.id, '--blocks', blockedId])
    }
  }

  if (options.blockedBy && options.blockedBy.length > 0) {
    for (const blockerId of options.blockedBy) {
      await execBd(workspace, ['dep', blockerId, '--blocks', task.id])
    }
  }

  return result
}

/**
 * Get a Beads task by ID
 *
 * @param workspace - Path to Beads workspace
 * @param id - Task ID (bd-xxx format)
 * @returns The task or null if not found
 */
export async function getBeadsTask(
  workspace: string,
  id: string
): Promise<BeadsTask | null> {
  try {
    const output = await execBd(workspace, ['show', id, '--json'])
    const tasks = JSON.parse(output) as Array<{ id: string; title: string; status?: string; description?: string; priority?: number }>

    if (!tasks || tasks.length === 0) {
      return null
    }

    const task = tasks[0]
    return {
      id: task.id,
      title: task.title,
      uri: `beads://./${task.id}`,
      status: task.status,
      content: task.description,
      priority: task.priority,
    }
  } catch (error) {
    const message = (error as Error).message?.toLowerCase() || ''
    if (
      message.includes('not found') ||
      message.includes('does not exist') ||
      message.includes('no issue found')
    ) {
      return null
    }
    throw error
  }
}

/**
 * Update a Beads task status via CLI
 *
 * @param workspace - Path to Beads workspace
 * @param id - Task ID (bd-xxx format)
 * @param status - New status value
 *
 * @example
 * ```typescript
 * await updateBeadsStatus(workspace.path, 'bd-abc123', 'done')
 * ```
 */
export async function updateBeadsStatus(
  workspace: string,
  id: string,
  status: string
): Promise<void> {
  await execBd(workspace, ['update', id, '--status', status])
}

/**
 * Update a Beads task with multiple fields
 *
 * @param workspace - Path to Beads workspace
 * @param id - Task ID (bd-xxx format)
 * @param updates - Fields to update
 * @returns The updated task
 */
export async function updateBeadsTask(
  workspace: string,
  id: string,
  updates: UpdateBeadsTaskOptions
): Promise<BeadsTask> {
  const args = ['update', id]

  if (updates.title) {
    args.push('--title', updates.title)
  }
  if (updates.content) {
    args.push('--description', updates.content)
  }
  if (updates.status) {
    args.push('--status', updates.status)
  }
  if (updates.priority !== undefined) {
    args.push('--priority', String(updates.priority))
  }

  args.push('--json')

  const output = await execBd(workspace, args)
  const tasks = JSON.parse(output) as Array<{ id: string; title: string; status?: string; description?: string; priority?: number }>

  if (!tasks || tasks.length === 0) {
    throw new Error(`Update returned no results for ${id}`)
  }

  const task = tasks[0]
  return {
    id: task.id,
    title: task.title,
    uri: `beads://./${task.id}`,
    status: task.status,
    content: task.description,
    priority: task.priority,
  }
}

/**
 * Delete a Beads task
 *
 * @param workspace - Path to Beads workspace
 * @param id - Task ID (bd-xxx format)
 */
export async function deleteBeadsTask(
  workspace: string,
  id: string
): Promise<void> {
  await execBd(workspace, ['delete', id, '--force'])
}

/**
 * Create a blocking relationship between tasks
 *
 * @param workspace - Path to Beads workspace
 * @param blockerId - ID of the task that blocks
 * @param blockedId - ID of the task being blocked
 */
export async function linkBeadsTasks(
  workspace: string,
  blockerId: string,
  blockedId: string
): Promise<void> {
  await execBd(workspace, ['dep', blockerId, '--blocks', blockedId])
}

/**
 * List all tasks in a Beads workspace
 *
 * @param workspace - Path to Beads workspace
 * @returns Array of tasks
 */
export async function listBeadsTasks(
  workspace: string
): Promise<BeadsTask[]> {
  const output = await execBd(workspace, ['list', '--json'])
  const tasks = JSON.parse(output) as Array<{ id: string; title: string; status?: string; description?: string; priority?: number }>

  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    uri: `beads://./${task.id}`,
    status: task.status,
    content: task.description,
    priority: task.priority,
  }))
}
