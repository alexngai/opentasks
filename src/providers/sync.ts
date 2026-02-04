/**
 * Provider Synchronization Extensions
 *
 * Extends the provider interface with bidirectional sync, conflict resolution,
 * and change tracking capabilities.
 */

import type { Provider, ProviderNode, WatchEvent } from './types.js'

// ============================================================================
// Sync State Types
// ============================================================================

/**
 * Version information for conflict detection
 */
export interface VersionInfo {
  /** Local version/revision */
  localVersion: string

  /** Remote version/revision (from provider) */
  remoteVersion: string

  /** Hash of local content */
  localHash?: string

  /** Hash of remote content */
  remoteHash?: string

  /** When local was last modified */
  localModifiedAt: string

  /** When remote was last modified */
  remoteModifiedAt?: string
}

/**
 * Sync state for a node
 */
export interface SyncState {
  /** Node ID in OpenTasks */
  nodeId: string

  /** URI of external node */
  externalUri: string

  /** Provider name */
  providerName: string

  /** Last successful sync timestamp */
  lastSyncAt: string

  /** Version info for conflict detection */
  version: VersionInfo

  /** Current sync status */
  status: SyncStatus

  /** Error if sync failed */
  error?: string

  /** Number of consecutive failures */
  failureCount: number
}

/**
 * Status of a sync operation
 */
export type SyncStatus =
  | 'synced'        // Up to date
  | 'pending'       // Changes to push
  | 'stale'         // Remote may have changed
  | 'conflict'      // Conflicting changes detected
  | 'error'         // Sync failed
  | 'disconnected'  // Provider unavailable

// ============================================================================
// Conflict Types
// ============================================================================

/**
 * Information about a sync conflict
 */
export interface ConflictInfo {
  /** Node ID */
  nodeId: string

  /** External URI */
  externalUri: string

  /** Local version of the data */
  local: ConflictVersion

  /** Remote version of the data */
  remote: ConflictVersion

  /** When conflict was detected */
  detectedAt: string

  /** Suggested resolution strategy */
  suggestedResolution: ConflictResolution
}

/**
 * A version in a conflict
 */
export interface ConflictVersion {
  /** Title */
  title: string

  /** Content */
  content?: string

  /** Status */
  status?: string

  /** When modified */
  modifiedAt: string

  /** Who modified */
  modifiedBy?: string

  /** Version/revision */
  version: string

  /** Full node data */
  data: ProviderNode | Record<string, unknown>
}

/**
 * Resolution strategy for conflicts
 */
export type ConflictResolution =
  | 'local-wins'    // Keep local changes
  | 'remote-wins'   // Keep remote changes
  | 'merge'         // Attempt automatic merge
  | 'manual'        // Require manual resolution

/**
 * Result of a conflict resolution
 */
export interface ResolutionResult {
  /** Whether resolution succeeded */
  success: boolean

  /** Resolution applied */
  resolution: ConflictResolution

  /** Merged data (if merge resolution) */
  mergedData?: ProviderNode

  /** Error if resolution failed */
  error?: string
}

// ============================================================================
// Sync Event Types
// ============================================================================

/**
 * Events emitted during sync operations
 */
export type SyncEventType =
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  | 'sync.conflict'
  | 'sync.push'
  | 'sync.pull'
  | 'sync.skip'

/**
 * Sync event payload
 */
export interface SyncEvent {
  type: SyncEventType
  nodeId: string
  externalUri: string
  timestamp: string
  details?: Record<string, unknown>
  error?: string
}

/**
 * Callback for sync events
 */
export type SyncEventCallback = (event: SyncEvent) => void

// ============================================================================
// Syncable Provider Interface
// ============================================================================

/**
 * Extended provider interface with sync capabilities
 */
export interface SyncableProvider extends Provider {
  /**
   * Get the current version/revision of a node
   */
  getVersion(id: string): Promise<string | null>

  /**
   * Get the last modified timestamp for a node
   */
  getLastModified(id: string): Promise<string | null>

  /**
   * Push local changes to the provider
   *
   * @param id - Node ID in provider
   * @param data - Data to push
   * @param expectedVersion - Expected remote version (for optimistic locking)
   * @returns Updated node or conflict info
   */
  push(
    id: string,
    data: Partial<ProviderNode>,
    expectedVersion?: string
  ): Promise<PushResult>

  /**
   * Pull latest data from provider
   *
   * @param id - Node ID in provider
   * @param ifModifiedSince - Only pull if modified after this time
   * @returns Node data or null if not modified
   */
  pull(id: string, ifModifiedSince?: string): Promise<ProviderNode | null>

  /**
   * Subscribe to real-time changes (enhanced watch)
   *
   * @param ids - Node IDs to watch (empty = watch all)
   * @param callback - Callback for changes
   * @returns Unsubscribe function
   */
  subscribe(ids: string[], callback: (event: WatchEvent) => void): () => void
}

/**
 * Result of a push operation
 */
export interface PushResult {
  /** Whether push succeeded */
  success: boolean

  /** Updated node if successful */
  node?: ProviderNode

  /** New version after push */
  newVersion?: string

  /** Conflict info if push failed due to conflict */
  conflict?: ConflictInfo

  /** Error message if failed */
  error?: string
}

