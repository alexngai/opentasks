/**
 * Daemon Lifecycle Manager
 *
 * Manages the start/stop lifecycle of an OpenTasks daemon.
 * Supports two modes via unified createDaemon():
 *   - Single-location: one store, one location (backward compatible)
 *   - Multi-location: multiple worktrees under one git repo
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLockManager, type LockManager } from './lock.js';
import { createRegistryManager, type RegistryManager } from './registry.js';
import { DaemonError, type DaemonState, type DaemonStatus, type DaemonEntry } from './types.js';
import { createIPCServer, type IPCServer } from './ipc.js';
import { createFileWatcher, type FileWatcher } from './watcher.js';
import { createDaemonFlushManager, type DaemonFlushManager } from './flush.js';
import { createSessionlogWatcher, type SessionlogWatcher } from './sessionlog-watcher.js';
import { createSessionlogAutoLinker, type SessionlogAutoLinker } from './sessionlog-linker.js';
import { registerLifecycleMethods } from './methods/lifecycle.js';
import { registerGraphMethods } from './methods/graph.js';
import { registerToolsMethods } from './methods/tools.js';
import { registerLocationMethods } from './methods/location.js';
import type { GraphStore } from '../graph/store.js';
import { createSkillTrackerRegistry } from '../tracking/skill-tracker.js';
import { createTranscriptExtractor } from '../tracking/transcript-extractor.js';
import {
  createProviderAwareStore,
  type ProviderAwareStore,
  type ReconcileResult,
} from '../graph/provider-store.js';
import { registerProviderMethods } from './methods/provider.js';
import { registerArchiveMethods } from './methods/archive.js';
import { registerContextFilesMethods } from './methods/context-files.js';
import { registerWatchMethods } from './methods/watch.js';
import { registerSyncMethods } from './methods/sync.js';
import {
  createGitGraphSyncer,
  type GitGraphSyncer,
} from '../graph/git-graph-syncer.js';
import type { PartialOpenTasksConfig } from '../config/index.js';
import { loadConfigFile } from '../config/loader.js';
import { createBeadsProvider } from '../providers/beads.js';
import { createSudocodeProvider } from '../providers/sudocode.js';
import { createClaudeTasksProvider } from '../providers/claude-tasks.js';
import { createGlobalProvider } from '../providers/global.js';
import {
  createLocationState,
  destroyLocationState,
  createSingleLocationResolver,
  createMultiLocationResolver,
  type LocationState,
  type LocationResolver,
} from './location-state.js';
import { readWorktreeRegistry, type WorktreeEntry } from '../core/worktree.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Base configuration shared by both daemon modes
 */
interface DaemonConfigBase {
  /** OpenTasks version */
  version: string;

  /** Shutdown timeout in milliseconds (default: 2000) */
  shutdownTimeoutMs?: number;

  /** Custom registry path (for testing) */
  registryPath?: string;
}

/**
 * Single-location daemon configuration (backward compatible)
 */
export interface SingleLocationDaemonConfig extends DaemonConfigBase {
  /** Path to .opentasks/ directory */
  locationPath: string;

  /** Injected GraphStore instance (caller creates and initializes it) */
  store: GraphStore;

  /** OpenTasks config override (for custom paths) */
  openTasksConfig?: PartialOpenTasksConfig;
}

/**
 * Multi-location daemon configuration
 */
export interface MultiLocationDaemonConfig extends DaemonConfigBase {
  /** Path to git common dir (e.g., /repo/.git) */
  gitCommonDir: string;

  /** Override for primary location path (default: auto-detected from git root) */
  primaryLocationPath?: string;
}

/**
 * Unified daemon configuration (discriminated by presence of gitCommonDir)
 */
export type DaemonConfig = SingleLocationDaemonConfig | MultiLocationDaemonConfig;

/**
 * Daemon interface
 */
export interface Daemon {
  /** Start the daemon */
  start(): Promise<void>;

  /** Stop the daemon gracefully */
  stop(): Promise<void>;

  /** Get daemon status */
  getStatus(): DaemonStatus;

  /** Socket path for IPC */
  readonly socketPath: string;

  /** Location path (daemon home directory) */
  readonly locationPath: string;
}

/**
 * Result of checking for existing daemon
 */
export interface ExistingDaemonResult {
  /** Whether a daemon is already running */
  running: boolean;

  /** Socket path if running */
  socketPath?: string;

