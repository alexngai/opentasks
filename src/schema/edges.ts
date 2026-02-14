/**
 * Edge type definitions for OpenTasks
 *
 * Edge direction semantics: `from` → `to`
 * - "blocks": from must complete before to can start
 * - "implements": from (issue) implements to (spec)
 */

/**
 * Core relationship types
 */
export type CoreEdgeType =
  | 'blocks'      // from blocks to (dependency)
  | 'implements'  // issue implements spec
  | 'references'  // general reference
  | 'related'     // loose association

/**
 * Extended relationship types (optional, for richer semantics)
 */
export type ExtendedEdgeType =
  | 'parent-of'       // hierarchical (alternative to parent_id)
  | 'child-of'        // inverse of parent-of
  | 'duplicates'      // marks duplicate
  | 'supersedes'      // replaces another node
  | 'depends-on'      // softer than blocks
  | 'discovered-from' // found while working on

/**
 * Entire integration edge types (auto-created by EntireAutoLinker)
 */
export type EntireEdgeType =
  | 'worked-on'       // task → session: "this task was worked on during this session"
  | 'implemented-by'  // task → checkpoint: "this checkpoint implements this task"
  | 'contains'        // session → checkpoint: "this session produced this checkpoint"

/**
 * All edge types (extensible via string)
 */
export type EdgeType = CoreEdgeType | ExtendedEdgeType | EntireEdgeType | string

/**
 * Edge - Represents a relationship between nodes
 */
export interface Edge {
  /** Hash-based ID: "x-xxxx" */
  id: string
  /** UUID v4 for distributed sync */
  uuid: string

  /** Source node ID or external URI */
  from_id: string
  /** Target node ID or external URI */
  to_id: string

  /** Relationship type */
  type: EdgeType

  /** When created (ISO 8601) */
  created_at: string
  /** Agent/user who created this edge */
  created_by?: string

  /** Origin system: "local" | integration name */
  source?: string

  /** Additional metadata */
  metadata?: Record<string, unknown>

  /** When edge was cached from provider (ISO 8601) */
  cached_at?: string
}
