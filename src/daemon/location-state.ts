/**
 * Location State Management
 *
 * Manages per-location state (store, flush manager, watcher) and provides
 * a LocationResolver abstraction that works for both single-location and
 * multi-location daemon modes.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createGraphStore, type GraphStore } from '../graph/store.js';
import type { ProviderAwareStore } from '../graph/provider-store.js';
import { createSQLitePersister } from '../storage/sqlite.js';
import { JSONLPersister } from '../storage/jsonl.js';
import type { Storage } from '../storage/interface.js';
import { createFileWatcher, type FileWatcher } from './watcher.js';
import { createDaemonFlushManager, type DaemonFlushManager } from './flush.js';
import { createSessionlogWatcher, type SessionlogWatcher } from './sessionlog-watcher.js';
import { createSessionlogAutoLinker, type SessionlogAutoLinker } from './sessionlog-linker.js';
import { DaemonError, type LocationInfo } from './types.js';
import type { SkillTrackerRegistry } from '../tracking/skill-tracker.js';
import { createTranscriptExtractor } from '../tracking/transcript-extractor.js';
import type { MaterializationArchiver } from '../materialization/types.js';
import { createGitArchiveStore } from '../materialization/git-archive-store.js';
import { createMaterializationArchiver } from '../materialization/archiver.js';
import { resolveGraphId } from '../materialization/graph-id.js';
import { createRemoteStoresFromConfig } from '../materialization/remote-store-factory.js';
import { loadConfig } from '../config/index.js';
import { createGitGraphSyncer, type GitGraphSyncer } from '../graph/git-graph-syncer.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-location runtime state
 */
export interface LocationState {
  /** Location hash */
  hash: string;

  /** Absolute path to .opentasks/ directory */
  opentasksPath: string;

  /** Graph store for this location */
  store: GraphStore;

  /** Provider-aware store wrapping the base store (optional, set by daemon) */
  providerStore?: ProviderAwareStore;

  /** Flush manager for this location */
  flushManager: DaemonFlushManager;

  /** File watcher for this location */
  watcher: FileWatcher;

  /** Whether this is the primary (default) location */
  primary: boolean;

  /** Whether the location is healthy */
  healthy: boolean;

  /** Sessionlog session watcher (if enabled) */
  sessionlogWatcher?: SessionlogWatcher;

  /** Sessionlog auto-linker (if enabled) */
  sessionlogLinker?: SessionlogAutoLinker;

  /** Materialization archiver (if enabled) */
  archiver?: MaterializationArchiver;

  /** Git graph syncer (if enabled) */
  graphSyncer?: GitGraphSyncer;

  /** Reconciliation trigger mode for reload events (default: 'async') */
  reconciliationOnReload?: 'async' | 'blocking' | 'none';

  /** Background reconciliation interval handle */
  reconciliationInterval?: ReturnType<typeof setInterval>;

  /** Per-provider reconciliation interval handles */
  providerReconciliationIntervals?: Map<string, ReturnType<typeof setInterval>>;

  /** Lease reaper interval handle (clears expired claims for this location) */
  claimSweepInterval?: ReturnType<typeof setInterval>;
}

/**
 * Resolves location hashes to LocationState instances.
 * Abstracts single-location vs multi-location routing.
 */
export interface LocationResolver {
  /** Resolve a location hash to its state. If hash is omitted, returns the default. */
  resolve(locationHash?: string): LocationState;

  /** Get the default (primary) location */
  getDefault(): LocationState;

  /** List all managed locations */
  list(): LocationInfo[];

  /** Check if a location hash is managed */
  has(hash: string): boolean;

  /** Add a new location (multi-location only) */
  add(state: LocationState): void;

  /** Remove a location and tear down its state */
  remove(hash: string): Promise<void>;

  /**
   * Register a listener fired when a location is added at runtime (multi-location
   * only). Lets the watch stream begin watching newly-added worktrees. No-op /
   * absent in single-location mode, which cannot add locations.
   */
  onLocationAdded?(listener: (state: LocationState) => void): void;

