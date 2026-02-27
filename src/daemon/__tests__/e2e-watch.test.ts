/**
 * E2E Watch Tests
 *
 * Tests the full watch notification pipeline:
 *   daemon (real store) + file watcher + IPC subscribe → watch.event notifications
 *
 * Uses createStoreForLocation (real SQLite + JSONL), createDaemon, createIPCClient.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../location-state.js';
import { createDaemon, type Daemon } from '../lifecycle.js';
import { createIPCClient, type IPCClient } from '../ipc.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node } from '../../schema/index.js';

// ============================================================================
// Helpers
// ============================================================================

interface WatchEvent {
  type: 'created' | 'updated' | 'deleted';
  nodeId: string;
  [key: string]: unknown;
}

/**
 * Collect watch.event notifications from a client
 */
function collectNotifications(client: IPCClient): {
  events: WatchEvent[];
  stop: () => void;
} {
  const events: WatchEvent[] = [];
  const unsub = client.onNotification((method, params) => {
    if (method === 'watch.event') {
      events.push(params as WatchEvent);
    }
  });
  return { events, stop: unsub };
}

/**
 * Wait until the events array has at least `count` entries, or timeout
 */
async function waitForEvents(
  events: WatchEvent[],
  count: number,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();
  while (events.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Watch Notifications', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: IPCClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-watch-'));
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
      client = null;
    }
    if (daemon) {
      try {
        await daemon.stop();
      } catch { /* ignore */ }
      daemon = null;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
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

  async function connectClient(): Promise<IPCClient> {
    client = createIPCClient(daemon!.socketPath);
    await client.connect();
    return client;
  }

  it('emits created event for new node', async () => {
    await startDaemon();
    const c = await connectClient();

    // Subscribe
    await c.request('watch.subscribe');
    const { events, stop } = collectNotifications(c);

    // Create a node via IPC
    await c.request<Node>('graph.create', {
      type: 'task',
      title: 'Watch Test Node',
      status: 'open',
    });

    // Flush to trigger file write → watcher → diff → broadcast
    await c.request('flush');

    // Wait for chokidar + debounce pipeline
    await waitForEvents(events, 1);
    stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const created = events.find((e) => e.type === 'created');
    expect(created).toBeTruthy();
    expect(created!.nodeId).toBeTruthy();
  });

  it('emits updated event for modified node', async () => {
    await startDaemon();
    const c = await connectClient();

    // Create and flush before subscribing (so it's in the cache)
    const node = await c.request<Node>('graph.create', {
      type: 'task',
      title: 'Before Update',
      status: 'open',
    });
    await c.request('flush');

    // Wait for JSONL write to settle
    await new Promise((r) => setTimeout(r, 300));

    // Now subscribe (seeds cache with current state)
    await c.request('watch.subscribe');
    const { events, stop } = collectNotifications(c);

    // Update the node
    await c.request('graph.update', {
      id: node.id,
      title: 'After Update',
    });
    await c.request('flush');

    await waitForEvents(events, 1);
    stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const updated = events.find((e) => e.type === 'updated');
    expect(updated).toBeTruthy();
    expect(updated!.nodeId).toBe(node.id);
  });

  it('emits deleted event for removed node', async () => {
    await startDaemon();
    const c = await connectClient();

    // Create and flush before subscribing
    const node = await c.request<Node>('graph.create', {
      type: 'task',
      title: 'To Delete',
      status: 'open',
    });
    await c.request('flush');
    await new Promise((r) => setTimeout(r, 300));

    // Subscribe (seeds cache)
    await c.request('watch.subscribe');
    const { events, stop } = collectNotifications(c);

    // Hard-delete the node
    await c.request('graph.delete', {
      id: node.id,
      options: { hard: true },
    });
    await c.request('flush');

    await waitForEvents(events, 1);
    stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const deleted = events.find((e) => e.type === 'deleted');
    expect(deleted).toBeTruthy();
    expect(deleted!.nodeId).toBe(node.id);
  });

  it('unsubscribe stops events', async () => {
    await startDaemon();
    const c = await connectClient();

    // Subscribe then unsubscribe
    await c.request('watch.subscribe');
    const { events, stop } = collectNotifications(c);
    await c.request('watch.unsubscribe');

    // Create + flush
    await c.request<Node>('graph.create', {
      type: 'task',
      title: 'Should Not Notify',
      status: 'open',
    });
    await c.request('flush');

    // Wait to confirm no events arrive
    await new Promise((r) => setTimeout(r, 800));
    stop();

    // subscriberCount dropped to 0 so diffAndBroadcast is skipped
    expect(events.length).toBe(0);
  });

  it('detects multiple event types in sequence', async () => {
    await startDaemon();
    const c = await connectClient();

    // Subscribe (empty cache)
    await c.request('watch.subscribe');
    const { events, stop } = collectNotifications(c);

    // Create
    const node = await c.request<Node>('graph.create', {
      type: 'task',
      title: 'Multi Event',
      status: 'open',
    });
    await c.request('flush');
    await waitForEvents(events, 1);

    // Update
    await c.request('graph.update', {
      id: node.id,
      title: 'Multi Event Updated',
    });
    await c.request('flush');
    await waitForEvents(events, 2);

    // Delete
    await c.request('graph.delete', {
      id: node.id,
      options: { hard: true },
    });
    await c.request('flush');
    await waitForEvents(events, 3);

    stop();

    const types = events.map((e) => e.type);
    expect(types).toContain('created');
    expect(types).toContain('updated');
    expect(types).toContain('deleted');
  });
});
