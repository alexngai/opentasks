/**
 * Claim wiring tests (HARDENING-PLAN P1).
 *
 * Exercises the full native path through the task tool:
 *   task() -> ProviderAwareStore.taskClaim/... -> GraphStore.claim/... ->
 *   ClaimManager -> atomic SQLite primitives.
 *
 * Complements coordination.test.ts (which tests the storage/manager layer) by
 * proving the operations are reachable and correct via the agent-facing tool,
 * including claimNext and end-to-end fencing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGraphStore, type GraphStore } from '../store.js';
import { createProviderAwareStore, type ProviderAwareStore } from '../provider-store.js';
import { createSQLitePersister } from '../../storage/sqlite.js';
import { task } from '../../tools/task.js';
import type { Storage } from '../../storage/interface.js';
import type { StoredNode, StoredEdge } from '../../schema/storage.js';
import type { TaskClaimData, TaskReleaseData } from '../../tools/types.js';

describe('Claim wiring (task tool -> provider store -> graph store)', () => {
  let tempDir: string;
  let storage: Storage;
  let store: GraphStore;
  let providerStore: ProviderAwareStore;

  let jsonlNodes: StoredNode[] = [];
  let jsonlEdges: StoredEdge[] = [];
  async function jsonlLoad() {
    return { nodes: jsonlNodes, edges: jsonlEdges };
  }
  async function jsonlSave(nodes: StoredNode[], edges: StoredEdge[]) {
    jsonlNodes = nodes;
    jsonlEdges = edges;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-claim-test-'));
    storage = createSQLitePersister(tempDir);
    jsonlNodes = [];
    jsonlEdges = [];
    store = createGraphStore({ basePath: tempDir }, storage, jsonlLoad, jsonlSave);
    await store.initialize();
    providerStore = createProviderAwareStore(store);
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      // ignore
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createTask(title: string): Promise<string> {
    const node = await store.createNode({ type: 'task', title, status: 'open' });
    return node.id;
  }

  it('claims a task via the tool and reports a fence', async () => {
    const id = await createTask('build feature');

    const res = await task(providerStore, { claim: { id, agentId: 'agent-a' } });

    expect(res.success).toBe(true);
    const data = res.data as TaskClaimData;
    expect(data.type).toBe('claim');
    expect(data.claimed).toBe(true);
    expect(data.nodeId).toBe(id);
    expect(data.fence).toBe(1);
    expect(data.lockUntil).toBeTruthy();
  });

  it('reports claimed=false (not an error) when another agent already holds it', async () => {
    const id = await createTask('build feature');
    await task(providerStore, { claim: { id, agentId: 'agent-a' } });

    const res = await task(providerStore, { claim: { id, agentId: 'agent-b' } });

    expect(res.success).toBe(true);
    const data = res.data as TaskClaimData;
    expect(data.claimed).toBe(false);
    expect(data.existingClaim?.agentId).toBe('agent-a');
  });

  it('errors when claiming a node that does not exist', async () => {
    const res = await task(providerStore, { claim: { id: 't-missing', agentId: 'agent-a' } });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('lets exactly one of 16 concurrent claims via the tool win', async () => {
    const id = await createTask('hot task');

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        task(providerStore, { claim: { id, agentId: `agent-${i}` } }),
      ),
    );

    const won = results.filter((r) => r.success && (r.data as TaskClaimData).claimed);
    expect(won).toHaveLength(1);
  });

  it('claimNext claims a ready task, and returns claimed=false when none remain', async () => {
    await createTask('only task');

    const first = await task(providerStore, { claimNext: { agentId: 'agent-a' } });
    expect(first.success).toBe(true);
    const firstData = first.data as TaskClaimData;
    expect(firstData.type).toBe('claimNext');
    expect(firstData.claimed).toBe(true);
    expect(firstData.nodeId).toBeTruthy();

    // The only task is now under a live lease -> nothing left to claim.
    const second = await task(providerStore, { claimNext: { agentId: 'agent-b' } });
    expect((second.data as TaskClaimData).claimed).toBe(false);
  });

  it('round-trips claim -> release -> reclaim via the tool', async () => {
    const id = await createTask('release me');

    const claim = await task(providerStore, { claim: { id, agentId: 'agent-a' } });
    const fence = (claim.data as TaskClaimData).fence;

    // wrong fence does not release
    const badRelease = await task(providerStore, {
      release: { id, agentId: 'agent-a', fence: (fence ?? 1) + 99 },
    });
    expect((badRelease.data as TaskReleaseData).released).toBe(false);

    // correct fence releases
    const release = await task(providerStore, { release: { id, agentId: 'agent-a', fence } });
    expect((release.data as TaskReleaseData).released).toBe(true);

    // now another agent can claim
    const reclaim = await task(providerStore, { claim: { id, agentId: 'agent-b' } });
    expect((reclaim.data as TaskClaimData).claimed).toBe(true);
  });

  it('renews a held claim and rejects a stale fence via the tool', async () => {
    const id = await createTask('renew me');
    await task(providerStore, { claim: { id, agentId: 'agent-a' } }); // fence 1
    await task(providerStore, { claim: { id, agentId: 'agent-a' } }); // re-claim -> fence 2

    const stale = await task(providerStore, {
      renew: { id, agentId: 'agent-a', fence: 1 },
    });
    expect((stale.data as TaskClaimData).claimed).toBe(false);

    const ok = await task(providerStore, { renew: { id, agentId: 'agent-a', fence: 2 } });
    expect((ok.data as TaskClaimData).claimed).toBe(true);
  });

  it('rejects exactly-one-operation violations', async () => {
    const none = await task(providerStore, {});
    expect(none.success).toBe(false);
    expect(none.error).toContain('No operation');

    const id = await createTask('x');
    const two = await task(providerStore, {
      claim: { id, agentId: 'a' },
      release: { id, agentId: 'a' },
    });
    expect(two.success).toBe(false);
    expect(two.error).toContain('Multiple operations');
  });
});
