/**
 * JSONL Persister for OpenTasks
 *
 * Git-friendly JSONL storage as source of truth.
 * Each line is a JSON object (node or edge).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StoredNode, StoredEdge } from '../schema/storage.js';
import { atomicWrite, appendToFile, fileExists, readFileOrEmpty } from './atomic-write.js';

/**
 * Configuration for JSONL Persister
 */
export interface JSONLPersisterConfig {
  /** Path to the JSONL file (e.g., ".opentasks/graph.jsonl") */
  path: string;

  /** Optional path for tombstones (soft deletes) */
  tombstonesPath?: string;

  /** Use atomic writes (default: true) */
  atomicWrite?: boolean;
}

/**
 * Result of loading a JSONL file
 */
export interface LoadResult {
  nodes: StoredNode[];
  edges: StoredEdge[];
}

/**
 * Determine if a parsed JSON object is an edge
 *
 * Edges have from_id and to_id fields, or id starting with 'x-'
 */
function isEdge(obj: Record<string, unknown>): boolean {
  return (
    ('from_id' in obj && 'to_id' in obj) || (typeof obj.id === 'string' && obj.id.startsWith('x-'))
  );
}

/**
 * JSONL Persister
 *
 * Handles reading/writing graph data to JSONL files.
 * Source of truth for OpenTasks data.
 */
export class JSONLPersister {
  private readonly config: Required<JSONLPersisterConfig>;
  private watcher: fs.FSWatcher | null = null;

  constructor(config: JSONLPersisterConfig) {
    this.config = {
      path: config.path,
      tombstonesPath: config.tombstonesPath || config.path.replace('.jsonl', '.tombstones.jsonl'),
      atomicWrite: config.atomicWrite ?? true,
    };
  }

  /**
   * Get the file path
   */
  get filePath(): string {
    return this.config.path;
  }

  /**
   * Check if the JSONL file exists
   */
  async exists(): Promise<boolean> {
    return fileExists(this.config.path);
  }

  /**
   * Load the entire graph from JSONL
   *
   * Parses each line as JSON and separates nodes from edges.
   * Invalid lines are skipped with a warning.
   *
   * @returns Object with nodes and edges arrays
   */
  async load(): Promise<LoadResult> {
    const content = await readFileOrEmpty(this.config.path);

    if (!content.trim()) {
      return { nodes: [], edges: [] };
    }

    const nodes: StoredNode[] = [];
    const edges: StoredEdge[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const obj = JSON.parse(line) as Record<string, unknown>;

        if (isEdge(obj)) {
          edges.push(obj as unknown as StoredEdge);
        } else {
          nodes.push(obj as StoredNode);
        }
      } catch (error) {
        console.warn(`Invalid JSON at line ${i + 1}: ${line.slice(0, 50)}...`);
      }
    }

    return { nodes, edges };
  }

  /**
   * Save the entire graph to JSONL
   *
   * Overwrites the file with all nodes and edges.
   * Uses atomic write by default (temp file + rename).
   *
   * @param nodes - All nodes to save
   * @param edges - All edges to save
   */
  async save(nodes: StoredNode[], edges: StoredEdge[]): Promise<void> {
    const lines: string[] = [];

    // Nodes first
    for (const node of nodes) {
      lines.push(JSON.stringify(node));
    }

    // Then edges
    for (const edge of edges) {
      lines.push(JSON.stringify(edge));
    }

    const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');

    if (this.config.atomicWrite) {
      await atomicWrite(this.config.path, content);
    } else {
      const dir = path.dirname(this.config.path);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.config.path, content, 'utf-8');
    }
  }

  /**
   * Append a single entry to the JSONL file
   *
   * Useful for incremental writes without rewriting the entire file.
   * Note: This can lead to duplicate entries; use save() for clean state.
   *
   * @param entry - Node or edge to append
   */
  async append(entry: StoredNode | StoredEdge): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    await appendToFile(this.config.path, line);
  }

  /**
   * Append multiple entries to the JSONL file
   *
   * @param entries - Nodes or edges to append
   */
  async appendMany(entries: Array<StoredNode | StoredEdge>): Promise<void> {
    if (entries.length === 0) return;

    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendToFile(this.config.path, lines);
  }

  /**
   * Watch the JSONL file for external changes
   *
   * Calls the callback when the file is modified.
   * Uses debouncing to avoid multiple calls for rapid changes.
   *
   * @param callback - Function to call on file change
   * @returns Unsubscribe function
   */
  watch(callback: () => void): () => void {
    if (this.watcher) {
      this.watcher.close();
    }

    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedCallback = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        callback();
        debounceTimer = null;
      }, 100);
    };

    try {
      this.watcher = fs.watch(this.config.path, (eventType) => {
        if (eventType === 'change') {
          debouncedCallback();
        }
      });

      this.watcher.on('error', (error) => {
        console.warn('File watcher error:', error);
      });
    } catch (error) {
      // File might not exist yet - that's OK
      console.warn('Could not watch file:', this.config.path);
    }

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
    };
  }

  /**
   * Stop watching the file
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Delete the JSONL file
   *
   * Use with caution - this removes all data.
   */
  async delete(): Promise<void> {
    try {
      await fs.promises.unlink(this.config.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * Create a JSONL persister with default configuration
 *
 * @param basePath - Base directory (e.g., ".opentasks")
 * @returns Configured JSONLPersister
 */
export function createJSONLPersister(basePath: string): JSONLPersister {
  return new JSONLPersister({
    path: path.join(basePath, 'graph.jsonl'),
    tombstonesPath: path.join(basePath, 'tombstones.jsonl'),
    atomicWrite: true,
  });
}
