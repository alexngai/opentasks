/**
 * Node type definitions for OpenTasks
 */

import type { Anchor, BaseNode } from './base.js';

/**
 * Context - Captures user intent, requirements, and context
 */
export interface Context extends BaseNode {
  type: 'context';

  /**
   * Optional status for context nodes
   * - draft: work in progress, not ready for implementation
   * - active: current, ready for implementation
   * - archived: superseded or no longer relevant
   */
  status?: 'draft' | 'active' | 'archived' | string;
}

/**
 * Task - Actionable work item with status workflow
 */
export interface Task extends BaseNode {
  type: 'task';

  /**
   * Workflow status (required for tasks)
   * - open: not started
   * - in_progress: actively being worked on
   * - blocked: waiting on dependency
   * - closed: completed or won't do
   */
  status: 'open' | 'in_progress' | 'blocked' | 'closed' | string;

  /** Who is responsible for this task */
  assignee?: string;

  /** When the task was closed (ISO 8601) */
  closed_at?: string;
}

/**
 * Feedback - Anchored comment, suggestion, or request on a node
 */
export interface Feedback extends BaseNode {
  type: 'feedback';

  /**
   * What this feedback is about (required)
   * Can be a context, task, or another feedback (for threading)
   */
  target_id: string;

  /** Optional anchor for line/text-specific feedback */
  target_anchor?: Anchor;

  /**
   * Type of feedback (required)
   * - comment: general observation
   * - suggestion: proposed change
   * - request: action needed
   */
  feedback_type: 'comment' | 'suggestion' | 'request' | string;

  /** Groups related feedback */
  thread_id?: string;
  /** Parent feedback in thread */
  reply_to_id?: string;

  /** Feedback has been addressed */
  resolved?: boolean;
  /** When resolved (ISO 8601) */
  resolved_at?: string;
  /** Feedback was dismissed (not addressed) */
  dismissed?: boolean;
  /** When dismissed (ISO 8601) */
  dismissed_at?: string;
}

/**
 * ExternalNode - Reference to an entity in an external system
 * Can be phantom (just a reference) or materialized (fetched data)
 */
export interface ExternalNode extends BaseNode {
  type: 'external';

  /** Canonical URI: "jira://PROJ-123", "beads://./bd-x7k9" */
  uri: string;

  /** Source system identifier: "jira" | "linear" | "github" | "beads" | etc. */
  source: string;

  /** Whether data has been fetched from external system */
  materialized: boolean;

  /** When data was last fetched (ISO 8601) */
  cached_at?: string;

  /** Whether cached data is known to be stale */
  stale?: boolean;

  /** Status from external system (their semantics, not ours) */
  external_status?: string;

  /** Raw data from external system */
  external_data?: Record<string, unknown>;
}

/**
 * EvidenceRef - a pointer to an independently checkable artifact
 * (a test result, commit, context node, or url). Never the agent's prose —
 * the value of evidence is that a partner can verify it themselves.
 */
export interface EvidenceRef {
  kind: 'test' | 'command' | 'commit' | 'context' | 'external' | 'url';
  /** test-suite id / command / git sha / context node id / uri */
  ref: string;
  /** exit code, "12/12 passed", metric value */
  detail?: string;
  /** content hash for tamper-evidence */
  hash?: string;
}

/**
 * AttemptMetadata - stored on `attempt.metadata.attempt`.
 *
 * `outcome` is a RESULT, not a workflow status: a failed attempt is
 * `status: closed` + `outcome: failure`, while the parent task stays open
 * (a retry is a new attempt).
 */
export interface AttemptMetadata {
  outcome: 'pending' | 'success' | 'failure' | 'abandoned' | 'inconclusive';
  /** What was tried / what happened; name files/areas touched for overlap visibility */
  summary?: string;
  /** Pointer to an independently checkable artifact — the Commitment lever */
  evidence?: EvidenceRef;
  /** Why it failed / was abandoned — the negative-result record */
  failureReason?: string;
  /** Best-of-N: this attempt was selected (paired with a `supersedes` edge) */
  selected?: boolean;
}

/**
 * Attempt - one agent's effort at a task, carrying an outcome + evidence.
 *
 * Subordinate to a task (like Feedback, via `target_id`), but with a
 * task-like lifecycle (claimable, status). Multiple attempts may target one
 * task concurrently — collaborative dedup and best-of-N are the same shape,
 * differing only in orchestration policy. The result lives in
 * `metadata.attempt` ({@link AttemptMetadata}).
 */
export interface Attempt extends BaseNode {
  type: 'attempt';

  /** The task this attempts (required) */
  target_id: string;

  /**
   * Workflow status. Starts `in_progress`; a terminal outcome closes it.
   * The result (success/failure/…) is in `metadata.attempt.outcome`, not here.
   */
  status: 'open' | 'in_progress' | 'blocked' | 'closed' | string;

  /** The agent making the attempt */
  assignee?: string;
}

/**
 * Discriminated union of all node types
 */
export type Node = Context | Task | Feedback | ExternalNode | Attempt;

/**
 * Node type literal union
 */
export type NodeType = 'context' | 'task' | 'feedback' | 'external' | 'attempt';
