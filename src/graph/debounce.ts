/**
 * Debounced Flusher Utility
 *
 * Core timing utility for debounced flush operations.
 * Used by SyncManager and daemon FlushManager.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for debounced flush behavior
 */
export interface DebounceConfig {
  /** Debounce delay in milliseconds */
  debounceMs: number

  /** Maximum delay before forced flush */
  maxDelayMs: number
}

/**
 * Callback for performing the actual flush operation
 */
export type FlushCallback = () => Promise<void>

/**
 * Debounced flusher interface - handles timing without external dependencies
 */
export interface DebouncedFlusher {
  /** Mark that changes exist (sets dirty flag) */
  markDirty(): void

  /** Schedule a debounced flush */
  schedule(): void

  /** Force immediate flush */
  flush(): Promise<void>

  /** Cancel pending flush and clear dirty state */
  cancel(): void

  /** Check if there are pending changes or scheduled flush */
  hasPending(): boolean
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a debounced flusher for coordinating timed flush operations
 *
 * Features:
 * - Debounce: Waits for quiet period before flushing
 * - Max delay: Forces flush even with continuous activity
 * - Deduplication: Concurrent flush() calls share same promise
 *
 * @param config - Debounce configuration
 * @param onFlush - Callback to perform the actual flush
 */
export function createDebouncedFlusher(
  config: DebounceConfig,
  onFlush: FlushCallback
): DebouncedFlusher {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxDelayTimer: ReturnType<typeof setTimeout> | null = null
  let flushPromise: Promise<void> | null = null
  let isDirty = false

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

    // If not dirty, nothing to do
    if (!isDirty) {
      return
    }

    // Clear dirty flag before flush (new changes during flush will re-set it)
    isDirty = false

    // Perform the flush
    await onFlush()
  }

  const flusher: DebouncedFlusher = {
    markDirty(): void {
      isDirty = true
    },

    schedule(): void {
      // Clear existing debounce timer
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }

      // Set new debounce timer
      debounceTimer = setTimeout(() => {
        void flusher.flush()
      }, config.debounceMs)

      // Set max delay timer (only once per batch)
      if (!maxDelayTimer) {
        maxDelayTimer = setTimeout(() => {
          void flusher.flush()
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
      isDirty = false
    },

    hasPending(): boolean {
      return isDirty || debounceTimer !== null
    },
  }

  return flusher
}
