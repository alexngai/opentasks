/**
 * Step 3 of the attempt/verify schema: the query helpers (§6 truth table).
 */

import { describe, it, expect } from 'vitest';
import {
  attemptOutcome,
  isInProgress,
  isCheckableEvidence,
  hasPassingVerification,
  isCheckableSuccess,
  isUnevidencedCompletion,
  type AttemptLike,
  type EdgeLike,
} from '../attempts.js';

const attempt = (id: string, status: string, meta?: Record<string, unknown>): AttemptLike => ({
  id,
  type: 'attempt',
  status,
  target_id: 't-1',
  metadata: meta,
});

describe('attempt/verify query helpers (step 3 — §6 truth table)', () => {
  it('isInProgress: only in_progress attempt nodes', () => {
    expect(isInProgress(attempt('a-1', 'in_progress'))).toBe(true);
    expect(isInProgress(attempt('a-1', 'closed'))).toBe(false);
    expect(isInProgress({ id: 't-1', type: 'task', status: 'in_progress' })).toBe(false);
  });

  it('reads the outcome from metadata.attempt', () => {
    expect(attemptOutcome(attempt('a-1', 'closed', { attempt: { outcome: 'failure' } }))).toBe('failure');
    expect(attemptOutcome(attempt('a-1', 'in_progress'))).toBeUndefined();
  });

  it('checkable evidence requires a non-empty ref', () => {
    expect(isCheckableEvidence({ kind: 'test', ref: 'suiteX' })).toBe(true);
    expect(isCheckableEvidence({ kind: 'test', ref: '' })).toBe(false);
    expect(isCheckableEvidence(undefined)).toBe(false);
  });

  it('hasPassingVerification: only a verifies/pass edge pointing at this attempt', () => {
    const edges: EdgeLike[] = [
      { from_id: 'a-9', to_id: 'a-1', type: 'verifies', metadata: { verdict: 'pass' } },
      { from_id: 'a-8', to_id: 'a-2', type: 'verifies', metadata: { verdict: 'pass' } }, // other attempt
      { from_id: 'a-7', to_id: 'a-1', type: 'verifies', metadata: { verdict: 'fail' } }, // failing verdict
    ];
    expect(hasPassingVerification('a-1', edges)).toBe(true);
    expect(hasPassingVerification('a-3', edges)).toBe(false);
  });

  describe('completion safety (the Commitment-failure query)', () => {
    const evidenced = attempt('a-1', 'closed', {
      attempt: { outcome: 'success', evidence: { kind: 'test', ref: 'suiteX' } },
    });
    const bareSuccess = attempt('a-2', 'closed', { attempt: { outcome: 'success' } });
    const failed = attempt('a-3', 'closed', { attempt: { outcome: 'failure' } });
    const passEdge: EdgeLike[] = [
      { from_id: 'a-9', to_id: 'a-2', type: 'verifies', metadata: { verdict: 'pass' } },
    ];

    it('success + own evidence → checkable, not unevidenced', () => {
      expect(isCheckableSuccess(evidenced)).toBe(true);
      expect(isUnevidencedCompletion(evidenced)).toBe(false);
    });

    it('success + no evidence + no verification → UNEVIDENCED (the risk)', () => {
      expect(isCheckableSuccess(bareSuccess)).toBe(false);
      expect(isUnevidencedCompletion(bareSuccess)).toBe(true);
    });

    it('success + no evidence + passing verification → checkable again', () => {
      expect(isCheckableSuccess(bareSuccess, passEdge)).toBe(true);
      expect(isUnevidencedCompletion(bareSuccess, passEdge)).toBe(false);
    });

    it('a failed attempt is neither a checkable success nor an unevidenced completion', () => {
      expect(isCheckableSuccess(failed)).toBe(false);
      expect(isUnevidencedCompletion(failed)).toBe(false);
    });
  });
});
