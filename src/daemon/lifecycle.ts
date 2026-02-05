/**
 * Daemon Lifecycle Manager
 *
 * Manages the start/stop lifecycle of an OpenTasks daemon.
 * Coordinates lock acquisition, registry, and graceful shutdown.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createLockManager, type LockManager } from './lock.js'
import { createRegistryManager, type RegistryManager } from './registry.js'
import { DaemonError, type DaemonState, type DaemonStatus, type DaemonEntry } from './types.js'
import type { OpenTasksConfig, PartialOpenTasksConfig } from '../config/index.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Daemon configuration
 */
export interface DaemonConfig {
  /** Path to .opentasks/ directory */
  locationPath: string

  /** OpenTasks version */
  version: string

  /** Shutdown timeout in milliseconds (default: 2000) */
  shutdownTimeoutMs?: number

  /** Custom registry path (for testing) */
  registryPath?: string

  /** OpenTasks config override (for custom paths) */
  openTasksConfig?: PartialOpenTasksConfig
}

/**
 * Daemon interface
 */
export interface Daemon {
  /** Start the daemon */
  start(): Promise<void>

  /** Stop the daemon gracefully */
  stop(): Promise<void>

  /** Get daemon status */
  getStatus(): DaemonStatus

  /** Socket path for IPC */
  readonly socketPath: string

  /** Location path */
  readonly locationPath: string
}

/**
 * Result of checking for existing daemon
 */
export interface ExistingDaemonResult {
  /** Whether a daemon is already running */
  running: boolean

  /** Socket path if running */
  socketPath?: string

  /** PID if running */
  pid?: number
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000

// ============================================================================
// Implementation
// ============================================================================

/**
 * Check if a daemon is already running for a location
 */
export async function checkExistingDaemon(
  locationPath: string
): Promise<ExistingDaemonResult> {
  const lockManager = createLockManager(locationPath)
  const isHeld = await lockManager.isHeld()

  if (!isHeld) {
    return { running: false }
  }

  const lock = await lockManager.read()
  if (!lock) {
    return { running: false }
  }

  return {
    running: true,
    socketPath: lock.socketPath,
    pid: lock.pid,
  }
}

/**
 * Create a daemon for a .opentasks/ location
 */
export function createDaemon(config: DaemonConfig): Daemon {
  const {
    locationPath,
    version,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    registryPath,
    openTasksConfig,
  } = config

  // Use config values for paths, falling back to defaults
  const socketFileName = openTasksConfig?.daemon?.socketPath ?? 'daemon.sock'
  const databaseFileName = openTasksConfig?.storage?.sqlitePath ?? 'cache.db'

  const socketPath = path.join(locationPath, socketFileName)
  const databasePath = path.join(locationPath, databaseFileName)

  // State
  let state: DaemonState = 'stopped'
  let startedAt: string | null = null
  let connectionCount = 0

  // Managers
  const lockManager: LockManager = createLockManager(locationPath)
  const registryManager: RegistryManager = createRegistryManager(registryPath)

  // Signal handlers (stored for cleanup)
  let signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = []

  /**
   * Setup signal handlers for graceful shutdown
   */
  function setupSignalHandlers(daemon: Daemon): void {
    const handler = () => {
      void daemon.stop()
    }

    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
    for (const signal of signals) {
      process.on(signal, handler)
      signalHandlers.push({ signal, handler })
    }
  }

  /**
   * Remove signal handlers
   */
  function removeSignalHandlers(): void {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler)
    }
    signalHandlers = []
  }

  /**
   * Remove socket file if it exists
   */
  async function removeSocketFile(): Promise<void> {
    try {
      await fs.unlink(socketPath)
    } catch (error) {
      // Ignore if doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  const daemon: Daemon = {
    socketPath,
    locationPath,

    async start(): Promise<void> {
      if (state !== 'stopped') {
        throw new DaemonError(
          'DAEMON_ALREADY_RUNNING',
          `Daemon is already ${state}`
        )
      }

      state = 'starting'

      try {
        // 1. Check for existing daemon
        const existing = await checkExistingDaemon(locationPath)
        if (existing.running) {
          state = 'stopped'
          throw new DaemonError(
            'DAEMON_ALREADY_RUNNING',
            `Daemon already running (PID ${existing.pid}) at ${existing.socketPath}`
          )
        }

        // 2. Acquire lock
        await lockManager.acquire({
          version,
          socketPath,
          databasePath,
        })

        // 3. Remove stale socket file
        await removeSocketFile()

        // 4. Register in global registry
        startedAt = new Date().toISOString()
        const entry: DaemonEntry = {
          locationPath,
          socketPath,
          pid: process.pid,
          version,
          startedAt,
          lastActivity: startedAt,
        }
        await registryManager.register(entry)

        // 5. Setup signal handlers
        setupSignalHandlers(daemon)

        // Note: IPC server, file watcher, and flush manager
        // will be initialized by subsequent issues

        state = 'running'
      } catch (error) {
        // Cleanup on failure
        state = 'stopped'
        startedAt = null

        // Try to release lock if we acquired it
        try {
          await lockManager.release()
        } catch {
          // Ignore release errors during cleanup
        }

        throw error
      }
    },

    async stop(): Promise<void> {
      if (state === 'stopped' || state === 'stopping') {
        return
      }

      if (state === 'starting') {
        // Wait a bit for start to complete or fail
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (state === 'starting') {
          throw new DaemonError(
            'SHUTDOWN_TIMEOUT',
            'Cannot stop daemon while starting'
          )
        }
      }

      state = 'stopping'

      // Use timeout for graceful shutdown
      const shutdownPromise = (async () => {
        try {
          // 1. Remove signal handlers first
          removeSignalHandlers()

          // Note: IPC server stop will be added here
          // - Stop accepting new connections
          // - Wait for in-flight requests

          // Note: File watcher stop will be added here

          // Note: Final flush will be added here

          // 2. Unregister from global registry
          await registryManager.unregister(locationPath)

          // 3. Remove socket file
          await removeSocketFile()

          // 4. Release lock
          await lockManager.release()

        } finally {
          state = 'stopped'
          startedAt = null
          connectionCount = 0
        }
      })()

      // Apply timeout
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError('SHUTDOWN_TIMEOUT', 'Shutdown timed out'))
        }, shutdownTimeoutMs)
      })

      try {
        await Promise.race([shutdownPromise, timeoutPromise])
      } catch (error) {
        // Force cleanup on timeout
        state = 'stopped'
        startedAt = null
        removeSignalHandlers()
        throw error
      }
    },

    getStatus(): DaemonStatus {
      return {
        state,
        startedAt,
        pid: process.pid,
        socketPath,
        pendingFlush: false, // Will be updated when flush manager is integrated
        connectionCount,
      }
    },
  }

  return daemon
}
