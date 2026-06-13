/**
 * E2E tests for the daemon `health` method counters (P3 M3 / F10).
 *
 * Verifies the health response surfaces watcher/reconcile counters and that the
 * reconcile loop's liveness is observable after a graph change.
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

interface HealthResponse {
  status: string;
  version: string;
  counters?: {
    watcherErrors: number;
    lastWatcherErrorAt: string | null;
    reconcileRuns: number;
    reconcileErrors: number;
    lastReconcileAt: string | null;
    lastReconcileErrorAt: string | null;
  };
  sync?: unknown;
}

describe('E2E: health counters', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: IPCClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-health-'));
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

  it('surfaces watcher/reconcile counters with sane initial values', async () => {
    await startDaemon();
    client = createIPCClient(daemon!.socketPath);
    await client.connect();

    const health = await client.request<HealthResponse>('health');

    expect(health.counters).toBeDefined();
    expect(health.counters!.watcherErrors).toBe(0);
    expect(health.counters!.reconcileErrors).toBe(0);
    expect(health.counters!.lastWatcherErrorAt).toBeNull();
    // sync is null with git sync disabled (still present as a field).
    expect(health.sync ?? null).toBeNull();
  });

  it('records reconcile liveness after a graph change', async () => {
    await startDaemon();
    client = createIPCClient(daemon!.socketPath);
    await client.connect();

    // A create + flush writes graph.jsonl → file watcher → provider reconcile.
    await client.request<Node>('graph.create', {
      type: 'task',
      title: 'Trigger reconcile',
      status: 'open',
    });
    await client.request('flush');

    // Wait for the watcher + reconcile to run.
    const start = Date.now();
    let counters: HealthResponse['counters'];
    while (Date.now() - start < 6000) {
      const health = await client.request<HealthResponse>('health');
      counters = health.counters;
      if (counters && counters.reconcileRuns >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(counters!.reconcileRuns).toBeGreaterThanOrEqual(1);
    expect(counters!.lastReconcileAt).not.toBeNull();
    expect(counters!.reconcileErrors).toBe(0);
  });
});
