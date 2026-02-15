/**
 * Daemon Lifecycle Manager
 *
 * Manages the start/stop lifecycle of an OpenTasks daemon.
 * Supports two modes via unified createDaemon():
 *   - Single-location: one store, one location (backward compatible)
 *   - Multi-location: multiple worktrees under one git repo
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLockManager, type LockManager } from "./lock.js";
import { createRegistryManager, type RegistryManager } from "./registry.js";
import {
  DaemonError,
  type DaemonState,
  type DaemonStatus,
  type DaemonEntry,
} from "./types.js";
import { createIPCServer, type IPCServer } from "./ipc.js";
import { createFileWatcher, type FileWatcher } from "./watcher.js";
import { createDaemonFlushManager, type DaemonFlushManager } from "./flush.js";
import { createEntireWatcher, type EntireWatcher } from "./entire-watcher.js";
import {
  createEntireAutoLinker,
  type EntireAutoLinker,
} from "./entire-linker.js";
import { registerLifecycleMethods } from "./methods/lifecycle.js";
import { registerGraphMethods } from "./methods/graph.js";
import { registerToolsMethods } from "./methods/tools.js";
import { registerLocationMethods } from "./methods/location.js";
import type { GraphStore } from "../graph/store.js";
import {
  createProviderAwareStore,
  type ProviderAwareStore,
} from "../graph/provider-store.js";
import { registerProviderMethods } from "./methods/provider.js";
import { registerArchiveMethods } from "./methods/archive.js";
import type { PartialOpenTasksConfig } from "../config/index.js";
import { loadConfigFile } from "../config/loader.js";
import { createBeadsProvider } from "../providers/beads.js";
import { createSudocodeProvider } from "../providers/sudocode.js";
import { createClaudeTasksProvider } from "../providers/claude-tasks.js";
import {
  createLocationState,
  destroyLocationState,
  createSingleLocationResolver,
  createMultiLocationResolver,
  type LocationState,
  type LocationResolver,
} from "./location-state.js";
import { readWorktreeRegistry, type WorktreeEntry } from "../core/worktree.js";

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
export type DaemonConfig =
  | SingleLocationDaemonConfig
  | MultiLocationDaemonConfig;

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
function isMultiLocationConfig(
  config: DaemonConfig,
): config is MultiLocationDaemonConfig {
  return "gitCommonDir" in config;
}

// ============================================================================
// Provider Registration
// ============================================================================

/**
 * Register external providers on a ProviderAwareStore based on config.
 * Reads the `providers` section of the OpenTasks config and instantiates
 * enabled providers, registering them with the store's provider registry.
 */
