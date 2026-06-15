/**
 * E2E: cross-system provenance from git-cascade events (P5 5.2 + flagship demo).
 *
 * Proves the "building block" claim end-to-end against a real daemon: a task is
 * created → claimed (as swarm-dispatch would) → "implemented" on a git-cascade
 * stream → closed, with provenance edges (task ← stream, task ← commit)
 * queryable in ONE call.
 *
 * Design decision (see docs/HARDENING-PLAN.md P5): OpenTasks stays
 * git-cascade-agnostic — there is no cascade provider or handler in opentasks.
 * The cascade-event → graph-edge mapping is CALLER-SIDE glue (it would live in
 * cc-swarm's sidecar, which already receives the events). This test embeds that
 * glue (`ingestCascadeEvent`) to document the pattern and prove it composes from
 * the existing `createNode` + `link` primitives. The events use the faithful
 * `x-cascade/stream.*` shapes (git-cascade `StreamOpenedParams` /
 * `StreamCommittedParams`); the integration contract is the event format, not
 * git-cascade's runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../../daemon/location-state.js';
import { createDaemon, type Daemon } from '../../daemon/lifecycle.js';
import { OpenTasksClient } from '../client.js';
import type { GraphStore } from '../../graph/store.js';

// ---------------------------------------------------------------------------
// Caller-side cascade ingestion (the documented pattern — NOT opentasks core).
// Given an `x-cascade/stream.*` event carrying `metadata.task_ref`, upsert an
// external `cascade://` node and link it to the referenced task. Returns the
// created node ids so a consumer can build the stream→commit chain.
// ---------------------------------------------------------------------------

interface CascadeEvent {
  method: string; // e.g. "x-cascade/stream.opened"
  params: {
    stream_id: string;
    name?: string;
    commit?: string;
    metadata?: { task_ref?: { resource_id: string; node_id: string } };
  };
}

async function ingestCascadeEvent(
  client: OpenTasksClient,
  event: CascadeEvent,
  state: { streamNodeId?: string },
): Promise<void> {
  const taskRef = event.params.metadata?.task_ref;
  if (!taskRef) return; // git-cascade events without a task_ref carry no link

  if (event.method.endsWith('stream.opened')) {
    const stream = (await client.createNode({
      type: 'external',
      title: `stream ${event.params.name ?? event.params.stream_id}`,
      uri: `cascade://${event.params.stream_id}`,
      source: 'cascade',
    } as never)) as { id: string };
    state.streamNodeId = stream.id;
    // The stream does the work for the task.
    await client.link({ fromId: stream.id, toId: taskRef.node_id, type: 'implements' });
  } else if (event.method.endsWith('stream.committed')) {
    const commit = (await client.createNode({
      type: 'external',
      title: `commit ${(event.params.commit ?? '').slice(0, 8)}`,
      uri: `cascade://${event.params.stream_id}@${event.params.commit}`,
      source: 'cascade',
    } as never)) as { id: string };
    // The commit references the task, and belongs to the stream (the chain).
    await client.link({ fromId: commit.id, toId: taskRef.node_id, type: 'references' });
    if (state.streamNodeId) {
      await client.link({ fromId: state.streamNodeId, toId: commit.id, type: 'parent-of' });
    }
  }
}

// ============================================================================

describe('E2E: cross-system provenance (git-cascade → OpenTasks)', () => {
  let tempDir: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore;
  let daemon: Daemon | null;
  let client: OpenTasksClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-cascade-'));
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

  async function startDaemon(): Promise<OpenTasksClient> {
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store,
      registryPath,
      shutdownTimeoutMs: 5000,
    });
    await daemon.start();
    client = new OpenTasksClient({ socketPath: daemon.socketPath, autoConnect: true });
    return client;
  }

  it('task → claim → cascade stream/commit → close, provenance queryable in one call', async () => {
    const c = await startDaemon();

    // 1. A task is created.
    const task = (await c.createNode({
      type: 'task',
      title: 'Add OAuth provider',
      status: 'open',
    })) as { id: string };

    // 2. Claimed (as swarm-dispatch would, via the atomic claim).
    const claim = (await c.task({ claim: { id: task.id, agentId: 'agent-1' } })) as {
      data?: { claimed?: boolean };
    };
    expect(claim.data?.claimed).toBe(true);

    // 3. The agent works on a git-cascade stream — faithful x-cascade events,
    //    each stamped by cc-swarm with the in-progress task's ref.
    const streamId = 'st-7f3a91';
    const sha = 'a1b2c3d4e5f60718';
    const taskRef = { resource_id: 'native://local', node_id: task.id };
    const events: CascadeEvent[] = [
      {
        method: 'x-cascade/stream.opened',
        params: { stream_id: streamId, name: 'feat-oauth', metadata: { task_ref: taskRef } },
      },
      {
        method: 'x-cascade/stream.committed',
        params: { stream_id: streamId, commit: sha, metadata: { task_ref: taskRef } },
      },
    ];

    // 4. Caller-side ingestion writes the provenance edges (opentasks-agnostic).
    const state: { streamNodeId?: string } = {};
    for (const event of events) await ingestCascadeEvent(c, event, state);

    // 5. Stream merged → task closed completed.
    await c.task({ transition: { id: task.id, action: 'start' } });
    await c.task({ transition: { id: task.id, action: 'complete' } });

    // 6. Provenance is queryable in ONE call: every edge pointing at the task.
    //    (The `edges` filter uses to_id/from_id; the EdgeSummary result uses
    //    fromId/toId.)
    const result = (await c.query({ edges: { to_id: task.id } })) as {
      items?: Array<{ fromId: string; toId: string; type: string }>;
    };
    const edges = result.items ?? [];

    // The stream implements the task; a commit references it.
    const implementsEdge = edges.find((e) => e.type === 'implements');
    const referencesEdge = edges.find((e) => e.type === 'references');
    expect(implementsEdge).toBeTruthy();
    expect(referencesEdge).toBeTruthy();

    // Resolve the linked nodes — they are the cascade stream + commit.
    const streamNode = (await c.getNode(implementsEdge!.fromId)) as { uri?: string };
    const commitNode = (await c.getNode(referencesEdge!.fromId)) as { uri?: string };
    expect(streamNode.uri).toBe(`cascade://${streamId}`);
    expect(commitNode.uri).toBe(`cascade://${streamId}@${sha}`);

    // The stream → commit chain edge exists too (task → stream → commit).
    const fromStream = (await c.query({ edges: { from_id: state.streamNodeId! } })) as {
      items?: Array<{ toId: string; type: string }>;
    };
    expect(
      (fromStream.items ?? []).some(
        (e) => e.type === 'parent-of' && e.toId === referencesEdge!.fromId,
      ),
    ).toBe(true);

    // 7. The task is closed.
    const finalTask = (await c.getNode(task.id)) as { status?: string };
    expect(finalTask.status).toBe('closed');
  });

  it('cascade events without a task_ref create no edges (ingestion is opt-in)', async () => {
    const c = await startDaemon();
    const task = (await c.createNode({ type: 'task', title: 'Unlinked', status: 'open' })) as {
      id: string;
    };

    const state: { streamNodeId?: string } = {};
    await ingestCascadeEvent(
      c,
      { method: 'x-cascade/stream.opened', params: { stream_id: 'st-x', name: 'orphan' } },
      state,
    );

    const result = (await c.query({ edges: { to_id: task.id } })) as { items?: unknown[] };
    expect((result.items ?? []).length).toBe(0);
  });
});
