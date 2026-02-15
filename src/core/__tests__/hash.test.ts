import { describe, it, expect } from 'vitest';
import { sha256, computeContentHash, contentEqual } from '../hash.js';
import type { StoredNode } from '../../schema/storage.js';

describe('sha256', () => {
  it('produces consistent hash for same input', () => {
    const hash1 = sha256('hello world');
    const hash2 = sha256('hello world');
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different input', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('world');
    expect(hash1).not.toBe(hash2);
  });

  it('produces 64-character hex string', () => {
    const hash = sha256('test');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeContentHash', () => {
  const baseNode: StoredNode = {
    id: 'c-a2b3',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'context',
    title: 'Test Context',
    content: 'Some content',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  };

  it('produces consistent hash for same content', () => {
    const hash1 = computeContentHash(baseNode);
    const hash2 = computeContentHash(baseNode);
    expect(hash1).toBe(hash2);
  });

  it('excludes non-substantive fields', () => {
    const node1 = { ...baseNode };
    const node2 = {
      ...baseNode,
      id: 'c-different',
      uuid: 'different-uuid',
      created_at: '2025-01-27T10:00:00Z',
      updated_at: '2025-01-27T10:00:00Z',
      claimed_by: 'agent-1',
      claimed_at: '2025-01-27T10:00:00Z',
    };

    expect(computeContentHash(node1)).toBe(computeContentHash(node2));
  });

  it('includes substantive fields', () => {
    const node1 = { ...baseNode };
    const node2 = { ...baseNode, title: 'Different Title' };
    const node3 = { ...baseNode, content: 'Different content' };
    const node4 = { ...baseNode, priority: 1 };

    expect(computeContentHash(node1)).not.toBe(computeContentHash(node2));
    expect(computeContentHash(node1)).not.toBe(computeContentHash(node3));
    expect(computeContentHash(node1)).not.toBe(computeContentHash(node4));
  });

  it('handles tags consistently (sorted)', () => {
    const node1: StoredNode = { ...baseNode, tags: ['b', 'a', 'c'] };
    const node2: StoredNode = { ...baseNode, tags: ['a', 'b', 'c'] };
    const node3: StoredNode = { ...baseNode, tags: ['c', 'a', 'b'] };

    expect(computeContentHash(node1)).toBe(computeContentHash(node2));
    expect(computeContentHash(node1)).toBe(computeContentHash(node3));
  });

  it('includes task-specific fields', () => {
    const task1: StoredNode = {
      ...baseNode,
      type: 'task',
      status: 'open',
      assignee: 'user1',
    };
    const task2: StoredNode = {
      ...baseNode,
      type: 'task',
      status: 'open',
      assignee: 'user2',
    };

    expect(computeContentHash(task1)).not.toBe(computeContentHash(task2));
  });

  it('includes feedback-specific fields', () => {
    const feedback1: StoredNode = {
      ...baseNode,
      type: 'feedback',
      target_id: 'c-target1',
      feedback_type: 'comment',
    };
    const feedback2: StoredNode = {
      ...baseNode,
      type: 'feedback',
      target_id: 'c-target2',
      feedback_type: 'comment',
    };

    expect(computeContentHash(feedback1)).not.toBe(computeContentHash(feedback2));
  });

  it('includes external-specific fields', () => {
    const external1: StoredNode = {
      ...baseNode,
      type: 'external',
      uri: 'jira://PROJ-123',
      source: 'jira',
      materialized: false,
    };
    const external2: StoredNode = {
      ...baseNode,
      type: 'external',
      uri: 'jira://PROJ-456',
      source: 'jira',
      materialized: false,
    };

    expect(computeContentHash(external1)).not.toBe(computeContentHash(external2));
  });
});

describe('contentEqual', () => {
  const baseNode: StoredNode = {
    id: 'c-a2b3',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'context',
    title: 'Test Context',
    content: 'Some content',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  };

  it('returns true for equal content', () => {
    const node1 = { ...baseNode };
    const node2 = {
      ...baseNode,
      id: 'c-different',
      uuid: 'different',
      created_at: 'different',
      updated_at: 'different',
    };

    expect(contentEqual(node1, node2)).toBe(true);
  });

  it('returns false for different content', () => {
    const node1 = { ...baseNode };
    const node2 = { ...baseNode, title: 'Different' };

    expect(contentEqual(node1, node2)).toBe(false);
  });
});