  /**
   * Register a listener fired when a location is removed, so watchers can drop
   * its per-location state. Receives the removed location's hash.
   */
  onLocationRemoved?(listener: (hash: string) => void): void;
}

// ============================================================================
// Store Factory
// ============================================================================

/**
 * Create a GraphStore for a location path.
 * Handles SQLite + JSONL persister creation and initialization.
 */
export async function createStoreForLocation(opentasksPath: string): Promise<GraphStore> {
  const jsonlPath = path.join(opentasksPath, 'graph.jsonl');

  const sqlite = createSQLitePersister(opentasksPath);
  const jsonl = new JSONLPersister({ path: jsonlPath });

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

  const store = createGraphStore(
    { basePath: opentasksPath, flush: { debounceMs: 5000, maxDelayMs: 30000 } },
    sqlite as unknown as Storage,
    jsonlLoad,
    jsonlSave,
  );
  await store.initialize();

  return store;
}

// ============================================================================
// LocationState Factory
// ============================================================================

/**
 * Create a full LocationState for a location.
 * Creates store, flush manager, and watcher.
 */
export async function createLocationState(
  opentasksPath: string,
  hash: string,
  primary: boolean = false,
  skillTrackerRegistry?: SkillTrackerRegistry,
): Promise<LocationState> {
  const store = await createStoreForLocation(opentasksPath);

  const watcher = createFileWatcher({ locationPath: opentasksPath });

  const flushManager = createDaemonFlushManager(
    { debounceMs: 5000, maxDelayMs: 30000 },
    async (_dirtyNodeIds) => {
      watcher.pause();
      try {
        await store.flush();
        // Auto-commit after flush if git sync is enabled
        if (graphSyncer) {
          await graphSyncer.commitIfDirty();
        }
      } finally {
        watcher.resume();
      }
    },
  );

  // Container for the state object — set before return so the reload handler
  // can access providerStore (which is wired up after createLocationState returns).
  let stateRef: LocationState | null = null;

  watcher.onchange((event) => {
    if (event.category === 'graph') {
      // External change to graph.jsonl detected — reload into SQLite
      flushManager.pause();
      void store.reload().then(async () => {
        flushManager.resume();

        // Trigger onReload reconciliation if a provider store is attached
        const providerStore = stateRef?.providerStore;
        const onReload = stateRef?.reconciliationOnReload ?? 'async';
        if (providerStore && onReload !== 'none') {
          const run = providerStore.reconcileProviders().catch(() => null);
          if (onReload === 'blocking') {
            await run;
          }
        }
      }).catch(() => {
        flushManager.resume();
      });
    }
  });

  // Initialize materialization archiver (if configured)
  let archiver: MaterializationArchiver | undefined;

  try {
    const config = await loadConfig(opentasksPath);
    if (config.materialization?.git?.enabled) {
      const graphId = resolveGraphId({
        explicitGraphId: config.materialization.graphId,
        locationName: config.location?.name,
        opentasksPath,
      });

      const gitStore = createGitArchiveStore({
        branch: config.materialization.git.branch,
        remote: config.materialization.git.remote,
        repoPath: config.materialization.git.repoPath,
        pushPolicy: config.materialization.git.pushPolicy,
        sourceRepoPath: opentasksPath,
      });

      const remoteStores = createRemoteStoresFromConfig(
        (config.materialization.remoteStores ?? []).map((rs: Record<string, unknown>) => ({
          type: rs.type as string,
          name: rs.name as string,
          enabled: (rs.enabled as boolean) ?? true,
          config: (rs.config as Record<string, unknown>) ?? {},
          events: (rs.events as string[]) ?? [],
        })),
      );

      archiver = createMaterializationArchiver({
        gitStore,
        remoteStores,
        policy: config.materialization.policy,
        graphId,
        graphPath: opentasksPath,
      });

      await archiver.initialize();

      // Rematerialize missing nodes on startup if configured
      if (config.materialization.rematerializeOnStartup) {
        void archiver.rematerializeAll(store).catch(() => {});
      }
    }
  } catch {
    // Materialization is optional — continue without it
    archiver = undefined;
  }

  // Initialize GitGraphSyncer (if configured)
  let graphSyncer: GitGraphSyncer | undefined;

  try {
    const syncConfig = (await loadConfig(opentasksPath)).sync;
    if (syncConfig?.git?.enabled) {
      graphSyncer = createGitGraphSyncer({
        opentasksPath,
        remote: syncConfig.git.remote,
        autoCommit: syncConfig.git.autoCommit,
        autoPush: syncConfig.git.autoPush,
        pushDebounceMs: syncConfig.git.pushDebounceMs,
      });
      graphSyncer.installMergeDriver();

      if (syncConfig.git.pullOnStartup) {
        await graphSyncer.pull();
      }

      if (syncConfig.git.autoCommit || syncConfig.git.autoPush) {
        graphSyncer.startAutoSync();
      }
    }
  } catch {
    // Git sync is optional — continue without it
    graphSyncer = undefined;
  }

  // Initialize Sessionlog integration (watcher + auto-linker + transcript extractor)
  let sessionlogWatcher: SessionlogWatcher | undefined;
  let sessionlogLinker: SessionlogAutoLinker | undefined;

  try {
    const sessionlogConfig = (await loadConfig(opentasksPath)).providers?.sessionlog;
    sessionlogWatcher = createSessionlogWatcher({
      locationPath: opentasksPath,
      sessionDirName: sessionlogConfig?.sessionDirName,
    });

    sessionlogLinker = createSessionlogAutoLinker({
      store,
      flushManager,
      archiver,
      skillTrackerRegistry,
    });

    const transcriptExtractor = createTranscriptExtractor({
      skillTrackerRegistry,
    });

    sessionlogWatcher.onSessionEvent(async (event) => {
      // Step 1: Extract transcript and backfill SkillTracker (BEFORE linker finalizes)
      if (event.type === 'ended') {
        try {
          await transcriptExtractor.extract(event);
        } catch {
          // Best-effort: don't block linker on extraction failure
        }
      }

      // Step 2: Linker finalizes (calls registry.remove() on ended)
      await sessionlogLinker!.handleSessionEvent(event);
    });

    await sessionlogWatcher.start();
  } catch {
    // Sessionlog integration is optional — continue without it
    sessionlogWatcher = undefined;
    sessionlogLinker = undefined;
  }

  const locationState: LocationState = {
    hash,
    opentasksPath,
    store,
    flushManager,
    watcher,
    primary,
    healthy: true,
    sessionlogWatcher,
    sessionlogLinker,
    archiver,
    graphSyncer,
  };

  // Allow the reload watcher closure to access providerStore
  stateRef = locationState;

  return locationState;
}

