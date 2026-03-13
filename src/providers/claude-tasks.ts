/**
 * Claude Tasks Provider
 *
 * Provider that bridges Claude Code's native task system with OpenTasks.
 * Handles claude:// and task:// URI schemes.
 *
 * Implements TaskManageable for semantic task lifecycle operations and
 * Watchable (when tasksDir is configured) for file-based change detection.
 */

import { access } from 'fs/promises';
import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ProviderOperationContext,
  ParsedUri,
  UriOptions,
} from './types.js';
import { ProviderError, createIsAvailable } from './types.js';
import type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
  ReadyTaskOptions,
} from './traits/TaskManageable.js';
import type {
  Watchable,
  WatchGranularity,
  WatchChangeCallback,
  ProviderNodeChangeEvent,
} from './traits/Watchable.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Claude Tasks provider
 */
export interface ClaudeTasksConfig {
  /** Session identifier ('current' or specific ID) */
  session?: string;

  /**
   * Task store adapter - allows injecting external task management
   * If not provided, uses an in-memory store for testing
   */
  taskStore?: ClaudeTaskStore;

  /**
   * Path to tasks directory on disk.
   * When set, enables the Watchable trait via chokidar file watching.
   */
  tasksDir?: string;

  /** Debounce delay for file watching in ms (default: 200) */
  watchDebounceMs?: number;
}

/**
 * Claude task structure
 */
export interface ClaudeTask {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Interface for task store adapter
 * Allows integration with Claude's actual task system or mock for testing
 */
export interface ClaudeTaskStore {
  get(id: string): Promise<ClaudeTask | null>;
  list(): Promise<ClaudeTask[]>;
  create(task: Omit<ClaudeTask, 'id'>): Promise<ClaudeTask>;
  update(id: string, updates: Partial<ClaudeTask>): Promise<ClaudeTask>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for claude:// or task:// URIs
 * Format: claude://[session/]id or task://[session/]id
 */
const CLAUDE_URI_PATTERN = /^(claude|task):\/\/(?:([^/]+)\/)?(.+)$/i;

/**
 * Pattern for Claude task IDs (numeric with optional prefix)
 */
const TASK_ID_PATTERN = /^(?:t-)?(\d+)$/;

// ============================================================================
// In-Memory Task Store (for testing/standalone mode)
// ============================================================================

/**
 * Create an in-memory task store for testing
 */
export function createInMemoryTaskStore(): ClaudeTaskStore {
  const tasks = new Map<string, ClaudeTask>();
  let nextId = 1;

  return {
    async get(id: string): Promise<ClaudeTask | null> {
      return tasks.get(id) ?? null;
    },

    async list(): Promise<ClaudeTask[]> {
      return Array.from(tasks.values());
    },

    async create(task: Omit<ClaudeTask, 'id'>): Promise<ClaudeTask> {
      const id = String(nextId++);
      const newTask: ClaudeTask = { ...task, id };
      tasks.set(id, newTask);
      return newTask;
    },

    async update(id: string, updates: Partial<ClaudeTask>): Promise<ClaudeTask> {
      const existing = tasks.get(id);
      if (!existing) {
        throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude');
      }
      const updated: ClaudeTask = { ...existing, ...updates, id };
      tasks.set(id, updated);
      return updated;
    },

    async delete(id: string): Promise<void> {
      if (!tasks.has(id)) {
        throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude');
      }
      tasks.delete(id);
    },
  };
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
      return 'open';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'closed';
    default:
      return status;
  }
}

/**
 * Map normalized status to Claude task status
 */
function mapStatusToClaudeStatus(status: string): ClaudeTask['status'] {
  switch (status.toLowerCase()) {
    case 'open':
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'closed':
    case 'completed':
    case 'done':
      return 'completed';
    default:
      return 'pending';
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
  };
}

/**
 * Valid task actions for each status state
 */
function validActionsForStatus(status: string): TaskAction[] {
  switch (status) {
    case 'open':
      return ['start', 'close'];
    case 'in_progress':
      return ['complete', 'close'];
    case 'closed':
      return ['reopen'];
    default:
      return ['start', 'complete', 'reopen', 'close'];
  }
}

// ============================================================================
// Claude Tasks Provider Implementation
// ============================================================================

/**
 * Create a Claude Tasks provider with TaskManageable and optional Watchable support
 */
export function createClaudeTasksProvider(
  config: ClaudeTasksConfig = {},
): Provider & TaskManageable & Partial<Watchable> {
  const session = config.session ?? 'current';
  const taskStore = config.taskStore ?? createInMemoryTaskStore();
  const tasksDir = config.tasksDir;
  const watchDebounceMs = config.watchDebounceMs ?? 200;

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: false,
    watch: !!tasksDir,
    mount: true,
    feedback: false,
  };

