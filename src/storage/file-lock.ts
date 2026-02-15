/**
 * Advisory File Lock for JSONL Writes (Phase 2)
 *
 * Serializes write access to graph.jsonl across multiple processes.
 * Uses fs.open with exclusive flag + lockfile pattern.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Configuration for file lock
 */
export interface FileLockConfig {
  /** Path to the lock file (e.g., ".opentasks/write.lock") */
  lockPath: string;
  /** Timeout for acquiring lock (ms) */
  timeout?: number;
  /** Retry interval (ms) */
  retryInterval?: number;
  /** Stale lock timeout (ms) — locks older than this are considered abandoned */
  staleTimeout?: number;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRY_INTERVAL = 50;
const DEFAULT_STALE_TIMEOUT = 30000;

/**
 * Advisory file lock for serializing JSONL writes
 *
 * Uses a lock file with PID to detect stale locks.
 */
export class FileLock {
  private readonly config: Required<FileLockConfig>;
  private fd: number | null = null;
  private acquired = false;

  constructor(config: FileLockConfig) {
    this.config = {
      lockPath: config.lockPath,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      retryInterval: config.retryInterval ?? DEFAULT_RETRY_INTERVAL,
      staleTimeout: config.staleTimeout ?? DEFAULT_STALE_TIMEOUT,
    };
  }

  /**
   * Acquire the lock
   *
   * Blocks (with polling) until the lock is acquired or timeout expires.
   *
   * @throws Error if lock cannot be acquired within timeout
   */
  async acquire(): Promise<void> {
    if (this.acquired) {
      throw new Error('Lock already acquired');
    }

    const dir = path.dirname(this.config.lockPath);
    fs.mkdirSync(dir, { recursive: true });

    const startTime = Date.now();

    while (true) {
      try {
        // Try to create lock file exclusively
        this.fd = fs.openSync(
          this.config.lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );

        // Write PID for stale detection
        const content = `${process.pid}\n${Date.now()}\n`;
        fs.writeSync(this.fd, content);

        this.acquired = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Lock exists — check if it's stale
          if (this.isStale()) {
            this.breakLock();
            continue;
          }

          // Check timeout
          if (Date.now() - startTime >= this.config.timeout) {
            throw new Error(
              `Failed to acquire lock within ${this.config.timeout}ms: ${this.config.lockPath}`,
            );
          }

          // Wait and retry
          await sleep(this.config.retryInterval);
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Release the lock
   */
  release(): void {
    if (!this.acquired) return;

    try {
      if (this.fd !== null) {
        fs.closeSync(this.fd);
        this.fd = null;
      }
    } catch {
      // Ignore close errors
    }

    try {
      fs.unlinkSync(this.config.lockPath);
    } catch {
      // Ignore unlink errors (file may already be removed)
    }

    this.acquired = false;
  }

  /**
   * Check if the current lock file is stale
   */
  private isStale(): boolean {
    try {
      const content = fs.readFileSync(this.config.lockPath, 'utf-8');
      const lines = content.trim().split('\n');
      const pid = parseInt(lines[0], 10);
      const timestamp = parseInt(lines[1], 10);

      // Check if the process is still running
      if (pid && !isProcessRunning(pid)) {
        return true;
      }

      // Check if the lock is too old
      if (timestamp && Date.now() - timestamp > this.config.staleTimeout) {
        return true;
      }

      return false;
    } catch {
      // If we can't read the lock file, treat as stale
      return true;
    }
  }

  /**
   * Forcefully break a stale lock
   */
  private breakLock(): void {
    try {
      fs.unlinkSync(this.config.lockPath);
    } catch {
      // Ignore
    }
  }

  /**
   * Whether the lock is currently held
   */
  get isLocked(): boolean {
    return this.acquired;
  }
}

/**
 * Execute a function while holding a file lock
 *
 * Automatically acquires and releases the lock.
 *
 * @param lockPath - Path to the lock file
 * @param fn - Function to execute while holding the lock
 * @param timeout - Lock acquisition timeout (ms)
 * @returns The return value of fn
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeout?: number,
): Promise<T> {
  const lock = new FileLock({ lockPath, timeout });

  await lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