/**
 * Tear down a LocationState, releasing all resources.
 */
export async function destroyLocationState(state: LocationState): Promise<void> {
  // Stop background reconciliation intervals
  if (state.reconciliationInterval) {
    clearInterval(state.reconciliationInterval);
    state.reconciliationInterval = undefined;
  }
  if (state.claimSweepInterval) {
    clearInterval(state.claimSweepInterval);
    state.claimSweepInterval = undefined;
  }
  if (state.providerReconciliationIntervals) {
    for (const handle of state.providerReconciliationIntervals.values()) {
      clearInterval(handle);
    }
    state.providerReconciliationIntervals = undefined;
  }

  // Stop provider watching/sync before tearing down store
  if (state.providerStore) {
    try {
      state.providerStore.stopProviderWatching();
    } catch {
      /* ignore */
    }
    try {
      state.providerStore.stopBackgroundSync();
    } catch {
      /* ignore */
    }
  }
  // Stop sessionlog watcher before main watcher
  if (state.sessionlogWatcher) {
    try {
      await state.sessionlogWatcher.stop();
    } catch {
      /* ignore */
    }
  }
  try {
    await state.watcher.stop();
  } catch {
    /* ignore */
  }
  try {
    await state.flushManager.finalFlush();
  } catch {
    /* ignore */
  }
  try {
    await state.store.close();
  } catch {
    /* ignore */
  }
  // Shut down archiver (flushes pending pushes)
  if (state.archiver) {
    try {
      await state.archiver.close();
    } catch {
      /* ignore */
    }
  }
  // Shut down git graph syncer (final sync + stop auto-sync)
  if (state.graphSyncer) {
    try {
      state.graphSyncer.stopAutoSync();
      await state.graphSyncer.sync();
    } catch {
      /* ignore */
    }
  }
}

