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

  describe('run()', () => {
    it('dedupes CONCURRENT same-key creates into a single create', async () => {
      const s = createIdempotencyStore();
      let creates = 0;
      const nodes = new Map<string, { id: string }>();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const create = async () => {
        creates += 1;
        await gate; // hold both callers in-flight at once
        const node = { id: `n-${creates}` };
        nodes.set(node.id, node);
        return node;
      };
      const fetch = async (id: string) => nodes.get(id) ?? null;

      const p1 = s.run('k', create, fetch);
      const p2 = s.run('k', create, fetch);
      release();
      const [a, b] = await Promise.all([p1, p2]);

      expect(creates).toBe(1); // the reservation closed the get→create gap
      expect(a.id).toBe(b.id);
    });

    it('returns the existing node on a SEQUENTIAL retry (one create)', async () => {
      const s = createIdempotencyStore();
      let creates = 0;
      const nodes = new Map<string, { id: string }>();
      const create = async () => {
        creates += 1;
        const node = { id: 'n1' };
        nodes.set(node.id, node);
        return node;
      };
      const fetch = async (id: string) => nodes.get(id) ?? null;

      const a = await s.run('k', create, fetch);
      const b = await s.run('k', create, fetch);
      expect(creates).toBe(1);
      expect(b.id).toBe(a.id);
    });

    it('recreates when the recorded node was deleted since', async () => {
      const s = createIdempotencyStore();
      let creates = 0;
      const live = new Set<string>();
      const create = async () => {
        creates += 1;
        const id = `n-${creates}`;
        live.add(id);
        return { id };
      };
      const fetch = async (id: string) => (live.has(id) ? { id } : null);

      const a = await s.run('k', create, fetch);
      live.delete(a.id); // simulate external deletion
      const b = await s.run('k', create, fetch);
      expect(creates).toBe(2);
      expect(b.id).not.toBe(a.id);
    });

    it('lets a retry recreate after the create fails (reservation released)', async () => {
      const s = createIdempotencyStore();
      let attempts = 0;
      const create = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return { id: 'n-ok' };
      };
      const fetch = async () => null;

      await expect(s.run('k', create, fetch)).rejects.toThrow('boom');
      const node = await s.run('k', create, fetch);
      expect(node.id).toBe('n-ok');
      expect(attempts).toBe(2);
    });
  });
});
