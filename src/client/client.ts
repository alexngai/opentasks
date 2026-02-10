/**
 * OpenTasks Client
 *
 * Client library for interacting with the OpenTasks daemon.
 * Provides a typed wrapper around the 3-tool interface.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { createIPCClient, type IPCClient } from '../daemon/ipc.js'
import { getGitCommonDir } from '../core/worktree.js'
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  NodeSummary,
  FeedbackSummary,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
} from '../tools/types.js'
import type {
  CreateNodeInput,
  UpdateNodeInput,
  DeleteOptions,
} from '../graph/types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating an OpenTasks client
 */
export interface ClientOptions {
  /** Path to the daemon socket file */
  socketPath?: string

  /** Auto-connect on first request (default: true) */
  autoConnect?: boolean

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number
}

/**
 * Error thrown when client operations fail
 */
export class ClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'NOT_CONNECTED' | 'CONNECTION_FAILED' | 'REQUEST_FAILED' | 'SOCKET_NOT_FOUND'
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

// ============================================================================
// Socket Path Discovery
// ============================================================================

/**
 * Find the multi-location daemon socket at .git/opentasks/daemon.sock
 */
function findGitDaemonSocket(startDir: string = process.cwd()): string | null {
  const gitCommonDir = getGitCommonDir(startDir)
  if (!gitCommonDir) return null

  const socketPath = path.join(gitCommonDir, 'opentasks', 'daemon.sock')
  if (fs.existsSync(socketPath)) {
    return socketPath
  }
  return null
}

/**
 * Find the .opentasks directory starting from cwd and walking up
 */
function findOpenTasksDir(startDir: string = process.cwd()): string | null {
  let currentDir = startDir

  while (true) {
    const candidate = path.join(currentDir, '.opentasks')
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      // Reached root
      return null
    }
    currentDir = parentDir
  }
}

/**
 * Get the default socket path.
 * Prefers .git/opentasks/daemon.sock (multi-location) then falls back
 * to walking up for .opentasks/daemon.sock (single-location).
 */
function getDefaultSocketPath(): string {
  // 1. Check for multi-location daemon socket first
  const gitSocket = findGitDaemonSocket()
  if (gitSocket) {
    return gitSocket
  }

  // 2. Fallback to single-location .opentasks/daemon.sock
  const openTasksDir = findOpenTasksDir()
  if (!openTasksDir) {
    throw new ClientError(
      'Could not find daemon socket. Is the daemon running?',
      'SOCKET_NOT_FOUND'
    )
  }
  return path.join(openTasksDir, 'daemon.sock')
}

// ============================================================================
// Client Implementation
// ============================================================================

/**
 * Client for interacting with the OpenTasks daemon
 *
 * Provides typed access to the 3-tool interface (link, query, annotate)
 * plus convenience methods for common operations.
 *
 * @example
 * ```typescript
 * const client = new OpenTasksClient()
 *
 * // Find ready work
 * const ready = await client.ready()
 *
 * // Create a relationship
 * await client.link({
 *   from_id: 'i-abc1',
 *   to_id: 's-def2',
 *   type: 'implements'
 * })
 *
 * // Add feedback
 * await client.annotate({
 *   target_id: 's-def2',
 *   create: { content: 'Implementation complete' }
 * })
 *
 * client.disconnect()
 * ```
 */
export class OpenTasksClient {
  private client: IPCClient | null = null
  private readonly options: Required<ClientOptions>
  private socketPath: string | null = null

  constructor(options?: ClientOptions) {
    this.options = {
      socketPath: options?.socketPath ?? '',
      autoConnect: options?.autoConnect ?? true,
      timeout: options?.timeout ?? 30000,
    }

    // If socket path provided, resolve it immediately
    if (options?.socketPath) {
      this.socketPath = options.socketPath
    }
  }

  // ==========================================================================
  // Connection Lifecycle
  // ==========================================================================

