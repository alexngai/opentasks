/**
 * Sync Manager for Graph Store
 *
 * Handles debounced synchronization between SQLite and JSONL.
 * SQLite is the write-through cache, JSONL is the source of truth.
 *
 * Composes DebouncedFlusher for timing, adds node-level dirty tracking
 * and Storage integration.
 */

import type { Storage } from '../storage/interface.js'
import { createDebouncedFlusher, type DebouncedFlusher } from './debounce.js'

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
  let pendingDirtyNodes = new Set<string>()

  // Create debounced flusher with our flush logic
  const flusher: DebouncedFlusher = createDebouncedFlusher(config, async () => {
    // Mark nodes as dirty in storage before flush
    for (const nodeId of pendingDirtyNodes) {
      await storage.markDirty(nodeId)
    }
    pendingDirtyNodes.clear()

    // Perform the actual flush
    await onFlush()
  })

  return {
    markDirty(nodeId: string): void {
      pendingDirtyNodes.add(nodeId)
      flusher.markDirty()
    },

    scheduleFlush(): void {
      flusher.schedule()
    },

    async flush(): Promise<void> {
      return flusher.flush()
    },

    cancel(): void {
      flusher.cancel()
      pendingDirtyNodes.clear()
    },

    hasPendingChanges(): boolean {
      return pendingDirtyNodes.size > 0 || flusher.hasPending()
    },
  }
}
