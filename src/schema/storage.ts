/**
 * Storage format types for JSONL persistence
 *
 * These types are permissive (unknown fields preserved) for:
 * - Forward compatibility with schema changes
 * - Provider data from external systems
 * - Migration safety
 */

import type { Edge } from './edges.js';

/**
 * Storage format for nodes (JSONL)
 * Flexible schema — all fields except core are optional
 * Unknown fields are preserved via index signature
 */
export interface StoredNode {
  // === CORE (required) ===
  id: string;
  uuid: string;
  type: string;
  title: string;
  created_at: string;
  updated_at: string;

  // === COMMON (optional) ===
  content?: string;
  content_hash?: string;
  priority?: number;
  tags?: string[];
  parent_id?: string;

  // === CONTEXT (optional) ===
  location?: string;
  branch?: string;
  merged_from?: string[];
  source?: string;

  // === COORDINATION (optional) ===
  claimed_by?: string;
  claimed_at?: string;
  lock_until?: string;

  // === LIFECYCLE (optional) ===
  archived?: boolean;
  archived_at?: string;
  deleted_at?: string;
  deleted_by?: string;

  // === TASK FIELDS (optional) ===
  status?: string;
  assignee?: string;
  closed_at?: string;

  // === FEEDBACK FIELDS (optional) ===
  target_id?: string;
  target_anchor?: {
    line?: number;
    text?: string;
    section?: string;
    context_before?: string;
    context_after?: string;
    anchor_status?: string;
  };
  feedback_type?: string;
  thread_id?: string;
  reply_to_id?: string;
  resolved?: boolean;
  resolved_at?: string;
  dismissed?: boolean;
  dismissed_at?: string;

  // === EXTERNAL FIELDS (optional) ===
  uri?: string;
  materialized?: boolean;
  cached_at?: string;
  stale?: boolean;
  external_status?: string;
  external_data?: Record<string, unknown>;

  // === EXTENSIBILITY ===
  metadata?: Record<string, unknown>;

  /** Preserve unknown fields from external sources */
  [key: string]: unknown;
}

/**
 * Storage format for edges (same as Edge, but aliased for clarity)
 */
export type StoredEdge = Edge;

/**
 * Complete persisted graph structure
 */
export interface PersistedGraph {
  nodes: StoredNode[];
  edges: StoredEdge[];
  metadata?: GraphMetadata;
}

/**
 * Graph-level metadata
 */
export interface GraphMetadata {
  /** Schema version */
  schema_version?: {
    major: number;
    minor: number;
    patch: number;
  };
  /** When graph was created */
  created_at?: string;
  /** When graph was last compacted */
  last_compacted_at?: string;
}

/**
 * Changes to the graph (for incremental sync)
 */
export interface GraphChanges {
  /** Nodes that were added/modified */
  dirtyNodes: string[];
  /** Nodes that were deleted */
  deletedNodes: string[];
  /** Edges that were added/modified */
  dirtyEdges: string[];
  /** Edges that were deleted */
  deletedEdges: string[];
}
