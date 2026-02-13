/**
 * Claude Tasks Provider
 *
 * Provider that bridges Claude Code's native task system with OpenTasks.
 * Handles claude:// and task:// URI schemes.
 *
 * Since Claude's tasks exist only within a session, this provider
 * acts as a bridge for materializing ephemeral tasks into the persistent graph.
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ParsedUri,
  UriOptions,
} from './types.js'
import { ProviderError } from './types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Claude Tasks provider
 */
export interface ClaudeTasksConfig {
  /** Session identifier ('current' or specific ID) */
  session?: string

  /**
   * Task store adapter - allows injecting external task management
   * If not provided, uses an in-memory store for testing
   */
  taskStore?: ClaudeTaskStore
}

/**
 * Claude task structure
 */
export interface ClaudeTask {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Interface for task store adapter
 * Allows integration with Claude's actual task system or mock for testing
 */
export interface ClaudeTaskStore {
  get(id: string): Promise<ClaudeTask | null>
  list(): Promise<ClaudeTask[]>
  create(task: Omit<ClaudeTask, 'id'>): Promise<ClaudeTask>
  update(id: string, updates: Partial<ClaudeTask>): Promise<ClaudeTask>
  delete(id: string): Promise<void>
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for claude:// or task:// URIs
 * Format: claude://[session/]id or task://[session/]id
 */
const CLAUDE_URI_PATTERN = /^(claude|task):\/\/(?:([^/]+)\/)?(.+)$/i

/**
 * Pattern for Claude task IDs (numeric with optional prefix)
 */
const TASK_ID_PATTERN = /^(?:t-)?(\d+)$/

// ============================================================================
// In-Memory Task Store (for testing/standalone mode)
// ============================================================================

/**
 * Create an in-memory task store for testing
 */
export function createInMemoryTaskStore(): ClaudeTaskStore {
  const tasks = new Map<string, ClaudeTask>()
  let nextId = 1

  return {
    async get(id: string): Promise<ClaudeTask | null> {
      return tasks.get(id) ?? null
    },

    async list(): Promise<ClaudeTask[]> {
      return Array.from(tasks.values())
    },

    async create(task: Omit<ClaudeTask, 'id'>): Promise<ClaudeTask> {
      const id = String(nextId++)
      const newTask: ClaudeTask = { ...task, id }
      tasks.set(id, newTask)
      return newTask
    },

    async update(id: string, updates: Partial<ClaudeTask>): Promise<ClaudeTask> {
      const existing = tasks.get(id)
      if (!existing) {
        throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude')
      }
      const updated: ClaudeTask = { ...existing, ...updates, id }
      tasks.set(id, updated)
      return updated
    },

    async delete(id: string): Promise<void> {
      if (!tasks.has(id)) {
        throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude')
      }
      tasks.delete(id)
    },
  }
}

// ============================================================================
// Type Conversion
// ============================================================================

/**
 * Map Claude task status to normalized status
 */
function mapStatus(status: ClaudeTask['status']): string {
  switch (status) {
    case 'pending':
      return 'open'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'closed'
    default:
      return status
  }
}

/**
 * Map normalized status to Claude task status
 */
function mapStatusToClaudeStatus(status: string): ClaudeTask['status'] {
  switch (status.toLowerCase()) {
    case 'open':
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'in_progress'
    case 'closed':
    case 'completed':
    case 'done':
      return 'completed'
    default:
      return 'pending'
  }
}

/**
 * Convert Claude task to ProviderNode
 */
function taskToProviderNode(task: ClaudeTask, session: string = 'current'): ProviderNode {
  return {
    id: task.id,
    uri: `claude://${session}/${task.id}`,
    type: 'task',
    title: task.subject,
    content: task.description,
    status: mapStatus(task.status),
    priority: 2, // Claude doesn't have priority, use default
    rawData: {
      ...task,
      activeForm: task.activeForm,
      owner: task.owner,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
    },
    fetchedAt: new Date().toISOString(),
  }
}

// ============================================================================
// Claude Tasks Provider Implementation
// ============================================================================

/**
 * Create a Claude Tasks provider
 */
export function createClaudeTasksProvider(config: ClaudeTasksConfig = {}): Provider {
  const session = config.session ?? 'current'
  const taskStore = config.taskStore ?? createInMemoryTaskStore()

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: false,
    watch: false,
    mount: true,
    feedback: false,
  }

  return {
    name: 'claude',
    schemes: ['claude', 'task'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for claude:// or task:// URI
      const match = uri.match(CLAUDE_URI_PATTERN)
      if (match) {
        const scheme = match[1].toLowerCase()
        const workspace = match[2] || 'current'
        const id = match[3]
        return {
          scheme,
          workspace,
          id,
          isRelative: workspace === 'current',
        }
      }

      // Check for bare task ID
      if (TASK_ID_PATTERN.test(uri)) {
        const id = uri.replace(/^t-/, '')
        return {
          scheme: 'claude',
          workspace: 'current',
          id,
          isRelative: true,
        }
      }

      return null
    },

    buildUri(id: string, options?: UriOptions): string {
      const workspace = options?.workspace ?? session
      if (options?.relative) {
        return id
      }
      return `claude://${workspace}/${id}`
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
      const taskId = parsed?.id ?? id.replace(/^t-/, '')
      const taskSession = parsed?.workspace ?? session

      try {
        const task = await taskStore.get(taskId)
        if (!task) return null
        return taskToProviderNode(task, taskSession)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to get task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined
        )
      }
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      try {
        let tasks = await taskStore.list()

        // Filter by status if specified
        if (filter?.status) {
          const normalizedStatus = filter.status.toLowerCase()
          tasks = tasks.filter((t) => {
            const taskStatus = mapStatus(t.status).toLowerCase()
            return taskStatus === normalizedStatus
          })
        }

        // Apply limit if specified
        if (filter?.limit) {
          tasks = tasks.slice(0, filter.limit)
        }

        return tasks.map((task) => taskToProviderNode(task, session))
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined
        )
      }
    },

    async create(input: ProviderCreateInput): Promise<ProviderNode> {
      try {
        const task = await taskStore.create({
          subject: input.title,
          description: input.content,
          status: input.status ? mapStatusToClaudeStatus(input.status) : 'pending',
          metadata: input.metadata,
        })

        return taskToProviderNode(task, session)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined
        )
      }
    },

    async update(id: string, updates: ProviderUpdateInput): Promise<ProviderNode> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const taskId = parsed?.id ?? id.replace(/^t-/, '')
      const taskSession = parsed?.workspace ?? session

      try {
        const updateData: Partial<ClaudeTask> = {}

        if (updates.title !== undefined) {
          updateData.subject = updates.title
        }
        if (updates.content !== undefined) {
          updateData.description = updates.content
        }
        if (updates.status !== undefined) {
          updateData.status = mapStatusToClaudeStatus(updates.status)
        }
        if (updates.metadata !== undefined) {
          updateData.metadata = updates.metadata
        }

        const task = await taskStore.update(taskId, updateData)

        return taskToProviderNode(task, taskSession)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined
        )
      }
    },

    async delete(id: string): Promise<void> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const taskId = parsed?.id ?? id.replace(/^t-/, '')

      try {
        await taskStore.delete(taskId)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined
        )
      }
    },
  }
}
