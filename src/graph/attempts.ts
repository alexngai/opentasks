/**
 * Attempt/verify query helpers (step 3 of docs/ATTEMPT-VERIFY-SCHEMA.md §6).
 *
 * Pure predicates over already-fetched nodes + edges. The MCP `list_attempts`
 * tool composes these over `client.query()` results, so no daemon RPC method is
 * needed. They encode the safety properties as queries:
 *   - "what is everyone doing now" = in-progress attempts (Expectation fix)
 *   - "unevidenced completions"     = success attempts that aren't checkable (Commitment fix)
 *   - "completable"                 = a task has a checkable success attempt
 */

import type { AttemptMetadata, EvidenceRef } from '../schema/index.js';

/** Minimal node shape these helpers read (works on Node and StoredNode). */
export interface AttemptLike {
  id: string;
  type: string;
  status?: string;
  target_id?: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
}

/** Minimal edge shape (works on Edge / StoredEdge / ProviderEdge). */
export interface EdgeLike {
  from_id: string;
  to_id: string;
  type: string;
  metadata?: Record<string, unknown>;
}

/** Read the `metadata.attempt` convention off an attempt node. */
export function attemptMeta(node: AttemptLike): AttemptMetadata | undefined {
  return node.metadata?.attempt as AttemptMetadata | undefined;
}

/** The recorded outcome, if any. */
export function attemptOutcome(node: AttemptLike): AttemptMetadata['outcome'] | undefined {
  return attemptMeta(node)?.outcome;
}

/** Actively-in-progress attempts — "what is everyone doing right now". */
export function isInProgress(node: AttemptLike): boolean {
  return node.type === 'attempt' && node.status === 'in_progress';
}

/** Evidence is checkable when it points somewhere a partner can verify. */
export function isCheckableEvidence(evidence: EvidenceRef | undefined): boolean {
  return !!evidence && typeof evidence.ref === 'string' && evidence.ref.length > 0;
}

/** Does any incoming `verifies` edge to this attempt carry verdict=pass? */
export function hasPassingVerification(attemptId: string, edges: EdgeLike[]): boolean {
  return edges.some(
    (e) =>
      e.type === 'verifies' &&
      e.to_id === attemptId &&
      (e.metadata?.verdict as string | undefined) === 'pass',
  );
}

/**
 * A checkable success: a successful attempt that a partner can actually verify —
 * either it carries its own checkable evidence, or an independent `verifies/pass`
 * edge points at it. This is the predicate behind "completable".
 */
export function isCheckableSuccess(node: AttemptLike, edges: EdgeLike[] = []): boolean {
  if (attemptOutcome(node) !== 'success') return false;
  return isCheckableEvidence(attemptMeta(node)?.evidence) || hasPassingVerification(node.id, edges);
}

/**
 * Unevidenced completion = a `success` attempt that is NOT checkable (no
 * evidence of its own and no passing verification). The Commitment-failure
 * safety query: completions that nobody can check.
 */
export function isUnevidencedCompletion(node: AttemptLike, edges: EdgeLike[] = []): boolean {
  return attemptOutcome(node) === 'success' && !isCheckableSuccess(node, edges);
}
