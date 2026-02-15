/**
 * Lock File Manager
 *
 * Manages exclusive daemon lock for .opentasks/ locations.
 * Ensures only one daemon per location using file-based locking.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { DaemonError, type DaemonLock, type LockMetadata } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Lock manager interface
 */
export interface LockManager {
  /** Attempt to acquire lock, throws if already held by live process */
  acquire(metadata: LockMetadata): Promise<void>;

  /** Release the lock */
  release(): Promise<void>;

  /** Check if lock is held by a live process */
  isHeld(): Promise<boolean>;

  /** Read lock file contents (if exists) */
  read(): Promise<DaemonLock | null>;

  /** Get the lock file path */
  readonly lockPath: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a process is alive
 */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process but checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a lock manager for a .opentasks/ location
 *
 * @param locationPath - Path to .opentasks/ directory
 */
export function createLockManager(locationPath: string): LockManager {
  const lockPath = path.join(locationPath, 'daemon.lock');
  let releaseFunction: (() => Promise<void>) | null = null;

  return {
    lockPath,

    async acquire(metadata: LockMetadata): Promise<void> {
      // Check if already holding lock
      if (releaseFunction) {
        throw new DaemonError('LOCK_HELD', 'Lock already held by this process');
      }

      // Check for existing lock
      const existing = await this.read();
      if (existing && isProcessAlive(existing.pid)) {
        throw new DaemonError(
          'DAEMON_ALREADY_RUNNING',
          `Daemon already running (PID ${existing.pid}) at ${existing.socketPath}`,
        );
      }

      // If stale lock exists, remove it first
      if (existing) {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Ignore if already removed
        }
      }

      // Write lock file contents first
      const lockContents: DaemonLock = {
        pid: process.pid,
        parentPid: process.ppid,
        startedAt: new Date().toISOString(),
        ...metadata,
      };

      // Ensure directory exists
      await fs.mkdir(locationPath, { recursive: true });

      // Write initial lock file
      await fs.writeFile(lockPath, JSON.stringify(lockContents, null, 2), 'utf8');

      try {
        // Acquire exclusive lock on the file
        releaseFunction = await lockfile.lock(lockPath, {
          stale: 10000, // Consider stale after 10s without update
          update: 5000, // Update lock file every 5s to prevent stale
          retries: 0, // Don't retry, fail immediately
        });
      } catch (error) {
        // Clean up the file we created
        try {
          await fs.unlink(lockPath);
        } catch {
          // Ignore cleanup errors
        }
        throw new DaemonError('LOCK_HELD', 'Failed to acquire exclusive lock', error);
      }
    },

    async release(): Promise<void> {
      if (!releaseFunction) {
        throw new DaemonError('LOCK_NOT_HELD', 'Lock not held by this process');
      }

      try {
        // Release the proper-lockfile lock
        await releaseFunction();
      } finally {
        releaseFunction = null;
      }

      // Remove the lock file
      try {
        await fs.unlink(lockPath);
      } catch {
        // Ignore if already removed
      }
    },

    async isHeld(): Promise<boolean> {
      const lock = await this.read();
      if (!lock) {
        return false;
      }
      return isProcessAlive(lock.pid);
    },

    async read(): Promise<DaemonLock | null> {
      try {
        const contents = await fs.readFile(lockPath, 'utf8');
        return JSON.parse(contents) as DaemonLock;
      } catch (error) {
        // File doesn't exist or is invalid
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        // Log but don't throw for parse errors - treat as no lock
        return null;
      }
    },
  };
}
