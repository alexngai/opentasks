/**
 * OpenTasks
 *
 * A graph-based task management system with agent-first design.
 *
 * @packageDocumentation
 */

// =============================================================================
// Config
// =============================================================================

export {
  loadConfig,
  getDefaults,
  parseEnvConfig,
  mergeConfigs,
  validateConfig,
  parseConfig,
  ConfigParseError,
  ConfigValidationError,
  DEFAULT_CONFIG,
} from './config/index.js'

export type {
  OpenTasksConfig,
  PartialOpenTasksConfig,
  StorageConfig,
  DaemonConfig as DaemonConfigOptions,
  ProvidersConfig,
  BeadsProviderConfig,
  ClaudeTasksProviderConfig,
  LoggingConfig,
  LoggingLevel,
  ValidationResult as ConfigValidationResult,
} from './config/index.js'

// =============================================================================
// Core
// =============================================================================

export { generateId, type IdNodeType } from './core/id.js'
export { sha256, computeContentHash } from './core/hash.js'

// =============================================================================
// Schema
// =============================================================================

export type {
  Node,
  NodeType,
  Context,
  Task,
  Feedback,
  ExternalNode,
  Edge,
  EdgeType,
  CoreEdgeType,
  ExtendedEdgeType,
  Anchor,
  BaseNode,
  StoredNode,
  StoredEdge,
  PersistedGraph,
  GraphMetadata,
  GraphChanges,
  ValidationResult,
} from './schema/index.js'

export {
  ValidationError,
  isContext,
  isTask,
  isFeedback,
  isExternal,
  validateStoredNode,
  parseNode,
  tryParseNode,
  hasKnownType,
} from './schema/index.js'

// =============================================================================
// Storage
// =============================================================================

export type {
  Storage,
  Transaction,
  NodeFilter as StorageNodeFilter,
  ResolvedNodeFilter,
  JSONLPersisterConfig,
  LoadResult,
  SQLitePersisterConfig,
} from './storage/index.js'

export {
  JSONLPersister,
  createJSONLPersister,
  SQLitePersister,
  createSQLitePersister,
  resolveNodeFilter,
  atomicWrite,
  appendToFile,
  fileExists,
  readFileOrEmpty,
} from './storage/index.js'

// =============================================================================
// Graph
// =============================================================================

export type {
  GraphStore,
  CreateNodeInput,
  UpdateNodeInput,
  CreateEdgeInput,
  DeleteOptions,
  NodeFilter,
  EdgeFilter,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
} from './graph/index.js'

export { createGraphStore } from './graph/index.js'

// =============================================================================
// Daemon
// =============================================================================

export type {
  Daemon,
  DaemonConfig,
  DaemonState,
  DaemonStatus,
  IPCServer,
  IPCClient,
  FileWatcher,
  WatcherConfig,
  DaemonFlushManager,
  FlushManagerConfig,
} from './daemon/index.js'

export {
  createDaemon,
  checkExistingDaemon,
  createIPCServer,
  createIPCClient,
  createFileWatcher,
  createDaemonFlushManager,
  registerLifecycleMethods,
  registerGraphMethods,
  registerToolsMethods,
  DaemonError,
} from './daemon/index.js'

// =============================================================================
// Tools (3-Tool Agent Interface)
// =============================================================================

export type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  NodeSummary,
  EdgeSummary,
  FeedbackSummary,
  BlockerQueryParams,
  FeedbackQueryParams,
  CreateFeedbackParams,
  FeedbackAnchor,
  FeedbackType,
  ToolErrorCode,
} from './tools/index.js'

export { link, query, annotate, ToolError } from './tools/index.js'

// =============================================================================
// Client
// =============================================================================

export type { ClientOptions } from './client/index.js'

export { OpenTasksClient, ClientError, createClient } from './client/index.js'

// =============================================================================
// Providers
// =============================================================================

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
  MaterializationManager,
  MaterializationContext,
  BeadsConfig,
  NativeProviderConfig,
  ClaudeTasksConfig,
  ClaudeTask,
  ClaudeTaskStore,
  // Watchable trait
  Watchable,
  WatchGranularity,
  WatchMechanism,
  WatchChangeCallback,
  ProviderChangeEvent,
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from './providers/index.js'

export {
  ProviderError,
  DEFAULT_MATERIALIZATION_CONFIG,
  createProviderRegistry,
  createNativeProvider,
  createBeadsProvider,
  createClaudeTasksProvider,
  createInMemoryTaskStore,
  createMaterializationManager,
  isWatchable,
} from './providers/index.js'

// Provider-Aware Store
export type {
  ProviderAwareStore,
  ProviderStoreConfig,
  ResolveOptions,
} from './graph/index.js'

export { createProviderAwareStore } from './graph/index.js'
