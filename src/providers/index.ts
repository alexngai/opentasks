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
  ProviderOperationContext,
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
  MetadataFieldSchema,
  ProviderMetadataSchema,
} from './types.js';

export { ProviderError, DEFAULT_MATERIALIZATION_CONFIG, createIsAvailable } from './types.js';

// Registry
export { createProviderRegistry } from './registry.js';

// Native Provider
export { createNativeProvider, type NativeProviderConfig } from './native.js';

// Beads Provider
export { createBeadsProvider, type BeadsConfig } from './beads.js';

// Claude Tasks Provider
export {
  createClaudeTasksProvider,
  createInMemoryTaskStore,
  type ClaudeTasksConfig,
  type ClaudeTask,
  type ClaudeTaskStore,
} from './claude-tasks.js';

// MAP Provider
export {
  createMAPProvider,
  type MAPProviderConfig,
  type MAPTaskClient,
  type MAPTask,
  type MAPTaskStatus,
  type MAPTaskEvent,
} from './map.js';

// MAP Client Factory
export {
  createMAPClient,
  type MAPClientOptions,
  type MAPClientResult,
} from './map-client-factory.js';

// Sudocode Provider
export { createSudocodeProvider, type SudocodeConfig } from './sudocode.js';

// Global Provider
export { createGlobalProvider, type GlobalProviderConfig } from './global.js';

// Sessionlog Provider
export {
  createSessionlogProvider,
  createInMemorySessionlogStore,
  createSessionlogCliStore,
  createSessionlogNativeStore,
  type SessionlogConfig,
  type SessionlogSession,
  type SessionlogCheckpoint,
  type SessionlogTokenUsage,
  type SessionlogStore,
} from './sessionlog.js';

// Materialization
export {
  createMaterializationManager,
  type MaterializationManager,
  type MaterializationContext,
  type MaterializeOptions,
} from './materialization.js';

// Traits - RelationshipQueryable
export type {
  RelationshipQueryable,
  ProviderEdge,
  EdgeDirection,
  QueryEdgesOptions,
} from './traits/index.js';

export {
  isRelationshipQueryable,
  filterEdgesByType,
  filterEdgesByDirection,
  getNeighborFromEdge,
} from './traits/index.js';

// Traits - Watchable
export type {
  Watchable,
  WatchGranularity,
  WatchMechanism,
  WatchChangeCallback,
  ProviderChangeEvent,
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from './traits/index.js';

export { isWatchable } from './traits/index.js';

// Traits - TaskManageable
export type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
  ReadyTaskOptions,
} from './traits/index.js';

export { isTaskManageable } from './traits/index.js';

// Traits - Reconcilable
export type {
  Reconcilable,
  ReconcilableNodeSummary,
  ListReconcilableOptions,
} from './traits/index.js';

export { isReconcilable } from './traits/index.js';

// Config-based Provider Factory
export {
  createProvidersFromConfig,
  type CreateProvidersOptions,
  type CreateProvidersResult,
} from './from-config.js';

// MAP Event Bridge
export {
  createMAPEventBridge,
  type MAPEventBridge,
  type MAPEventBridgeConfig,
  type MAPEventSender,
  type MAPConnection,
  type TaskInfo,
} from './map-event-bridge.js';

// MAP Connector (inbound — handles opentasks/*.request notifications)
export {
  createMAPConnector,
  MAP_CONNECTOR_METHODS,
  type MAPConnector,
  type MAPConnectorConfig,
  type MAPNotificationSender,
} from './map-connector.js';

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
} from './sync.js';
export {
  isSyncableProvider,
  calculateContentHash,
  compareVersions,
  hasConflict,
  suggestResolution,
} from './sync.js';
