/**
 * Daemon Flush Manager
 *
 * Coordinates debounced flushing from SQLite to JSONL with
 * file watcher integration for handling external changes.
 */

import { createDebouncedFlusher, type DebouncedFlusher, type DebounceConfig } from '../graph/debounce.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Callback to perform the actual flush operation
 */
export type FlushOperation = (nodeIds: string[]) => Promise<void>

/**
 * Daemon flush manager configuration
 */
export interface FlushManagerConfig {
  /** Debounce delay in milliseconds (default: 5000) */
  debounceMs?: number

  /** Maximum delay before forced flush (default: 30000) */
  maxDelayMs?: number
}

/**
 * Daemon flush manager interface
 */
export interface DaemonFlushManager {
  /** Mark a node as dirty (needs flush) */
  markDirty(nodeId: string): void

  /** Schedule a debounced flush */
  schedule(): void

  /** Force immediate flush */
  flush(): Promise<void>

  /** Pause flushing (for file watcher coordination) */
  pause(): void

  /** Resume flushing */
  resume(): void

  /** Final flush on shutdown (ignores pause state) */
  finalFlush(): Promise<void>

  /** Check if there are pending changes */
  hasPendingChanges(): boolean

  /** Get list of dirty node IDs */
  getDirtyNodes(): string[]

  /** Check if currently paused */
  readonly paused: boolean
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_FLUSH_CONFIG: Required<FlushManagerConfig> = {
  debounceMs: 5000, // 5 seconds
  maxDelayMs: 30000, // 30 seconds
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a daemon flush manager
 *
 * @param config - Flush configuration
 * @param onFlush - Callback to perform the actual flush with dirty node IDs
 */
export function createDaemonFlushManager(
  config: FlushManagerConfig,
  onFlush: FlushOperation
): DaemonFlushManager {
  const {
    debounceMs = DEFAULT_FLUSH_CONFIG.debounceMs,
    maxDelayMs = DEFAULT_FLUSH_CONFIG.maxDelayMs,
  } = config

  const dirtyNodes = new Set<string>()
  let isPaused = false

  /**
   * Perform flush operation
   */
  async function doFlush(): Promise<void> {
    if (dirtyNodes.size === 0) {
      return
    }

    // Copy and clear dirty nodes before flush
    const nodeIds = Array.from(dirtyNodes)
    dirtyNodes.clear()

    await onFlush(nodeIds)
  }

  // Create debounced flusher for timing
  const flusher: DebouncedFlusher = createDebouncedFlusher(
    { debounceMs, maxDelayMs },
    doFlush
  )

  return {
    get paused(): boolean {
      return isPaused
    },

    markDirty(nodeId: string): void {
      dirtyNodes.add(nodeId)
      flusher.markDirty()
    },

    schedule(): void {
      if (isPaused) return
      flusher.schedule()
    },

    async flush(): Promise<void> {
      if (isPaused) return
      await flusher.flush()
    },

    pause(): void {
      isPaused = true
      // Cancel any pending scheduled flush
      flusher.cancel()
      // Note: we keep dirtyNodes intact - they'll be flushed on resume
    },

    resume(): void {
      isPaused = false
      // If there are pending dirty nodes, re-mark and schedule
      if (dirtyNodes.size > 0) {
        flusher.markDirty()
        flusher.schedule()
      }
    },

    async finalFlush(): Promise<void> {
      // Final flush ignores pause state
      // Cancel any pending scheduled flush
      flusher.cancel()

      // Flush all remaining dirty nodes
      await doFlush()
    },

    hasPendingChanges(): boolean {
      return dirtyNodes.size > 0 || flusher.hasPending()
    },

    getDirtyNodes(): string[] {
      return Array.from(dirtyNodes)
    },
  }
}
