/**
 * Lifecycle Method Handlers
 *
 * JSON-RPC method handlers for daemon lifecycle operations.
 */

import type { IPCServer } from '../ipc.js';
import type { DaemonStatus } from '../types.js';

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
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register lifecycle method handlers on an IPC server
 */
export function registerLifecycleMethods(options: LifecycleMethodsOptions): void {
  const { server, getStatus, shutdown, version, startedAt, checkHealth } = options;

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
