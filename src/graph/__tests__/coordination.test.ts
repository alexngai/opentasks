/**
 * Atomic claiming tests (HARDENING-PLAN P1).
 *
 * Proves the coordination primitives are race-free:
 * - N concurrent claimants on one task -> exactly one winner
 * - expired leases are stealable; live leases are not
 * - fence tokens reject stale release/renew
 *
 * The atomicity comes from single conditional UPDATEs in SQLite (synchronous
 * better-sqlite3, no await gap between guard and write), so the old
 * read-modify-write race is gone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLitePersister } from '../../storage/sqlite.js';
import { createClaimManager } from '../coordination.js';
import type { StoredNode } from '../../schema/storage.js';

const T0 = '2026-01-01T00:00:00.000Z';

function makeNode(id: string, overrides: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    uuid: `uuid-${id}`,
    type: 'task',
    title: id,
    status: 'open',
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

describe('Atomic claiming', () => {
  let storage: SQLitePersister;

  beforeEach(async () => {
    storage = new SQLitePersister({ path: ':memory:' });
    storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // ==========================================================================
  // Storage-level atomic primitives (deterministic via injected `now`)
  // ==========================================================================
  describe('storage.claimNode / releaseNode / renewNode', () => {
    it('claims a free task and bumps the fence to 1', async () => {
      await storage.createNode(makeNode('t-1'));

      const r = await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 });

      expect(r.ok).toBe(true);
      expect(r.fence).toBe(1);
      expect(r.claimedBy).toBe('agent-a');
      const node = await storage.getNode('t-1');
      expect(node?.claimed_by).toBe('agent-a');
      expect(node?.assignee).toBe('agent-a');
      expect(node?.lock_until).toBe('2026-01-01T00:00:01.000Z');
    });

    it('refuses to claim a task held under a live lease', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 });

      const r = await storage.claimNode('t-1', 'agent-b', {
        leaseMs: 1000,
        now: '2026-01-01T00:00:00.500Z', // still within agent-a's lease
      });

      expect(r.ok).toBe(false);
      expect(r.claimedBy).toBe('agent-a');
    });

    it('lets another agent steal an expired lease and bumps the fence', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 });

      const r = await storage.claimNode('t-1', 'agent-b', {
        leaseMs: 1000,
        now: '2026-01-01T00:00:02.000Z', // past agent-a's lease
      });

      expect(r.ok).toBe(true);
      expect(r.fence).toBe(2);
      const node = await storage.getNode('t-1');
      expect(node?.claimed_by).toBe('agent-b');
    });

    it('does not claim non-task nodes', async () => {
      await storage.createNode(makeNode('c-1', { type: 'context', status: undefined }));

      const r = await storage.claimNode('c-1', 'agent-a', { leaseMs: 1000, now: T0 });

      expect(r.ok).toBe(false);
    });

    it('force-claims a live lease held by another agent', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 10_000, now: T0 });

      const r = await storage.claimNode('t-1', 'agent-b', { leaseMs: 1000, now: T0, force: true });

      expect(r.ok).toBe(true);
      expect(r.fence).toBe(2);
    });

    it('rejects release with a stale fence, accepts the current fence', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 }); // fence 1
      const reclaim = await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 }); // fence 2
      expect(reclaim.fence).toBe(2);

      expect(await storage.releaseNode('t-1', 'agent-a', { fence: 1 })).toBe(false);
      expect(await storage.releaseNode('t-1', 'agent-a', { fence: 2 })).toBe(true);

      const node = await storage.getNode('t-1');
      expect(node?.claimed_by ?? null).toBeNull();
    });

    it('rejects release from a non-holder after a steal', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 }); // fence 1
      await storage.claimNode('t-1', 'agent-b', {
        leaseMs: 1000,
        now: '2026-01-01T00:00:02.000Z',
      }); // steal -> fence 2, holder agent-b

      // agent-a's stale release (its old fence, and it is no longer holder) is rejected
      expect(await storage.releaseNode('t-1', 'agent-a', { fence: 1 })).toBe(false);
      const node = await storage.getNode('t-1');
      expect(node?.claimed_by).toBe('agent-b');
    });

    it('renews a held lease without changing the fence, and rejects a wrong fence', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 }); // fence 1

      const ok = await storage.renewNode('t-1', 'agent-a', { leaseMs: 5000, now: T0, fence: 1 });
      expect(ok.ok).toBe(true);
      expect(ok.fence).toBe(1);
      expect(ok.lockUntil).toBe('2026-01-01T00:00:05.000Z');

      const bad = await storage.renewNode('t-1', 'agent-a', { leaseMs: 5000, now: T0, fence: 99 });
      expect(bad.ok).toBe(false);
    });

    it('marks the node dirty after a successful claim', async () => {
      await storage.createNode(makeNode('t-1'));
      await storage.claimNode('t-1', 'agent-a', { leaseMs: 1000, now: T0 });

      const dirty = await storage.getDirtyNodes();
      expect(dirty).toContain('t-1');
    });
  });

  // ==========================================================================
  // The headline: N concurrent claimants -> exactly one winner
  // ==========================================================================
  describe('concurrency', () => {
    it('lets exactly one of 16 concurrent claimants win', async () => {
      await storage.createNode(makeNode('t-hot'));
      const mgr = createClaimManager(storage);

      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) => mgr.claim('t-hot', `agent-${i}`)),
      );

      const winners = results.filter((r) => r.success);
      expect(winners).toHaveLength(1);
      // Every loser reports the same actual holder.
      const holder = winners[0].claim!.agentId;
      for (const loser of results.filter((r) => !r.success)) {
        expect(loser.existingClaim?.agentId).toBe(holder);
      }
      const node = await storage.getNode('t-hot');
      expect(node?.claimed_by).toBe(holder);
    });

    it('lets exactly one of 16 concurrent claimants win across 50 distinct tasks', async () => {
      const mgr = createClaimManager(storage);
      for (let t = 0; t < 50; t++) {
        await storage.createNode(makeNode(`t-${t}`));
      }

      // For each task, 16 agents race. Across all tasks, every task is claimed
      // exactly once and no task has two winners.
      for (let t = 0; t < 50; t++) {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) => mgr.claim(`t-${t}`, `agent-${i}`)),
        );
        expect(results.filter((r) => r.success)).toHaveLength(1);
      }
    });
  });

  // ==========================================================================
  // ClaimManager lifecycle
  // ==========================================================================
  describe('ClaimManager', () => {
    it('round-trips claim -> release -> reclaim by another agent', async () => {
      await storage.createNode(makeNode('t-1'));
      const mgr = createClaimManager(storage);

      const c1 = await mgr.claim('t-1', 'agent-a');
      expect(c1.success).toBe(true);
      expect(c1.claim?.fence).toBe(1);

      // a different agent cannot claim while held
      expect((await mgr.claim('t-1', 'agent-b')).success).toBe(false);

      // holder releases with its fence
      expect(await mgr.release('t-1', 'agent-a', c1.claim!.fence)).toBe(true);

      // now another agent can claim
      const c2 = await mgr.claim('t-1', 'agent-b');
      expect(c2.success).toBe(true);
      expect(c2.claim?.agentId).toBe('agent-b');
      expect(c2.claim?.fence).toBe(2);
    });

    it('reports a precise error for a missing node', async () => {
      const mgr = createClaimManager(storage);
      const r = await mgr.claim('t-missing', 'agent-a');
      expect(r.success).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('renew via ClaimManager rejects a stale fence', async () => {
      await storage.createNode(makeNode('t-1'));
      const mgr = createClaimManager(storage);
      await mgr.claim('t-1', 'agent-a'); // fence 1
      await mgr.claim('t-1', 'agent-a'); // re-claim -> fence 2

      const stale = await mgr.renew('t-1', 'agent-a', 1000, 1);
      expect(stale.success).toBe(false);
      expect(stale.error).toContain('Fence');

      const ok = await mgr.renew('t-1', 'agent-a', 1000, 2);
      expect(ok.success).toBe(true);
    });
  });
});
