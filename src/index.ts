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
} from './config/index.js';

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
} from './config/index.js';

// =============================================================================
// Core
// =============================================================================

export { generateId, type IdNodeType } from './core/id.js';
export { sha256, computeContentHash } from './core/hash.js';

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
} from './schema/index.js';

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
} from './schema/index.js';

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
} from './storage/index.js';

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
} from './storage/index.js';

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
} from './graph/index.js';

export { createGraphStore } from './graph/index.js';

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
  DaemonWithStoreConfig,
  MultiLocationDaemonFromGitConfig,
} from './daemon/index.js';

export {
  createDaemon,
  checkExistingDaemon,
  createIPCServer,
  createIPCClient,
  createFileWatcher,
  createDaemonFlushManager,
  createStoreForLocation,
  registerLifecycleMethods,
  registerGraphMethods,
  registerToolsMethods,
  registerWatchMethods,
  registerSyncMethods,
  DaemonError,
  createDaemonWithStore,
  createMultiLocationDaemonFromGit,
} from './daemon/index.js';

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
  ContextSummaryParams,
  ContextSummaryResult,
  Breadcrumb,
  ToolErrorCode,
} from './tools/index.js';

export { link, query, annotate, ToolError } from './tools/index.js';

// =============================================================================
// Client
// =============================================================================

export type { ClientOptions } from './client/index.js';

export { OpenTasksClient, ClientError, createClient } from './client/index.js';

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
} from './providers/index.js';

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
} from './providers/index.js';

// MAP Integration
export {
  createMAPEventBridge,
  type MAPEventBridge,
  type MAPEventBridgeConfig,
  type MAPEventSender,
  type MAPConnection,
  type TaskInfo as MAPTaskInfo,
} from './providers/map-event-bridge.js';

// MAP Connector (inbound — handles opentasks/*.request from remote agents)
export {
  createMAPConnector,
  MAP_CONNECTOR_METHODS,
  type MAPConnector,
  type MAPConnectorConfig,
  type MAPNotificationSender,
} from './providers/map-connector.js';

// Provider-Aware Store
export type { ProviderAwareStore, ProviderStoreConfig, ResolveOptions } from './graph/index.js';

export { createProviderAwareStore } from './graph/index.js';

// =============================================================================
// Tracking (Skill Usage)
// =============================================================================

export type {
  SkillName,
  SkillInvocation,
  SkillUsageStats,
  SkillUsageSummary,
  SkillTrackerOptions,
  SkillTracker,
  SkillTrackerRegistry,
} from './tracking/index.js';

export { createSkillTracker, createSkillTrackerRegistry } from './tracking/index.js';

// =============================================================================
// Sessionlog (Native TypeScript Implementation)
// =============================================================================

// Re-export sessionlog module as a namespace for clean boundary
export * as sessionlog from './sessionlog/index.js';

// =============================================================================
// MCP Server
// =============================================================================

export { createMCPServer, startMCPServer, ALL_SCOPES, type MCPServerOptions, type MCPScope } from './mcp/index.js';
