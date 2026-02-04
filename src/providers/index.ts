/**
 * OpenTasks Providers Module
 *
 * Provider system for connecting OpenTasks with external task/issue systems.
 *
 * @packageDocumentation
 */

// Types
export type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderNodeType,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ParsedUri,
  UriOptions,
  WatchCallback,
  WatchEvent,
  Unsubscribe,
  SearchOptions,
  MaterializationStrategy,
  MaterializationConfig,
  ProviderRegistry,
  ProviderErrorCode,
} from './types.js'

export { ProviderError, DEFAULT_MATERIALIZATION_CONFIG } from './types.js'

// Registry
export { createProviderRegistry } from './registry.js'

// Native Provider
export { createNativeProvider } from './native.js'

// Beads Provider
export { createBeadsProvider, type BeadsConfig } from './beads.js'

// Claude Tasks Provider
export {
  createClaudeTasksProvider,
  createInMemoryTaskStore,
  type ClaudeTasksConfig,
  type ClaudeTask,
  type ClaudeTaskStore,
} from './claude-tasks.js'

// Materialization
export {
  createMaterializationManager,
  type MaterializationManager,
  type MaterializationContext,
} from './materialization.js'

// Traits
export type {
  RelationshipQueryable,
  ProviderEdge,
  EdgeDirection,
  QueryEdgesOptions,
} from './traits/index.js'

export {
  isRelationshipQueryable,
  filterEdgesByType,
  filterEdgesByDirection,
  getNeighborFromEdge,
} from './traits/index.js'

// Config-based Provider Factory
export {
  createProvidersFromConfig,
  type CreateProvidersOptions,
  type CreateProvidersResult,
} from './from-config.js'

// Sync Extensions
export type {
  VersionInfo,
  SyncState,
  SyncStatus,
  ConflictInfo,
  ConflictVersion,
  ConflictResolution,
  ResolutionResult,
  SyncEventType,
  SyncEvent,
  SyncEventCallback,
  SyncableProvider,
  PushResult,
  SyncManager,
  SyncDirection,
  SyncOptions,
  SyncResult,
} from './sync.js'
export {
  isSyncableProvider,
  calculateContentHash,
  compareVersions,
  hasConflict,
  suggestResolution,
} from './sync.js'