// ============================================================================
// LocationResolver Implementations
// ============================================================================

/**
 * Create a resolver for single-location mode.
 * Always resolves to the single provided LocationState.
 */
export function createSingleLocationResolver(state: LocationState): LocationResolver {
  return {
    resolve(_locationHash?: string): LocationState {
      // Single-location mode ignores the hash, always returns the one state
      return state;
    },

    getDefault(): LocationState {
      return state;
    },

    list(): LocationInfo[] {
      return [
        {
          hash: state.hash,
          opentasksPath: state.opentasksPath,
          primary: true,
          healthy: state.healthy,
        },
      ];
    },

    has(_hash: string): boolean {
      return _hash === state.hash;
    },

    add(_state: LocationState): void {
      throw new DaemonError('LOCATION_INIT_FAILED', 'Cannot add locations in single-location mode');
    },

    async remove(_hash: string): Promise<void> {
      throw new DaemonError(
        'LOCATION_INIT_FAILED',
        'Cannot remove locations in single-location mode',
      );
    },
  };
}

/**
 * Create a resolver for multi-location mode.
 * Routes requests to the appropriate LocationState by hash.
 */
export function createMultiLocationResolver(primaryHash: string): LocationResolver {
  const locations = new Map<string, LocationState>();
  const addListeners = new Set<(state: LocationState) => void>();
  const removeListeners = new Set<(hash: string) => void>();

  return {
    resolve(locationHash?: string): LocationState {
      if (!locationHash) {
        return this.getDefault();
      }

      const state = locations.get(locationHash);
      if (!state) {
        throw new DaemonError('LOCATION_NOT_FOUND', `Location not found: ${locationHash}`);
      }
      return state;
    },

    getDefault(): LocationState {
      const primary = locations.get(primaryHash);
      if (!primary) {
        // Fallback to first available location
        const first = locations.values().next();
        if (first.done) {
          throw new DaemonError('LOCATION_NOT_FOUND', 'No locations available');
        }
        return first.value;
      }
      return primary;
    },

    list(): LocationInfo[] {
      return Array.from(locations.values()).map((state) => ({
        hash: state.hash,
        opentasksPath: state.opentasksPath,
        primary: state.primary,
        healthy: state.healthy,
      }));
    },

    has(hash: string): boolean {
      return locations.has(hash);
    },

    add(state: LocationState): void {
      locations.set(state.hash, state);
      for (const listener of addListeners) {
        try {
          listener(state);
        } catch {
          /* a listener failure must not block the add */
        }
      }
    },

    async remove(hash: string): Promise<void> {
      const state = locations.get(hash);
      if (!state) return;

      locations.delete(hash);
      for (const listener of removeListeners) {
        try {
          listener(hash);
        } catch {
          /* ignore */
        }
      }
      await destroyLocationState(state);
    },

    onLocationAdded(listener: (state: LocationState) => void): void {
      addListeners.add(listener);
    },

    onLocationRemoved(listener: (hash: string) => void): void {
      removeListeners.add(listener);
    },
  };
}
