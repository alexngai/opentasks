/**
 * OpenTasks Graph Layer
 *
 * Provides unified CRUD, rich queries, and business logic validation
 * on top of the persistence layer.
 *
 * @packageDocumentation
 */

// Types
export type {
  NodeType,
  CreateNodeInput,
  UpdateNodeInput,
  DeleteOptions,
  CreateEdgeInput,
  PriorityFilter,
  NodeFilter,
  EdgeFilter,
  BlockerOptions,
  ReadyOptions,
  FeedbackOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  CycleResult,
  FlushConfig,
  GraphStoreConfig,
  GraphErrorCode,
} from './types.js';

export { GraphError } from './types.js';

// Validation
export type { ValidationService } from './validation.js';
export { createValidationService } from './validation.js';

// Query
export type { QueryEngine, NodeResolver, QueryEngineOptions } from './query.js';
export { createQueryEngine } from './query.js';

// Debounce (core timing utility)
export type { DebouncedFlusher, DebounceConfig } from './debounce.js';
export { createDebouncedFlusher } from './debounce.js';

// Sync
export type { SyncManager, SyncConfig } from './sync.js';
export { createSyncManager, DEFAULT_SYNC_CONFIG } from './sync.js';

// Store
export type { GraphStore, GraphTransaction } from './store.js';
export { createGraphStore } from './store.js';

// Provider-Aware Store
export type {
  ProviderAwareStore,
  ProviderStoreConfig,
  ResolveOptions,
  ProviderChangeHandler,
  ReconcileOptions,
  ReconcileNodeResult,
  ReconcileResult,
} from './provider-store.js';
export { createProviderAwareStore } from './provider-store.js';

// Edge Type Registry
export type {
  EdgeTypeDefinition,
  EdgeTypeSupport,
  EdgeTypeLookupResult,
} from './EdgeTypeRegistry.js';
export {
  EdgeTypeRegistry,
  BUILTIN_EDGE_TYPES,
  getEdgeTypeRegistry,
  createEdgeTypeRegistry,
  resetEdgeTypeRegistry,
} from './EdgeTypeRegistry.js';

// Graphology Adapter
export type {
  NodeURI,
  GraphNodeAttributes,
  GraphEdgeAttributes,
  GraphologyAdapter,
} from './GraphologyAdapter.js';
export { GraphologyAdapterImpl, createGraphologyAdapter } from './GraphologyAdapter.js';

// Federated Graph
export type {
  TraversalDirection,
  RelatedOptions,
  ReachableOptions,
  ShortestPathOptions,
  NodePredicate,
  EdgeStep,
  TraversalPattern,
  TraversalResult,
  SelectorType,
  ParsedSelector,
  GraphCapabilities,
  FederatedGraph,
} from './FederatedGraph.js';
export { FederatedGraphImpl, createFederatedGraph } from './FederatedGraph.js';

// Hydrating Federated Graph
export type {
  CacheConfig,
  ResolvedNode,
  FederatedReadyOptions,
  HydratingFederatedGraph,
  HydratingFederatedGraphConfig,
} from './HydratingFederatedGraph.js';
export {
  DEFAULT_CACHE_CONFIG,
  HydratingFederatedGraphImpl,
  createHydratingFederatedGraph,
} from './HydratingFederatedGraph.js';

// Coordination (Agent Context and Claims)
export type {
  OperationContext,
  StandardNodeMetadata,
  ExecutionMetadata,
  TrackingMetadata,
  ExternalSyncMetadata,
  ClaimInfo,
  ClaimOptions,
  ClaimResult,
  ClaimManager,
} from './coordination.js';
export { createClaimManager } from './coordination.js';

// History (Audit Trail)
export type {
  OperationType,
  FieldChange,
  OperationLogEntry,
  OperationLogQueryOptions,
  AgentActivitySummary,
  OperationLogger,
} from './history.js';
export {
  createInMemoryOperationLogger,
  createNodeLogEntry,
  createEdgeLogEntry,
  createClaimLogEntry,
} from './history.js';
