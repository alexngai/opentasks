/**
 * Context Files — Core API
 *
 * Creates and manages context nodes that reference codebase files.
 * Context-file nodes are lightweight pointers — the file content is
 * resolved on demand via the resolver, not stored in the JSONL graph.
 */

import type { GraphStore } from '../graph/store.js';
import type { Node, Context } from '../schema/index.js';
import type {
  ContextFileMetadata,
  CreateContextFileInput,
  SyncContextFileOptions,
  DriftResult,
  ContextFileResolution,
} from './types.js';
import {
  resolveContextFile,
  contentHash,
  getHeadCommit,
  readFileFromWorktree,
  readFileAtCommit,
  inferFileType,
  fileExists,
  fileExistsAtCommit,
} from './resolver.js';

// ============================================================================
// Type guards
// ============================================================================

/**
 * Check whether a node is a context-file node (has context_file metadata).
 */
export function isContextFileNode(node: Node): node is Context & { metadata: ContextFileMetadata } {
  return (
    node.type === 'context' &&
    node.metadata !== undefined &&
    (node.metadata as Record<string, unknown>).context_file === true &&
    typeof (node.metadata as Record<string, unknown>).context_file_path === 'string'
  );
}

/**
 * Extract context-file metadata from a node, or null if not a context-file node.
 */
export function getContextFileMetadata(node: Node): ContextFileMetadata | null {
  if (!isContextFileNode(node)) return null;
  return node.metadata as unknown as ContextFileMetadata;
}

// ============================================================================
// Context File Manager
// ============================================================================

/**
 * Manager for context-file operations against a graph store.
 */
export interface ContextFileManager {
  /**
   * Create a context-file node for a codebase file.
   *
   * - Reads the file to compute a content hash
   * - Records the current HEAD commit (or the specified commit)
   * - Stores only the pointer metadata, not the file content
   */
  create(input: CreateContextFileInput): Promise<Context>;

  /**
   * Resolve a context-file node's content.
   *
   * Reads the file from the working tree (or at the pinned commit)
   * and returns content + drift info.
   */
  resolve(nodeId: string): Promise<ContextFileResolution>;

  /**
   * Resolve at the originally captured commit.
   *
   * Always returns the exact content that was captured, regardless
   * of current working tree state.
   */
  resolveAtCapturedCommit(nodeId: string): Promise<ContextFileResolution>;

  /**
   * Check whether a context-file node has drifted from its captured state.
   */
  checkDrift(nodeId: string): Promise<DriftResult>;

  /**
   * Sync a context-file node with the current file state.
   *
   * Updates the commit SHA and content hash to reflect the current HEAD.
   * No-ops if the content hasn't changed (unless force: true).
   */
  sync(nodeId: string, options?: SyncContextFileOptions): Promise<Context>;

  /**
   * List all context-file nodes in the store.
   */
  list(): Promise<Array<Context & { metadata: ContextFileMetadata }>>;
}

/**
 * Create a ContextFileManager for a repository.
 *
 * @param store - The graph store to operate on
 * @param repoRoot - Absolute path to the repository root
 */
export function createContextFileManager(
  store: GraphStore,
  repoRoot: string,
): ContextFileManager {
  /**
   * Load and validate a context-file node by ID.
   */
  async function loadContextFileNode(nodeId: string): Promise<Context & { metadata: ContextFileMetadata }> {
    const node = await store.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    if (!isContextFileNode(node)) {
      throw new Error(`Node ${nodeId} is not a context-file node`);
    }
    return node as Context & { metadata: ContextFileMetadata };
  }

  return {
    async create(input: CreateContextFileInput): Promise<Context> {
      const { filePath, title, tags, priority, commit } = input;

      // Verify file exists
      const exists = commit
        ? await fileExistsAtCommit(repoRoot, filePath, commit)
        : await fileExists(repoRoot, filePath);

      if (!exists) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read file and compute hash
      const content = commit
        ? await readFileAtCommit(repoRoot, filePath, commit)
        : await readFileFromWorktree(repoRoot, filePath);
      const hash = contentHash(content);

      // Determine commit SHA
      const commitSha = commit ?? await getHeadCommit(repoRoot);

      // Infer file type
      const fileType = inferFileType(filePath);

      // Derive title if not provided
      const nodeTitle = title ?? filePath;

      // Build metadata
      const metadata: ContextFileMetadata = {
        context_file: true,
        context_file_path: filePath,
        context_file_type: fileType,
        context_file_commit: commitSha,
        context_file_content_hash: hash,
        context_file_synced_at: new Date().toISOString(),
      };

      // Create the context node — content is NOT stored
      const node = await store.createNode({
        type: 'context',
        title: nodeTitle,
        status: 'active',
        tags,
        priority,
        metadata: metadata as unknown as Record<string, unknown>,
      });

      return node as Context;
    },

    async resolve(nodeId: string): Promise<ContextFileResolution> {
      const node = await loadContextFileNode(nodeId);
      const meta = node.metadata;

      return resolveContextFile(
        repoRoot,
        meta.context_file_path,
        meta.context_file_content_hash,
      );
    },

    async resolveAtCapturedCommit(nodeId: string): Promise<ContextFileResolution> {
      const node = await loadContextFileNode(nodeId);
      const meta = node.metadata;

      if (!meta.context_file_commit) {
        throw new Error(`Node ${nodeId} has no captured commit SHA`);
      }

      return resolveContextFile(
        repoRoot,
        meta.context_file_path,
        meta.context_file_content_hash,
        meta.context_file_commit,
      );
    },

    async checkDrift(nodeId: string): Promise<DriftResult> {
      const node = await loadContextFileNode(nodeId);
      const meta = node.metadata;

      const currentContent = await readFileFromWorktree(repoRoot, meta.context_file_path);
      const currentHash = contentHash(currentContent);
      const currentCommit = await getHeadCommit(repoRoot);

      return {
        drifted: meta.context_file_content_hash !== undefined && currentHash !== meta.context_file_content_hash,
        currentCommit,
        capturedCommit: meta.context_file_commit,
        currentHash,
        capturedHash: meta.context_file_content_hash,
      };
    },

    async sync(nodeId: string, options?: SyncContextFileOptions): Promise<Context> {
      const node = await loadContextFileNode(nodeId);
      const meta = node.metadata;

      const currentContent = await readFileFromWorktree(repoRoot, meta.context_file_path);
      const currentHash = contentHash(currentContent);
      const currentCommit = await getHeadCommit(repoRoot);

      // Skip if unchanged (unless forced)
      if (!options?.force && currentHash === meta.context_file_content_hash) {
        return node;
      }

      // Update metadata
      const updatedMetadata: ContextFileMetadata = {
        ...meta,
        context_file_commit: currentCommit,
        context_file_content_hash: currentHash,
        context_file_synced_at: new Date().toISOString(),
      };

      const updated = await store.updateNode(nodeId, {
        metadata: updatedMetadata as unknown as Record<string, unknown>,
      });

      return updated as Context;
    },

    async list(): Promise<Array<Context & { metadata: ContextFileMetadata }>> {
      const contextNodes = await store.query.nodes({ type: 'context' });
      return contextNodes.filter(isContextFileNode) as Array<Context & { metadata: ContextFileMetadata }>;
    },
  };
}