// ============================================================================
// Sync Manager Interface
// ============================================================================

/**
 * Manages synchronization between OpenTasks and providers
 */
export interface SyncManager {
  /**
   * Register a node for synchronization
   *
   * @param nodeId - Local node ID
   * @param externalUri - External URI to sync with
   * @param options - Sync options
   */
  register(nodeId: string, externalUri: string, options?: SyncOptions): Promise<void>

  /**
   * Unregister a node from synchronization
   */
  unregister(nodeId: string): Promise<void>

  /**
   * Get sync state for a node
   */
  getState(nodeId: string): Promise<SyncState | null>

  /**
   * Get all sync states
   */
  getAllStates(): Promise<SyncState[]>

  /**
   * Sync a specific node
   *
   * @param nodeId - Node to sync
   * @param direction - Sync direction
   * @returns Sync result
   */
  sync(nodeId: string, direction?: SyncDirection): Promise<SyncResult>

  /**
   * Sync all registered nodes
   *
   * @param direction - Sync direction
   * @returns Results for each node
   */
  syncAll(direction?: SyncDirection): Promise<Map<string, SyncResult>>

  /**
   * Get pending conflicts
   */
  getConflicts(): Promise<ConflictInfo[]>

  /**
   * Resolve a conflict
   *
   * @param nodeId - Node with conflict
   * @param resolution - How to resolve
   * @returns Resolution result
   */
  resolveConflict(nodeId: string, resolution: ConflictResolution): Promise<ResolutionResult>

  /**
   * Mark a node as having local changes
   */
  markDirty(nodeId: string): void

  /**
   * Start background sync
   *
   * @param intervalMs - Sync interval in milliseconds
   */
  startBackgroundSync(intervalMs: number): void

  /**
   * Stop background sync
   */
  stopBackgroundSync(): void

  /**
   * Subscribe to sync events
   */
  onEvent(callback: SyncEventCallback): () => void
}

/**
 * Direction for sync operation
 */
export type SyncDirection = 'push' | 'pull' | 'both'

/**
 * Options for registering a sync
 */
export interface SyncOptions {
  /** Sync direction preference */
  direction?: SyncDirection

  /** Conflict resolution strategy */
  conflictResolution?: ConflictResolution

  /** Auto-sync on changes */
  autoSync?: boolean

  /** Sync interval for this node (overrides global) */
  syncIntervalMs?: number
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** Whether sync succeeded */
  success: boolean

  /** Direction that was synced */
  direction: SyncDirection

  /** Changes pushed (if any) */
  pushed?: boolean

  /** Changes pulled (if any) */
  pulled?: boolean

  /** Updated sync state */
  state: SyncState

  /** Error if sync failed */
  error?: string
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a provider supports sync operations
 */
export function isSyncableProvider(provider: Provider): provider is SyncableProvider {
  return (
    'getVersion' in provider &&
    'getLastModified' in provider &&
    'push' in provider &&
    'pull' in provider &&
    'subscribe' in provider
  )
}

// ============================================================================
// Sync Utilities
// ============================================================================

/**
 * Calculate content hash for change detection
 */
export function calculateContentHash(content: string): string {
  // Simple hash for change detection (not cryptographic)
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(16)
}

/**
 * Compare versions (returns -1, 0, or 1)
 */
export function compareVersions(local: string, remote: string): number {
  // Handle numeric versions
  const localNum = parseInt(local, 10)
  const remoteNum = parseInt(remote, 10)

  if (!isNaN(localNum) && !isNaN(remoteNum)) {
    return localNum < remoteNum ? -1 : localNum > remoteNum ? 1 : 0
  }

  // Handle ISO timestamp versions
  if (local.includes('T') && remote.includes('T')) {
    return local < remote ? -1 : local > remote ? 1 : 0
  }

  // String comparison fallback
  return local.localeCompare(remote)
}

/**
 * Determine if there's a conflict
 */
export function hasConflict(state: SyncState): boolean {
  if (state.status === 'conflict') return true

  const { localVersion, remoteVersion, localHash, remoteHash } = state.version

  // If versions differ and both have been modified, it's a conflict
  if (localVersion !== remoteVersion) {
    // If we have hashes and they differ, confirm conflict
    if (localHash && remoteHash && localHash !== remoteHash) {
      return true
    }
    // If remote is newer and we have local changes, it's a conflict
    if (state.status === 'pending' && compareVersions(localVersion, remoteVersion) < 0) {
      return true
    }
  }

  return false
}

/**
 * Suggest a resolution strategy based on conflict details
 */
export function suggestResolution(conflict: ConflictInfo): ConflictResolution {
  const { local, remote } = conflict

  // If only one side has meaningful changes, prefer that side
  const localChanged = local.content !== remote.content || local.title !== remote.title
  const remoteChanged = remote.content !== local.content || remote.title !== local.title

  if (localChanged && !remoteChanged) return 'local-wins'
  if (remoteChanged && !localChanged) return 'remote-wins'

  // If both changed, check timestamps
  if (local.modifiedAt > remote.modifiedAt) return 'local-wins'
  if (remote.modifiedAt > local.modifiedAt) return 'remote-wins'

  // Default to manual resolution
  return 'manual'
}
