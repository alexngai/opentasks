/**
 * Context Files — Types
 *
 * Metadata schema for context nodes that reference files in the codebase.
 * A context-file node stores a lightweight pointer to a repo file plus
 * versioning info (commit SHA, content hash). The actual file content is
 * resolved on access rather than duplicated into the graph store.
 */

// ============================================================================
// Metadata stored on node.metadata for context-file nodes
// ============================================================================

/**
 * Metadata fields added to a context node that references a codebase file.
 *
 * These live inside `node.metadata` alongside any other metadata.
 */
export interface ContextFileMetadata {
  /** Marker — distinguishes context-file nodes from plain context nodes */
  context_file: true;

  /** Repo-relative path to the file (e.g. "src/auth/middleware.ts", "docs/arch.md") */
  context_file_path: string;

  /**
   * File type hint.
   * - "markdown" for .md files
   * - "code" for source files
   * - "text" for other text files
   */
  context_file_type: ContextFileType;

  /** Git commit SHA when the file was last synced/captured */
  context_file_commit?: string;

  /** SHA-256 hash of the file content at the synced commit */
  context_file_content_hash?: string;

  /** ISO 8601 timestamp of last sync from file */
  context_file_synced_at?: string;
}

/**
 * File type classification
 */
export type ContextFileType = 'markdown' | 'code' | 'text';

// ============================================================================
// Resolution result
// ============================================================================

/**
 * Result of resolving a context file's content.
 */
export interface ContextFileResolution {
  /** The resolved file content */
  content: string;

  /** Commit SHA the content was read from (HEAD if worktree) */
  commit: string;

  /** SHA-256 of the resolved content */
  contentHash: string;

  /** Whether content differs from what was captured (hash mismatch) */
  drifted: boolean;

  /** Repo-relative file path */
  filePath: string;
}

/**
 * Drift detection result for a context-file node.
 */
export interface DriftResult {
  /** Whether the file has changed since the node was synced */
  drifted: boolean;

  /** Current commit SHA (HEAD) */
  currentCommit: string;

  /** Commit SHA stored in the node */
  capturedCommit?: string;

  /** Current content hash */
  currentHash: string;

  /** Content hash stored in the node */
  capturedHash?: string;
}

// ============================================================================
// Input types
// ============================================================================

/**
 * Input for creating a context-file node.
 */
export interface CreateContextFileInput {
  /** Repo-relative file path */
  filePath: string;

  /**
   * Optional title. If omitted, derived from the file path
   * (e.g. "src/auth/middleware.ts" → "auth/middleware.ts")
   */
  title?: string;

  /** Optional tags */
  tags?: string[];

  /** Optional priority */
  priority?: number;

  /**
   * Pin to a specific commit SHA. If omitted, uses current HEAD.
   */
  commit?: string;
}

/**
 * Options for syncing a context-file node with the current file state.
 */
export interface SyncContextFileOptions {
  /** Force sync even if content hash hasn't changed */
  force?: boolean;
}
