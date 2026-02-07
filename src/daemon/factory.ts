/**
 * Daemon Factory
 *
 * Convenience factory that creates a fully initialized daemon
 * with SQLite + JSONL storage and a GraphStore.
 */

import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { createDaemon, type Daemon, type DaemonConfig } from './lifecycle.js'
import { createGraphStore, type GraphStore } from '../graph/store.js'
import { createSQLitePersister } from '../storage/sqlite.js'
import { JSONLPersister } from '../storage/jsonl.js'
import type { Storage } from '../storage/interface.js'

/**
 * Configuration for createDaemonWithStore
 */
export interface DaemonWithStoreConfig {
  /** Path to .opentasks/ directory */
  locationPath: string

  /** OpenTasks version */
  version: string

  /** Custom registry path (for testing) */
  registryPath?: string

  /** Shutdown timeout in milliseconds */
  shutdownTimeoutMs?: number
}

/**
 * Create a daemon with a fully initialized GraphStore
 *
 * Handles the boilerplate of creating SQLite + JSONL persisters,
 * building a GraphStore, initializing it, and passing it to createDaemon.
 *
 * @param config - Daemon configuration
 * @returns A ready-to-start daemon with an initialized store
 */
export async function createDaemonWithStore(
  config: DaemonWithStoreConfig
): Promise<Daemon> {
  const { locationPath, version, registryPath, shutdownTimeoutMs } = config

  const jsonlPath = path.join(locationPath, 'graph.jsonl')

  // Create SQLite persister
  const sqlite = createSQLitePersister(locationPath)

  // Create JSONL persister
  const jsonl = new JSONLPersister({ path: jsonlPath })

  // JSONL load/save functions
  const jsonlLoad = async () => {
    if (!existsSync(jsonlPath)) {
      return { nodes: [], edges: [] }
    }
    return await jsonl.load()
  }

  const jsonlSave = async (nodes: Parameters<typeof jsonl.save>[0], edges: Parameters<typeof jsonl.save>[1]) => {
    await jsonl.save(nodes, edges)
  }

  // Create and initialize graph store
  const store: GraphStore = createGraphStore(
    { basePath: locationPath, flush: { debounceMs: 5000, maxDelayMs: 30000 } },
    sqlite as unknown as Storage,
    jsonlLoad,
    jsonlSave
  )
  await store.initialize()

  return createDaemon({
    locationPath,
    version,
    store,
    registryPath,
    shutdownTimeoutMs,
  })
}
