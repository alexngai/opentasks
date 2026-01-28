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
} from './types.js'

export { GraphError } from './types.js'

// Validation
export type { ValidationService } from './validation.js'
export { createValidationService } from './validation.js'

// Query
export type { QueryEngine } from './query.js'
export { createQueryEngine } from './query.js'

// Sync
export type { SyncManager, SyncConfig } from './sync.js'
export { createSyncManager, DEFAULT_SYNC_CONFIG } from './sync.js'

// Store
export type { GraphStore, GraphTransaction } from './store.js'
export { createGraphStore } from './store.js'
