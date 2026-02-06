/**
 * Locked JSONL Writer for OpenTasks (Phase 2)
 *
 * Wraps JSONL append operations with advisory file locking
 * for safe concurrent access across multiple processes.
 */

import * as path from 'node:path'
import type { StoredNode, StoredEdge } from '../schema/storage.js'
import { JSONLPersister } from './jsonl.js'
import { withFileLock } from './file-lock.js'

/**
 * Configuration for the locked writer
 */
export interface LockedWriterConfig {
  /** Path to the .opentasks directory */
  basePath: string
  /** Lock acquisition timeout (ms) */
  lockTimeout?: number
}

/**
 * Locked JSONL writer
 *
 * All write operations acquire an advisory file lock before
 * appending to graph.jsonl. Reads do NOT require the lock
 * (SQLite WAL handles concurrent reads).
 */
export class LockedJsonlWriter {
  private readonly persister: JSONLPersister
  private readonly lockPath: string
  private readonly lockTimeout: number

  constructor(config: LockedWriterConfig) {
    this.persister = new JSONLPersister({
      path: path.join(config.basePath, 'graph.jsonl'),
    })
    this.lockPath = path.join(config.basePath, 'write.lock')
    this.lockTimeout = config.lockTimeout ?? 5000
  }

  /**
   * Append a single entry while holding the write lock
   */
  async appendLocked(entry: StoredNode | StoredEdge): Promise<void> {
    await withFileLock(
      this.lockPath,
      async () => {
        await this.persister.append(entry)
      },
      this.lockTimeout
    )
  }

  /**
   * Append multiple entries while holding the write lock
   */
  async appendManyLocked(entries: Array<StoredNode | StoredEdge>): Promise<void> {
    if (entries.length === 0) return

    await withFileLock(
      this.lockPath,
      async () => {
        await this.persister.appendMany(entries)
      },
      this.lockTimeout
    )
  }

  /**
   * Save (overwrite) the entire file while holding the write lock
   */
  async saveLocked(nodes: StoredNode[], edges: StoredEdge[]): Promise<void> {
    await withFileLock(
      this.lockPath,
      async () => {
        await this.persister.save(nodes, edges)
      },
      this.lockTimeout
    )
  }

  /**
   * Load from JSONL (no lock needed — reads are safe)
   */
  async load() {
    return this.persister.load()
  }

  /**
   * Get the underlying persister for non-locked operations
   */
  get underlying(): JSONLPersister {
    return this.persister
  }
}

/**
 * Deduplicate JSONL entries by keeping the latest updated_at per ID
 *
 * Used during cache rebuild to resolve append-only duplicates.
 *
 * @param nodes - All node entries (may include duplicates)
 * @returns Deduplicated nodes
 */
export function deduplicateNodes(nodes: StoredNode[]): StoredNode[] {
  const map = new Map<string, StoredNode>()

  for (const node of nodes) {
    const existing = map.get(node.id)
    if (!existing || node.updated_at > existing.updated_at) {
      map.set(node.id, node)
    }
  }

  return Array.from(map.values())
}

/**
 * Deduplicate edge entries by keeping the latest per ID
 *
 * @param edges - All edge entries (may include duplicates)
 * @returns Deduplicated edges
 */
export function deduplicateEdges(edges: StoredEdge[]): StoredEdge[] {
  const map = new Map<string, StoredEdge>()

  for (const edge of edges) {
    const existing = map.get(edge.id)
    if (!existing || (edge.created_at && existing.created_at && edge.created_at > existing.created_at)) {
      map.set(edge.id, edge)
    }
  }

  return Array.from(map.values())
}
