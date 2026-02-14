/**
 * TaskManageable Trait
 *
 * Optional trait for providers that support task lifecycle operations.
 * Providers implement this trait to expose semantic task actions
 * (start, complete, block, etc.) beyond raw CRUD.
 *
 * Not all providers manage tasks — a spec-only provider or a feed
 * provider would skip this trait entirely and still work as a
 * standard Provider for CRUD operations.
 */

import type { Provider, ProviderNode, ProviderOperationContext } from '../types.js'

// ============================================================================
// Task Action Types
// ============================================================================

/**
 * Semantic task actions.
 *
 * Providers map these to their own native status model.
 * For example, a provider with statuses ['pending', 'active', 'done']
 * might map 'start' → 'active' and 'complete' → 'done'.
 */
export type TaskAction = 'start' | 'complete' | 'block' | 'reopen' | 'close'

// ============================================================================
// Task Capabilities
// ============================================================================

/**
 * Declares what task operations a provider supports.
 *
 * Consumers inspect this to know what actions are valid before
 * attempting them. The `actions` array is the minimum contract —
 * optional capabilities like assignment are declared separately.
 */
export interface TaskCapabilities {
  /** Which semantic actions this provider supports */
  actions: TaskAction[]

  /** Whether the provider supports assigning tasks to owners */
  supportsAssignment: boolean

  /** Whether the provider can compute ready tasks natively */
  supportsReadyQuery: boolean

  /** The provider's native status values (informational) */
  statusModel: string[]
}

// ============================================================================
// Options
// ============================================================================

/**
 * Options for querying ready tasks from a provider
 */
export interface ReadyTaskOptions {
  /** Maximum number of tasks to return */
  limit?: number

  /** Filter by tags */
  tags?: string[]

  /** Filter by minimum priority */
  priority?: number

  /** Filter by assignee */
  assignee?: string
}

// ============================================================================
// TaskManageable Trait
// ============================================================================

/**
 * TaskManageable Trait
 *
 * Providers implement this trait to expose task lifecycle operations
 * that go beyond raw CRUD. The trait uses semantic actions rather than
 * direct status strings — each provider maps actions to its own
 * status model internally.
 *
 * Required methods:
 * - `transitionTask` — apply a semantic action to a task
 * - `readyTasks` — list tasks with no active blockers
 *
 * Optional methods:
 * - `assignTask` — assign a task to an owner
 * - `validActions` — introspect valid next actions for a task
 *
 * @example
 * ```typescript
 * class BeadsProvider implements Provider, TaskManageable {
 *   readonly taskCapabilities: TaskCapabilities = {
 *     actions: ['start', 'complete', 'block', 'reopen'],
 *     supportsAssignment: true,
 *     supportsReadyQuery: true,
 *     statusModel: ['open', 'in_progress', 'blocked', 'done'],
 *   }
 *
 *   async transitionTask(id: string, action: TaskAction) {
 *     // Map semantic action to bd CLI command
 *     switch (action) {
 *       case 'start': return this.exec(['task', 'start', id])
 *       case 'complete': return this.exec(['task', 'complete', id])
 *       // ...
 *     }
 *   }
 *
 *   async readyTasks(options?: ReadyTaskOptions) {
 *     return this.exec(['task', 'list', '--ready'])
 *   }
 * }
 * ```
 */
export interface TaskManageable {
  /** Declares what task operations this provider supports */
  readonly taskCapabilities: TaskCapabilities

  /**
   * Transition a task's status using a semantic action.
   *
   * The provider maps the action to its native status model.
   * Throws if the action is not valid for the task's current state.
   *
   * @param id - Task ID (in provider's local format)
   * @param action - The semantic action to apply
   * @param context - Optional operational context
   * @returns The updated task node
   */
  transitionTask(
    id: string,
    action: TaskAction,
    context?: ProviderOperationContext
  ): Promise<ProviderNode>

  /**
   * Get tasks that are ready to work on (no active blockers).
   *
   * Each provider determines "ready" based on its own semantics.
   * The store layer can aggregate across providers.
   *
   * @param options - Filtering options
   * @param context - Optional operational context
   * @returns Array of ready task nodes
   */
  readyTasks(
    options?: ReadyTaskOptions,
    context?: ProviderOperationContext
  ): Promise<ProviderNode[]>

  /**
   * Assign a task to an owner.
   *
   * Optional — only available when `taskCapabilities.supportsAssignment` is true.
   *
   * @param id - Task ID (in provider's local format)
   * @param assignee - The assignee identifier
   * @param context - Optional operational context
   * @returns The updated task node
   */
  assignTask?(
    id: string,
    assignee: string,
    context?: ProviderOperationContext
  ): Promise<ProviderNode>

  /**
   * Get the valid next actions for a task in its current state.
   *
   * Optional — useful for UI to show available actions.
   * If not implemented, consumers can fall back to `taskCapabilities.actions`.
   *
   * @param id - Task ID (in provider's local format)
   * @param context - Optional operational context
   * @returns Array of valid actions for this task's current state
   */
  validActions?(
    id: string,
    context?: ProviderOperationContext
  ): Promise<TaskAction[]>
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Check if a provider implements the TaskManageable trait
 *
 * @param provider - The provider to check
 * @returns True if the provider supports task lifecycle operations
 *
 * @example
 * ```typescript
 * const provider = registry.resolveProvider(uri)
 * if (provider && isTaskManageable(provider)) {
 *   await provider.transitionTask(taskId, 'start')
 *   const ready = await provider.readyTasks({ limit: 10 })
 * }
 * ```
 */
export function isTaskManageable(
  provider: Provider
): provider is Provider & TaskManageable {
  const p = provider as unknown as TaskManageable
  return (
    typeof p.transitionTask === 'function' &&
    typeof p.readyTasks === 'function' &&
    p.taskCapabilities !== undefined &&
    typeof p.taskCapabilities === 'object'
  )
}
