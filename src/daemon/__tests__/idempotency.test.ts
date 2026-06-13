/**
 * Tests for the in-memory IdempotencyStore (P3 M3 / F9).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createIdempotencyStore } from '../idempotency.js';

describe('createIdempotencyStore', () => {
  afterEach(() => vi.useRealTimers());

  it('returns undefined for an unknown key', () => {
    const s = createIdempotencyStore();
    expect(s.get('nope')).toBeUndefined();
  });

  it('returns the recorded node id for a known key', () => {
    const s = createIdempotencyStore();
    s.set('k1', 'node-1');
    expect(s.get('k1')).toBe('node-1');
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    const s = createIdempotencyStore({ ttlMs: 1000 });
    s.set('k1', 'node-1');
    expect(s.get('k1')).toBe('node-1');
    vi.advanceTimersByTime(1001);
    expect(s.get('k1')).toBeUndefined();
  });

  it('evicts the oldest entries past the max', () => {
    const s = createIdempotencyStore({ max: 2 });
    s.set('a', 'na');
    s.set('b', 'nb');
    s.set('c', 'nc'); // over cap → evicts 'a'
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBe('nb');
    expect(s.get('c')).toBe('nc');
  });

  it('re-setting a key refreshes its recency so it is not evicted first', () => {
    const s = createIdempotencyStore({ max: 2 });
    s.set('a', 'na');
    s.set('b', 'nb');
    s.set('a', 'na2'); // refresh 'a' → 'b' becomes oldest
    s.set('c', 'nc'); // evicts 'b'
    expect(s.get('a')).toBe('na2');
    expect(s.get('b')).toBeUndefined();
    expect(s.get('c')).toBe('nc');
  });
});
