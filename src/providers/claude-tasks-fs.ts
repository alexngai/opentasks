/**
 * Filesystem-backed ClaudeTaskStore
 *
 * Persists Claude tasks as individual JSON files on disk.
 * Uses advisory file locking for safe concurrent access.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from '../storage/file-lock.js';
import { ProviderError } from './types.js';
import type { ClaudeTask, ClaudeTaskStore } from './claude-tasks.js';

// ============================================================================
// Types
// ============================================================================

export interface FilesystemTaskStoreOptions {
  /** Directory where task JSON files are stored */
  basePath: string;
  /** Lock acquisition timeout in ms (default 5000) */
  lockTimeout?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LOCK_TIMEOUT = 5000;
const HIGHWATERMARK_FILE = '.highwatermark';
const LOCK_FILE = '.lock';
const TMP_SUFFIX = '.tmp';

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a filesystem-backed task store.
 *
 * Each task is stored as `<basePath>/<id>.json`. A `.highwatermark` file
 * tracks the next ID to assign. All mutating operations are serialized
 * through an advisory file lock.
 */
export function createFilesystemTaskStore(options: FilesystemTaskStoreOptions): ClaudeTaskStore {
  const { basePath, lockTimeout = DEFAULT_LOCK_TIMEOUT } = options;
  const lockPath = path.join(basePath, LOCK_FILE);

  // Ensure base directory exists
  fs.mkdirSync(basePath, { recursive: true });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function taskPath(id: string): string {
    return path.join(basePath, `${id}.json`);
  }

  function highwatermarkPath(): string {
    return path.join(basePath, HIGHWATERMARK_FILE);
  }

  function readHighwatermark(): number {
    try {
      const content = fs.readFileSync(highwatermarkPath(), 'utf-8');
      const value = parseInt(content.trim(), 10);
      return Number.isNaN(value) ? 0 : value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw err;
    }
  }

  function writeHighwatermark(value: number): void {
    const tmpPath = highwatermarkPath() + TMP_SUFFIX;
    fs.writeFileSync(tmpPath, String(value), 'utf-8');
    fs.renameSync(tmpPath, highwatermarkPath());
  }

  function atomicWriteJson(filePath: string, data: unknown): void {
    const tmpPath = filePath + TMP_SUFFIX;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  function readTaskFile(id: string): ClaudeTask | null {
    try {
      const content = fs.readFileSync(taskPath(id), 'utf-8');
      return JSON.parse(content) as ClaudeTask;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Store implementation
  // ---------------------------------------------------------------------------

  return {
    async get(id: string): Promise<ClaudeTask | null> {
      return readTaskFile(id);
    },

    async list(): Promise<ClaudeTask[]> {
      let entries: string[];
      try {
        entries = fs.readdirSync(basePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw err;
      }

      const tasks: ClaudeTask[] = [];
      for (const entry of entries) {
        // Skip dotfiles and non-json files
        if (entry.startsWith('.') || !entry.endsWith('.json')) {
          continue;
        }
        try {
          const content = fs.readFileSync(path.join(basePath, entry), 'utf-8');
          tasks.push(JSON.parse(content) as ClaudeTask);
        } catch {
          // Skip files that can't be parsed
        }
      }

      // Sort by numeric ID ascending
      tasks.sort((a, b) => {
        const numA = parseInt(a.id, 10);
        const numB = parseInt(b.id, 10);
        if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
          return numA - numB;
        }
        return a.id.localeCompare(b.id);
      });

      return tasks;
    },

    async create(task: Omit<ClaudeTask, 'id'>): Promise<ClaudeTask> {
      return withFileLock(
        lockPath,
        async () => {
          const current = readHighwatermark();
          const nextId = current + 1;
          writeHighwatermark(nextId);

          const id = String(nextId);
          const newTask: ClaudeTask = { ...task, id };
          atomicWriteJson(taskPath(id), newTask);
          return newTask;
        },
        lockTimeout,
      );
    },

    async update(id: string, updates: Partial<ClaudeTask>): Promise<ClaudeTask> {
      return withFileLock(
        lockPath,
        async () => {
          const existing = readTaskFile(id);
          if (!existing) {
            throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude');
          }
          const updated: ClaudeTask = { ...existing, ...updates, id };
          atomicWriteJson(taskPath(id), updated);
          return updated;
        },
        lockTimeout,
      );
    },

    async delete(id: string): Promise<void> {
      return withFileLock(
        lockPath,
        async () => {
          const filePath = taskPath(id);
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new ProviderError('NOT_FOUND', `Task not found: ${id}`, 'claude');
            }
            throw err;
          }
        },
        lockTimeout,
      );
    },
  };
}
