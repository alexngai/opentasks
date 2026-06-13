/**
 * OpenTasks Client
 *
 * Client library for interacting with the OpenTasks daemon.
 * Provides a typed wrapper around the 3-tool interface.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createIPCClient, type IPCClient } from '../daemon/ipc.js';
import type { WatchFilter } from '../daemon/methods/watch.js';
import type { ProviderNodeChangeEvent } from '../providers/traits/Watchable.js';
import { getGitCommonDir } from '../core/worktree.js';
import { ensureGlobalStoreInitialized } from '../core/init.js';
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  TaskParams,
  TaskResult,
  NodeSummary,
  FeedbackSummary,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
  ContextSummaryParams,
  ContextSummaryResult,
} from '../tools/types.js';
import type { CreateNodeInput, UpdateNodeInput, DeleteOptions } from '../graph/types.js';
import type {
  CreateContextFileInput,
  SyncContextFileOptions,
  ContextFileResolution,
  DriftResult,
} from '../context-files/types.js';
import type { Context } from '../schema/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating an OpenTasks client
 */
export interface ClientOptions {
  /** Path to the daemon socket file */
  socketPath?: string;

  /** Auto-connect on first request (default: true) */
  autoConnect?: boolean;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Error thrown when client operations fail
 */
export class ClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_CONNECTED'
      | 'CONNECTION_FAILED'
      | 'REQUEST_FAILED'
      | 'SOCKET_NOT_FOUND',
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

// ============================================================================
// Socket Path Discovery
// ============================================================================

/**
 * Find the multi-location daemon socket at .git/opentasks/daemon.sock
 */
function findGitDaemonSocket(startDir: string = process.cwd()): string | null {
  const gitCommonDir = getGitCommonDir(startDir);
  if (!gitCommonDir) return null;

  const socketPath = path.join(gitCommonDir, 'opentasks', 'daemon.sock');
  if (fs.existsSync(socketPath)) {
    return socketPath;
  }
  return null;
}

/**
 * Find the opentasks directory starting from cwd and walking up.
 * Priority: OPENTASKS_PROJECT_DIR env var > .swarm/opentasks > .opentasks
 */
function findOpenTasksDir(startDir: string = process.cwd()): string | null {
  // Explicit override via env var
  if (process.env.OPENTASKS_PROJECT_DIR) {
    const explicit = path.resolve(startDir, process.env.OPENTASKS_PROJECT_DIR);
    if (fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) {
      return explicit;
    }
  }

  let currentDir = startDir;

  while (true) {
    // Check swarmkit-managed layout first, then standalone
    const swarmCandidate = path.join(currentDir, '.swarm', 'opentasks');
    if (fs.existsSync(swarmCandidate) && fs.statSync(swarmCandidate).isDirectory()) {
      return swarmCandidate;
    }

    const candidate = path.join(currentDir, '.opentasks');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Get the default socket path.
 * Prefers .git/opentasks/daemon.sock (multi-location), then walks up for
 * .opentasks/daemon.sock (single-location), then falls back to
 * ~/.opentasks/daemon.sock (global store).
 */
function getDefaultSocketPath(): string {
  // 1. Check for multi-location daemon socket first
  const gitSocket = findGitDaemonSocket();
  if (gitSocket) {
    return gitSocket;
  }

  // 2. Fallback to single-location .opentasks/daemon.sock
  const openTasksDir = findOpenTasksDir();
  if (openTasksDir) {
    return path.join(openTasksDir, 'daemon.sock');
  }

  // 3. Fallback to global daemon at ~/.opentasks/daemon.sock
  // Auto-init ~/.opentasks/ if it doesn't exist yet
  const globalDir = ensureGlobalStoreInitialized();
  const globalSocketPath = path.join(globalDir, 'daemon.sock');
  if (fs.existsSync(globalSocketPath)) {
    return globalSocketPath;
  }

  throw new ClientError(
    'Could not find daemon socket. Is the daemon running?',
    'SOCKET_NOT_FOUND',
  );
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
  private client: IPCClient | null = null;
  private readonly options: Required<ClientOptions>;
  private socketPath: string | null = null;

  constructor(options?: ClientOptions) {
    this.options = {
      socketPath: options?.socketPath ?? '',
      autoConnect: options?.autoConnect ?? true,
      timeout: options?.timeout ?? 30000,
    };

    // If socket path provided, resolve it immediately
    if (options?.socketPath) {
      this.socketPath = options.socketPath;
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
      return;
    }

    // Resolve socket path if not already done
    if (!this.socketPath) {
      this.socketPath = getDefaultSocketPath();
    }

    this.client = createIPCClient(this.socketPath);

    try {
      await this.client.connect();
    } catch (error) {
      this.client = null;
      throw new ClientError(
        `Failed to connect to daemon: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'CONNECTION_FAILED',
      );
    }
  }

  /**
   * Disconnect from the daemon
   */
  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  /**
   * Check if connected to the daemon
   */
  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Ensure connection before making a request
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.options.autoConnect) {
      await this.connect();
      return;
    }

    throw new ClientError(
      'Not connected to daemon. Call connect() first or enable autoConnect.',
      'NOT_CONNECTED',
    );
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
    await this.ensureConnected();
    return this.client!.request<LinkResult>('tools.link', params);
  }

  /**
   * Query the graph
   *
   * @param params - Query parameters
   * @returns Query result with items and pagination info
   */
  async query(params: QueryParams): Promise<QueryResult> {
    await this.ensureConnected();
    return this.client!.request<QueryResult>('tools.query', params);
  }

  /**
   * Manage feedback lifecycle
   *
   * @param params - Annotate parameters
   * @returns Annotate result with success status
   */
  async annotate(params: AnnotateParams): Promise<AnnotateResult> {
    await this.ensureConnected();
    return this.client!.request<AnnotateResult>('tools.annotate', params);
  }

  /**
   * Task lifecycle operations
   *
   * @param params - Task parameters (transition, ready, assign, or validActions)
   * @returns Task result with operation-specific data
   */
  async task(params: TaskParams): Promise<TaskResult> {
    await this.ensureConnected();
    return this.client!.request<TaskResult>('tools.task', params);
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
    const result = await this.query({ ready: options || {} });
    return result.items as NodeSummary[];
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
    });
    return result.items as NodeSummary[];
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
    });
    return result.items as NodeSummary[];
  }

  /**
   * Get feedback on a specific node
   *
   * @param nodeId - Node to get feedback for
   * @param options - Feedback query options
   * @returns Array of feedback summaries
   */
  async feedback(
    nodeId: string,
    options?: Omit<FeedbackOptions, 'nodeId'>,
  ): Promise<FeedbackSummary[]> {
    const result = await this.query({
      feedback: { nodeId, ...options },
    });
    return result.items as FeedbackSummary[];
  }

  /**
   * Get context summary breadcrumbs for session continuity.
   *
   * Returns structured breadcrumbs: recently completed tasks, active tasks,
   * blocked tasks, related context nodes, and unresolved feedback.
   * Useful at session start to understand what was being worked on.
   *
   * @param params - Context summary parameters (taskId, tags, branch, limit)
   * @returns Structured context summary with breadcrumbs
   */
  async contextSummary(params?: ContextSummaryParams): Promise<ContextSummaryResult> {
    const result = await this.query({ contextSummary: params || {} });
    return result.contextSummary!;
  }

  /**
   * Transition a task's status using a semantic action
   *
   * @param id - Task ID or provider URI
   * @param action - Semantic action ('start', 'complete', 'block', 'reopen', 'close')
   * @returns Task result with updated node
   */
  async taskTransition(
    id: string,
    action: 'start' | 'complete' | 'block' | 'reopen' | 'close',
  ): Promise<TaskResult> {
    return this.task({ transition: { id, action } });
  }

  /**
   * Get tasks ready to work on across all task-capable providers
   *
   * @param options - Ready task query options
   * @returns Task result with ready items
   */
  async taskReady(options?: {
    providers?: string[];
    limit?: number;
    tags?: string[];
  }): Promise<TaskResult> {
    return this.task({ ready: options || {} });
  }

  /**
   * Assign a task to an owner
   *
   * @param id - Task ID or provider URI
   * @param assignee - Assignee identifier
   * @returns Task result with updated node
   */
  async taskAssign(id: string, assignee: string): Promise<TaskResult> {
    return this.task({ assign: { id, assignee } });
  }

  /**
   * Get valid next actions for a task in its current state
   *
   * @param id - Task ID or provider URI
   * @returns Task result with valid actions
   */
  async taskValidActions(id: string): Promise<TaskResult> {
    return this.task({ validActions: { id } });
  }

  // ==========================================================================
  // Graph CRUD (with unified provider dispatch)
  // ==========================================================================

  /**
   * Create a node.
   * When `scheme` is provided, routes creation to that provider.
   * Otherwise uses the configured defaultProvider.
   *
   * @param params - Node creation parameters
   * @param options - Optional provider routing options
   * @returns The created node (materialized locally if via external provider)
   */
  async createNode(params: CreateNodeInput, options?: { scheme?: string }): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('graph.create', { ...params, scheme: options?.scheme });
  }

  /**
   * Get a node by local ID or provider URI.
   * For external/materialized nodes, refreshes if stale.
   *
   * @param idOrUri - Local node ID (e.g., 'i-abc1') or provider URI (e.g., 'sudocode://proj/i-456')
   */
  async getNode(idOrUri: string): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('graph.get', { id: idOrUri });
  }

  /**
   * Update a node by local ID or provider URI.
   * For external/materialized nodes, routes update to the owning provider.
   *
   * @param idOrUri - Local node ID or provider URI
   * @param updates - Fields to update
   */
  async updateNode(idOrUri: string, updates: UpdateNodeInput): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('graph.update', { id: idOrUri, ...updates });
  }

  /**
   * Delete a node by local ID or provider URI.
   * For external/materialized nodes, deletes in the owning provider
   * and removes the local materialized copy.
   *
   * @param idOrUri - Local node ID or provider URI
   * @param options - Delete options (hard vs soft)
   */
  async deleteNode(idOrUri: string, options?: DeleteOptions): Promise<void> {
    await this.ensureConnected();
    await this.client!.request('graph.delete', { id: idOrUri, options });
  }

  // ==========================================================================
  // Provider Introspection
  // ==========================================================================

  /**
   * List all registered providers and their capabilities
   */
  async listProviders(): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('provider.list', {});
  }

  /**
   * Get info about a specific provider
   *
   * @param name - Provider name
   */
  async getProvider(name: string): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('provider.info', { name });
  }

  /**
   * Trigger provider reconciliation
   *
   * @param options - Optional reconciliation options (providers, nodeIds)
   * @returns Reconciliation result with per-node status
   */
  async reconcileProviders(options?: { providers?: string[]; nodeIds?: string[] }): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('provider.reconcile', options ?? {});
  }

  // ==========================================================================
  // Skill Tracking
  // ==========================================================================

  /**
   * Get skill usage summary for a specific session/trajectory
   *
   * @param sessionId - Session ID to query
   * @returns Skill usage summary or null if session not found
   */
  async skillUsage(sessionId: string): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('tracking.skills', { sessionId });
  }

  /**
   * Get skill usage summaries for all active sessions
   *
   * @returns Array of skill usage summaries
   */
  async allSkillUsage(): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('tracking.skills.all', {});
  }

  /**
   * End skill tracking for a session and return the final summary
   *
   * @param sessionId - Session ID to finalize
   * @returns Final skill usage summary or null if session not found
   */
  async endSkillTracking(sessionId: string): Promise<unknown> {
    await this.ensureConnected();
    return this.client!.request('tracking.skills.end', { sessionId });
  }

  // ==========================================================================
  // Context Files
  // ==========================================================================

  /**
   * Create a context-file node for a codebase file.
   */
  async createContextFile(input: CreateContextFileInput): Promise<Context> {
    await this.ensureConnected();
    return this.client!.request<Context>('contextFiles.create', input);
  }

  /**
   * Resolve a context-file node's content from the filesystem.
   *
   * @param id - Context node ID
   * @param atCapturedCommit - If true, resolve at the originally captured commit
   */
  async resolveContextFile(
    id: string,
    atCapturedCommit?: boolean,
  ): Promise<ContextFileResolution> {
    await this.ensureConnected();
    return this.client!.request<ContextFileResolution>('contextFiles.resolve', {
      id,
      atCapturedCommit,
    });
  }

  /**
   * Check whether a context-file has drifted from its captured state.
   */
  async checkContextFileDrift(id: string): Promise<DriftResult> {
    await this.ensureConnected();
    return this.client!.request<DriftResult>('contextFiles.checkDrift', { id });
  }

  /**
   * Batch drift check for multiple context-file nodes.
   */
  async checkContextFileDriftBatch(ids: string[]): Promise<DriftResult[]> {
    await this.ensureConnected();
    return this.client!.request<DriftResult[]>('contextFiles.checkDriftBatch', { ids });
  }

  /**
   * Re-pin a context-file node to current HEAD.
   */
  async syncContextFile(id: string, options?: SyncContextFileOptions): Promise<Context> {
    await this.ensureConnected();
    return this.client!.request<Context>('contextFiles.sync', {
      id,
      force: options?.force,
    });
  }

  // ==========================================================================
  // Watch / Events
  // ==========================================================================

  /**
   * Subscribe to real-time graph change events from the daemon's watch stream.
   *
   * The daemon pushes `watch.event` notifications for node creates, updates, and
   * deletes. The optional `filter` narrows delivery server-side by provider node
   * type and/or status — an empty or omitted filter receives every event. Delete
   * events are always delivered (they carry no node to filter on, and only prompt
   * a re-poll).
   *
   * Delivery is fire-and-forget with no replay (M1): a subscriber that
   * disconnects misses events emitted while it was gone. A replay cursor lands
   * in M2.
   *
   * @param filter - Optional coarse type/status filter. Pass `undefined` for all events.
   * @param handler - Invoked for each matching change event.
   * @returns An async unsubscribe function; call it to stop receiving events.
   */
  async subscribe(
    filter: WatchFilter | undefined,
    handler: (event: ProviderNodeChangeEvent) => void,
  ): Promise<() => Promise<void>> {
    await this.ensureConnected();

    // Capture the active connection so unsubscribe targets the same socket even
    // if the client reconnects later.
    const client = this.client!;
    const removeHandler = client.onNotification((method, params) => {
      if (method === 'watch.event') {
        handler(params as ProviderNodeChangeEvent);
      }
    });

    try {
      await client.request('watch.subscribe', { filter: filter ?? {} });
    } catch (error) {
      removeHandler();
      throw error;
    }

    let unsubscribed = false;
    return async () => {
      if (unsubscribed) return;
      unsubscribed = true;
      removeHandler();
      // Best-effort: drop this connection's server-side subscription. If the
      // daemon or socket is already gone, the local handler removal is enough.
      if (this.client === client && client.connected) {
        try {
          await client.request('watch.unsubscribe', {});
        } catch {
          // Daemon unreachable — nothing more to clean up locally.
        }
      }
    };
  }

  // ==========================================================================
  // Generic RPC
  // ==========================================================================

  /**
   * Call any daemon method by name
   */
  async call<R = unknown>(method: string, params?: unknown): Promise<R> {
    await this.ensureConnected();
    return this.client!.request<R>(method, params);
  }
}

/**
 * Create a new OpenTasks client
 *
 * @param options - Client options
 * @returns OpenTasks client instance
 */
export function createClient(options?: ClientOptions): OpenTasksClient {
  return new OpenTasksClient(options);
}
