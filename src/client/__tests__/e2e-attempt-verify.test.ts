/**
 * E2E for the attempt/verify schema through the REAL daemon + store.
 *
 * Exercises the seam the unit/mocked tests don't: client.createNode/link/query
 * for `attempt` nodes and `verifies` edges over the live Unix socket →
 * daemon graph methods → a real GraphStore (real id-gen, validation, SQLite +
 * JSONL persistence) → back. See docs/ATTEMPT-VERIFY-SCHEMA.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../../daemon/location-state.js';
import { createDaemon, type Daemon } from '../../daemon/lifecycle.js';
import { OpenTasksClient } from '../client.js';
import type { GraphStore } from '../../graph/store.js';

type AnyNode = { id: string; type: string; target_id?: string; status?: string; assignee?: string; metadata?: Record<string, unknown> };
type AnyEdge = { from_id: string; to_id: string; type: string; metadata?: Record<string, unknown> };

describe('E2E: attempt + verify through the real daemon', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: OpenTasksClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-attempt-'));
    opentasksPath = path.join(tempDir, '.opentasks');
    registryPath = path.join(tempDir, 'registry', 'registry.json');
    await fs.mkdir(opentasksPath, { recursive: true });
    store = await createStoreForLocation(opentasksPath);
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store,
      registryPath,
      shutdownTimeoutMs: 5000,
    });
    await daemon.start();
    client = new OpenTasksClient({ socketPath: daemon.socketPath, autoConnect: true });
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

  it('creates, persists, and queries an attempt node + a verifies edge end-to-end', async () => {
    const c = client!;

    // A task to attempt.
    const task = (await c.createNode({ type: 'task', title: 'Add feature X', status: 'open' })) as AnyNode;
    expect(task.id).toMatch(/^t-/);

    // record_attempt (create): an in-progress attempt with evidence-less pending outcome.
    const attempt = (await c.createNode({
      type: 'attempt',
      title: 'Attempt at feature X',
      target_id: task.id,
      assignee: 'agent-A',
      status: 'in_progress',
      metadata: { attempt: { outcome: 'pending' } },
    })) as AnyNode;

    // The real store assigned an `a-` id and persisted the subordinate fields.
    expect(attempt.id).toMatch(/^a-/);
    expect(attempt.type).toBe('attempt');
    expect(attempt.target_id).toBe(task.id);
    expect(attempt.assignee).toBe('agent-A');
    expect((attempt.metadata?.attempt as { outcome?: string })?.outcome).toBe('pending');

    // Round-trips back through the daemon by id.
    const fetched = (await c.getNode(attempt.id)) as AnyNode;
    expect(fetched.id).toBe(attempt.id);
    expect(fetched.target_id).toBe(task.id);

    // A verifier's attempt, then a `verifies` edge carrying the verdict.
    const verifier = (await c.createNode({
      type: 'attempt',
      title: 'Independent check',
      target_id: task.id,
      assignee: 'agent-B',
      status: 'closed',
      metadata: { attempt: { outcome: 'success' } },
    })) as AnyNode;

    const linkResult = await c.link({
      fromId: verifier.id,
      toId: attempt.id,
      type: 'verifies',
      metadata: { verdict: 'pass', verifier: 'agent-B' },
    });
    expect(linkResult.success).toBe(true);

    // Query both attempts back (verbose → full nodes with metadata/target_id).
    const nodeResult = await c.query({ nodes: { type: 'attempt' }, verbose: true });
    const attempts = nodeResult.items as unknown as AnyNode[];
    expect(attempts.map((n) => n.id).sort()).toEqual([attempt.id, verifier.id].sort());
    expect(attempts.every((n) => n.target_id === task.id)).toBe(true);

    // Query the verifies edge back with its verdict metadata.
    const edgeResult = await c.query({ edges: { type: 'verifies' }, verbose: true });
    const edges = edgeResult.items as unknown as AnyEdge[];
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from_id: verifier.id, to_id: attempt.id, type: 'verifies' });
    expect((edges[0].metadata as { verdict?: string })?.verdict).toBe('pass');
  });

  it('updating an attempt to a terminal outcome persists it (record_attempt update path)', async () => {
    const c = client!;
    const task = (await c.createNode({ type: 'task', title: 'T', status: 'open' })) as AnyNode;
    const attempt = (await c.createNode({
      type: 'attempt',
      title: 'A',
      target_id: task.id,
      assignee: 'agent-A',
      status: 'in_progress',
      metadata: { attempt: { outcome: 'pending' } },
    })) as AnyNode;

    await c.updateNode(attempt.id, {
      status: 'closed',
      metadata: { attempt: { outcome: 'failure', failureReason: 'compile error' } },
    });

    const fetched = (await c.getNode(attempt.id)) as AnyNode;
    expect(fetched.status).toBe('closed');
    expect((fetched.metadata?.attempt as { outcome?: string; failureReason?: string })).toMatchObject({
      outcome: 'failure',
      failureReason: 'compile error',
    });
  });
});
