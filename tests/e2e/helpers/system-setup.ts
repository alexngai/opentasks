/**
 * E2E Test System Setup
 *
 * Helpers for setting up and tearing down a full OpenTasks system for E2E tests.
 * This includes IPC server, storage, graph store, and method handlers.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

// Storage
import { createSQLitePersister } from '../../../src/storage/sqlite.js'
import { createJSONLPersister } from '../../../src/storage/jsonl.js'
import type { Storage } from '../../../src/storage/interface.js'

// Graph
import { createGraphStore, type GraphStore } from '../../../src/graph/store.js'

// Daemon
import {
  createIPCServer,
  createDaemonFlushManager,
  registerToolsMethods,
  type IPCServer,
  type DaemonFlushManager,
} from '../../../src/daemon/index.js'

// Client
import { OpenTasksClient, createClient } from '../../../src/client/index.js'

// Providers
import { createProviderRegistry, type ProviderRegistry } from '../../../src/providers/registry.js'
import { createNativeProvider } from '../../../src/providers/native.js'
import { createBeadsProvider, type BeadsConfig } from '../../../src/providers/beads.js'
import type { Provider } from '../../../src/providers/types.js'
import { createMaterializationManager, type MaterializationManager } from '../../../src/providers/materialization.js'

// Federated Graph
import { createGraphologyAdapter, type GraphologyAdapter } from '../../../src/graph/GraphologyAdapter.js'
import {
  createHydratingFederatedGraph,
  type HydratingFederatedGraph,
  type CacheConfig,
} from '../../../src/graph/HydratingFederatedGraph.js'

// Beads helpers
import { isBdAvailable, createBeadsWorkspace, getBdExecutable, type BeadsWorkspaceContext } from './beads-helpers.js'

// Re-export test flags from integration helpers
export { AGENT_TESTS, AGENT_SKIP_MESSAGE, SLOW_TESTS } from '../../integration/helpers/flags.js'

/**
 * Storage type for E2E tests
 */
export type StorageType = 'sqlite' | 'jsonl'

/**
 * Options for E2E system setup
 */
export interface E2ESystemOptions {
  /** Storage backend type (default: sqlite) */
  storageType?: StorageType

  /** Whether to create the .opentasks directory structure (default: true) */
  createStructure?: boolean

  /** Custom test name for temp directory naming */
  testName?: string

  /** Flush manager debounce in ms (default: 100 for fast tests) */
  flushDebounceMs?: number

  /** Enable BeadsProvider integration (requires bd CLI) */
  enableBeads?: boolean

  /** Cache TTL in milliseconds for HydratingGraph (default: 1000 for fast tests) */
  cacheTTL?: number

  /**
   * Reuse an existing Beads workspace instead of creating a new one.
   * When provided, the workspace will NOT be cleaned up on stop().
   * Use this with beforeAll/afterAll to share workspace across tests.
   */
  beadsWorkspacePath?: string
}

/**
 * E2E test system context
 *
 * Provides access to all components of a running OpenTasks system.
 */
export interface E2ESystemContext {
  /** Root temp directory for this test */
  rootDir: string

  /** Path to .opentasks directory */
  openTasksDir: string

  /** Path to daemon socket */
  socketPath: string

  /** Path to SQLite storage file */
  storagePath: string

  /** Path to JSONL file */
  jsonlPath: string

  /** IPC server */
  server: IPCServer

  /** Graph store */
  store: GraphStore

  /** Connected client for making requests */
  client: OpenTasksClient

  /** Storage type used */
  storageType: StorageType

  /** Provider registry for resolving URIs */
  providerRegistry: ProviderRegistry

  /** Native provider for creating specs/issues */
  nativeProvider: Provider

  /** Beads workspace directory (if bd available and enabled) */
  beadsWorkspace?: string

  /** BeadsProvider instance (if bd available and enabled) */
  beadsProvider?: Provider

  /** Graphology adapter for in-memory graph */
  graphologyAdapter: GraphologyAdapter

  /** Hydrating federated graph for cross-provider operations */
  hydratingGraph: HydratingFederatedGraph

  /** Materialization manager for external node caching */
  materializationManager: MaterializationManager

  /** Whether Beads integration is available */
  beadsAvailable: boolean

