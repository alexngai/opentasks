/**
 * E2E tests for idempotent node creation (P3 M3 / F9).
 *
 * A `graph.create` carrying an `idempotency_key` is deduped by the daemon: a
 * retry with the same key returns the original node instead of a duplicate.
 * Drives the real daemon + OpenTasksClient.createNode path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../../daemon/location-state.js';
import { createDaemon, type Daemon } from '../../daemon/lifecycle.js';
import { OpenTasksClient } from '../client.js';
import type { GraphStore } from '../../graph/store.js';

describe('E2E: idempotent create', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: OpenTasksClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-idem-'));
    opentasksPath = path.join(tempDir, '.opentasks');
    registryPath = path.join(tempDir, 'registry', 'registry.json');
    await fs.mkdir(opentasksPath, { recursive: true });
    store = await createStoreForLocation(opentasksPath);
    daemon = null;
    client = null;
  });

  afterEach(async () => {
    if (client?.connected) client.disconnect();
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

  it('returns the original node when a create is retried with the same key', async () => {
    await startDaemon();
    const c = connectClient();

    const first = (await c.createNode(
      { type: 'task', title: 'Retry me', status: 'open' },
      { idempotencyKey: 'k-1' },
    )) as { id: string };

    const second = (await c.createNode(
      { type: 'task', title: 'Retry me', status: 'open' },
      { idempotencyKey: 'k-1' },
    )) as { id: string };

    expect(second.id).toBe(first.id);

    // Exactly one node exists.
    const all = await store.query.nodes({});
    expect(all.filter((n) => (n as { title?: string }).title === 'Retry me')).toHaveLength(1);
  });

  it('creates distinct nodes for distinct keys', async () => {
    await startDaemon();
    const c = connectClient();

    const a = (await c.createNode(
      { type: 'task', title: 'A', status: 'open' },
      { idempotencyKey: 'k-a' },
    )) as { id: string };
    const b = (await c.createNode(
      { type: 'task', title: 'B', status: 'open' },
      { idempotencyKey: 'k-b' },
    )) as { id: string };

    expect(a.id).not.toBe(b.id);
  });

  it('does not dedupe creates without a key', async () => {
    await startDaemon();
    const c = connectClient();

    const a = (await c.createNode({ type: 'task', title: 'No key', status: 'open' })) as {
      id: string;
    };
    const b = (await c.createNode({ type: 'task', title: 'No key', status: 'open' })) as {
      id: string;
    };

    expect(a.id).not.toBe(b.id);
  });
});
