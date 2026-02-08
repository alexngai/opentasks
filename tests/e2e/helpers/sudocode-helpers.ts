/**
 * Sudocode E2E Test Helpers
 *
 * CLI wrappers and workspace setup for testing the Sudocode provider
 * against the real sudocode binary. Follows the same pattern as beads-helpers.ts.
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const execAsync = promisify(execCallback)

// ============================================================================
// Types
// ============================================================================

export interface SudocodeTask {
  id: string
  title: string
  uri: string
  status?: string
  content?: string
  priority?: number
}

export interface SudocodeWorkspaceContext {
  path: string
  cleanup(): Promise<void>
}

// ============================================================================
// Sudocode CLI Availability
// ============================================================================

let _sudocodeAvailable: boolean | null = null
let _sudocodeExecutable: string | null = null

/**
 * Check if sudocode CLI is available in PATH.
 * Result is cached. Prefers direct 'sudocode' over 'npx sudocode' for speed.
 */
export async function isSudocodeAvailable(): Promise<boolean> {
  if (_sudocodeAvailable !== null) return _sudocodeAvailable

  try {
    await execAsync('sudocode --version', { timeout: 10000 })
    _sudocodeAvailable = true
    _sudocodeExecutable = 'sudocode'
    return true
  } catch {
    try {
      await execAsync('npx sudocode --version', { timeout: 30000 })
      _sudocodeAvailable = true
      _sudocodeExecutable = 'npx sudocode'
      return true
    } catch {
      _sudocodeAvailable = false
      _sudocodeExecutable = null
      return false
    }
  }
}

export function getSudocodeExecutable(): string {
  return _sudocodeExecutable ?? 'npx sudocode'
}

export const SUDOCODE_SKIP_MESSAGE =
  'Skipping: sudocode CLI not available (npm install -g sudocode)'

// ============================================================================
// Workspace Management
// ============================================================================

/**
 * Create an isolated sudocode workspace for testing.
 * Initializes git repo + sudocode init in the specified directory.
 */