  // =========================================================================
  // Watch State (only active when tasksDir is configured)
  // =========================================================================

  /** Cached content hashes for change diffing: task id → hash */
  const cachedHashes = new Map<string, string>();

  /** chokidar watcher instance */
  let fileWatcher: import('chokidar').FSWatcher | null = null;

  /** Current watch callback */
  let watchCallback: WatchChangeCallback | null = null;

  /** Debounce timer for coalescing rapid file changes */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Simple hash for diffing (not cryptographic — just for detecting changes).
   */
  function quickHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * Build a stable hash key for a Claude task (substantive fields only)
   */
  function taskHashKey(task: ClaudeTask): string {
    const substantive = {
      subject: task.subject,
      description: task.description,
      status: task.status,
      owner: task.owner,
      blocks: task.blocks ? [...task.blocks].sort() : undefined,
      blockedBy: task.blockedBy ? [...task.blockedBy].sort() : undefined,
    };
    return quickHash(JSON.stringify(substantive));
  }

  /**
   * Diff current task state against cached hashes and emit change events.
   */
  async function diffAndEmit(): Promise<void> {
    if (!watchCallback) return;

    try {
      const tasks = await taskStore.list();
      const currentIds = new Set<string>();

      for (const task of tasks) {
        currentIds.add(task.id);
        const hash = taskHashKey(task);
        const prevHash = cachedHashes.get(task.id);
        const providerNode = taskToProviderNode(task, session);

        if (!prevHash) {
          // New task
          watchCallback({
            kind: 'node',
            event: {
              type: 'created',
              nodeId: task.id,
              uri: providerNode.uri,
              node: providerNode,
              timestamp: new Date().toISOString(),
            },
          });
        } else if (prevHash !== hash) {
          // Changed task
          const event: ProviderNodeChangeEvent = {
            type: 'updated',
            nodeId: task.id,
            uri: providerNode.uri,
            node: providerNode,
            timestamp: new Date().toISOString(),
          };
          watchCallback({ kind: 'node', event });
        }

        cachedHashes.set(task.id, hash);
      }

      // Detect deleted tasks
      for (const [id] of cachedHashes) {
        if (!currentIds.has(id)) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'deleted',
              nodeId: id,
              uri: `claude://${session}/${id}`,
              timestamp: new Date().toISOString(),
            },
          });
          cachedHashes.delete(id);
        }
      }
    } catch {
      // Resilient — continue watching despite transient errors
    }
  }

  /**
   * Handle a raw file change event with debouncing
   */
  function onFileChange(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void diffAndEmit();
    }, watchDebounceMs);
  }

  /**
   * Seed the cached hashes from current task state
   */
  async function seedCache(): Promise<void> {
    try {
      const tasks = await taskStore.list();
      cachedHashes.clear();
      for (const task of tasks) {
        cachedHashes.set(task.id, taskHashKey(task));
      }
    } catch {
      // If we can't seed, first diff will treat everything as 'created'
    }
  }

  // For filesystem-backed stores, check tasksDir accessibility.
  // For in-memory stores, always available.
  const isAvailable = createIsAvailable(async () => {
    if (!tasksDir) return true; // in-memory store is always available
    try {
      await access(tasksDir);
      return true;
    } catch {
      return false;
    }
  });

  return {
    name: 'claude',
    schemes: ['claude', 'task'],
    capabilities,
    local: true,
    description: 'Claude Code native task system. Bridges Claude task lifecycle (pending/in_progress/completed) with OpenTasks. Assignee maps to task owner.',
    metadataSchema: {
      fields: {
        tags: { type: 'string[]', description: 'Tags for categorization and ready-task filtering (stored inside metadata)' },
      },
      description: 'Arbitrary metadata is persisted on the Claude task. Tags are stored in metadata.tags and used by ready-task queries.',
    },

    isAvailable,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for claude:// or task:// URI
      const match = uri.match(CLAUDE_URI_PATTERN);
      if (match) {
        const scheme = match[1].toLowerCase();
        const workspace = match[2] || 'current';
        const id = match[3];
        return {
          scheme,
          workspace,
          id,
          isRelative: workspace === 'current',
        };
      }

      // Check for bare task ID
      if (TASK_ID_PATTERN.test(uri)) {
        const id = uri.replace(/^t-/, '');
        return {
          scheme: 'claude',
          workspace: 'current',
          id,
          isRelative: true,
        };
      }

      return null;
    },

    buildUri(id: string, options?: UriOptions): string {
      const workspace = options?.workspace ?? session;
      if (options?.relative) {
        return id;
      }
      return `claude://${workspace}/${id}`;
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null;
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string, _context?: ProviderOperationContext): Promise<ProviderNode | null> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id.replace(/^t-/, '');
      const taskSession = parsed?.workspace ?? session;

      try {
        const task = await taskStore.get(taskId);
        if (!task) return null;
        return taskToProviderNode(task, taskSession);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to get task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async list(
      filter?: ProviderFilter,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      try {
        let tasks = await taskStore.list();

        // Filter by status if specified
        if (filter?.status) {
          const normalizedStatus = filter.status.toLowerCase();
          tasks = tasks.filter((t) => {
            const taskStatus = mapStatus(t.status).toLowerCase();
            return taskStatus === normalizedStatus;
          });
        }

        // Apply limit if specified
        if (filter?.limit) {
          tasks = tasks.slice(0, filter.limit);
        }

        return tasks.map((task) => taskToProviderNode(task, session));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async create(
      input: ProviderCreateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      try {
        const task = await taskStore.create({
          subject: input.title,
          description: input.content,
          status: input.status ? mapStatusToClaudeStatus(input.status) : 'pending',
          metadata: input.metadata,
        });

        return taskToProviderNode(task, session);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async update(
      id: string,
      updates: ProviderUpdateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id.replace(/^t-/, '');
      const taskSession = parsed?.workspace ?? session;

      try {
        const updateData: Partial<ClaudeTask> = {};

        if (updates.title !== undefined) {
          updateData.subject = updates.title;
        }
        if (updates.content !== undefined) {
          updateData.description = updates.content;
        }
        if (updates.status !== undefined) {
          updateData.status = mapStatusToClaudeStatus(updates.status);
        }
        if (updates.metadata !== undefined) {
          updateData.metadata = updates.metadata;
        }

        const task = await taskStore.update(taskId, updateData);

        return taskToProviderNode(task, taskSession);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async delete(id: string, _context?: ProviderOperationContext): Promise<void> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id.replace(/^t-/, '');

      try {
        await taskStore.delete(taskId);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
          'claude',
          error instanceof Error ? error : undefined,
        );
      }
    },

    // =========================================================================
    // Watchable Implementation (only functional when tasksDir is configured)
    // =========================================================================

    watchGranularity: {
      reportsChangedFields: false,
      reportsPreviousValues: false,
      reportsEdgeChanges: false,
      mechanism: 'file-watch' as const,
    } satisfies WatchGranularity,

    startWatching(callback: WatchChangeCallback): void {
      if (!tasksDir) {
        return; // Watching not configured — silently no-op
      }

      // Replace callback if already watching
      watchCallback = callback;

      if (fileWatcher) {
        return; // Already watching, just updated callback
      }

      // Seed cache before starting watcher so we only emit real changes
      void seedCache().then(async () => {
        if (!watchCallback) return; // Stopped before seed completed

        const chokidar = await import('chokidar');
        fileWatcher = chokidar.watch(tasksDir, {
          ignoreInitial: true,
          persistent: true,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 20,
          },
        });

        fileWatcher.on('add', onFileChange);
        fileWatcher.on('change', onFileChange);
        fileWatcher.on('unlink', onFileChange);

        fileWatcher.on('error', () => {
          // Resilient — continue watching despite transient errors
        });
      });
    },

    stopWatching(): void {
      watchCallback = null;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      if (fileWatcher) {
        void fileWatcher.close();
        fileWatcher = null;
      }
    },

    get isWatching(): boolean {
      return fileWatcher !== null && watchCallback !== null;
    },

    // =========================================================================
    // TaskManageable Implementation
    // =========================================================================

    taskCapabilities: {
      actions: ['start', 'complete', 'reopen', 'close'],
      supportsAssignment: true,
      supportsReadyQuery: true,
      statusModel: ['open', 'in_progress', 'closed'],
    } satisfies TaskCapabilities,

    async transitionTask(
      id: string,
      action: TaskAction,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const statusMap: Partial<Record<TaskAction, ClaudeTask['status']>> = {
        start: 'in_progress',
        complete: 'completed',
        reopen: 'pending',
        close: 'completed',
      };

      const targetStatus = statusMap[action];
      if (!targetStatus) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Claude tasks do not support the '${action}' action`,
          'claude',
        );
      }

      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id.replace(/^t-/, '');

      // Validate transition is allowed from current state
      const current = await this.get(taskId);
      if (current) {
        const currentStatus = current.status ?? 'open';
        const allowed = validActionsForStatus(currentStatus);
        if (!allowed.includes(action)) {
          throw new ProviderError(
            'NOT_SUPPORTED',
            `Cannot ${action} a task in '${currentStatus}' state. Valid actions: ${allowed.join(', ')}`,
            'claude',
          );
        }
      }

      const task = await taskStore.update(taskId, { status: targetStatus });
      return taskToProviderNode(task, session);
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const tasks = await taskStore.list();
      const readyTasks: ProviderNode[] = [];

      for (const task of tasks) {
        // Only pending (open) tasks can be ready
        if (task.status !== 'pending') continue;

        // Apply tag filter
        if (options?.tags) {
          const taskTags = (task.metadata?.tags as string[] | undefined) ?? [];
          if (!options.tags.every((t) => taskTags.includes(t))) continue;
        }

        // Apply priority filter (Claude tasks default to priority 2)
        if (options?.priority !== undefined) {
          const taskPriority = 2; // Claude tasks don't have individual priorities
          if (taskPriority > options.priority) continue;
        }

        // Apply assignee filter
        if (options?.assignee && task.owner !== options.assignee) continue;

        // Check for active blockers
        let hasActiveBlocker = false;
        if (task.blockedBy && task.blockedBy.length > 0) {
          for (const blockerId of task.blockedBy) {
            const blocker = await taskStore.get(blockerId);
            if (blocker && blocker.status !== 'completed') {
              hasActiveBlocker = true;
              break;
            }
          }
        }

        if (!hasActiveBlocker) {
          readyTasks.push(taskToProviderNode(task, session));
        }
      }

      // Sort by priority (lower = higher priority) — consistent with beads/sudocode
      readyTasks.sort((a, b) => {
        const aPriority = a.priority ?? Infinity;
        const bPriority = b.priority ?? Infinity;
        return aPriority - bPriority;
      });

      // Apply limit
      if (options?.limit && readyTasks.length > options.limit) {
        return readyTasks.slice(0, options.limit);
      }

      return readyTasks;
    },

    async assignTask(
      id: string,
      assignee: string,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id.replace(/^t-/, '');

      const task = await taskStore.update(taskId, { owner: assignee });
      return taskToProviderNode(task, session);
    },

    async validActions(id: string, _context?: ProviderOperationContext): Promise<TaskAction[]> {
      const node = await this.get(id);
      if (!node) {
        throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude');
      }

      return validActionsForStatus(node.status ?? 'open');
    },
  };
}
