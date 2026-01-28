/**
 * OpenTasks Daemon Module
 *
 * Background daemon for coordination, IPC, file watching, and flush management.
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
} from './types.js'

export { DaemonError } from './types.js'

// Lock
export type { LockManager } from './lock.js'
export { createLockManager } from './lock.js'

// Registry
export type { RegistryManager } from './registry.js'
export { createRegistryManager, getGlobalRegistryPath } from './registry.js'

// Lifecycle
export type { Daemon, DaemonConfig, ExistingDaemonResult } from './lifecycle.js'
export { createDaemon, checkExistingDaemon } from './lifecycle.js'

// IPC
export type {
  IPCServer,
  IPCClient,
  IPCRequest,
  IPCResponse,
  IPCError,
  MethodHandler,
} from './ipc.js'
export { createIPCServer, createIPCClient, JSON_RPC_ERRORS } from './ipc.js'

// Methods - Lifecycle
export type { HealthResponse, LifecycleMethodsOptions } from './methods/lifecycle.js'
export { registerLifecycleMethods } from './methods/lifecycle.js'

// Methods - Graph
export type { GraphMethodsOptions } from './methods/graph.js'
export { registerGraphMethods } from './methods/graph.js'

// Watcher
export type {
  FileWatcher,
  WatcherConfig,
  FileChangeEvent,
  ChangeType,
  FileCategory,
  ChangeHandler,
} from './watcher.js'
export { createFileWatcher } from './watcher.js'

// Flush Manager
export type {
  DaemonFlushManager,
  FlushManagerConfig,
  FlushOperation,
} from './flush.js'
export { createDaemonFlushManager, DEFAULT_FLUSH_CONFIG } from './flush.js'
