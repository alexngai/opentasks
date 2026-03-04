/**
 * E2E Store Roundtrip Tests
 *
 * Exercises real SQLite + JSONL persistence via createStoreForLocation.
 * Verifies CRUD → flush → reload roundtrips and cross-provider blocker resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStoreForLocation } from '../../daemon/location-state.js';
import type { GraphStore } from '../store.js';

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;
let opentasksPath: string;
let store: GraphStore;

async function freshStore(): Promise<GraphStore> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-store-'));
  opentasksPath = path.join(tempDir, '.opentasks');
  await fs.mkdir(opentasksPath, { recursive: true });
  store = await createStoreForLocation(opentasksPath);
  return store;
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Store JSONL Roundtrip', () => {
  beforeEach(async () => {
    await freshStore();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch { /* ignore */ }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('nodes survive flush + reload', async () => {
    const node = await store.createNode({ type: 'task', title: 'Roundtrip Task', status: 'open' });

    await store.flush();
    await store.reload();

    const retrieved = await store.getNode(node.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Roundtrip Task');
    expect(retrieved!.status).toBe('open');
  });

  it('tags survive flush + reload', async () => {
    const node = await store.createNode({ type: 'task', title: 'Tagged Task', status: 'open' });
    await store.addTags(node.id, ['bug', 'urgent']);

    await store.flush();
    await store.reload();

    const retrieved = await store.getNode(node.id);
    expect(retrieved).not.toBeNull();

    // Verify tags are still present via query
    const tagged = await store.query.nodes({ tags: ['bug'] });
    expect(tagged.some((n) => n.id === node.id)).toBe(true);
  });

  it('edges survive flush + reload', async () => {
    const parent = await store.createNode({ type: 'task', title: 'Parent', status: 'open' });
    const child = await store.createNode({ type: 'task', title: 'Child', status: 'open' });
    const edge = await store.createEdge({ from_id: parent.id, to_id: child.id, type: 'blocks' });

    await store.flush();
    await store.reload();

    const retrieved = await store.getEdge(edge.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.from_id).toBe(parent.id);
    expect(retrieved!.to_id).toBe(child.id);
    expect(retrieved!.type).toBe('blocks');
  });

  it('external node addition via reload', async () => {
    // Create initial node and flush
    await store.createNode({ type: 'task', title: 'Existing', status: 'open' });
    await store.flush();

    // Manually append a new node to graph.jsonl
    const jsonlPath = path.join(opentasksPath, 'graph.jsonl');
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const newNode = {
      id: 't-external1',
      uuid: 'ext-uuid-001',
      type: 'task',
      title: 'External Node',
      status: 'open',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    };
    await fs.writeFile(jsonlPath, content + JSON.stringify(newNode) + '\n', 'utf-8');

    await store.reload();

    const retrieved = await store.getNode('t-external1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('External Node');
  });

  it('external node modification via reload', async () => {
    const node = await store.createNode({ type: 'task', title: 'Original Title', status: 'open' });
    await store.flush();

    // Modify title in JSONL directly
    const jsonlPath = path.join(opentasksPath, 'graph.jsonl');
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const modified = content.replace('Original Title', 'Modified Title');
    await fs.writeFile(jsonlPath, modified, 'utf-8');

    await store.reload();

    const retrieved = await store.getNode(node.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Modified Title');
  });

  it('external node deletion via reload', async () => {
    const node1 = await store.createNode({ type: 'task', title: 'Keep Me', status: 'open' });
    const node2 = await store.createNode({ type: 'task', title: 'Delete Me', status: 'open' });
    await store.flush();

    // Rewrite JSONL without node2
    const jsonlPath = path.join(opentasksPath, 'graph.jsonl');
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const obj = JSON.parse(line);
        return obj.id !== node2.id;
      } catch {
        return true;
      }
    });
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

    await store.reload();

    const kept = await store.getNode(node1.id);
    expect(kept).not.toBeNull();
    expect(kept!.title).toBe('Keep Me');

    const deleted = await store.getNode(node2.id);
    expect(deleted).toBeNull();
  });

  it('external edge deletion via reload', async () => {
    const a = await store.createNode({ type: 'task', title: 'A', status: 'open' });
    const b = await store.createNode({ type: 'task', title: 'B', status: 'open' });
    const edge = await store.createEdge({ from_id: a.id, to_id: b.id, type: 'blocks' });
    await store.flush();

    // Rewrite JSONL without the edge
    const jsonlPath = path.join(opentasksPath, 'graph.jsonl');
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter((line) => {
      if (!line.trim()) return false;
      try {
        const obj = JSON.parse(line);
        return obj.id !== edge.id;
      } catch {
        return true;
      }
    });
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n', 'utf-8');

    await store.reload();

    const retrieved = await store.getEdge(edge.id);
    expect(retrieved).toBeNull();

    // Nodes should still exist
    expect(await store.getNode(a.id)).not.toBeNull();
    expect(await store.getNode(b.id)).not.toBeNull();
  });
});