  /**
   * Connect to the daemon
   */
  async connect(): Promise<void> {
    if (this.client?.connected) {
      return
    }

    // Resolve socket path if not already done
    if (!this.socketPath) {
      this.socketPath = getDefaultSocketPath()
    }

    this.client = createIPCClient(this.socketPath)

    try {
      await this.client.connect()
    } catch (error) {
      this.client = null
      throw new ClientError(
        `Failed to connect to daemon: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'CONNECTION_FAILED'
      )
    }
  }

  /**
   * Disconnect from the daemon
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect()
      this.client = null
    }
  }

  /**
   * Check if connected to the daemon
   */
  get connected(): boolean {
    return this.client?.connected ?? false
  }

  /**
   * Ensure connection before making a request
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return
    }

    if (this.options.autoConnect) {
      await this.connect()
      return
    }

    throw new ClientError(
      'Not connected to daemon. Call connect() first or enable autoConnect.',
      'NOT_CONNECTED'
    )
  }

  // ==========================================================================
  // Core Tools
  // ==========================================================================

  /**
   * Create or remove an edge between nodes
   *
   * @param params - Link parameters
   * @returns Link result with success status
   */
  async link(params: LinkParams): Promise<LinkResult> {
    await this.ensureConnected()
    return this.client!.request<LinkResult>('tools.link', params)
  }

  /**
   * Query the graph
   *
   * @param params - Query parameters
   * @returns Query result with items and pagination info
   */
  async query(params: QueryParams): Promise<QueryResult> {
    await this.ensureConnected()
    return this.client!.request<QueryResult>('tools.query', params)
  }

  /**
   * Manage feedback lifecycle
   *
   * @param params - Annotate parameters
   * @returns Annotate result with success status
   */
  async annotate(params: AnnotateParams): Promise<AnnotateResult> {
    await this.ensureConnected()
    return this.client!.request<AnnotateResult>('tools.annotate', params)
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Get issues ready to work on (no active blockers)
   *
   * @param options - Ready query options
   * @returns Array of ready issue summaries
   */
  async ready(options?: ReadyOptions): Promise<NodeSummary[]> {
    const result = await this.query({ ready: options || {} })
    return result.items as NodeSummary[]
  }

  /**
   * Get nodes blocking a specific node
   *
   * @param nodeId - Node to find blockers for
   * @param options - Blocker query options
   * @returns Array of blocking node summaries
   */
  async blockers(nodeId: string, options?: Omit<BlockerOptions, 'nodeId'>): Promise<NodeSummary[]> {
    const result = await this.query({
      blockers: { nodeId, ...options },
    })
    return result.items as NodeSummary[]
  }

  /**
   * Get nodes blocked by a specific node
   *
   * @param nodeId - Node to find blocked nodes for
   * @param options - Blocker query options
   * @returns Array of blocked node summaries
   */
  async blocking(nodeId: string, options?: Omit<BlockerOptions, 'nodeId'>): Promise<NodeSummary[]> {
    const result = await this.query({
      blocking: { nodeId, ...options },
    })
    return result.items as NodeSummary[]
  }

  /**
   * Get feedback on a specific node
   *
   * @param nodeId - Node to get feedback for
   * @param options - Feedback query options
   * @returns Array of feedback summaries
   */
  async feedback(nodeId: string, options?: Omit<FeedbackOptions, 'nodeId'>): Promise<FeedbackSummary[]> {
    const result = await this.query({
      feedback: { nodeId, ...options },
    })
    return result.items as FeedbackSummary[]
  }

  // ==========================================================================
  // Graph CRUD
  // ==========================================================================

  /**
   * Create a node
   */
  async createNode(params: CreateNodeInput): Promise<unknown> {
    await this.ensureConnected()
    return this.client!.request('graph.create', params)
  }

  /**
   * Get a node by ID
   */
  async getNode(id: string): Promise<unknown> {
    await this.ensureConnected()
    return this.client!.request('graph.get', { id })
  }

  /**
   * Update a node by ID
   */
  async updateNode(id: string, updates: UpdateNodeInput): Promise<unknown> {
    await this.ensureConnected()
    return this.client!.request('graph.update', { id, ...updates })
  }

  /**
   * Delete a node by ID
   */
  async deleteNode(id: string, options?: DeleteOptions): Promise<void> {
    await this.ensureConnected()
    await this.client!.request('graph.delete', { id, options })
  }

  // ==========================================================================
  // Generic RPC
  // ==========================================================================

  /**
   * Call any daemon method by name
   */
  async call<R = unknown>(method: string, params?: unknown): Promise<R> {
    await this.ensureConnected()
    return this.client!.request<R>(method, params)
  }
}

/**
 * Create a new OpenTasks client
 *
 * @param options - Client options
 * @returns OpenTasks client instance
 */
export function createClient(options?: ClientOptions): OpenTasksClient {
  return new OpenTasksClient(options)
}
