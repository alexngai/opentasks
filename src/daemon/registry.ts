/**
 * Global Daemon Registry
 *
 * Manages the global registry of all running OpenTasks daemons.
 * Located at ~/.opentasks/registry.json
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import lockfile from 'proper-lockfile';
import { DaemonError, type DaemonRegistry, type DaemonEntry } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Registry manager interface
 */
export interface RegistryManager {
  /** Register daemon on startup */
  register(entry: DaemonEntry): Promise<void>;

  /** Unregister daemon on shutdown */
  unregister(locationPath: string): Promise<void>;

  /** Find daemon for a location */
  find(locationPath: string): Promise<DaemonEntry | null>;

  /** List all registered daemons */
  list(): Promise<DaemonEntry[]>;

  /** Remove stale entries (dead PIDs) */
  cleanup(): Promise<number>;

  /** Get the registry file path */
  readonly registryPath: string;
}

// ============================================================================
// Constants
// ============================================================================

const REGISTRY_VERSION = '1.0.0';

/**
 * Get the default global registry path
 */
export function getGlobalRegistryPath(): string {
  const globalDir = process.env.OPENTASKS_HOME || path.join(os.homedir(), '.opentasks');
  return path.join(globalDir, 'registry.json');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a process is alive
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create empty registry
 */
function createEmptyRegistry(): DaemonRegistry {
  return {
    version: REGISTRY_VERSION,
    daemons: [],
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a registry manager
 *
 * @param registryPath - Path to registry.json file (defaults to ~/.opentasks/registry.json)
 */
export function createRegistryManager(
  registryPath: string = getGlobalRegistryPath(),
): RegistryManager {
  const registryDir = path.dirname(registryPath);

  /**
   * Ensure registry directory and file exist
   */
  async function ensureRegistry(): Promise<void> {
    // Create directory if missing
    await fs.mkdir(registryDir, { recursive: true });

    // Create registry file if missing
    try {
      await fs.access(registryPath);
    } catch {
      await writeRegistry(createEmptyRegistry());
    }
  }

  /**
   * Read the registry file
   */
  async function readRegistry(): Promise<DaemonRegistry> {
    try {
      const contents = await fs.readFile(registryPath, 'utf8');
      return JSON.parse(contents) as DaemonRegistry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createEmptyRegistry();
      }
      throw new DaemonError('REGISTRY_ERROR', 'Failed to read registry', error);
    }
  }

  /**
   * Write the registry file atomically
   */
  async function writeRegistry(registry: DaemonRegistry): Promise<void> {
    const tempPath = `${registryPath}.tmp.${process.pid}`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(registry, null, 2), 'utf8');
      await fs.rename(tempPath, registryPath);
    } catch (error) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new DaemonError('REGISTRY_ERROR', 'Failed to write registry', error);
    }
  }

  /**
   * Execute an operation with file locking
   */
  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensureRegistry();

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(registryPath, {
        stale: 10000,
        retries: {
          retries: 5,
          minTimeout: 100,
          maxTimeout: 1000,
        },
      });

      return await operation();
    } catch (error) {
      if ((error as Error).message?.includes('ELOCKED')) {
        throw new DaemonError('REGISTRY_ERROR', 'Registry is locked by another process', error);
      }
      throw error;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore release errors
        }
      }
    }
  }

  return {
    registryPath,

    async register(entry: DaemonEntry): Promise<void> {
      await withLock(async () => {
        const registry = await readRegistry();

        // Remove any existing entry for this location
        registry.daemons = registry.daemons.filter((d) => d.locationPath !== entry.locationPath);

        // Add new entry
        registry.daemons.push(entry);

        await writeRegistry(registry);
      });
    },

    async unregister(locationPath: string): Promise<void> {
      await withLock(async () => {
        const registry = await readRegistry();

        registry.daemons = registry.daemons.filter((d) => d.locationPath !== locationPath);

        await writeRegistry(registry);
      });
    },

    async find(locationPath: string): Promise<DaemonEntry | null> {
      const registry = await readRegistry();
      const entry = registry.daemons.find((d) => d.locationPath === locationPath);

      if (!entry) {
        return null;
      }

      // Verify daemon is still alive
      if (!isProcessAlive(entry.pid)) {
        return null;
      }

      return entry;
    },

    async list(): Promise<DaemonEntry[]> {
      const registry = await readRegistry();
      return registry.daemons;
    },

    async cleanup(): Promise<number> {
      return await withLock(async () => {
        const registry = await readRegistry();
        const originalCount = registry.daemons.length;

        // Filter out dead processes
        registry.daemons = registry.daemons.filter((d) => isProcessAlive(d.pid));

        const removedCount = originalCount - registry.daemons.length;

        if (removedCount > 0) {
          await writeRegistry(registry);
        }

        return removedCount;
      });
    },
  };
}