function registerConfiguredProviders(
  providerStore: ProviderAwareStore,
  config?: PartialOpenTasksConfig,
): void {
  const providersConfig = config?.providers as
    | {
        beads?: { enabled?: boolean; executable?: string; timeout?: number };
        claudeTasks?: { enabled?: boolean };
        sudocode?: { enabled?: boolean; executable?: string; timeout?: number };
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
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Check if a daemon is already running for a location
 */
export async function checkExistingDaemon(
  locationPath: string,
): Promise<ExistingDaemonResult> {
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

function createSingleLocationDaemon(
  config: SingleLocationDaemonConfig,
): Daemon {
  const {
    locationPath,
    version,
    store,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    registryPath,
    openTasksConfig,
  } = config;

  // Use config values for paths, falling back to defaults
  const socketFileName = openTasksConfig?.daemon?.socketPath ?? "daemon.sock";
  const databaseFileName = openTasksConfig?.storage?.sqlitePath ?? "cache.db";

  const socketPath = path.join(locationPath, socketFileName);
  const databasePath = path.join(locationPath, databaseFileName);

  // State
  let state: DaemonState = "stopped";
  let startedAt: string | null = null;

  // Managers
  const lockManager: LockManager = createLockManager(locationPath);
  const registryManager: RegistryManager = createRegistryManager(registryPath);

  // Components (initialized in start(), torn down in stop())
  let ipcServer: IPCServer | null = null;
  let fileWatcher: FileWatcher | null = null;
  let flushManager: DaemonFlushManager | null = null;
  let activeProviderStore: ProviderAwareStore | null = null;
  let entireWatcher: EntireWatcher | null = null;
  let entireLinker: EntireAutoLinker | null = null;

  // Signal handlers (stored for cleanup)
  let signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];

  function setupSignalHandlers(daemon: Daemon): void {
    const handler = () => {
      void daemon.stop();
    };
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const daemon: Daemon = {
    socketPath,
    locationPath,

    async start(): Promise<void> {
      if (state !== "stopped") {
        throw new DaemonError(
          "DAEMON_ALREADY_RUNNING",
          `Daemon is already ${state}`,
        );
      }

      state = "starting";

      try {
        // 1. Check for existing daemon
        const existing = await checkExistingDaemon(locationPath);
        if (existing.running) {
          state = "stopped";
          throw new DaemonError(
            "DAEMON_ALREADY_RUNNING",
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
          (openTasksConfig?.defaultProvider as string | undefined) ?? "native";
        const providerStore = createProviderAwareStore(store, {
          defaultProvider,
        });

        // Register external providers from config
        registerConfiguredProviders(providerStore, openTasksConfig);
        activeProviderStore = providerStore;

        const locationState: LocationState = {
          hash: "primary",
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

        registerToolsMethods({
          server: ipcServer,
          locationResolver,
        });

        registerProviderMethods({
          server: ipcServer,
          locationResolver,
        });

        registerArchiveMethods({
          server: ipcServer,
          locationResolver,
        });

        // 10. Start IPC server (begin listening)
        await ipcServer.start();

        // 11. Create and start file watcher
        fileWatcher = createFileWatcher({ locationPath });

        fileWatcher.onchange((_event) => {
          // External changes detected. Full reload deferred.
        });

        await fileWatcher.start();

        // Update the location state's watcher reference
        locationState.watcher = fileWatcher;

        // 12. Start provider watching for watchable providers
        providerStore.startProviderWatching();

        // 13. Initialize Entire watcher + auto-linker (optional)
        try {
          entireWatcher = createEntireWatcher({ locationPath });
          entireLinker = createEntireAutoLinker({
            store,
            flushManager,
          });

          entireWatcher.onSessionEvent((event) => {
            void entireLinker!.handleSessionEvent(event);
          });

          await entireWatcher.start();
        } catch {
          // Entire integration is optional — continue without it
          entireWatcher = null;
          entireLinker = null;
        }

        // 13. Mark as running
        state = "running";
      } catch (error) {
        // Cleanup on failure
        state = "stopped";
        startedAt = null;

        if (entireWatcher) {
          try {
            await entireWatcher.stop();
          } catch {
            /* ignore */
          }
          entireWatcher = null;
          entireLinker = null;
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
      if (state === "stopped" || state === "stopping") {
        return;
      }

      if (state === "starting") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (state === "starting") {
          throw new DaemonError(
            "SHUTDOWN_TIMEOUT",
            "Cannot stop daemon while starting",
          );
        }
      }

      state = "stopping";

      const shutdownPromise = (async () => {
        try {
          removeSignalHandlers();

          if (ipcServer) {
            await ipcServer.stop();
            ipcServer = null;
          }

          // Stop Entire watcher before file watcher
          if (entireWatcher) {
            await entireWatcher.stop();
            entireWatcher = null;
            entireLinker = null;
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

          await store.close();
          await registryManager.unregister(locationPath);
          await removeSocketFile();
          await lockManager.release();
        } finally {
          state = "stopped";
          startedAt = null;
        }
      })();

      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError("SHUTDOWN_TIMEOUT", "Shutdown timed out"));
        }, shutdownTimeoutMs);
      });

      try {
        await Promise.race([shutdownPromise, timeoutPromise]);
      } catch (error) {
        state = "stopped";
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
  const daemonHomePath = path.join(gitCommonDir, "opentasks");
  const socketPath = path.join(daemonHomePath, "daemon.sock");
  const databasePath = path.join(daemonHomePath, "cache.db");

  // Primary location: override or auto-detect (git root's .opentasks/)
  const gitRoot = path.dirname(gitCommonDir); // /repo/.git → /repo
  const defaultPrimaryPath = path.join(gitRoot, ".opentasks");
  const primaryPath = primaryOverride ?? defaultPrimaryPath;

  // State
  let state: DaemonState = "stopped";
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
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Initialize a location, returning its state. Returns null on failure (degraded mode).
   */
  async function initLocation(
    opentasksPath: string,
    hash: string,
    isPrimary: boolean,
    locationConfig?: PartialOpenTasksConfig,
  ): Promise<LocationState | null> {
    try {
      const locState = await createLocationState(
        opentasksPath,
        hash,
        isPrimary,
      );
      // Wrap store with provider-aware dispatch
      const defaultProvider =
        (locationConfig?.defaultProvider as string | undefined) ?? "native";
      locState.providerStore = createProviderAwareStore(locState.store, {
        defaultProvider,
      });

      // Register external providers from config
      registerConfiguredProviders(locState.providerStore, locationConfig);

      await locState.watcher.start();

      // Start provider watching for watchable providers
      locState.providerStore.startProviderWatching();

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
    return "primary";
  }

  const daemon: Daemon = {
    socketPath,
    locationPath: daemonHomePath,

    async start(): Promise<void> {
      if (state !== "stopped") {
        throw new DaemonError(
          "DAEMON_ALREADY_RUNNING",
          `Daemon is already ${state}`,
        );
      }

      state = "starting";

      try {
        // 1. Ensure daemon home directory exists
        await fs.mkdir(daemonHomePath, { recursive: true });

        // 2. Check for existing daemon
        const existing = await checkExistingDaemon(daemonHomePath);
        if (existing.running) {
          state = "stopped";
          throw new DaemonError(
            "DAEMON_ALREADY_RUNNING",
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
          throw new DaemonError(
            "LOCATION_INIT_FAILED",
            "No locations could be initialized",
          );
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
            if (locations.length === 0) return "unhealthy";
            const unhealthy = locations.filter((l) => !l.healthy);
            if (unhealthy.length === locations.length) return "unhealthy";
            if (unhealthy.length > 0) return "degraded";
            return "healthy";
          },
        });

        registerGraphMethods({
          server: ipcServer,
          locationResolver,
        });

        registerToolsMethods({
          server: ipcServer,
          locationResolver,
        });

        registerProviderMethods({
          server: ipcServer,
          locationResolver,
        });

        registerLocationMethods({
          server: ipcServer,
          locationResolver,
          gitCommonDir,
        });

        // 14. Start IPC server
        await ipcServer.start();

        // 15. Mark as running
        state = "running";
      } catch (error) {
        // Cleanup on failure
        state = "stopped";
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
      if (state === "stopped" || state === "stopping") {
        return;
      }

      if (state === "starting") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (state === "starting") {
          throw new DaemonError(
            "SHUTDOWN_TIMEOUT",
            "Cannot stop daemon while starting",
          );
        }
      }

      state = "stopping";

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
          state = "stopped";
          startedAt = null;
        }
      })();

      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new DaemonError("SHUTDOWN_TIMEOUT", "Shutdown timed out"));
        }, shutdownTimeoutMs);
      });

      try {
        await Promise.race([shutdownPromise, timeoutPromise]);
      } catch (error) {
        state = "stopped";
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
