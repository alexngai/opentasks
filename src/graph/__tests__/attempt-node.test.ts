/**
 * Step 1 of the attempt/verify schema: the `attempt` node type.
 * See docs/ATTEMPT-VERIFY-SCHEMA.md §8.
 *
 * Covers: id prefix, validation (create + stored), parse/type-guard, and
 * content hashing (target identifies the attempt; outcome metadata does not).
 */

import { describe, it, expect } from 'vitest';
import { createValidationService } from '../validation.js';
import { generateId, inferTypeFromId, typePrefix } from '../../core/id.js';
import { validateStoredNode, parseNode, isAttempt } from '../../schema/index.js';
import { computeContentHash } from '../../core/hash.js';
import type { StoredNode } from '../../schema/storage.js';
import type { CreateNodeInput } from '../types.js';

const baseStored = {
  id: 'a-x7k9',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'attempt at t-abc1',
  created_at: '2026-06-16T00:00:00.000Z',
  updated_at: '2026-06-16T00:00:00.000Z',
};

describe('attempt node type (step 1)', () => {
  describe('id generation', () => {
    it('uses the "a-" prefix for attempts', () => {
      expect(typePrefix('attempt')).toBe('a');
      expect(generateId('attempt').id).toMatch(/^a-[a-z0-9]+$/);
    });

    it('infers attempt from an a- id', () => {
      expect(inferTypeFromId(generateId('attempt').id)).toBe('attempt');
    });
  });

  describe('create-node validation', () => {
    const validation = createValidationService();

    it('accepts an attempt with a target_id', () => {
      const input: CreateNodeInput = {
        type: 'attempt',
        title: 'attempt at t-abc1',
        target_id: 't-abc1',
        status: 'in_progress',
      };
      const result = validation.validateCreateNode(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects an attempt without a target_id', () => {
      const input: CreateNodeInput = { type: 'attempt', title: 'orphan attempt' };
      const result = validation.validateCreateNode(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'target_id' && e.code === 'REQUIRED')).toBe(true);
    });
  });

  describe('stored-node validation + parse', () => {
    it('validates a stored attempt with target_id', () => {
      const stored: StoredNode = { ...baseStored, type: 'attempt', target_id: 't-abc1', status: 'in_progress' };
      expect(validateStoredNode(stored).valid).toBe(true);
    });

    it('flags a stored attempt missing target_id', () => {
      const stored: StoredNode = { ...baseStored, type: 'attempt', status: 'in_progress' };
      const res = validateStoredNode(stored);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === 'target_id')).toBe(true);
    });

    it('parseNode returns the attempt and isAttempt narrows it', () => {
      const stored: StoredNode = { ...baseStored, type: 'attempt', target_id: 't-abc1', status: 'in_progress' };
      const node = parseNode(stored);
      expect(node.type).toBe('attempt');
      expect(isAttempt(node)).toBe(true);
      if (isAttempt(node)) {
        expect(node.target_id).toBe('t-abc1');
      }
    });
  });

  describe('content hash', () => {
    const attempt: StoredNode = {
      id: 'a-1', uuid: 'u', type: 'attempt', title: 'x',
      target_id: 't-aaa', created_at: 'n', updated_at: 'n',
    };

    it('includes target_id — changing the target changes the hash', () => {
      const other: StoredNode = { ...attempt, target_id: 't-bbb' };
      expect(computeContentHash(attempt)).not.toBe(computeContentHash(other));
    });

    it('ignores metadata — the outcome is not content-hashed (identified by id)', () => {
      const pending: StoredNode = { ...attempt, metadata: { attempt: { outcome: 'pending' } } };
      const success: StoredNode = { ...attempt, metadata: { attempt: { outcome: 'success' } } };
      expect(computeContentHash(pending)).toBe(computeContentHash(success));
    });
  });
});
