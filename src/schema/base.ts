/**
 * Base types shared by all OpenTasks nodes
 */

/**
 * Anchor for locating feedback within content
 */
export interface Anchor {
  /** Line number (1-indexed) */
  line?: number;

  /** Text snippet for fuzzy matching if line moves */
  text?: string;

  /** Section heading */
  section?: string;

  /** Context for relocation */
  context_before?: string;
  context_after?: string;

  /**
   * Anchor validity status
   * - valid: anchor location confirmed
   * - relocated: moved but found
   * - stale: could not relocate
   */
  anchor_status?: 'valid' | 'relocated' | 'stale';
}

/**
 * Common fields shared by all node types
 */
export interface BaseNode {
  // === Identity ===
  /** Hash-based ID: prefix + base36 (e.g., "s-a2b3", "i-x7k9") */
  id: string;
  /** UUID v4 for distributed sync */
  uuid: string;

  // === Core ===
  /** Human-readable title */
  title: string;
  /** Markdown body content */
  content?: string;
  /** SHA256 hash of content for deduplication */
  content_hash?: string;

  // === Timestamps (ISO 8601) ===
  created_at: string;
  updated_at: string;

  // === Organization ===
  /** Priority: 0 (highest) to 4 (lowest) */
  priority?: number;
  /** Tags for categorization */
  tags?: string[];
  /** Parent node ID for hierarchy support */
  parent_id?: string;

  // === Context ===
  /** OpenTasks location URI */
  location?: string;
  /** Git branch that created this node */
  branch?: string;
  /** Branches merged into this node */
  merged_from?: string[];
  /** Origin system: "local" | provider name */
  source?: string;

  // === Coordination ===
  /** Agent/user ID that claimed this node */
  claimed_by?: string;
  /** When the node was claimed (ISO 8601) */
  claimed_at?: string;
  /** Soft lock expiry (ISO 8601) */
  lock_until?: string;

  // === Lifecycle ===
  /** Soft delete flag */
  archived?: boolean;
  /** When archived (ISO 8601) */
  archived_at?: string;

  // === Extensibility ===
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}
