/**
 * Lifecycle Method Handlers
 *
 * JSON-RPC method handlers for daemon lifecycle operations.
 */

import type { IPCServer } from '../ipc.js';
import type { DaemonStatus } from '../types.js';
import type { DaemonHealthSnapshot } from '../health-counters.js';
import type { SyncerHealth } from '../../graph/git-graph-syncer.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  version: string;

  /**
   * Counters for otherwise-silent watcher/reconcile failures + liveness
   * timestamps (F10). Omitted if the daemon wasn't given a counters source.
   */
  counters?: DaemonHealthSnapshot;

  /**
   * Git sync health (last error/op/success + cumulative error count), or null
   * when git sync is disabled. Omitted if no sync-health source was provided.
   */
  sync?: SyncerHealth | null;
}

/**
 * Status getter function
 */
export type StatusGetter = () => DaemonStatus;

/**
 * Shutdown handler function
 */
export type ShutdownHandler = () => Promise<void>;

/**
 * Health checker function for multi-location awareness
 */
export type HealthChecker = () => 'healthy' | 'degraded' | 'unhealthy';

/**
 * Options for registering lifecycle methods
 */
export interface LifecycleMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Function to get current daemon status */
  getStatus: StatusGetter;

  /** Function to trigger shutdown */
  shutdown: ShutdownHandler;

  /** OpenTasks version */
  version: string;

  /** Timestamp when daemon started */
  startedAt: Date;

  /** Optional health checker for multi-location awareness */
  checkHealth?: HealthChecker;

  /** Optional source of watcher/reconcile failure counters (F10) */
  getHealthCounters?: () => DaemonHealthSnapshot;

  /** Optional source of git sync health (null when sync is disabled) (F10) */
  getSyncHealth?: () => SyncerHealth | null;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register lifecycle method handlers on an IPC server
 */
export function registerLifecycleMethods(options: LifecycleMethodsOptions): void {
  const { server, getStatus, shutdown, version, startedAt, checkHealth, getHealthCounters, getSyncHealth } =
    options;

  // ping - Simple health check
  server.handle('ping', async () => {
    return { pong: true };
  });

  // health - Detailed health information
  server.handle('health', async (): Promise<HealthResponse> => {
    const memory = process.memoryUsage();
    const uptime = Date.now() - startedAt.getTime();

    return {
      status: checkHealth ? checkHealth() : 'healthy',
      uptime,
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
      },
      version,
      ...(getHealthCounters ? { counters: getHealthCounters() } : {}),
      ...(getSyncHealth ? { sync: getSyncHealth() } : {}),
    };
  });

  // status - Daemon status and stats
  server.handle('status', async (): Promise<DaemonStatus> => {
    return getStatus();
  });

  // shutdown - Graceful shutdown
  server.handle('shutdown', async () => {
    // Schedule shutdown after response is sent
    setImmediate(() => {
      void shutdown();
    });

    return { success: true };
  });
}
