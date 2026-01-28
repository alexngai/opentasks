/**
 * Sync Manager for Graph Store
 *
 * Handles debounced synchronization between SQLite and JSONL.
 * SQLite is the write-through cache, JSONL is the source of truth.
 */

import type { Storage } from '../storage/interface.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for sync behavior
 */
export interface SyncConfig {
  /** Debounce delay in milliseconds (default: 5000) */
  debounceMs: number

  /** Maximum delay before forced flush (default: 30000) */
  maxDelayMs: number
}

/**
 * Callback for performing the actual flush operation
 */
export type FlushCallback = () => Promise<void>

/**
 * Sync manager interface
 */
export interface SyncManager {
  /** Mark a node as dirty (needs JSONL sync) */
  markDirty(nodeId: string): void

  /** Schedule a debounced flush */
  scheduleFlush(): void

  /** Force immediate flush */
  flush(): Promise<void>

  /** Cancel pending flush (for cleanup) */
  cancel(): void

  /** Check if there are pending changes */
  hasPendingChanges(): boolean
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  debounceMs: 5000, // 5 seconds
  maxDelayMs: 30000, // 30 seconds
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a sync manager for coordinating SQLite and JSONL persistence
 *
 * @param config - Sync configuration
 * @param storage - SQLite storage for dirty tracking
 * @param onFlush - Callback to perform the actual flush
 */
export function createSyncManager(
  config: SyncConfig,
  storage: Storage,
  onFlush: FlushCallback
): SyncManager {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxDelayTimer: ReturnType<typeof setTimeout> | null = null
  let flushPromise: Promise<void> | null = null
  let pendingDirtyNodes = new Set<string>()

  /**
   * Clear all timers
   */
  function clearTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (maxDelayTimer) {
      clearTimeout(maxDelayTimer)
      maxDelayTimer = null
    }
  }

  /**
   * Perform the actual flush operation
   */
  async function doFlush(): Promise<void> {
    // Clear timers
    clearTimers()

    // If no pending changes, nothing to do
    if (pendingDirtyNodes.size === 0) {
      return
    }

    // Mark nodes as dirty in storage
    for (const nodeId of pendingDirtyNodes) {
      await storage.markDirty(nodeId)
    }
    pendingDirtyNodes.clear()

    // Perform the flush
    await onFlush()
  }

  return {
    markDirty(nodeId: string): void {
      pendingDirtyNodes.add(nodeId)
    },

    scheduleFlush(): void {
      // Clear existing debounce timer
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }

      // Set new debounce timer
      debounceTimer = setTimeout(() => {
        void this.flush()
      }, config.debounceMs)

      // Set max delay timer (only once per batch)
      if (!maxDelayTimer) {
        maxDelayTimer = setTimeout(() => {
          void this.flush()
        }, config.maxDelayMs)
      }
    },

    async flush(): Promise<void> {
      // If already flushing, wait for it
      if (flushPromise) {
        return flushPromise
      }

      // Create new flush promise
      flushPromise = doFlush().finally(() => {
        flushPromise = null
      })

      return flushPromise
    },

    cancel(): void {
      clearTimers()
      pendingDirtyNodes.clear()
    },

    hasPendingChanges(): boolean {
      return pendingDirtyNodes.size > 0 || debounceTimer !== null
    },
  }
}