  /** PID if running */
  pid?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if config is for multi-location mode
 */
function isMultiLocationConfig(config: DaemonConfig): config is MultiLocationDaemonConfig {
  return 'gitCommonDir' in config;
}

// ============================================================================
// Provider Registration
// ============================================================================

/**
 * Register external providers on a ProviderAwareStore based on config.
 * Reads the `providers` section of the OpenTasks config and instantiates
 * enabled providers, registering them with the store's provider registry.
 *
 * Note: The MAP provider is NOT registered here. MAP connections are
 * agent-specific (different agents may connect to different MAP servers),
 * so MAP provider and event bridge setup is the responsibility of the
 * agent process or plugin (e.g., claude-code-swarm), not the daemon.
 */
function registerConfiguredProviders(
  providerStore: ProviderAwareStore,
  config?: PartialOpenTasksConfig,
  locationPath?: string,
): void {
  const providersConfig = config?.providers as
    | {
        beads?: { enabled?: boolean; executable?: string; timeout?: number };
        claudeTasks?: { enabled?: boolean };
        sudocode?: { enabled?: boolean; executable?: string; timeout?: number };
        global?: { enabled?: boolean; path?: string; timeout?: number; cacheTTL?: number };
      }
    | undefined;

  if (!providersConfig) return;

  // Register Beads provider if enabled
  if (providersConfig.beads?.enabled !== false) {
    try {
      const beads = createBeadsProvider({
        executable: providersConfig.beads?.executable,
        timeout: providersConfig.beads?.timeout,
      });
      providerStore.providers.register(beads);
    } catch {
      // Graceful degradation: skip provider if creation fails
    }
  }

  // Register Sudocode provider if enabled
  if (providersConfig.sudocode?.enabled !== false) {
    try {
      const sudocode = createSudocodeProvider({
        executable: providersConfig.sudocode?.executable,
        timeout: providersConfig.sudocode?.timeout,
      });
      providerStore.providers.register(sudocode);
    } catch {
      // Graceful degradation: skip provider if creation fails
    }
  }

  // Register Claude Tasks provider if enabled
  if (providersConfig.claudeTasks?.enabled !== false) {
    try {
      const claudeTasks = createClaudeTasksProvider();
      providerStore.providers.register(claudeTasks);
    } catch {
      // Graceful degradation: skip provider if creation fails
    }
  }

  // Register Global provider if enabled (and not the global daemon itself)
  const globalHome = path.join(os.homedir(), '.opentasks');
  const isGlobalDaemon = locationPath
    ? path.resolve(locationPath) === path.resolve(globalHome)
    : false;

  if (!isGlobalDaemon && providersConfig.global?.enabled !== false) {
    try {
      const globalProvider = createGlobalProvider({
        globalPath: providersConfig.global?.path || undefined,
        timeout: providersConfig.global?.timeout,
        cacheTTL: providersConfig.global?.cacheTTL,
      });
      providerStore.providers.register(globalProvider);
    } catch {
      // Graceful degradation: global daemon may not be running
    }
  }
}

// ============================================================================
// Reconciliation Helpers
// ============================================================================

type ReconciliationTrigger = 'async' | 'blocking' | 'none';

/**
 * Trigger provider reconciliation based on the configured mode.
 *
 * - 'blocking': await the reconciliation before returning
 * - 'async': fire-and-forget (errors logged but not thrown)
 * - 'none': skip entirely
 */
async function triggerReconciliation(
  providerStore: ProviderAwareStore,
  mode: ReconciliationTrigger,
): Promise<ReconcileResult | null> {
  if (mode === 'none') return null;

  const run = providerStore.reconcileProviders().catch(() => null);

  if (mode === 'blocking') {
    return await run;
  }

  // 'async' — fire and forget
  void run;
  return null;
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Check if a daemon is already running for a location
 */
export async function checkExistingDaemon(locationPath: string): Promise<ExistingDaemonResult> {
  const lockManager = createLockManager(locationPath);
  const isHeld = await lockManager.isHeld();

  if (!isHeld) {
    return { running: false };
  }

  const lock = await lockManager.read();
  if (!lock) {
    return { running: false };
  }

  return {
    running: true,
    socketPath: lock.socketPath,
    pid: lock.pid,
  };
}

// ============================================================================
// Unified Factory
// ============================================================================

/**
 * Create a daemon, supporting both single-location and multi-location modes.
 *
 * - If config has `locationPath` + `store`: single-location mode (backward compatible)
 * - If config has `gitCommonDir`: multi-location mode (manages all worktrees)
 */
export function createDaemon(config: DaemonConfig): Daemon {
  if (isMultiLocationConfig(config)) {
    return createMultiLocationDaemon(config);
  }
  return createSingleLocationDaemon(config);
}

// ============================================================================
// Single-Location Daemon
// ============================================================================

function createSingleLocationDaemon(config: SingleLocationDaemonConfig): Daemon {
  const {
    locationPath,
    version,
    store,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    registryPath,
    openTasksConfig,
  } = config;

  // Use config values for paths, falling back to defaults
  const socketFileName = openTasksConfig?.daemon?.socketPath ?? 'daemon.sock';
  const databaseFileName = openTasksConfig?.storage?.sqlitePath ?? 'cache.db';

  const socketPath = path.join(locationPath, socketFileName);
  const databasePath = path.join(locationPath, databaseFileName);

  // State
  let state: DaemonState = 'stopped';
  let startedAt: string | null = null;

  // Managers
  const lockManager: LockManager = createLockManager(locationPath);
  const registryManager: RegistryManager = createRegistryManager(registryPath);

  // Components (initialized in start(), torn down in stop())
  let ipcServer: IPCServer | null = null;
  let fileWatcher: FileWatcher | null = null;
  let flushManager: DaemonFlushManager | null = null;
  let activeProviderStore: ProviderAwareStore | null = null;
  let sessionlogWatcher: SessionlogWatcher | null = null;
  let sessionlogLinker: SessionlogAutoLinker | null = null;
  let reconciliationIntervalHandle: ReturnType<typeof setInterval> | null = null;
  let providerIntervalHandles: Map<string, ReturnType<typeof setInterval>> | null = null;
  let claimSweepIntervalHandle: ReturnType<typeof setInterval> | null = null;

  // Git graph syncer — null when `sync.git.enabled` is false (default).
  // When enabled: installed merge driver + optional pull-on-startup + optional
  // auto-commit/push timer managed internally by the syncer.
  let gitSyncer: GitGraphSyncer | null = null;
  let gitSyncConfig: {
    enabled: boolean;
    remote?: string;
    autoCommit: boolean;
    autoPush: boolean;
    pullOnStartup: boolean;
  } = {
    enabled: false,
    autoCommit: false,
    autoPush: false,
    pullOnStartup: false,
  };

  // Signal handlers (stored for cleanup)
  let signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];

  function setupSignalHandlers(daemon: Daemon): void {
    const handler = () => {
      void daemon.stop();
    };
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    for (const signal of signals) {
      process.on(signal, handler);
      signalHandlers.push({ signal, handler });
    }
  }

  function removeSignalHandlers(): void {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers = [];
  }

  async function removeSocketFile(): Promise<void> {
    try {
      await fs.unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const daemon: Daemon = {
    socketPath,
    locationPath,

    async start(): Promise<void> {
      if (state !== 'stopped') {
        throw new DaemonError('DAEMON_ALREADY_RUNNING', `Daemon is already ${state}`);
      }

      state = 'starting';

      try {
        // 1. Check for existing daemon
        const existing = await checkExistingDaemon(locationPath);
        if (existing.running) {
          state = 'stopped';
          throw new DaemonError(
            'DAEMON_ALREADY_RUNNING',
            `Daemon already running (PID ${existing.pid}) at ${existing.socketPath}`,
          );
        }

        // 2. Acquire lock
        await lockManager.acquire({
          version,
          socketPath,
          databasePath,
        });

        // 3. Remove stale socket file
        await removeSocketFile();

        // 4. Register in global registry
        startedAt = new Date().toISOString();
        const entry: DaemonEntry = {
          locationPath,
          socketPath,
          pid: process.pid,
          version,
          startedAt,
          lastActivity: startedAt,
        };
        await registryManager.register(entry);

        // 5. Setup signal handlers
        setupSignalHandlers(daemon);

        // 6. Create flush manager
        flushManager = createDaemonFlushManager(
          { debounceMs: 5000, maxDelayMs: 30000 },
          async (_dirtyNodeIds) => {
            fileWatcher?.pause();
            try {
              await store.flush();
            } finally {
              fileWatcher?.resume();
            }
          },
        );

        // 7. Create IPC server
        ipcServer = createIPCServer(socketPath);

        // 8. Create single-location resolver wrapping store + flushManager
        const defaultProvider =
          (openTasksConfig?.defaultProvider as string | undefined) ?? 'native';
        const reconciliationConfig = openTasksConfig?.reconciliation as
          | { onStartup?: ReconciliationTrigger; onReload?: ReconciliationTrigger; backgroundInterval?: number; providerIntervals?: Record<string, number> }
          | undefined;
        const providerStore = createProviderAwareStore(store, {
          defaultProvider,
          reconciliation: reconciliationConfig,
        });

        // Register external providers from config
        registerConfiguredProviders(providerStore, openTasksConfig, locationPath);
        activeProviderStore = providerStore;

        // Wire cross-provider node resolver into query engine
        store.setNodeResolver(async (idOrUri) => {
          const node = await providerStore.resolveNode(idOrUri);
          if (!node) return null;
          // Convert Node/ProviderNode to StoredNode shape for QueryEngine
          const raw = node as unknown as Record<string, unknown>;
          return {
            id: node.id,
            uuid: (raw.uuid ?? node.id) as string,
            type: (node.type ?? 'task') as string,
            title: (node.title ?? '') as string,
            content: node.content as string | undefined,
            status: raw.status as string | undefined,
            priority: raw.priority as number | undefined,
            archived: (raw.archived as boolean) ?? false,
            created_at: (raw.created_at ?? new Date().toISOString()) as string,
            updated_at: (raw.updated_at ?? new Date().toISOString()) as string,
          };
        });

        const locationState: LocationState = {
          hash: 'primary',
          opentasksPath: locationPath,
          store,
          providerStore,
          flushManager,
          watcher: null as unknown as FileWatcher, // watcher managed separately
          primary: true,
          healthy: true,
        };
        const locationResolver = createSingleLocationResolver(locationState);

        // 9. Register method handlers
        registerLifecycleMethods({
          server: ipcServer,
          getStatus: () => daemon.getStatus(),
          shutdown: () => daemon.stop(),
          version,
          startedAt: new Date(startedAt),
        });

        registerGraphMethods({
          server: ipcServer,
          locationResolver,
        });

        // Create shared skill tracker registry (only if enabled in config)
        const skillTrackingEnabled = openTasksConfig?.tracking?.skillTracking !== false;
        const skillTrackerRegistry = skillTrackingEnabled
          ? createSkillTrackerRegistry()
          : undefined;

        registerToolsMethods({
          server: ipcServer,
          locationResolver,
          skillTrackerRegistry,
        });

        registerProviderMethods({
          server: ipcServer,
          locationResolver,
        });

        registerContextFilesMethods({
          server: ipcServer,
          locationResolver,
        });

        registerArchiveMethods({
          server: ipcServer,
          locationResolver,
        });

        registerWatchMethods({
          server: ipcServer,
          locationResolver,
        });

        // 9b. Set up the git syncer if enabled. The initialization is
        // factored into `buildSyncer` so it can run both at startup (using
        // the OpenTasksConfig passed to createDaemon) and at runtime via
        // the `sync.reload` IPC method (which reads the latest
        // `.opentasks/config.json` from disk — used when an external
        // writer like OpenHive's PATCH endpoint flips the flag).
        type SyncGitConfig = {
          enabled?: boolean;
          remote?: string;
          autoCommit?: boolean;
          autoPush?: boolean;
          pullOnStartup?: boolean;
          pushDebounceMs?: number;
        };

        const disabledSync = {
          enabled: false,
          autoCommit: false,
          autoPush: false,
          pullOnStartup: false,
        } as typeof gitSyncConfig;

        /**
         * Rebuild the syncer from a config block, replacing whatever's
         * currently active. Tears down the previous syncer's timers first
         * so callers don't need to.
         *
         * @param gitConfig config block (usually `config.sync.git`)
         * @param options.doInitialPull when true, honor `pullOnStartup`.
         *   Startup passes true; `sync.reload` passes false because the
         *   caller can issue `sync.pull` explicitly if they want.
         */
        async function buildSyncer(
          gitConfig: SyncGitConfig | undefined,
          options: { doInitialPull: boolean },
        ): Promise<void> {
          // Tear down any existing syncer first — we're replacing it.
          if (gitSyncer) {
            try { gitSyncer.stopAutoSync(); } catch { /* ignore */ }
            gitSyncer = null;
          }

          if (!gitConfig?.enabled) {
            gitSyncConfig = { ...disabledSync };
            return;
          }

          gitSyncConfig = {
            enabled: true,
            remote: gitConfig.remote,
            autoCommit: gitConfig.autoCommit ?? false,
            autoPush: gitConfig.autoPush ?? false,
            pullOnStartup: gitConfig.pullOnStartup ?? false,
          };

          try {
            gitSyncer = createGitGraphSyncer({
              opentasksPath: locationPath,
              remote: gitSyncConfig.remote ?? null,
              autoCommit: gitSyncConfig.autoCommit,
              autoPush: gitSyncConfig.autoPush,
              pushDebounceMs: gitConfig.pushDebounceMs,
            });

            // Install the JSONL merge driver once per repo so concurrent
            // pushes from peer hubs resolve cleanly on pull. Re-running
            // this after reload is idempotent (it just verifies the
            // .gitattributes entry exists).
            try {
              gitSyncer.installMergeDriver();
            } catch {
              /* merge driver install is best-effort */
            }

            if (options.doInitialPull && gitSyncConfig.pullOnStartup) {
              try {
                await gitSyncer.pull();
              } catch {
                /* initial pull failure is non-fatal */
              }
            }

            // Start the auto-sync timer right away — in the startup path
            // the main block will idempotently call this again, which the
            // syncer short-circuits. In the reload path, this is the only
            // place that starts it.
            gitSyncer.startAutoSync();
          } catch {
            // Syncer construction failed (e.g. not a git repo) — disable
            // gracefully and keep going.
            gitSyncer = null;
            gitSyncConfig = { ...disabledSync };
          }
        }

        const startupSyncConfig = openTasksConfig?.sync as
          | { git?: SyncGitConfig }
          | undefined;
        await buildSyncer(startupSyncConfig?.git, { doInitialPull: true });

        registerSyncMethods({
          server: ipcServer,
          getSyncer: () => gitSyncer,
          // Serialize manual sync/pull with the flush so a pending flush can't
          // clobber a freshly-pulled graph.jsonl (F2 race); reload SQLite after.
          flushManager: flushManager ?? undefined,
          reloadStore: async () => {
            await store.reload();
          },
          getSyncStatus: () => ({
            enabled: gitSyncConfig.enabled,
            remote: gitSyncConfig.remote,
            autoCommit: gitSyncConfig.autoCommit,
            autoPush: gitSyncConfig.autoPush,
            pullOnStartup: gitSyncConfig.pullOnStartup,
            autoSyncRunning: gitSyncer?.isAutoSyncRunning() ?? false,
            health: gitSyncer?.getHealth(),
          }),
          reloadSyncer: async () => {
            // Re-read `.opentasks/config.json` from disk — the whole
            // point of reload is to pick up externally-rewritten config.
            //
            // We read the raw JSON rather than routing through
            // `loadConfigFile` so that a minimal file carrying only the
            // `sync.git` block (e.g. the shape OpenHive's
            // `applyGitSyncConfig` writes) is accepted. The full config
            // schema rejects partial writes that omit unrelated blocks.
            let diskGit: SyncGitConfig | undefined;
            try {
              const configPath = path.join(locationPath, 'config.json');
              const raw = await fs.readFile(configPath, 'utf-8');
              const parsed = JSON.parse(raw) as { sync?: { git?: SyncGitConfig } } | null;
              diskGit = parsed?.sync?.git;
            } catch {
              /* missing or unreadable — rebuild as disabled */
            }
            await buildSyncer(diskGit, { doInitialPull: false });
            return {
              enabled: gitSyncConfig.enabled,
              remote: gitSyncConfig.remote,
              autoCommit: gitSyncConfig.autoCommit,
              autoPush: gitSyncConfig.autoPush,
              pullOnStartup: gitSyncConfig.pullOnStartup,
              autoSyncRunning: gitSyncer?.isAutoSyncRunning() ?? false,
              health: gitSyncer?.getHealth(),
            };
          },
        });

        // 10. Start IPC server (begin listening). The auto-sync timer
        // was already started inside `buildSyncer` above.
        await ipcServer.start();

        // 11. Create and start file watcher
        fileWatcher = createFileWatcher({ locationPath });

        const onReload = reconciliationConfig?.onReload ?? 'async';
        fileWatcher.onchange((event) => {
          if (event.category === 'graph' && onReload !== 'none' && activeProviderStore) {
            // After external graph changes, reconcile provider-backed nodes
            void activeProviderStore.reconcileProviders().catch(() => {});
          }
        });

        await fileWatcher.start();

        // Update the location state's watcher reference
        locationState.watcher = fileWatcher;

        // 12. Start provider watching for watchable providers
        providerStore.startProviderWatching();

        // 12b. Trigger startup reconciliation
        const onStartup = reconciliationConfig?.onStartup ?? 'async';
        await triggerReconciliation(providerStore, onStartup);

        // 12c. Start background reconciliation interval
        const bgInterval = reconciliationConfig?.backgroundInterval ?? 300000;
        if (bgInterval > 0) {
          reconciliationIntervalHandle = setInterval(() => {
            if (activeProviderStore) {
              void activeProviderStore.reconcileProviders().catch(() => {});
            }
          }, bgInterval);
        }

        // 12c-bis. Background lease reaper — atomically clears expired claims so
        // a crashed/AFK agent's tasks become claimable again and the change
        // flushes (reaching watchers). Steal-on-expiry already makes them
        // reclaimable; this actively cleans up the stale claim fields + notifies.
        const LEASE_SWEEP_INTERVAL_MS = 60_000;
        claimSweepIntervalHandle = setInterval(() => {
          if (!activeProviderStore || !flushManager) return;
          const fm = flushManager;
          void activeProviderStore
            .sweepExpiredClaims()
            .then((cleared) => {
              if (cleared.length === 0) return;
              for (const id of cleared) fm.markDirty(id);
              fm.schedule();
            })
            .catch(() => {});
        }, LEASE_SWEEP_INTERVAL_MS);

        // 12d. Start per-provider reconciliation intervals
        const providerIntervals = reconciliationConfig?.providerIntervals as Record<string, number> | undefined;
        if (providerIntervals && Object.keys(providerIntervals).length > 0) {
          providerIntervalHandles = new Map();
          for (const [providerName, interval] of Object.entries(providerIntervals)) {
            if (interval > 0) {
              providerIntervalHandles.set(
                providerName,
                setInterval(() => {
                  if (activeProviderStore) {
                    void activeProviderStore.reconcileProviders({ providers: [providerName] }).catch(() => {});
                  }
                }, interval),
              );
            }
          }
        }

        // 13. Initialize Sessionlog watcher + auto-linker + transcript extractor (optional)
        try {
          sessionlogWatcher = createSessionlogWatcher({
            locationPath,
            sessionDirName: openTasksConfig?.providers?.sessionlog?.sessionDirName as string | undefined,
          });
          sessionlogLinker = createSessionlogAutoLinker({
            store,
            flushManager,
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
          sessionlogWatcher = null;
          sessionlogLinker = null;
        }

        // 13. Mark as running
        state = 'running';
      } catch (error) {
        // Cleanup on failure
        state = 'stopped';
        startedAt = null;

        if (reconciliationIntervalHandle) {
          clearInterval(reconciliationIntervalHandle);
          reconciliationIntervalHandle = null;
        }
        if (providerIntervalHandles) {
          for (const handle of providerIntervalHandles.values()) clearInterval(handle);
          providerIntervalHandles = null;
        }
        if (claimSweepIntervalHandle) {
          clearInterval(claimSweepIntervalHandle);
          claimSweepIntervalHandle = null;
        }

        if (gitSyncer) {
          try { gitSyncer.stopAutoSync(); } catch { /* ignore */ }
          gitSyncer = null;
        }

        if (sessionlogWatcher) {
          try {
            await sessionlogWatcher.stop();
          } catch {
            /* ignore */
          }
          sessionlogWatcher = null;
          sessionlogLinker = null;
        }

        if (fileWatcher) {
          try {
            await fileWatcher.stop();
          } catch {
            /* ignore */
          }
          fileWatcher = null;
        }

        if (ipcServer) {
          try {
            await ipcServer.stop();
          } catch {
            /* ignore */
          }
          ipcServer = null;
        }

        flushManager = null;

        try {
          await lockManager.release();
        } catch {
          // Ignore release errors during cleanup
        }

        throw error;
      }
    },

    async stop(): Promise<void> {
      if (state === 'stopped' || state === 'stopping') {
        return;
      }

      if (state === 'starting') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (state === 'starting') {
          throw new DaemonError('SHUTDOWN_TIMEOUT', 'Cannot stop daemon while starting');
        }
      }

      state = 'stopping';

      const shutdownPromise = (async () => {
        try {
          removeSignalHandlers();

          if (ipcServer) {
            await ipcServer.stop();
            ipcServer = null;
          }

          // Stop Sessionlog watcher before file watcher
          if (sessionlogWatcher) {
            await sessionlogWatcher.stop();
            sessionlogWatcher = null;
            sessionlogLinker = null;
          }

          // Stop background reconciliation
          if (reconciliationIntervalHandle) {
            clearInterval(reconciliationIntervalHandle);
            reconciliationIntervalHandle = null;
          }
          if (providerIntervalHandles) {
            for (const handle of providerIntervalHandles.values()) clearInterval(handle);
            providerIntervalHandles = null;
          }
          if (claimSweepIntervalHandle) {
            clearInterval(claimSweepIntervalHandle);
            claimSweepIntervalHandle = null;
          }

          // Stop provider watching before tearing down file watcher and store
          if (activeProviderStore) {
            activeProviderStore.stopProviderWatching();
            activeProviderStore.stopBackgroundSync();
            activeProviderStore = null;
          }

          if (fileWatcher) {
            await fileWatcher.stop();
            fileWatcher = null;
          }

          if (flushManager) {
            await flushManager.finalFlush();
            flushManager = null;
          }

          // After the final flush has landed on disk, attempt a final
          // commit+push so the remote sees the last in-flight changes
          // before the daemon goes quiet. Best-effort only — git failures
          // must not block shutdown.
          if (gitSyncer) {
            gitSyncer.stopAutoSync();
            if (gitSyncConfig.autoCommit) {
              try { await gitSyncer.commitIfDirty(); } catch { /* ignore */ }
            }
            if (gitSyncConfig.autoPush) {
              try { await gitSyncer.push(); } catch { /* ignore */ }
            }
            gitSyncer = null;
          }

          await store.close();
          await registryManager.unregister(locationPath);
          await removeSocketFile();
          await lockManager.release();
        } finally {
          state = 'stopped';
          startedAt = null;
        }
      })();

      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError('SHUTDOWN_TIMEOUT', 'Shutdown timed out'));
        }, shutdownTimeoutMs);
      });

      try {
        await Promise.race([shutdownPromise, timeoutPromise]);
      } catch (error) {
        state = 'stopped';
        startedAt = null;
        removeSignalHandlers();
        throw error;
      }
    },

