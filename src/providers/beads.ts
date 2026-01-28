/**
 * Beads Provider
 *
 * Provider that integrates with Beads via CLI.
 * Handles beads:// and bd:// URI schemes.
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ParsedUri,
  UriOptions,
  SearchOptions,
  ProviderError,
} from './types.js'
import { ProviderError as ProviderErrorClass } from './types.js'

const execAsync = promisify(execCallback)

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Beads provider
 */
export interface BeadsConfig {
  /** Path to bd executable (default: 'bd') */
  executable?: string

  /** Working directory for bd commands */
  cwd?: string

  /** Timeout for CLI commands in ms (default: 30000) */
  timeout?: number
}

/**
 * Raw Beads issue structure from CLI JSON output
 */
interface BeadsIssue {
  id: string
  title: string
  description?: string
  status?: string
  priority?: number | string
  tags?: string[]
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for beads:// or bd:// URIs
 * Format: beads://[workspace/]id or bd://[workspace/]id
 */
const BEADS_URI_PATTERN = /^(beads|bd):\/\/(?:([^/]+)\/)?(.+)$/i

/**
 * Pattern for Beads issue IDs
 */
const BEADS_ID_PATTERN = /^bd-[a-z0-9]+$/i

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map Beads priority to normalized 0-4 scale
 */
function mapPriority(priority: number | string | undefined): number | undefined {
  if (priority === undefined) return undefined

  if (typeof priority === 'number') {
    // Assume already 0-4 scale
    return Math.max(0, Math.min(4, priority))
  }

  // Map string priorities
  switch (priority.toLowerCase()) {
    case 'critical':
    case 'highest':
      return 0
    case 'high':
      return 1
    case 'medium':
    case 'normal':
      return 2
    case 'low':
      return 3
    case 'lowest':
      return 4
    default:
      return 2
  }
}

/**
 * Convert Beads issue to ProviderNode
 */
function beadsIssueToProviderNode(issue: BeadsIssue, workspace: string = '.'): ProviderNode {
  return {
    id: issue.id,
    uri: `beads://${workspace}/${issue.id}`,
    type: 'issue',
    title: issue.title,
    content: issue.description,
    status: issue.status,
    priority: mapPriority(issue.priority),
    rawData: issue,
    fetchedAt: new Date().toISOString(),
  }
}

// ============================================================================
// Beads Provider Implementation
// ============================================================================

/**
 * Create a Beads provider
 */
export function createBeadsProvider(config: BeadsConfig = {}): Provider {
  const executable = config.executable ?? 'bd'
  const cwd = config.cwd
  const timeout = config.timeout ?? 30000

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: true,
    watch: false,
  }

  /**
   * Execute a bd CLI command
   */
  async function execBd(args: string[]): Promise<string> {
    const command = [executable, ...args].join(' ')

    try {
      const { stdout } = await execAsync(command, {
        cwd,
        timeout,
        env: { ...process.env },
      })
      return stdout.trim()
    } catch (error) {
      const err = error as { code?: string; message?: string; killed?: boolean }

      if (err.code === 'ENOENT') {
        throw new ProviderErrorClass(
          'PROVIDER_ERROR',
          `Beads CLI not found: ${executable}`,
          'beads'
        )
      }

      if (err.killed) {
        throw new ProviderErrorClass('TIMEOUT', `Command timed out: ${command}`, 'beads')
      }

      throw new ProviderErrorClass(
        'OPERATION_FAILED',
        `Beads CLI error: ${err.message}`,
        'beads',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Parse JSON output from bd CLI
   */
  function parseJson<T>(output: string): T {
    try {
      return JSON.parse(output) as T
    } catch {
      throw new ProviderErrorClass(
        'PROVIDER_ERROR',
        'Failed to parse Beads CLI output as JSON',
        'beads'
      )
    }
  }

  return {
    name: 'beads',
    schemes: ['beads', 'bd'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for beads:// or bd:// URI
      const match = uri.match(BEADS_URI_PATTERN)
      if (match) {
        const scheme = match[1].toLowerCase()
        const workspace = match[2] || '.'
        const id = match[3]
        return {
          scheme,
          workspace,
          id,
          isRelative: workspace === '.',
        }
      }

      // Check for bare Beads ID
      if (BEADS_ID_PATTERN.test(uri)) {
        return {
          scheme: 'beads',
          workspace: '.',
          id: uri,
          isRelative: true,
        }
      }

      return null
    },

    buildUri(id: string, options?: UriOptions): string {
      const workspace = options?.workspace ?? '.'
      if (options?.relative) {
        return id
      }
      return `beads://${workspace}/${id}`
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string): Promise<ProviderNode | null> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const issueId = parsed?.id ?? id
      const workspace = parsed?.workspace ?? '.'

      try {
        const output = await execBd(['show', issueId, '--json'])
        const issue = parseJson<BeadsIssue>(output)
        return beadsIssueToProviderNode(issue, workspace)
      } catch (error) {
        // Return null for not found, re-throw other errors
        if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
          const message = error.message.toLowerCase()
          if (message.includes('not found') || message.includes('does not exist')) {
            return null
          }
        }
        throw error
      }
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      const args = ['list', '--json']

      // Add filters if supported by bd CLI
      if (filter?.status) {
        args.push('--status', filter.status)
      }
      if (filter?.limit) {
        args.push('--limit', String(filter.limit))
      }

      const output = await execBd(args)
      const issues = parseJson<BeadsIssue[]>(output)

      return issues.map((issue) => beadsIssueToProviderNode(issue))
    },

    async create(input: ProviderCreateInput): Promise<ProviderNode> {
      const args = ['create', input.title]

      if (input.content) {
        args.push('--description', input.content)
      }
      if (input.status) {
        args.push('--status', input.status)
      }
      if (input.priority !== undefined) {
        args.push('--priority', String(input.priority))
      }

      args.push('--json')

      const output = await execBd(args)
      const issue = parseJson<BeadsIssue>(output)

      return beadsIssueToProviderNode(issue)
    },

    async update(id: string, updates: ProviderUpdateInput): Promise<ProviderNode> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const issueId = parsed?.id ?? id

      const args = ['update', issueId]

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

      const output = await execBd(args)
      const issue = parseJson<BeadsIssue>(output)

      return beadsIssueToProviderNode(issue)
    },

    async delete(id: string): Promise<void> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const issueId = parsed?.id ?? id

      await execBd(['delete', issueId, '--force'])
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      const args = ['search', query, '--json']

      if (options?.limit) {
        args.push('--limit', String(options.limit))
      }

      const output = await execBd(args)
      const issues = parseJson<BeadsIssue[]>(output)

      return issues.map((issue) => beadsIssueToProviderNode(issue))
    },
  }
}
