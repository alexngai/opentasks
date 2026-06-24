/**
 * REPRO: ready query must honor incoming `blocks` edges.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGraphStore, type GraphStore } from '../store.js';
import { createProviderAwareStore, type ProviderAwareStore } from '../provider-store.js';
import { createSQLitePersister } from '../../storage/sqlite.js';
import { task } from '../../tools/task.js';
import { link } from '../../tools/link.js';
import { query } from '../../tools/query.js';
import type { Storage } from '../../storage/interface.js';
import type { StoredNode, StoredEdge } from '../../schema/storage.js';

describe('REPRO ready honors blocks', () => {
  let tempDir: string;
  let storage: Storage;
  let store: GraphStore;
  let providerStore: ProviderAwareStore;
  let jsonlNodes: StoredNode[] = [];
  let jsonlEdges: StoredEdge[] = [];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-repro-'));
    storage = createSQLitePersister(tempDir);
    jsonlNodes = [];
    jsonlEdges = [];
    store = createGraphStore(
      { basePath: tempDir },
      storage,
      async () => ({ nodes: jsonlNodes, edges: jsonlEdges }),
      async (n, e) => {
        jsonlNodes = n;
        jsonlEdges = e;
      },
    );
    await store.initialize();
    providerStore = createProviderAwareStore(store);
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('repro', async () => {
    const a = await store.createNode({ type: 'task', title: 'A blocker', status: 'open' });
    const b = await store.createNode({ type: 'task', title: 'B assembler', status: 'open' });

    const linkRes = await link(store, { fromId: a.id, toId: b.id, type: 'blocks' });
    console.log('LINK:', JSON.stringify(linkRes));

    // direct graph ready
    const graphReady = await store.query.ready({});
    console.log('GRAPH READY:', graphReady.map((t) => t.id));

    // tools query ready (no providerStore)
    const qReady = await query(store, { ready: {} });
    console.log('QUERY READY (no provider):', JSON.stringify(qReady.items));

    // tools query ready (with providerStore)
    const qReadyP = await query(store, { ready: {} }, undefined, providerStore);
    console.log('QUERY READY (provider):', JSON.stringify(qReadyP.items));

    // task ready (provider federated)
    const taskReadyRes = await task(providerStore, { ready: {} });
    console.log('TASK READY:', JSON.stringify(taskReadyRes.data));

    // blockers of B
    const blockers = await store.query.blockers(b.id);
    console.log('B BLOCKERS:', blockers.map((n) => n.id));

    const aNode = await store.getNode(a.id);
    console.log('A node status:', aNode?.status, 'archived:', aNode?.archived);
    const edgesToB = await storage.getEdgesTo(b.id, 'blocks');
    console.log('EDGES TO B (blocks):', JSON.stringify(edgesToB));

    // Now complete A
    await task(providerStore, { transition: { id: a.id, action: 'complete' } });
    const aAfter = await store.getNode(a.id);
    console.log('A node status after complete:', aAfter?.status);
    const graphReady2 = await store.query.ready({});
    console.log('GRAPH READY after complete:', graphReady2.map((t) => t.id));
  });
});
