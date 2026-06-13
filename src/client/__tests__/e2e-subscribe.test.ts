/**
 * E2E tests for OpenTasksClient.subscribe()
 *
 * Exercises the full client-facing watch pipeline against a real daemon:
 *   OpenTasksClient.subscribe(filter, handler)
 *     → watch.subscribe RPC (binds the filter to this socket)
 *     → mutation → flush → file watcher → diff → filtered broadcast
 *     → watch.event notification → handler
 *
 * The key M1 acceptance criterion (docs/HARDENING-PLAN.md): a filtered
 * subscription receives only matching events; non-matching events are dropped
 * server-side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../../daemon/location-state.js';
import { createDaemon, type Daemon } from '../../daemon/lifecycle.js';
import { OpenTasksClient } from '../client.js';
import type { GraphStore } from '../../graph/store.js';
import type { ProviderNodeChangeEvent } from '../../providers/traits/Watchable.js';
import type { WatchEventPayload, SinceResult } from '../../daemon/events.js';

// ============================================================================
// Helpers
// ============================================================================

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 8000,
): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: OpenTasksClient.subscribe', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: OpenTasksClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-subscribe-'));
    opentasksPath = path.join(tempDir, '.opentasks');
    registryPath = path.join(tempDir, 'registry', 'registry.json');
    await fs.mkdir(opentasksPath, { recursive: true });

    store = await createStoreForLocation(opentasksPath);
    daemon = null;
    client = null;
  });

  afterEach(async () => {
    if (client?.connected) {
      client.disconnect();
    }
    client = null;
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        /* ignore */
      }
      daemon = null;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function startDaemon(): Promise<void> {
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store,
      registryPath,
      shutdownTimeoutMs: 5000,
    });
    await daemon.start();
  }

  function connectClient(): OpenTasksClient {
    client = new OpenTasksClient({ socketPath: daemon!.socketPath, autoConnect: true });
    return client;
  }

  it('delivers events to a subscriber with an empty filter', async () => {
    await startDaemon();
    const c = connectClient();

    const events: ProviderNodeChangeEvent[] = [];
    const unsub = await c.subscribe(undefined, (e) => events.push(e));

    // Let the file watcher fully initialize before mutating.
    await new Promise((r) => setTimeout(r, 300));

    const node = (await c.createNode({
      type: 'task',
      title: 'Hello',
      status: 'open',
    })) as { id: string };
    await c.call('flush');

    await waitFor(() => events.some((e) => e.nodeId === node.id));
    await unsub();

    const created = events.find((e) => e.nodeId === node.id);
    expect(created).toBeTruthy();
    expect(created!.type).toBe('created');
  });

  it('delivers only filter-matching events; drops non-matching ones', async () => {
    await startDaemon();
    const c = connectClient();

    const events: ProviderNodeChangeEvent[] = [];
    // Only want events for nodes whose status is 'open'.
    const unsub = await c.subscribe({ statuses: ['open'] }, (e) => events.push(e));

    await new Promise((r) => setTimeout(r, 300));

    // Matching create.
    const match = (await c.createNode({
      type: 'task',
      title: 'Open task',
      status: 'open',
    })) as { id: string };
    await c.call('flush');

    // Non-matching create (status 'blocked' — excluded by the filter).
    const nonMatch = (await c.createNode({
      type: 'task',
      title: 'Blocked task',
      status: 'blocked',
    })) as { id: string };
    await c.call('flush');

    // Fence: a second matching create. Once we've seen the fence, the diff
    // cycle that produced it has also processed the non-matching node, so its
    // absence is a real signal (not just slow delivery).
    const fence = (await c.createNode({
      type: 'task',
      title: 'Second open task',
      status: 'open',
    })) as { id: string };
    await c.call('flush');

    await waitFor(() => events.some((e) => e.nodeId === fence.id));
    await unsub();

    const ids = events.map((e) => e.nodeId);
    expect(ids).toContain(match.id);
    expect(ids).toContain(fence.id);
    expect(ids).not.toContain(nonMatch.id);
  });

  it('unsubscribe stops further delivery', async () => {
    await startDaemon();
    const c = connectClient();

    const events: ProviderNodeChangeEvent[] = [];
    const unsub = await c.subscribe(undefined, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 300));

    await unsub();

    await c.createNode({ type: 'task', title: 'After unsub', status: 'open' });
    await c.call('flush');

    // Give the pipeline time; no events should arrive (subscriberCount → 0).
    await new Promise((r) => setTimeout(r, 800));

    expect(events.length).toBe(0);
  });

  describe('replay / backfill (M2)', () => {
    it('backfills events missed while disconnected via a resume cursor', async () => {
      await startDaemon();
      const socketPath = daemon!.socketPath;

      // Subscriber 1: receive an event, capture its cursor, then disconnect.
      const c1 = new OpenTasksClient({ socketPath, autoConnect: true });
      const seen1: WatchEventPayload[] = [];
      const unsub1 = await c1.subscribe(undefined, (e) => seen1.push(e));
      await new Promise((r) => setTimeout(r, 300));

      const a = (await c1.createNode({
        type: 'task',
        title: 'A',
        status: 'open',
      })) as { id: string };
      await c1.call('flush');
      await waitFor(() => seen1.some((e) => e.nodeId === a.id));

      const evA = seen1.find((e) => e.nodeId === a.id)!;
      expect(typeof evA.seq).toBe('number');
      expect(typeof evA.epoch).toBe('string');
      const cursor = { epoch: evA.epoch!, seq: evA.seq! };

      await unsub1();
      c1.disconnect();

      // Mutate while no one is subscribed, via a separate connection. The
      // watcher stays active, so the event is still buffered for replay.
      const cMut = new OpenTasksClient({ socketPath, autoConnect: true });
      const b = (await cMut.createNode({
        type: 'task',
        title: 'B',
        status: 'open',
      })) as { id: string };
      await cMut.call('flush');
      await new Promise((r) => setTimeout(r, 500)); // let the watcher diff + buffer
      cMut.disconnect();

      // Subscriber 2: reconnect with the saved cursor → backfills B.
      const c3 = new OpenTasksClient({ socketPath, autoConnect: true });
      const seen3: WatchEventPayload[] = [];
      let resynced = false;
      const unsub3 = await c3.subscribe(undefined, (e) => seen3.push(e), {
        since: cursor,
        onResync: () => {
          resynced = true;
        },
      });

      await waitFor(() => seen3.some((e) => e.nodeId === b.id));
      await unsub3();
      c3.disconnect();

      expect(resynced).toBe(false);
      const ids3 = seen3.map((e) => e.nodeId);
      expect(ids3).toContain(b.id); // missed event backfilled
      expect(ids3).not.toContain(a.id); // already-seen event not replayed
    });

    it('signals resync when the cursor cannot be served (stale epoch)', async () => {
      await startDaemon();
      const c = new OpenTasksClient({ socketPath: daemon!.socketPath, autoConnect: true });

      const seen: WatchEventPayload[] = [];
      let resynced = false;
      const unsub = await c.subscribe(undefined, (e) => seen.push(e), {
        since: { epoch: 'stale-epoch-does-not-match', seq: 999 },
        onResync: () => {
          resynced = true;
        },
      });

      // A cursor from a non-existent epoch can't be served → resync, not silence.
      expect(resynced).toBe(true);

      await unsub();
      c.disconnect();
    });

    it('exposes events.current / events.since as client methods', async () => {
      await startDaemon();
      const c = new OpenTasksClient({ socketPath: daemon!.socketPath, autoConnect: true });

      const base = await c.eventsCurrent();
      expect(typeof base.epoch).toBe('string');
      expect(base.seq).toBe(0);

      // Activate the watcher and produce one event.
      const seen: WatchEventPayload[] = [];
      const unsub = await c.subscribe(undefined, (e) => seen.push(e));
      await new Promise((r) => setTimeout(r, 300));
      const n = (await c.createNode({
        type: 'task',
        title: 'N',
        status: 'open',
      })) as { id: string };
      await c.call('flush');
      await waitFor(() => seen.some((e) => e.nodeId === n.id));

      // events.since from the baseline cursor returns the new event.
      const delta = await c.eventsSince(base);
      if ('resync' in delta && delta.resync) throw new Error('unexpected resync');
      if (!('events' in delta)) throw new Error('expected events');
      expect(delta.epoch).toBe(base.epoch);
      expect(delta.events.some((s) => s.event.nodeId === n.id)).toBe(true);

      // A different epoch → resync.
      const stale = await c.eventsSince({ epoch: 'other-epoch', seq: 0 });
      expect('resync' in stale && stale.resync).toBe(true);

      // A malformed cursor (missing seq) is rejected by the method guard → resync.
      const malformed = (await c.call('events.since', {
        cursor: { epoch: base.epoch },
      })) as SinceResult;
      expect('resync' in malformed && malformed.resync).toBe(true);

      await unsub();
      c.disconnect();
    });
  });
});
