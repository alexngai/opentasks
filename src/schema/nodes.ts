/**
 * Node type definitions for OpenTasks
 */

import type { Anchor, BaseNode } from './base.js'

/**
 * Spec - Captures user intent, requirements, and context
 */
export interface Spec extends BaseNode {
  type: 'spec'

  /**
   * Optional status for specs
   * - draft: work in progress, not ready for implementation
   * - active: current, ready for implementation
   * - archived: superseded or no longer relevant
   */
  status?: 'draft' | 'active' | 'archived' | string
}

/**
 * Issue - Actionable work item with status workflow
 */
export interface Issue extends BaseNode {
  type: 'issue'

  /**
   * Workflow status (required for issues)
   * - open: not started
   * - in_progress: actively being worked on
   * - blocked: waiting on dependency
   * - closed: completed or won't do
   */
  status: 'open' | 'in_progress' | 'blocked' | 'closed' | string

  /** Who is responsible for this issue */
  assignee?: string

  /** When the issue was closed (ISO 8601) */
  closed_at?: string
}

/**
 * Feedback - Anchored comment, suggestion, or request on a node
 */
export interface Feedback extends BaseNode {
  type: 'feedback'

  /**
   * What this feedback is about (required)
   * Can be a spec, issue, or another feedback (for threading)
   */
  target_id: string

  /** Optional anchor for line/text-specific feedback */
  target_anchor?: Anchor

  /**
   * Type of feedback (required)
   * - comment: general observation
   * - suggestion: proposed change
   * - request: action needed
   */
  feedback_type: 'comment' | 'suggestion' | 'request' | string

  /** Groups related feedback */
  thread_id?: string
  /** Parent feedback in thread */
  reply_to_id?: string

  /** Feedback has been addressed */
  resolved?: boolean
  /** When resolved (ISO 8601) */
  resolved_at?: string
  /** Feedback was dismissed (not addressed) */
  dismissed?: boolean
  /** When dismissed (ISO 8601) */
  dismissed_at?: string
}

/**
 * ExternalNode - Reference to an entity in an external system
 * Can be phantom (just a reference) or materialized (fetched data)
 */
export interface ExternalNode extends BaseNode {
  type: 'external'

  /** Canonical URI: "jira://PROJ-123", "beads://./bd-x7k9" */
  uri: string

  /** Source system identifier: "jira" | "linear" | "github" | "beads" | etc. */
  source: string

  /** Whether data has been fetched from external system */
  materialized: boolean

  /** When data was last fetched (ISO 8601) */
  cached_at?: string

  /** Whether cached data is known to be stale */
  stale?: boolean

  /** Status from external system (their semantics, not ours) */
  external_status?: string

  /** Raw data from external system */
  external_data?: Record<string, unknown>
}

/**
 * Discriminated union of all node types
 */
export type Node = Spec | Issue | Feedback | ExternalNode

/**
 * Node type literal union
 */
export type NodeType = 'spec' | 'issue' | 'feedback' | 'external'
