/**
 * Materialization Store Types
 *
 * Type definitions for the pluggable archival layer that captures
 * materialized external node snapshots to durable storage.
 */

// ============================================================================
// Snapshot Types
// ============================================================================

/**
 * Provenance — where a snapshot's data originated
 */
export interface SnapshotProvenance {
  /** Configured graph ID (namespace in archive) */
  graphId: string

  /** Absolute path to .opentasks/ directory at archive time */
  graphPath: string

  /** Git remote URL (if available) */
  gitRemote?: string

  /** Git branch the session operated on */
  gitBranch?: string

  /** Git commit SHA at archive time */
  gitHead?: string
}

/**
 * Edge snapshot — portable URI-based edge representation
 */
export interface EdgeSnapshot {
  fromUri: string
  toUri: string
  edgeType: string
  metadata?: Record<string, unknown>
}

/**
 * Base materialization snapshot.
 * Self-contained — everything needed to reconstruct the node.
 */
export interface MaterializationSnapshot {
  /** Schema version for forward compatibility */
  version: 1

  /** Canonical URI of the archived entity */
  uri: string

  /** Provider source */
  source: string

  /** Entity type within the source */
  entityType: string

  /** When the original entity was created */
  createdAt: string

  /** When this snapshot was captured */
  archivedAt: string

  /** Complete node data for reconstruction */
  node: {
    title: string
    content?: string
    status?: string
    external_status?: string
    external_data: Record<string, unknown>
    tags?: string[]
  }

  /** Provenance — where this data came from */
  provenance: SnapshotProvenance
}

/**
 * Session snapshot — extends base with relationships and checkpoints
 */
export interface SessionSnapshot extends MaterializationSnapshot {
  entityType: 'session'

  /** Related edges at archive time */
  edges: EdgeSnapshot[]

  /** Checkpoint IDs that belong to this session */
  checkpointIds: string[]
}

/**
 * Checkpoint snapshot — extends base with code commit correlation
 */
export interface CheckpointSnapshot extends MaterializationSnapshot {
  entityType: 'checkpoint'

  /** The code commit this checkpoint corresponds to */
  codeCommit?: string

  /** The session this checkpoint belongs to */
  sessionUri: string
}

// ============================================================================
// Archive Policy
// ============================================================================

/**
 * Controls when archival happens
 */
export interface ArchivePolicy {
  /** Archive when a session starts (default: false) */
  archiveOnStart: boolean

  /** Archive on each checkpoint (default: true when eager) */
  archiveOnCheckpoint: boolean

  /** Archive when a session ends (default: true) */
  archiveOnEnd: boolean

  /**
   * Full materialization before archiving.
   * When true, captures all available data from external_data.
   * When false, archives only what's already in the graph node.
   */
  materializeBeforeArchive: boolean
}

export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  archiveOnStart: false,
  archiveOnCheckpoint: true,
  archiveOnEnd: true,
  materializeBeforeArchive: true,
}

// ============================================================================
// Git Archive Store Types
// ============================================================================

/**
 * Configuration for the git archive store
 */
export interface GitArchiveStoreConfig {
  /** Branch name for archive commits (default: 'opentasks/archive') */
  branch: string

  /** Git remote name to push to (default: none — local only) */
  remote?: string

  /**
   * Path to a separate git repo for the archive.
   * If not set, uses the source repo's git dir.
   */
  repoPath?: string

  /** When to push to remote */
  pushPolicy: 'immediate' | 'on-session-end' | 'manual'

  /** Path to the source repo's .opentasks directory */
  sourceRepoPath: string
}

export const DEFAULT_GIT_ARCHIVE_CONFIG: Omit<GitArchiveStoreConfig, 'sourceRepoPath'> = {
  branch: 'opentasks/archive',
  pushPolicy: 'on-session-end',
}

// ============================================================================
// Store Interfaces
// ============================================================================

/**
 * Result of archiving a snapshot
 */
export interface ArchiveResult {
  stored: boolean
  uri: string
  error?: string
}

/**
 * Result of archiving multiple snapshots
 */
export interface BatchArchiveResult {
  results: ArchiveResult[]
  successCount: number
  failureCount: number
}

