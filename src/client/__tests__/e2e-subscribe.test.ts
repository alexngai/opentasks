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
});
