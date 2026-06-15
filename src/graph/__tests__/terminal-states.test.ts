/**
 * Terminal-state tests (HARDENING-PLAN P1.5).
 *
 * `failed` and `abandoned` are first-class terminal states distinct from
 * `closed` (= successfully completed). This lets decommitment be expressed and
 * makes the MAP status mapping lossless (completed vs failed no longer collapse).
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
import type { TaskTransitionData, TaskValidActionsData } from '../../tools/types.js';

describe('Terminal states (failed / abandoned)', () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-terminal-test-'));
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

  it('fails an in-progress task -> status "failed"', async () => {
    const id = await createTask('flaky work');
    await task(providerStore, { transition: { id, action: 'start' } });

    const res = await task(providerStore, { transition: { id, action: 'fail' } });

    expect(res.success).toBe(true);
    expect((res.data as TaskTransitionData).node.status).toBe('failed');
  });

  it('abandons an open task -> status "abandoned"', async () => {
    const id = await createTask('never mind');

    const res = await task(providerStore, { transition: { id, action: 'abandon' } });

    expect(res.success).toBe(true);
    expect((res.data as TaskTransitionData).node.status).toBe('abandoned');
  });

  it('rejects fail from open (must be started first)', async () => {
    const id = await createTask('not started');

    const res = await task(providerStore, { transition: { id, action: 'fail' } });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cannot fail/i);
  });

  it('a failed task can only be reopened', async () => {
    const id = await createTask('to retry');
    await task(providerStore, { transition: { id, action: 'start' } });
    await task(providerStore, { transition: { id, action: 'fail' } });

    const res = await task(providerStore, { validActions: { id } });
    expect((res.data as TaskValidActionsData).actions).toEqual(['reopen']);

    const reopened = await task(providerStore, { transition: { id, action: 'reopen' } });
    expect((reopened.data as TaskTransitionData).node.status).toBe('open');
  });

  it('failed/abandoned are distinct from closed (completed)', async () => {
    const a = await createTask('a');
    const b = await createTask('b');
    await task(providerStore, { transition: { id: a, action: 'start' } });
    await task(providerStore, { transition: { id: a, action: 'complete' } });
    await task(providerStore, { transition: { id: b, action: 'start' } });
    await task(providerStore, { transition: { id: b, action: 'fail' } });

    const aNode = await store.getNode(a);
    const bNode = await store.getNode(b);
    expect((aNode as { status?: string }).status).toBe('closed');
    expect((bNode as { status?: string }).status).toBe('failed');
  });

  it('a failed blocker keeps its dependent out of ready until the blocker is closed', async () => {
    const blocker = await createTask('prerequisite');
    const dependent = await createTask('downstream');
    // blocker blocks dependent (from = blocker, to = dependent)
    await store.createEdge({ from_id: blocker, to_id: dependent, type: 'blocks' });

    // Open blocker -> dependent is not ready.
    let ready = await store.query.ready();
    expect(ready.map((t) => t.id)).not.toContain(dependent);

    // Fail the blocker. A failed prerequisite did NOT deliver, so only 'closed'
    // clears a blocker — the dependent must stay blocked (deliberate: failed and
    // abandoned remain active blockers).
    await task(providerStore, { transition: { id: blocker, action: 'start' } });
    await task(providerStore, { transition: { id: blocker, action: 'fail' } });

    ready = await store.query.ready();
    expect(ready.map((t) => t.id)).not.toContain(dependent);

    // Reopen + complete the blocker -> now closed -> the dependent becomes ready.
    await task(providerStore, { transition: { id: blocker, action: 'reopen' } });
    await task(providerStore, { transition: { id: blocker, action: 'start' } });
    await task(providerStore, { transition: { id: blocker, action: 'complete' } });

    ready = await store.query.ready();
    expect(ready.map((t) => t.id)).toContain(dependent);
  });
});
