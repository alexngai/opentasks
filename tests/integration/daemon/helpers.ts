/**
 * Daemon Test Helpers
 *
 * Utilities for spawning and managing daemon processes in integration tests.
 */

import { existsSync } from 'node:fs'
import { createDaemon, type Daemon, type DaemonConfig } from '../../../src/daemon/lifecycle.js'
import { createIPCServer, createIPCClient, type IPCServer, type IPCClient } from '../../../src/daemon/ipc.js'
import { waitFor, waitForFile, sleep } from '../helpers/index.js'

/**
 * Options for creating a test daemon
 */
export interface TestDaemonOptions {
  /** Path to .opentasks/ directory */
  locationPath: string
  /** Custom registry path (isolated for tests) */
  registryPath?: string
  /** OpenTasks version */
  version?: string
  /** Shutdown timeout in ms */
  shutdownTimeoutMs?: number
}

/**
 * Create a test daemon with isolated registry
 */
export function createTestDaemon(options: TestDaemonOptions): Daemon {
  const config: DaemonConfig = {
    locationPath: options.locationPath,
    version: options.version ?? '0.0.1-test',
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2000,
    registryPath: options.registryPath,
  }
  return createDaemon(config)
}

/**
 * Wait for a daemon socket to exist
 */
export async function waitForDaemonSocket(
  socketPath: string,
  timeoutMs = 5000
): Promise<void> {
  await waitForFile(socketPath, { timeout: timeoutMs })
}

/**
 * Wait for a daemon socket to be removed
 */
export async function waitForDaemonSocketRemoved(
  socketPath: string,
  timeoutMs = 5000
): Promise<void> {
  await waitFor(() => !existsSync(socketPath), {
    timeout: timeoutMs,
    message: `Socket ${socketPath} was not removed within ${timeoutMs}ms`,
  })
}

/**
 * Context for a running IPC server in tests
 */
export interface TestIPCContext {
  server: IPCServer
  socketPath: string
  createClient(): IPCClient
  stop(): Promise<void>
}

/**
 * Start a test IPC server
 */
export async function startTestIPCServer(socketPath: string): Promise<TestIPCContext> {
  const server = createIPCServer(socketPath)
  await server.start()

  return {
    server,
    socketPath,
    createClient(): IPCClient {
      return createIPCClient(socketPath)
    },
    async stop(): Promise<void> {
      await server.stop()
    },
  }
}

/**
 * Create multiple clients and connect them
 */
export async function createConnectedClients(
  socketPath: string,
  count: number
): Promise<IPCClient[]> {
  const clients: IPCClient[] = []

  for (let i = 0; i < count; i++) {
    const client = createIPCClient(socketPath)
    await client.connect()
    clients.push(client)
  }

  return clients
}

/**
 * Disconnect all clients
 */
export function disconnectAllClients(clients: IPCClient[]): void {
  for (const client of clients) {
    client.disconnect()
  }
}

/**
 * Run a function with a temporary IPC server
 */
export async function withIPCServer<T>(
  socketPath: string,
  fn: (ctx: TestIPCContext) => Promise<T>
): Promise<T> {
  const ctx = await startTestIPCServer(socketPath)
  try {
    return await fn(ctx)
  } finally {
    await ctx.stop()
  }
}

/**
 * Run a function with a temporary daemon
 */
export async function withDaemon<T>(
  options: TestDaemonOptions,
  fn: (daemon: Daemon) => Promise<T>
): Promise<T> {
  const daemon = createTestDaemon(options)
  await daemon.start()
  try {
    return await fn(daemon)
  } finally {
    await daemon.stop()
  }
}
