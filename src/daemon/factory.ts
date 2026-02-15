/**
 * Daemon Factory
 *
 * Convenience factories that create fully initialized daemons
 * with SQLite + JSONL storage and GraphStores.
 *
 * - createDaemonWithStore: Single-location mode (backward compatible)
 * - createMultiLocationDaemonFromGit: Multi-location mode for git repos
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDaemon, type Daemon } from './lifecycle.js';
import { createGraphStore, type GraphStore } from '../graph/store.js';
import { createSQLitePersister } from '../storage/sqlite.js';
import { JSONLPersister } from '../storage/jsonl.js';
import type { Storage } from '../storage/interface.js';

/**
 * Configuration for createDaemonWithStore
 */
export interface DaemonWithStoreConfig {
  /** Path to .opentasks/ directory */
  locationPath: string;

  /** OpenTasks version */
  version: string;

  /** Custom registry path (for testing) */
  registryPath?: string;

  /** Shutdown timeout in milliseconds */
  shutdownTimeoutMs?: number;
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
export async function createDaemonWithStore(config: DaemonWithStoreConfig): Promise<Daemon> {
  const { locationPath, version, registryPath, shutdownTimeoutMs } = config;

  const jsonlPath = path.join(locationPath, 'graph.jsonl');

  // Create SQLite persister
  const sqlite = createSQLitePersister(locationPath);

  // Create JSONL persister
  const jsonl = new JSONLPersister({ path: jsonlPath });

  // JSONL load/save functions
  const jsonlLoad = async () => {
    if (!existsSync(jsonlPath)) {
      return { nodes: [], edges: [] };
    }
    return await jsonl.load();
  };

  const jsonlSave = async (
    nodes: Parameters<typeof jsonl.save>[0],
    edges: Parameters<typeof jsonl.save>[1],
  ) => {
    await jsonl.save(nodes, edges);
  };

  // Create and initialize graph store
  const store: GraphStore = createGraphStore(
    { basePath: locationPath, flush: { debounceMs: 5000, maxDelayMs: 30000 } },
    sqlite as unknown as Storage,
    jsonlLoad,
    jsonlSave,
  );
  await store.initialize();

  return createDaemon({
    locationPath,
    version,
    store,
    registryPath,
    shutdownTimeoutMs,
  });
}

/**
 * Configuration for createMultiLocationDaemonFromGit
 */
export interface MultiLocationDaemonFromGitConfig {
  /** Path to git common dir (e.g., /repo/.git) */
  gitCommonDir: string;

  /** OpenTasks version */
  version: string;

  /** Custom registry path (for testing) */
  registryPath?: string;

  /** Shutdown timeout in milliseconds */
  shutdownTimeoutMs?: number;

  /** Override for primary location path */
  primaryLocationPath?: string;
}

/**
 * Create a multi-location daemon from a git repo
 *
 * The daemon manages all worktrees registered in the git repo.
 * Each worktree gets its own store, flush manager, and watcher.
 *
 * @param config - Multi-location daemon configuration
 * @returns A ready-to-start daemon (call start() to initialize locations)
 */
export function createMultiLocationDaemonFromGit(config: MultiLocationDaemonFromGitConfig): Daemon {
  const { gitCommonDir, version, registryPath, shutdownTimeoutMs, primaryLocationPath } = config;

  return createDaemon({
    gitCommonDir,
    version,
    registryPath,
    shutdownTimeoutMs,
    primaryLocationPath,
  });
}