  /**
   * Create an additional client (for multi-agent tests)
   */
  createClient(name?: string): Promise<OpenTasksClient>

  /**
   * Flush pending changes to disk
   */
  flush(): Promise<void>

  /**
   * Stop the system and clean up
   */
  stop(): Promise<void>
}

/**
 * Set up a complete E2E test system
 *
 * Creates an isolated environment with:
 * - Temp directory structure
 * - SQLite storage with JSONL sync
 * - IPC server with registered tool handlers
 * - Connected client
 *
 * @example
 * ```typescript
 * const system = await setupE2ESystem({ testName: 'workflow-test' })
 * try {
 *   const result = await system.client.query({ ready: {} })
 *   // ... test assertions
 * } finally {
 *   await system.stop()
 * }
 * ```
 */
export async function setupE2ESystem(options: E2ESystemOptions = {}): Promise<E2ESystemContext> {
  const {
    storageType = 'sqlite',
    createStructure = true,
    testName = 'e2e',
    flushDebounceMs = 100, // Fast debounce for tests
    enableBeads = false,
    cacheTTL = 1000, // Short TTL for fast tests
    beadsWorkspacePath,
  } = options

  // Create temp directory
  const rootDir = await mkdtemp(join(tmpdir(), `opentasks-${testName}-`))

  // Create .opentasks directory structure
  const openTasksDir = join(rootDir, '.opentasks')
  if (createStructure) {
    await mkdir(openTasksDir, { recursive: true })
  }

  // Set up paths
  const socketPath = join(openTasksDir, 'daemon.sock')
  const storagePath = join(openTasksDir, 'cache.db') // createSQLitePersister appends /cache.db to base path
  const jsonlPath = join(openTasksDir, 'opentasks.jsonl')

  // Create SQLite storage (pass base directory, not file path)
  const sqlite = createSQLitePersister(openTasksDir)
  await sqlite.initialize()

  // Create JSONL persister for sync
  const jsonl = createJSONLPersister(jsonlPath)

  // JSONL load/save functions
  const jsonlLoad = async () => {
    try {
      if (!existsSync(jsonlPath)) {
        return { nodes: [], edges: [] }
      }
      return await jsonl.load()
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  const jsonlSave = async (nodes: any[], edges: any[]) => {
    await jsonl.save(nodes, edges)
  }

  // Create graph store
  const store = createGraphStore(
    { flush: { debounceMs: flushDebounceMs, maxDelayMs: flushDebounceMs * 2 } },
    sqlite as Storage,
    jsonlLoad,
    jsonlSave
  )
  await store.initialize()

  // Create provider registry and native provider
  const providerRegistry = createProviderRegistry()
  const nativeProvider = createNativeProvider(store)
  providerRegistry.register(nativeProvider)

  // Check if Beads is available and set up if requested
  let beadsAvailable = false
  let beadsWorkspaceContext: BeadsWorkspaceContext | undefined
  let beadsProvider: Provider | undefined
  let ownsBeadsWorkspace = false // Track if we created the workspace (for cleanup)

  if (enableBeads) {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      let beadsDir: string

      if (beadsWorkspacePath) {
        // Reuse existing workspace (don't clean up on stop)
        beadsDir = beadsWorkspacePath
        ownsBeadsWorkspace = false
      } else {
        // Create new Beads workspace in temp directory
        beadsDir = join(rootDir, 'beads-workspace')
        beadsWorkspaceContext = await createBeadsWorkspace(beadsDir, 'bd')
        ownsBeadsWorkspace = true
      }

      // Create and register BeadsProvider
      const beadsConfig: BeadsConfig = {
        executable: getBdExecutable(),
        cwd: beadsDir,
        timeout: 30000,
        watchPath: join(beadsDir, '.beads'),
        watchDebounceMs: 100, // Faster debounce for tests
      }
      beadsProvider = createBeadsProvider(beadsConfig)
      providerRegistry.register(beadsProvider)

      // If reusing workspace, create a minimal context for the path
      if (!beadsWorkspaceContext) {
        beadsWorkspaceContext = {
          path: beadsDir,
          prefix: 'bd',
          async cleanup() {
            // No-op for reused workspace
          },
        }
      }
    }
  }

  // Create Graphology adapter and load from storage
  const graphologyAdapter = createGraphologyAdapter()
  await graphologyAdapter.loadFromStorage(sqlite as Storage)

  // Create materialization manager
  const materializationManager = createMaterializationManager({
    default: 'lazy',
    staleAfter: cacheTTL,
  })

  // Create hydrating federated graph
  const hydratingGraph = createHydratingFederatedGraph(graphologyAdapter, {
    storage: sqlite as Storage,
    providerRegistry,
    cacheConfig: {
      defaultTTL: cacheTTL,
      staleWhileRevalidate: true,
      providerTTL: {},
    },
  })

  // Create flush manager (for tool handlers)
  const flushManager = createDaemonFlushManager(
    { debounceMs: flushDebounceMs, maxDelayMs: flushDebounceMs * 2 },
    async (nodeIds: string[]) => {
      await store.flush()
    }
  )

  // Create IPC server
  const server = createIPCServer(socketPath)

  // Register tool handlers
  registerToolsMethods({
    server,
    store,
    flushManager,
  })

  // Start IPC server
  await server.start()

  // Create and connect client
  const client = createClient({ socketPath })
  await client.connect()

  // Track additional clients for cleanup
  const additionalClients: OpenTasksClient[] = []

  // Build context
  const context: E2ESystemContext = {
    rootDir,
    openTasksDir,
    socketPath,
    storagePath,
    jsonlPath,
    server,
    store,
    client,
    storageType,
    providerRegistry,
    nativeProvider,
    beadsWorkspace: beadsWorkspaceContext?.path,
    beadsProvider,
    graphologyAdapter,
    hydratingGraph,
    materializationManager,
    beadsAvailable,

    async createClient(name?: string): Promise<OpenTasksClient> {
      const additionalClient = createClient({ socketPath })
      await additionalClient.connect()
      additionalClients.push(additionalClient)
      return additionalClient
    },

    async flush(): Promise<void> {
      await flushManager.flush()
    },

    async stop(): Promise<void> {
      // Stop background sync if running
      if (materializationManager.isBackgroundSyncRunning()) {
        materializationManager.stopBackgroundSync()
      }

      // Disconnect all clients
      for (const c of additionalClients) {
        c.disconnect()
      }
      client.disconnect()

      // Stop IPC server
      await server.stop()

      // Close graph store (flushes pending changes)
      await store.close()

      // Close SQLite
      sqlite.close()

      // Clean up Beads workspace only if we created it
      if (beadsWorkspaceContext && ownsBeadsWorkspace) {
        await beadsWorkspaceContext.cleanup()
      }

      // Clean up temp directory
      if (existsSync(rootDir)) {
        await rm(rootDir, { recursive: true, force: true })
      }
    },
  }

  return context
}

/**
 * Run a test function with a full E2E system
 *
 * Handles setup and teardown automatically.
 *
 * @example
 * ```typescript
 * await withE2ESystem({ testName: 'my-test' }, async (system) => {
 *   const ready = await system.client.ready()
 *   expect(ready).toHaveLength(0)
 * })
 * ```
 */
export async function withE2ESystem<T>(
  options: E2ESystemOptions,
  fn: (system: E2ESystemContext) => Promise<T>
): Promise<T> {
  const system = await setupE2ESystem(options)
  try {
    return await fn(system)
  } finally {
    await system.stop()
  }
}

/**
 * Multi-system context for testing inter-system communication
 */
export interface MultiE2ESystemContext {
  /** All systems in the context */
  systems: E2ESystemContext[]

  /** Stop all systems and clean up */
  stopAll(): Promise<void>
}

/**
 * Set up multiple isolated E2E systems
 *
 * Useful for testing scenarios where multiple OpenTasks instances
 * need to communicate or sync.
 */
export async function setupMultiE2ESystems(
  count: number,
  options: E2ESystemOptions = {}
): Promise<MultiE2ESystemContext> {
  const systems: E2ESystemContext[] = []

  for (let i = 0; i < count; i++) {
    const system = await setupE2ESystem({
      ...options,
      testName: `${options.testName ?? 'multi'}-${i}`,
    })
    systems.push(system)
  }

  return {
    systems,
    async stopAll(): Promise<void> {
      await Promise.all(systems.map(s => s.stop()))
    },
  }
}