/**
 * Filter for listing/querying archived snapshots
 */
export interface ArchiveFilter {
  source?: string
  graphId?: string
  entityType?: string
  archivedAfter?: string
  archivedBefore?: string
  uriPattern?: string
}

/**
 * Entry in an archive listing
 */
export interface ArchiveListEntry {
  uri: string
  entityType: string
  graphId: string
  archivedAt: string
  title?: string
  status?: string
}

/**
 * Health status of a store
 */
export interface StoreStatus {
  healthy: boolean
  message?: string
  lastArchiveAt?: string
  lastError?: string
}

/**
 * Base materialization store interface.
 * Both GitArchiveStore and RemoteStore implement this.
 */
export interface MaterializationStore {
  /** Store identifier */
  readonly name: string

  /** Store type */
  readonly type: string

  /** Whether this store is currently enabled */
  readonly enabled: boolean

  /** Archive a single snapshot */
  archive(snapshot: MaterializationSnapshot): Promise<ArchiveResult>

  /** Archive multiple snapshots */
  archiveBatch(snapshots: MaterializationSnapshot[]): Promise<BatchArchiveResult>

  /** Retrieve a snapshot by URI */
  retrieve(uri: string): Promise<MaterializationSnapshot | null>

  /** List available snapshots */
  list(filter?: ArchiveFilter): Promise<ArchiveListEntry[]>

  /** Initialize the store */
  initialize(): Promise<void>

  /** Gracefully shut down */
  close(): Promise<void>

  /** Health check */
  status(): Promise<StoreStatus>
}

// ============================================================================
// Remote Store Interface
// ============================================================================

/**
 * Remote store configuration (from config file)
 */
export interface RemoteStoreConfig {
  type: string
  name: string
  enabled: boolean
  config: Record<string, unknown>
  events: string[]
}

/**
 * Interface that remote (non-git) storage backends must implement.
 * Extends the base MaterializationStore with remote-specific concerns.
 */
export interface RemoteStore extends MaterializationStore {
  /** Which events this store should receive */
  readonly events: string[]
}

// ============================================================================
// Archiver Types
// ============================================================================

/**
 * Result of an archive event (fan-out across all stores)
 */
export interface ArchiveEventResult {
  uri: string
  stores: Array<{
    storeName: string
    stored: boolean
    error?: string
  }>
}

/**
 * Result of bulk rematerialization
 */
export interface RematerializeAllResult {
  restored: number
  failed: number
  skipped: number
  errors: Array<{ uri: string; error: string }>
}

/**
 * The MaterializationArchiver coordinates between event sources
 * (auto-linker) and stores (git, remote).
 */
export interface MaterializationArchiver {
  /** Called by the auto-linker when a session lifecycle event occurs */
  onSessionEvent(
    eventType: string,
    sessionUri: string,
    store: import('../graph/store.js').GraphStore
  ): Promise<ArchiveEventResult>

  /** Manually archive a specific node by URI */
  archiveNode(
    uri: string,
    store: import('../graph/store.js').GraphStore
  ): Promise<ArchiveEventResult>

  /** Rematerialize a node from the archive into the graph */
  rematerialize(
    uri: string,
    store: import('../graph/store.js').GraphStore
  ): Promise<boolean>

  /** Rematerialize all missing nodes */
  rematerializeAll(
    store: import('../graph/store.js').GraphStore
  ): Promise<RematerializeAllResult>

  /** List all archived sessions */
  listArchived(filter?: ArchiveFilter): Promise<ArchiveListEntry[]>

  /** Initialize all stores */
  initialize(): Promise<void>

  /** Shut down all stores */
  close(): Promise<void>
}

/**
 * Configuration for the MaterializationArchiver
 */
export interface MaterializationArchiverConfig {
  /** The git archive store (primary, always present when archival is enabled) */
  gitStore: MaterializationStore

  /** Additional remote stores */
  remoteStores: RemoteStore[]

  /** Archive policy */
  policy: ArchivePolicy

  /** Graph ID for namespacing */
  graphId: string

  /** Path to .opentasks/ directory */
  graphPath: string
}