export async function createSudocodeWorkspace(
  dir: string
): Promise<SudocodeWorkspaceContext> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  await execAsync('git init', { cwd: dir })
  await execAsync('git config user.email "test@test.com"', { cwd: dir })
  await execAsync('git config user.name "Test User"', { cwd: dir })
  await execAsync('git config commit.gpgSign false', { cwd: dir })
  await execAsync(
    'touch .gitkeep && git add . && git commit --no-gpg-sign -m "init"',
    { cwd: dir }
  )

  const scExec = getSudocodeExecutable()
  await execAsync(`${scExec} init`, { cwd: dir, timeout: 30000 })

  return {
    path: dir,
    async cleanup(): Promise<void> {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

// ============================================================================
// CLI Execution
// ============================================================================

function shellEscape(arg: string): string {
  if (/['\s"\\$`!]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`
  }
  return arg
}

/**
 * Execute a sudocode CLI command in a workspace directory.
 * Handles stdout from both exit code 0 and non-zero (some sudocode commands
 * like `delete --hard` exit with code 1 but still produce valid JSON on stdout).
 */
async function execSc(
  workspace: string,
  args: string[],
  timeout: number = 30000
): Promise<string> {
  const scExec = getSudocodeExecutable()
  const command = [scExec, ...args.map(shellEscape)].join(' ')

  try {
    const { stdout } = await execAsync(command, {
      cwd: workspace,
      timeout,
      env: { ...process.env },
    })
    return stdout.trim()
  } catch (error) {
    const err = error as {
      code?: string | number
      message?: string
      killed?: boolean
      stdout?: string
      stderr?: string
    }

    // Some sudocode commands exit non-zero but still provide valid stdout
    if (err.stdout && err.stdout.trim()) {
      return err.stdout.trim()
    }

    if (err.code === 'ENOENT') {
      throw new Error('Sudocode CLI not found')
    }

    if (err.killed) {
      throw new Error(`Command timed out: ${command}`)
    }

    throw new Error(
      `Sudocode CLI error: ${err.stderr || err.message || 'Unknown error'}`
    )
  }
}

// ============================================================================
// Issue Operations
// ============================================================================

export async function createSudocodeIssue(
  workspace: string,
  title: string,
  options: { content?: string; priority?: number } = {}
): Promise<SudocodeTask> {
  const args = ['--json', 'issue', 'create', title]
  if (options.content) args.push('-d', options.content)
  if (options.priority !== undefined) args.push('-p', String(options.priority))

  const output = await execSc(workspace, args)
  const data = JSON.parse(output) as { id: string; title: string; status?: string }

  return {
    id: data.id,
    title: data.title,
    uri: `sudocode://./${data.id}`,
    status: data.status ?? 'open',
    content: options.content,
    priority: options.priority,
  }
}

export async function getSudocodeIssue(
  workspace: string,
  id: string
): Promise<SudocodeTask | null> {
  try {
    const output = await execSc(workspace, ['--json', 'issue', 'show', id])
    const data = JSON.parse(output) as {
      id: string
      title: string
      status?: string
      content?: string
      priority?: number
    }

    if (!data || !data.id) return null

    return {
      id: data.id,
      title: data.title,
      uri: `sudocode://./${data.id}`,
      status: data.status,
      content: data.content,
      priority: data.priority,
    }
  } catch (error) {
    const message = (error as Error).message?.toLowerCase() || ''
    if (message.includes('not found')) return null
    throw error
  }
}

export async function updateSudocodeIssue(
  workspace: string,
  id: string,
  updates: { title?: string; description?: string; status?: string; priority?: number }
): Promise<SudocodeTask> {
  const args = ['--json', 'issue', 'update', id]
  if (updates.title) args.push('--title', updates.title)
  if (updates.description) args.push('--description', updates.description)
  if (updates.status) args.push('-s', updates.status)
  if (updates.priority !== undefined) args.push('-p', String(updates.priority))

  const output = await execSc(workspace, args)
  const data = JSON.parse(output) as {
    id: string
    title: string
    status?: string
    content?: string
    priority?: number
  }

  return {
    id: data.id,
    title: data.title,
    uri: `sudocode://./${data.id}`,
    status: data.status,
    content: data.content,
    priority: data.priority,
  }
}

export async function deleteSudocodeIssue(
  workspace: string,
  id: string
): Promise<void> {
  await execSc(workspace, ['issue', 'delete', '--hard', id])
}

export async function listSudocodeIssues(
  workspace: string
): Promise<SudocodeTask[]> {
  const output = await execSc(workspace, ['--json', 'issue', 'list'])
  const data = JSON.parse(output) as Array<{
    id: string
    title: string
    status?: string
    content?: string
    priority?: number
  }>

  return data.map((d) => ({
    id: d.id,
    title: d.title,
    uri: `sudocode://./${d.id}`,
    status: d.status,
    content: d.content,
    priority: d.priority,
  }))
}

// ============================================================================
// Spec Operations
// ============================================================================

export async function createSudocodeSpec(
  workspace: string,
  title: string,
  options: { content?: string; priority?: number } = {}
): Promise<SudocodeTask> {
  const args = ['--json', 'spec', 'create', title]
  if (options.content) args.push('-d', options.content)
  if (options.priority !== undefined) args.push('-p', String(options.priority))

  const output = await execSc(workspace, args)
  const data = JSON.parse(output) as { id: string; title: string }

  return {
    id: data.id,
    title: data.title,
    uri: `sudocode://./${data.id}`,
    content: options.content,
    priority: options.priority,
  }
}

export async function listSudocodeSpecs(
  workspace: string
): Promise<SudocodeTask[]> {
  const output = await execSc(workspace, ['--json', 'spec', 'list'])
  const data = JSON.parse(output) as Array<{
    id: string
    title: string
    content?: string
    priority?: number
  }>

  return data.map((d) => ({
    id: d.id,
    title: d.title,
    uri: `sudocode://./${d.id}`,
    content: d.content,
    priority: d.priority,
  }))
}

// ============================================================================
// Relationship Operations
// ============================================================================

export async function linkSudocodeEntities(
  workspace: string,
  fromId: string,
  toId: string,
  type: string = 'references'
): Promise<void> {
  await execSc(workspace, ['link', fromId, toId, '-t', type])
}
