/**
 * Context Files — Watcher Integration
 *
 * Bridges the daemon file watcher with context-file nodes.
 * When a watched file changes, marks the corresponding context-file node
 * as potentially drifted so callers can decide whether to re-sync.
 */

import type { FileChangeEvent, ChangeHandler } from '../daemon/watcher.js';
import type { GraphStore } from '../graph/store.js';
import type { Node } from '../schema/index.js';
import { isContextFileNode, getContextFileMetadata } from './context-files.js';
import * as path from 'node:path';

/**
 * Options for the context-file watcher handler.
 */
export interface ContextFileWatcherOptions {
  /** The graph store to query for context-file nodes */
  store: GraphStore;

  /**
   * Root of the repository (to compute repo-relative paths).
   * The watcher emits absolute paths; we compare against
   * `context_file_path` which is repo-relative.
   */
  repoRoot: string;

  /**
   * Callback invoked when a context-file node's source file changes.
   * Receives the node and the change event.
   */
  onDrift?: (node: Node, event: FileChangeEvent) => void;

  /**
   * Auto-sync context-file nodes when their source file changes.
   * Default: false (only fires onDrift callback).
   */
  autoSync?: boolean;
}

/**
 * Create a ChangeHandler that reacts to context-file source changes.
 *
 * Wire this into the daemon file watcher:
 * ```ts
 * const handler = createContextFileChangeHandler({ store, repoRoot });
 * fileWatcher.onchange(handler);
 * ```
 *
 * The handler scans context-file nodes for any whose `context_file_path`
 * matches the changed file, then fires the onDrift callback.
 */
export function createContextFileChangeHandler(
  options: ContextFileWatcherOptions,
): ChangeHandler {
  const { store, repoRoot, onDrift } = options;

  return async (event: FileChangeEvent) => {
    // Only react to file additions and changes (not unlinks for now)
    if (event.type === 'unlink') return;

    // Compute repo-relative path from the absolute watcher path
    const repoRelative = path.relative(repoRoot, event.path);

    // Find context-file nodes that reference this file
    const contextNodes = await store.query.nodes({ type: 'context' });
    for (const node of contextNodes) {
      if (!isContextFileNode(node)) continue;
      const meta = getContextFileMetadata(node);
      if (!meta) continue;

      // Normalize for comparison (forward slashes)
      const metaPath = meta.context_file_path.split(path.sep).join('/');
      const eventPath = repoRelative.split(path.sep).join('/');

      if (metaPath === eventPath) {
        onDrift?.(node, event);
      }
    }
  };
}
