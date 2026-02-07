/**
 * Daemon Module Types
 *
 * Shared types for daemon lifecycle, IPC, and coordination.
 */

// ============================================================================
// Lock File Types
// ============================================================================

/**
 * Contents of .opentasks/daemon.lock
 */
export interface DaemonLock {
  /** Process ID of daemon */
  pid: number

  /** Parent process ID (for orphan detection) */
  parentPid: number

  /** OpenTasks version */
  version: string

  /** ISO timestamp when daemon started */
  startedAt: string

  /** Path to Unix socket for IPC */
  socketPath: string

  /** Path to SQLite database */
  databasePath: string
}

/**
 * Metadata provided when acquiring lock (PID and timestamp added automatically)
 */
export type LockMetadata = Omit<DaemonLock, 'pid' | 'parentPid' | 'startedAt'>

// ============================================================================
// Registry Types
// ============================================================================

/**
 * Global registry file format (~/.opentasks/registry.json)
 */
export interface DaemonRegistry {
  /** Registry format version */
  version: string

  /** All registered daemons */
  daemons: DaemonEntry[]
}

/**
 * Entry for a registered daemon
 */
export interface DaemonEntry {
  /** Absolute path to .opentasks/ directory */
  locationPath: string

  /** Socket path for IPC */
  socketPath: string

  /** Process ID */
  pid: number

  /** OpenTasks version */
  version: string

  /** When daemon started (ISO timestamp) */
  startedAt: string

  /** Last activity timestamp (ISO) */
  lastActivity: string
}

// ============================================================================
// Daemon Status Types
// ============================================================================

/**
 * Daemon runtime state
 */
export type DaemonState = 'starting' | 'running' | 'stopping' | 'stopped'

/**
 * Daemon status information
 */
export interface DaemonStatus {
  /** Current state */
  state: DaemonState

  /** When daemon started (ISO timestamp), null if not started */
  startedAt: string | null

  /** Process ID */
  pid: number

  /** Socket path for IPC */
  socketPath: string

  /** Whether there are pending changes to flush */
  pendingFlush: boolean

  /** Number of active IPC connections */
  connectionCount: number

  /** Number of managed locations (multi-location mode) */
  locationCount?: number
}

// ============================================================================
// Location Types (Multi-Location)
// ============================================================================

/**
 * Information about a managed location
 */
export interface LocationInfo {
  /** Location hash */
  hash: string

  /** Absolute path to .opentasks/ directory */
  opentasksPath: string

  /** Whether this is the primary (default) location */
  primary: boolean

  /** Whether the location is healthy */
  healthy: boolean
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for daemon operations
 */
export type DaemonErrorCode =
  | 'LOCK_HELD'
  | 'LOCK_NOT_HELD'
  | 'DAEMON_NOT_RUNNING'
  | 'DAEMON_ALREADY_RUNNING'
  | 'REGISTRY_ERROR'
  | 'IPC_ERROR'
  | 'SHUTDOWN_TIMEOUT'
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_INIT_FAILED'

/**
 * Daemon-specific error
 */
export class DaemonError extends Error {
  constructor(
    public readonly code: DaemonErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}