describe('E2E: Cross-Provider Blocker Resolution', () => {
  beforeEach(async () => {
    await freshStore();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch { /* ignore */ }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('edge creation with external URI succeeds', async () => {
    const task = await store.createNode({ type: 'task', title: 'Local Task', status: 'open' });
    await store.flush();

    // Create edge with global:// URI as from_id
    const edge = await store.createEdge({
      from_id: 'global://g-blocker',
      to_id: task.id,
      type: 'blocks',
    });

    expect(edge).toBeTruthy();
    expect(edge.from_id).toBe('global://g-blocker');
    expect(edge.to_id).toBe(task.id);
  });

  it('ready() excludes task with active external blocker', async () => {
    const task = await store.createNode({ type: 'task', title: 'Blocked Task', status: 'open' });
    await store.createEdge({
      from_id: 'global://g-active',
      to_id: task.id,
      type: 'blocks',
    });

    // Set resolver that returns an active (open) blocker
    store.setNodeResolver(async (idOrUri: string) => {
      if (idOrUri === 'global://g-active') {
        return {
          id: 'g-active',
          uuid: 'uuid-g-active',
          type: 'task',
          title: 'Active Blocker',
          status: 'open',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    const ready = await store.query.ready();
    expect(ready.every((n) => n.id !== task.id)).toBe(true);
  });

  it('ready() includes task when external blocker is closed', async () => {
    const task = await store.createNode({ type: 'task', title: 'Unblocked Task', status: 'open' });
    await store.createEdge({
      from_id: 'global://g-done',
      to_id: task.id,
      type: 'blocks',
    });

    // Set resolver that returns a closed blocker
    store.setNodeResolver(async (idOrUri: string) => {
      if (idOrUri === 'global://g-done') {
        return {
          id: 'g-done',
          uuid: 'uuid-g-done',
          type: 'task',
          title: 'Done Blocker',
          status: 'closed',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    const ready = await store.query.ready();
    expect(ready.some((n) => n.id === task.id)).toBe(true);
  });

  it('ready() handles mixed local + external blockers', async () => {
    const blocker = await store.createNode({ type: 'task', title: 'Local Blocker', status: 'open' });
    const task = await store.createNode({ type: 'task', title: 'Doubly Blocked', status: 'open' });

    // Local blocker edge
    await store.createEdge({
      from_id: blocker.id,
      to_id: task.id,
      type: 'blocks',
    });
    // External blocker edge
    await store.createEdge({
      from_id: 'global://g-ext',
      to_id: task.id,
      type: 'blocks',
    });

    // External blocker is closed, but local blocker is open → not ready
    store.setNodeResolver(async (idOrUri: string) => {
      if (idOrUri === 'global://g-ext') {
        return {
          id: 'g-ext',
          uuid: 'uuid-g-ext',
          type: 'task',
          title: 'External',
          status: 'closed',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    let ready = await store.query.ready();
    expect(ready.every((n) => n.id !== task.id)).toBe(true);

    // Close local blocker
    await store.updateNode(blocker.id, { status: 'closed' });

    ready = await store.query.ready();
    expect(ready.some((n) => n.id === task.id)).toBe(true);
  });

  it('query.blockers() resolves external URIs', async () => {
    const task = await store.createNode({ type: 'task', title: 'Task With External Blocker', status: 'open' });
    await store.createEdge({
      from_id: 'global://g-blocker-info',
      to_id: task.id,
      type: 'blocks',
    });

    store.setNodeResolver(async (idOrUri: string) => {
      if (idOrUri === 'global://g-blocker-info') {
        return {
          id: 'g-blocker-info',
          uuid: 'uuid-g-bi',
          type: 'task',
          title: 'Remote Blocker',
          status: 'in_progress',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-01T00:00:00.000Z',
        };
      }
      return null;
    });

    const blockers = await store.query.blockers(task.id);
    expect(blockers.some((b) => b.id === 'g-blocker-info')).toBe(true);
  });
});
