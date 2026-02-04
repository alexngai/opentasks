/**
 * Wait Utilities for Integration Tests
 *
 * Helpers for waiting on async conditions with timeouts.
 */

import { existsSync, statSync } from 'node:fs'

/**
 * Options for wait functions
 */
export interface WaitOptions {
  /** Maximum time to wait in ms */
  timeout?: number
  /** Interval between checks in ms */
  interval?: number
  /** Message to include in timeout error */
  message?: string
}

const DEFAULT_TIMEOUT = 10000
const DEFAULT_INTERVAL = 100

/**
 * Wait for a condition to become true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {}
): Promise<void> {
  const { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_INTERVAL, message } = options

  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return
    }
    await sleep(interval)
  }

  throw new Error(message ?? `Condition not met within ${timeout}ms`)
}

/**
 * Wait for a file to exist
 */
export async function waitForFile(
  filePath: string,
  options: WaitOptions = {}
): Promise<void> {
  await waitFor(() => existsSync(filePath), {
    ...options,
    message: options.message ?? `File ${filePath} did not appear within ${options.timeout ?? DEFAULT_TIMEOUT}ms`,
  })
}

/**
 * Wait for a file to be modified after a given time
 */
export async function waitForFileModified(
  filePath: string,
  afterTime: number,
  options: WaitOptions = {}
): Promise<void> {
  await waitFor(() => {
    if (!existsSync(filePath)) return false
    const stats = statSync(filePath)
    return stats.mtimeMs > afterTime
  }, {
    ...options,
    message: options.message ?? `File ${filePath} was not modified within ${options.timeout ?? DEFAULT_TIMEOUT}ms`,
  })
}

/**
 * Wait for a socket file to exist (indicating daemon is ready)
 */
export async function waitForSocket(
  socketPath: string,
  options: WaitOptions = {}
): Promise<void> {
  await waitFor(() => existsSync(socketPath), {
    ...options,
    message: options.message ?? `Socket ${socketPath} did not appear within ${options.timeout ?? DEFAULT_TIMEOUT}ms`,
  })
}

/**
 * Wait for a socket file to be removed (indicating daemon has shut down)
 */
export async function waitForSocketRemoved(
  socketPath: string,
  options: WaitOptions = {}
): Promise<void> {
  await waitFor(() => !existsSync(socketPath), {
    ...options,
    message: options.message ?? `Socket ${socketPath} was not removed within ${options.timeout ?? DEFAULT_TIMEOUT}ms`,
  })
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry an async function until it succeeds or times out
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: WaitOptions = {}
): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_INTERVAL, message } = options

  const startTime = Date.now()
  let lastError: Error | undefined

  while (Date.now() - startTime < timeout) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error
      await sleep(interval)
    }
  }

  throw new Error(
    message ?? `Retry failed after ${timeout}ms: ${lastError?.message ?? 'Unknown error'}`
  )
}
