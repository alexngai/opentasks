/**
 * File Watcher
 *
 * Watches for external changes to OpenTasks files.
 * Notifies handlers when files are modified externally.
 */

import * as path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'

// ============================================================================
// Types
// ============================================================================

/**
 * Type of file change detected
 */
export type ChangeType = 'add' | 'change' | 'unlink'

/**
 * File category for change handling
 */
export type FileCategory = 'graph' | 'context' | 'task' | 'config' | 'unknown'

/**
 * Change event emitted by watcher
 */
export interface FileChangeEvent {
  /** Type of change */
  type: ChangeType

  /** Absolute path to file */
  path: string

  /** Category of file */
  category: FileCategory
}

/**
 * Handler called when file changes are detected
 */
export type ChangeHandler = (event: FileChangeEvent) => void

/**
 * File watcher configuration
 */
export interface WatcherConfig {
  /** Path to .opentasks/ directory */
  locationPath: string

  /** Debounce delay in milliseconds (default: 100) */
  debounceMs?: number

  /** Whether to watch markdown files (default: true) */
  watchMarkdown?: boolean
}

/**
 * File watcher interface
 */
export interface FileWatcher {
  /** Start watching for changes */
  start(): Promise<void>

  /** Stop watching */
  stop(): Promise<void>

  /** Pause change detection (during internal writes) */
  pause(): void

  /** Resume change detection */
  resume(): void

  /** Register change handler */
  onchange(handler: ChangeHandler): void

  /** Check if currently paused */
  readonly paused: boolean
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DEBOUNCE_MS = 100

// ============================================================================
// Implementation
// ============================================================================

/**
 * Determine file category from path
 */
function categorizeFile(filePath: string, locationPath: string): FileCategory {
  const relative = path.relative(locationPath, filePath)

  if (relative === 'graph.jsonl') {
    return 'graph'
  }

  if (relative === 'config.json') {
    return 'config'
  }

  if (relative.startsWith('context/') && relative.endsWith('.md')) {
    return 'context'
  }

  if (relative.startsWith('tasks/') && relative.endsWith('.md')) {
    return 'task'
  }

  return 'unknown'
}

/**
 * Create a file watcher for a .opentasks/ location
 */
export function createFileWatcher(config: WatcherConfig): FileWatcher {
  const {
    locationPath,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    watchMarkdown = true,
  } = config

  let watcher: FSWatcher | null = null
  let isPaused = false
  const handlers: ChangeHandler[] = []

  // Debounce map: path -> timeout
  const pendingChanges = new Map<string, {
    timeout: ReturnType<typeof setTimeout>
    type: ChangeType
  }>()

  /**
   * Emit a change event to all handlers
   */
  function emitChange(event: FileChangeEvent): void {
    if (isPaused) return

    for (const handler of handlers) {
      try {
        handler(event)
      } catch {
        // Ignore handler errors
      }
    }
  }

  /**
   * Handle a file change (with debouncing)
   */
  function handleChange(type: ChangeType, filePath: string): void {
    const category = categorizeFile(filePath, locationPath)

    // Ignore unknown files
    if (category === 'unknown') return

    // Skip markdown if not watching
    if (!watchMarkdown && (category === 'context' || category === 'task')) {
      return
    }

    // Cancel existing pending change for this path
    const existing = pendingChanges.get(filePath)
    if (existing) {
      clearTimeout(existing.timeout)
    }

    // Schedule debounced emit
    const timeout = setTimeout(() => {
      pendingChanges.delete(filePath)
      emitChange({ type, path: filePath, category })
    }, debounceMs)

    pendingChanges.set(filePath, { timeout, type })
  }

  return {
    get paused(): boolean {
      return isPaused
    },

    async start(): Promise<void> {
      if (watcher) {
        return
      }

      // Build watch paths
      const watchPaths = [
        path.join(locationPath, 'graph.jsonl'),
        path.join(locationPath, 'config.json'),
      ]

      if (watchMarkdown) {
        watchPaths.push(
          path.join(locationPath, 'context'),
          path.join(locationPath, 'tasks')
        )
      }

      return new Promise((resolve, reject) => {
        watcher = chokidar.watch(watchPaths, {
          ignoreInitial: true,
          persistent: true,
          awaitWriteFinish: {
            stabilityThreshold: 50,
            pollInterval: 10,
          },
        })

        watcher.on('add', (filePath) => handleChange('add', filePath))
        watcher.on('change', (filePath) => handleChange('change', filePath))
        watcher.on('unlink', (filePath) => handleChange('unlink', filePath))

        watcher.on('ready', () => {
          resolve()
        })

        watcher.on('error', (error) => {
          reject(error)
        })
      })
    },

    async stop(): Promise<void> {
      // Clear all pending changes
      for (const { timeout } of pendingChanges.values()) {
        clearTimeout(timeout)
      }
      pendingChanges.clear()

      if (watcher) {
        await watcher.close()
        watcher = null
      }
    },

    pause(): void {
      isPaused = true
    },

    resume(): void {
      isPaused = false
    },

    onchange(handler: ChangeHandler): void {
      handlers.push(handler)
    },
  }
}
