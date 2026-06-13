/**
 * Tests for the in-memory EventManager (P3 M2).
 */

import { describe, it, expect } from 'vitest';
import { createEventManager } from '../events.js';
import type { ProviderNodeChangeEvent } from '../../providers/traits/Watchable.js';

function ev(nodeId: string): ProviderNodeChangeEvent {
  return {
    type: 'deleted',
    nodeId,
    uri: `global://${nodeId}`,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

describe('createEventManager', () => {
  it('assigns monotonic seq starting at 1 and stamps the epoch', () => {
    const em = createEventManager({ epoch: 'e1' });
    const a = em.emit(ev('a'));
    const b = em.emit(ev('b'));

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.epoch).toBe('e1');
    expect(b.epoch).toBe('e1');
    expect(a.event.nodeId).toBe('a');
    expect(typeof a.emittedAt).toBe('string');
  });

  it('current() reflects the latest assigned seq', () => {
    const em = createEventManager({ epoch: 'e1' });
    expect(em.current()).toEqual({ epoch: 'e1', seq: 0 });
    em.emit(ev('a'));
    em.emit(ev('b'));
    expect(em.current()).toEqual({ epoch: 'e1', seq: 2 });
  });

  it('since() returns exactly the events with seq > cursor.seq', () => {
    const em = createEventManager({ epoch: 'e1' });
    em.emit(ev('a')); // 1
    em.emit(ev('b')); // 2
    em.emit(ev('c')); // 3

    const result = em.since({ epoch: 'e1', seq: 1 });
    expect('resync' in result && result.resync).toBeFalsy();
    if (!('events' in result)) throw new Error('expected events');
    expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(result.events.map((e) => e.event.nodeId)).toEqual(['b', 'c']);
  });

  it('since() at the head returns an empty delta (not resync)', () => {
    const em = createEventManager({ epoch: 'e1' });
    em.emit(ev('a'));
    em.emit(ev('b'));

    const result = em.since({ epoch: 'e1', seq: 2 });
    expect(result).toEqual({ epoch: 'e1', events: [] });
  });

  it('since() on a fresh manager with a seq-0 cursor returns empty', () => {
    const em = createEventManager({ epoch: 'e1' });
    expect(em.since({ epoch: 'e1', seq: 0 })).toEqual({ epoch: 'e1', events: [] });
  });

  it('since() with a different epoch signals resync', () => {
    const em = createEventManager({ epoch: 'e2' });
    em.emit(ev('a'));
    expect(em.since({ epoch: 'e1', seq: 0 })).toEqual({ epoch: 'e2', resync: true });
  });

  it('since() signals resync when the cursor predates the buffer window', () => {
    const em = createEventManager({ epoch: 'e1', bufferSize: 3 });
    em.emit(ev('a')); // 1 (evicted)
    em.emit(ev('b')); // 2
    em.emit(ev('c')); // 3
    em.emit(ev('d')); // 4 — buffer now holds seq 2,3,4

    // Cursor at seq 1: the next event (seq 2) is still buffered → serveable.
    const ok = em.since({ epoch: 'e1', seq: 1 });
    if (!('events' in ok)) throw new Error('expected events');
    expect(ok.events.map((e) => e.seq)).toEqual([2, 3, 4]);

    // Cursor at seq 0: the next event (seq 1) was evicted → cannot serve a
    // complete delta → resync.
    expect(em.since({ epoch: 'e1', seq: 0 })).toEqual({ epoch: 'e1', resync: true });
  });

  it('caps the ring buffer at bufferSize, evicting oldest', () => {
    const em = createEventManager({ epoch: 'e1', bufferSize: 2 });
    em.emit(ev('a')); // 1
    em.emit(ev('b')); // 2
    em.emit(ev('c')); // 3 — evicts seq 1

    // seq 2 still serveable (cursor 1 → next is 2, buffered).
    const ok = em.since({ epoch: 'e1', seq: 1 });
    if (!('events' in ok)) throw new Error('expected events');
    expect(ok.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(em.current()).toEqual({ epoch: 'e1', seq: 3 });
  });
});