    getStatus(): DaemonStatus {
      return {
        state,
        startedAt,
        pid: process.pid,
        socketPath,
        pendingFlush: flushManager?.hasPendingChanges() ?? false,
        connectionCount: ipcServer?.getConnectionCount() ?? 0,
      };
    },
  };

  return daemon;
}

// ============================================================================
// Multi-Location Daemon
// ============================================================================

function createMultiLocationDaemon(config: MultiLocationDaemonConfig): Daemon {
  const {
    gitCommonDir,
    version,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    registryPath,
    primaryLocationPath: primaryOverride,
  } = config;

  // Daemon home is .git/opentasks/
  const daemonHomePath = path.join(gitCommonDir, 'opentasks');
  const socketPath = path.join(daemonHomePath, 'daemon.sock');
  const databasePath = path.join(daemonHomePath, 'cache.db');

  // Primary location: override or auto-detect (git root's .opentasks/)
  const gitRoot = path.dirname(gitCommonDir); // /repo/.git → /repo
  const defaultPrimaryPath = path.join(gitRoot, '.opentasks');
  const primaryPath = primaryOverride ?? defaultPrimaryPath;

  // State
  let state: DaemonState = 'stopped';
  let startedAt: string | null = null;

  // Managers
  const lockManager: LockManager = createLockManager(daemonHomePath);
  const registryManager: RegistryManager = createRegistryManager(registryPath);

  // Components
  let ipcServer: IPCServer | null = null;
  let locationResolver: LocationResolver | null = null;

  // Signal handlers
  let signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];

  function setupSignalHandlers(daemon: Daemon): void {
    const handler = () => {
      void daemon.stop();
    };
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    for (const signal of signals) {
      process.on(signal, handler);
      signalHandlers.push({ signal, handler });
    }
  }

  function removeSignalHandlers(): void {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers = [];
  }

  async function removeSocketFile(): Promise<void> {
    try {
      await fs.unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Initialize a location, returning its state. Returns null on failure (degraded mode).
   */
  // Shared skill tracker registry for the entire daemon.
  // Created lazily based on primary config's tracking.skillTracking setting.
  let sharedSkillTrackerRegistry: ReturnType<typeof createSkillTrackerRegistry> | undefined;

  async function initLocation(
    opentasksPath: string,
    hash: string,
    isPrimary: boolean,
    locationConfig?: PartialOpenTasksConfig,
  ): Promise<LocationState | null> {
    try {
      // On primary init, create the shared registry if tracking is enabled
      if (isPrimary && locationConfig?.tracking?.skillTracking !== false) {
        sharedSkillTrackerRegistry = createSkillTrackerRegistry();
      }

      const locReconciliationConfig = locationConfig?.reconciliation as
        | { onStartup?: ReconciliationTrigger; onReload?: ReconciliationTrigger; backgroundInterval?: number; providerIntervals?: Record<string, number> }
        | undefined;

      const locState = await createLocationState(opentasksPath, hash, isPrimary, sharedSkillTrackerRegistry);
      // Wrap store with provider-aware dispatch
      const defaultProvider = (locationConfig?.defaultProvider as string | undefined) ?? 'native';
      locState.providerStore = createProviderAwareStore(locState.store, {
        defaultProvider,
        reconciliation: locReconciliationConfig,
      });

      // Set reconciliation onReload mode for the watcher handler
      locState.reconciliationOnReload = locReconciliationConfig?.onReload ?? 'async';

      // Register external providers from config
      registerConfiguredProviders(locState.providerStore, locationConfig, opentasksPath);

      // Wire cross-provider node resolver into query engine
      const provStore = locState.providerStore;
      locState.store.setNodeResolver(async (idOrUri) => {
        const node = await provStore.resolveNode(idOrUri);
        if (!node) return null;
        const raw = node as unknown as Record<string, unknown>;
        return {
          id: node.id,
          uuid: (raw.uuid ?? node.id) as string,
          type: (node.type ?? 'task') as string,
          title: (node.title ?? '') as string,
          content: node.content as string | undefined,
          status: raw.status as string | undefined,
          priority: raw.priority as number | undefined,
          archived: (raw.archived as boolean) ?? false,
          created_at: (raw.created_at ?? new Date().toISOString()) as string,
          updated_at: (raw.updated_at ?? new Date().toISOString()) as string,
        };
      });

      await locState.watcher.start();

      // Start provider watching for watchable providers
      locState.providerStore.startProviderWatching();

      // Trigger startup reconciliation
      const onStartup = locReconciliationConfig?.onStartup ?? 'async';
      await triggerReconciliation(locState.providerStore, onStartup);

      // Start background reconciliation interval
      const bgInterval = locReconciliationConfig?.backgroundInterval ?? 300000;
      if (bgInterval > 0) {
        locState.reconciliationInterval = setInterval(() => {
          if (locState.providerStore) {
            void locState.providerStore.reconcileProviders().catch(() => {});
          }
        }, bgInterval);
      }

      // Start per-provider reconciliation intervals
      const providerIntervals = locReconciliationConfig?.providerIntervals;
      if (providerIntervals && Object.keys(providerIntervals).length > 0) {
        locState.providerReconciliationIntervals = new Map();
        for (const [providerName, interval] of Object.entries(providerIntervals)) {
          if (interval > 0) {
            locState.providerReconciliationIntervals.set(
              providerName,
              setInterval(() => {
                if (locState.providerStore) {
                  void locState.providerStore.reconcileProviders({ providers: [providerName] }).catch(() => {});
                }
              }, interval),
            );
          }
        }
      }

      return locState;
    } catch {
      // Graceful degradation: skip failed locations
      return null;
    }
  }

  /**
   * Read worktree entries from the registry. Returns empty array if no registry.
   */
  function getWorktreeEntries(): WorktreeEntry[] {
    try {
      const registry = readWorktreeRegistry(gitCommonDir);
      return registry.worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Determine primary hash from config or worktree registry
   */
  function determinePrimaryHash(entries: WorktreeEntry[]): string {
    // If primary path matches a registered worktree, use its hash
    const primaryEntry = entries.find(
      (e) => path.resolve(e.opentasksPath) === path.resolve(primaryPath),
    );
    if (primaryEntry) {
      return primaryEntry.hash;
    }
    // Fallback: use 'primary' as the hash
    return 'primary';
  }

  const daemon: Daemon = {
    socketPath,
    locationPath: daemonHomePath,

    async start(): Promise<void> {
      if (state !== 'stopped') {
        throw new DaemonError('DAEMON_ALREADY_RUNNING', `Daemon is already ${state}`);
      }

      state = 'starting';

      try {
        // 1. Ensure daemon home directory exists
        await fs.mkdir(daemonHomePath, { recursive: true });

        // 2. Check for existing daemon
        const existing = await checkExistingDaemon(daemonHomePath);
        if (existing.running) {
          state = 'stopped';
          throw new DaemonError(
            'DAEMON_ALREADY_RUNNING',
            `Daemon already running (PID ${existing.pid}) at ${existing.socketPath}`,
          );
        }

        // 3. Acquire lock
        await lockManager.acquire({
          version,
          socketPath,
          databasePath,
        });

        // 4. Remove stale socket file
        await removeSocketFile();

        // 5. Register in global registry
        startedAt = new Date().toISOString();
        const entry: DaemonEntry = {
          locationPath: daemonHomePath,
          socketPath,
          pid: process.pid,
          version,
          startedAt,
          lastActivity: startedAt,
        };
        await registryManager.register(entry);

        // 6. Setup signal handlers
        setupSignalHandlers(daemon);

        // 7. Read worktree registry and determine primary hash
        const worktreeEntries = getWorktreeEntries();
        const primaryHash = determinePrimaryHash(worktreeEntries);

        // 8. Create multi-location resolver
        locationResolver = createMultiLocationResolver(primaryHash);

        // 9. Initialize primary location (load config from .opentasks/config.json)
        let primaryConfig: PartialOpenTasksConfig | null = null;
        try {
          primaryConfig = await loadConfigFile(path.dirname(primaryPath));
        } catch {
          // Config load failure is non-fatal; defaults will be used
        }

        const primaryState = await initLocation(
          primaryPath,
          primaryHash,
          true,
          primaryConfig ?? undefined,
        );
        if (primaryState) {
          locationResolver.add(primaryState);
        }

        // 10. Initialize worktree locations (graceful degradation)
        for (const wt of worktreeEntries) {
          // Skip if already added as primary
          if (locationResolver.has(wt.hash)) continue;

          let wtConfig: PartialOpenTasksConfig | null = null;
          try {
            wtConfig = await loadConfigFile(path.dirname(wt.opentasksPath));
          } catch {
            // Config load failure is non-fatal
          }

          const wtState = await initLocation(
            wt.opentasksPath,
            wt.hash,
            false,
            wtConfig ?? undefined,
          );
          if (wtState) {
            locationResolver.add(wtState);
          }
        }

        // 11. Verify at least one location initialized
        if (locationResolver.list().length === 0) {
          throw new DaemonError('LOCATION_INIT_FAILED', 'No locations could be initialized');
        }

        // 12. Create IPC server
        ipcServer = createIPCServer(socketPath);

        // 13. Register method handlers
        registerLifecycleMethods({
          server: ipcServer,
          getStatus: () => daemon.getStatus(),
          shutdown: () => daemon.stop(),
          version,
          startedAt: new Date(startedAt),
          checkHealth: () => {
            const locations = locationResolver!.list();
            if (locations.length === 0) return 'unhealthy';
            const unhealthy = locations.filter((l) => !l.healthy);
            if (unhealthy.length === locations.length) return 'unhealthy';
            if (unhealthy.length > 0) return 'degraded';
            return 'healthy';
          },
        });

        registerGraphMethods({
          server: ipcServer,
          locationResolver,
        });

        registerToolsMethods({
          server: ipcServer,
          locationResolver,
          skillTrackerRegistry: sharedSkillTrackerRegistry,
        });

        registerProviderMethods({
          server: ipcServer,
          locationResolver,
        });

        registerContextFilesMethods({
          server: ipcServer,
          locationResolver,
        });

        registerLocationMethods({
          server: ipcServer,
          locationResolver,
          gitCommonDir,
        });

        registerWatchMethods({
          server: ipcServer,
          locationResolver,
        });

        // 14. Start IPC server
        await ipcServer.start();

        // 15. Mark as running
        state = 'running';
      } catch (error) {
        // Cleanup on failure
        state = 'stopped';
        startedAt = null;

        if (ipcServer) {
          try {
            await ipcServer.stop();
          } catch {
            /* ignore */
          }
          ipcServer = null;
        }

        // Tear down all initialized locations
        if (locationResolver) {
          for (const info of locationResolver.list()) {
            try {
              await locationResolver.remove(info.hash);
            } catch {
              /* ignore */
            }
          }
          locationResolver = null;
        }

        try {
          await lockManager.release();
        } catch {
          // Ignore release errors during cleanup
        }

        throw error;
      }
    },

    async stop(): Promise<void> {
      if (state === 'stopped' || state === 'stopping') {
        return;
      }

      if (state === 'starting') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (state === 'starting') {
          throw new DaemonError('SHUTDOWN_TIMEOUT', 'Cannot stop daemon while starting');
        }
      }

      state = 'stopping';

      const shutdownPromise = (async () => {
        try {
          removeSignalHandlers();

          // Stop IPC server
          if (ipcServer) {
            await ipcServer.stop();
            ipcServer = null;
          }

          // Tear down all locations (stop watchers, flush, close stores)
          if (locationResolver) {
            const locations = locationResolver.list();
            for (const info of locations) {
              try {
                await locationResolver.remove(info.hash);
              } catch {
                /* ignore during shutdown */
              }
            }
            locationResolver = null;
          }

          // Unregister, remove socket, release lock
          await registryManager.unregister(daemonHomePath);
          await removeSocketFile();
          await lockManager.release();
        } finally {
          state = 'stopped';
          startedAt = null;
        }
      })();

      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError('SHUTDOWN_TIMEOUT', 'Shutdown timed out'));
        }, shutdownTimeoutMs);
      });

      try {
        await Promise.race([shutdownPromise, timeoutPromise]);
      } catch (error) {
        state = 'stopped';
        startedAt = null;
        removeSignalHandlers();
        throw error;
      }
    },

    getStatus(): DaemonStatus {
      const locations = locationResolver?.list() ?? [];
      const hasPendingFlush = locations.some((info) => {
        try {
          const locState = locationResolver?.resolve(info.hash);
          return locState?.flushManager.hasPendingChanges() ?? false;
        } catch {
          return false;
        }
      });

      return {
        state,
        startedAt,
        pid: process.pid,
        socketPath,
        pendingFlush: hasPendingFlush,
        connectionCount: ipcServer?.getConnectionCount() ?? 0,
        locationCount: locations.length,
      };
    },
  };

  return daemon;
}
