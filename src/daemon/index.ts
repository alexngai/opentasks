/**
 * OpenTasks Daemon Module
 *
 * Background daemon for coordination, IPC, file watching, and flush management.
 * Supports both single-location and multi-location (worktree) modes.
 *
 * @packageDocumentation
 */

// Types
export type {
  DaemonLock,
  LockMetadata,
  DaemonRegistry,
  DaemonEntry,
  DaemonState,
  DaemonStatus,
  DaemonErrorCode,
  LocationInfo,
} from './types.js';

export { DaemonError } from './types.js';

// Lock
export type { LockManager } from './lock.js';
export { createLockManager } from './lock.js';

// Registry
export type { RegistryManager } from './registry.js';
export { createRegistryManager, getGlobalRegistryPath } from './registry.js';

// Lifecycle
export type {
  Daemon,
  DaemonConfig,
  SingleLocationDaemonConfig,
  MultiLocationDaemonConfig,
  ExistingDaemonResult,
} from './lifecycle.js';
export { createDaemon, checkExistingDaemon } from './lifecycle.js';

// Factory
export type { DaemonWithStoreConfig, MultiLocationDaemonFromGitConfig } from './factory.js';
export { createDaemonWithStore, createMultiLocationDaemonFromGit } from './factory.js';

// Location State
export type { LocationState, LocationResolver } from './location-state.js';
export {
  createStoreForLocation,
  createLocationState,
  destroyLocationState,
  createSingleLocationResolver,
  createMultiLocationResolver,
} from './location-state.js';

// IPC
export type {
  IPCServer,
  IPCClient,
  IPCRequest,
  IPCResponse,
  IPCError,
  MethodHandler,
} from './ipc.js';
export { createIPCServer, createIPCClient, JSON_RPC_ERRORS } from './ipc.js';

// Methods - Lifecycle
export type {
  HealthResponse,
  HealthChecker,
  LifecycleMethodsOptions,
} from './methods/lifecycle.js';
export { registerLifecycleMethods } from './methods/lifecycle.js';

// Methods - Graph
export type { GraphMethodsOptions } from './methods/graph.js';
export { registerGraphMethods } from './methods/graph.js';

// Methods - Tools (3-tool agent interface)
export type { ToolsMethodsOptions } from './methods/tools.js';
export { registerToolsMethods } from './methods/tools.js';

// Methods - Watch (graph change subscription)
export type { WatchMethodsOptions } from './methods/watch.js';
export { registerWatchMethods } from './methods/watch.js';

// Methods - Location (multi-location management)
export type { LocationMethodsOptions } from './methods/location.js';
export { registerLocationMethods } from './methods/location.js';

// Methods - Context Files
export type { ContextFilesMethodsOptions } from './methods/context-files.js';
export { registerContextFilesMethods } from './methods/context-files.js';

// Watcher
export type {
  FileWatcher,
  WatcherConfig,
  FileChangeEvent,
  ChangeType,
  FileCategory,
  ChangeHandler,
} from './watcher.js';
export { createFileWatcher } from './watcher.js';

// Flush Manager
export type { DaemonFlushManager, FlushManagerConfig, FlushOperation } from './flush.js';
export { createDaemonFlushManager, DEFAULT_FLUSH_CONFIG } from './flush.js';

// Sessionlog Integration
export type {
  SessionlogWatcher,
  SessionlogWatcherConfig,
  SessionlogSessionState,
  SessionlogSessionEvent,
  SessionEventHandler,
} from './sessionlog-watcher.js';
export { createSessionlogWatcher } from './sessionlog-watcher.js';

export type {
  SessionlogAutoLinker,
  SessionlogAutoLinkerConfig,
  CorrelationResult,
  MatchedTask,
  CorrelationStrategy,
  CorrelationConfidence,
} from './sessionlog-linker.js';
export { createSessionlogAutoLinker } from './sessionlog-linker.js';
