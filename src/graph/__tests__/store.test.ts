/**
 * Tests for Graph Store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGraphStore, type GraphStore } from '../store.js';
import type { Storage, Transaction } from '../../storage/interface.js';
import type { StoredNode, StoredEdge } from '../../schema/storage.js';
import type { EdgeType } from '../../schema/edges.js';
import type { GraphStoreConfig } from '../types.js';
import { GraphError } from '../types.js';
import type { NodeResolver } from '../query.js';

// ============================================================================
// Mock Storage
// ============================================================================

function createMockStorage(): Storage & {
  _nodes: Map<string, StoredNode>;
  _edges: Map<string, StoredEdge>;
  _tags: Map<string, Set<string>>;
  _dirty: Set<string>;
} {
  const nodes = new Map<string, StoredNode>();
  const edges = new Map<string, StoredEdge>();
  const tags = new Map<string, Set<string>>();
  const dirty = new Set<string>();

  return {
    _nodes: nodes,
    _edges: edges,
    _tags: tags,
    _dirty: dirty,

    async createNode(node: StoredNode): Promise<void> {
      if (nodes.has(node.id)) {
        throw new Error(`Node already exists: ${node.id}`);
      }
      nodes.set(node.id, { ...node });
    },

    async getNode(id: string): Promise<StoredNode | null> {
      return nodes.get(id) || null;
    },

    async updateNode(id: string, updates: Partial<StoredNode>): Promise<void> {
      const existing = nodes.get(id);
      if (!existing) {
        throw new Error(`Node not found: ${id}`);
      }
      nodes.set(id, { ...existing, ...updates });
    },

    async deleteNode(id: string): Promise<void> {
      nodes.delete(id);
      tags.delete(id);
    },

    async queryNodes(filter: {
      type?: string | string[];
      status?: string | string[];
      archived?: boolean;
      parent_id?: string;
    }): Promise<StoredNode[]> {
      let result = Array.from(nodes.values());

      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        result = result.filter((n) => types.includes(n.type));
      }
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        result = result.filter((n) => n.status && statuses.includes(n.status));
      }
      if (filter.archived !== undefined) {
        result = result.filter((n) => n.archived === filter.archived);
      }
      if (filter.parent_id) {
        result = result.filter((n) => n.parent_id === filter.parent_id);
      }

      return result;
    },

    async createEdge(edge: StoredEdge): Promise<void> {
      if (edges.has(edge.id)) {
        throw new Error(`Edge already exists: ${edge.id}`);
      }
      edges.set(edge.id, { ...edge });
    },

    async getEdge(id: string): Promise<StoredEdge | null> {
      return edges.get(id) || null;
    },

    async deleteEdge(id: string): Promise<void> {
      edges.delete(id);
    },

    async getEdgesFrom(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
      let result = Array.from(edges.values()).filter((e) => e.from_id === nodeId);
      if (type) {
        result = result.filter((e) => e.type === type);
      }
      return result;
    },

    async getEdgesTo(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
      let result = Array.from(edges.values()).filter((e) => e.to_id === nodeId);
      if (type) {
        result = result.filter((e) => e.type === type);
      }
      return result;
    },

    async getAllEdges(type?: EdgeType): Promise<StoredEdge[]> {
      let result = Array.from(edges.values());
      if (type) {
        result = result.filter((e) => e.type === type);
      }
      return result;
    },

    async addTag(nodeId: string, tag: string): Promise<void> {
      if (!tags.has(nodeId)) {
        tags.set(nodeId, new Set());
      }
      tags.get(nodeId)!.add(tag);
    },

    async removeTag(nodeId: string, tag: string): Promise<void> {
      tags.get(nodeId)?.delete(tag);
    },

    async getTags(nodeId: string): Promise<string[]> {
      return Array.from(tags.get(nodeId) || []);
    },

    async getTagsForNodes(nodeIds: string[]): Promise<Map<string, string[]>> {
      const result = new Map<string, string[]>();
      for (const id of nodeIds) {
        result.set(id, Array.from(tags.get(id) || []));
      }
      return result;
    },

    async getNodesByTag(tag: string): Promise<StoredNode[]> {
      const result: StoredNode[] = [];
      for (const [nodeId, nodeTags] of tags) {
        if (nodeTags.has(tag)) {
          const node = nodes.get(nodeId);
          if (node) result.push(node);
        }
      }
      return result;
    },

    async getReady(): Promise<StoredNode[]> {
      return [];
    },

    async runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      // Simple mock - no actual transaction
      const tx: Transaction = {
        // Read operations
        getNode: this.getNode.bind(this),
        getEdge: this.getEdge.bind(this),
        getTags: this.getTags.bind(this),
        getEdgesFrom: this.getEdgesFrom.bind(this),
        // Write operations
        createNode: this.createNode.bind(this),
        updateNode: this.updateNode.bind(this),
        createEdge: this.createEdge.bind(this),
        deleteEdge: this.deleteEdge.bind(this),
        addTag: this.addTag.bind(this),
        removeTag: this.removeTag.bind(this),
      };
      return fn(tx);
    },

    async markDirty(nodeId: string): Promise<void> {
      dirty.add(nodeId);
    },

    async getDirtyNodes(): Promise<string[]> {
      return Array.from(dirty);
    },

    async clearDirty(nodeIds: string[]): Promise<void> {
      for (const id of nodeIds) {
        dirty.delete(id);
      }
    },

    async close(): Promise<void> {
      // no-op
    },
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('GraphStore', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let store: GraphStore;
  let jsonlData: { nodes: StoredNode[]; edges: StoredEdge[] };
  let jsonlSaveCalls: Array<{ nodes: StoredNode[]; edges: StoredEdge[] }>;

  const config: GraphStoreConfig = {
    basePath: '/test/.opentasks',
    flush: {
      debounceMs: 100,
      maxDelayMs: 500,
    },
  };

  beforeEach(() => {
    storage = createMockStorage();
    jsonlData = { nodes: [], edges: [] };
    jsonlSaveCalls = [];

    store = createGraphStore(
      config,
      storage,
      async () => jsonlData,
      async (nodes, edges) => {
        jsonlSaveCalls.push({ nodes, edges });
        jsonlData = { nodes, edges };
      },
    );
  });

  afterEach(async () => {
    await store.close();
  });

  describe('lifecycle', () => {
    it('should initialize from JSONL', async () => {
      // Pre-populate JSONL
      jsonlData = {
        nodes: [
          {
            id: 'c-test1',
            uuid: 'uuid-1',
            type: 'context',
            title: 'Test Context',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
            tags: ['important'],
          },
        ],
        edges: [],
      };

      await store.initialize();

      // Verify synced to storage
      const node = await storage.getNode('c-test1');
      expect(node).not.toBeNull();
      expect(node?.title).toBe('Test Context');

      // Verify tags synced
      const nodeTags = await storage.getTags('c-test1');
      expect(nodeTags).toContain('important');
    });

    it('should flush on close', async () => {
      await store.initialize();

      // Create a node
      await store.createNode({
        type: 'context',
        title: 'New Context',
      });

      // Close should trigger flush
      await store.close();

      // Verify JSONL was saved
      expect(jsonlSaveCalls.length).toBeGreaterThan(0);
    });
  });

  describe('createNode', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should create a context', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'My Context',
        content: 'Description',
        priority: 1,
      });

      expect(node.type).toBe('context');
      expect(node.title).toBe('My Context');
      expect(node.content).toBe('Description');
      expect(node.priority).toBe(1);
      expect(node.id).toMatch(/^c-[a-z0-9]+$/);
    });

    it('should create a task with status', async () => {
      const node = await store.createNode({
        type: 'task',
        title: 'My Task',
        status: 'open',
      });

      expect(node.type).toBe('task');
      if (node.type === 'task') {
        expect(node.status).toBe('open');
      }
    });

    it('should create a feedback node', async () => {
      // First create target context
      const context = await store.createNode({
        type: 'context',
        title: 'Target Context',
      });

      const feedback = await store.createNode({
        type: 'feedback',
        title: 'My Feedback',
        target_id: context.id,
        feedback_type: 'comment',
      });

      expect(feedback.type).toBe('feedback');
      if (feedback.type === 'feedback') {
        expect(feedback.target_id).toBe(context.id);
        expect(feedback.feedback_type).toBe('comment');
      }
    });

    it('should handle tags', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'Tagged Context',
        tags: ['urgent', 'feature'],
      });

      expect(node.tags).toContain('urgent');
      expect(node.tags).toContain('feature');
    });

    it('should reject invalid input', async () => {
      await expect(
        store.createNode({
          type: 'context',
          title: '', // Empty title
        }),
      ).rejects.toThrow(GraphError);
    });
  });

  describe('getNode', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should get existing node', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'Test Context',
      });

      const fetched = await store.getNode(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.title).toBe('Test Context');
    });

    it('should return null for non-existent node', async () => {
      const fetched = await store.getNode('c-nonexistent');
      expect(fetched).toBeNull();
    });
  });

  describe('updateNode', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should update node fields', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'Original Title',
      });

      const updated = await store.updateNode(created.id, {
        title: 'Updated Title',
        priority: 2,
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.priority).toBe(2);
    });

    it('should throw for non-existent node', async () => {
      await expect(store.updateNode('c-nonexistent', { title: 'New Title' })).rejects.toThrow(
        GraphError,
      );
    });
  });

  describe('deleteNode', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should soft delete by default', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'To Delete',
      });

      await store.deleteNode(created.id);

      // Node should still exist but be archived
      const node = await storage.getNode(created.id);
      expect(node).not.toBeNull();
      expect(node?.archived).toBe(true);
    });

    it('should hard delete when requested', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'To Delete Hard',
      });

      await store.deleteNode(created.id, { hard: true });

      // Node should be gone
      const node = await storage.getNode(created.id);
      expect(node).toBeNull();
    });

    it('should throw for non-existent node', async () => {
      await expect(store.deleteNode('c-nonexistent')).rejects.toThrow(GraphError);
    });
  });

  describe('restoreNode', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should restore archived node', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'To Archive',
      });

      await store.deleteNode(created.id); // Soft delete (archive)
      const restored = await store.restoreNode(created.id);

      expect(restored.archived).toBe(false);
    });

    it('should throw when restoring non-archived node', async () => {
      const created = await store.createNode({
        type: 'context',
        title: 'Not Archived',
      });

      await expect(store.restoreNode(created.id)).rejects.toThrow(GraphError);
    });
  });

  describe('createEdge', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should create edge between nodes', async () => {
      const context = await store.createNode({ type: 'context', title: 'Context' });
      const task = await store.createNode({
        type: 'task',
        title: 'Task',
        status: 'open',
      });

      const edge = await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'implements',
      });

      expect(edge.from_id).toBe(task.id);
      expect(edge.to_id).toBe(context.id);
      expect(edge.type).toBe('implements');
      expect(edge.id).toMatch(/^x-[a-z0-9]+$/);
    });

    it('should reject self-reference', async () => {
      const context = await store.createNode({ type: 'context', title: 'Context' });

      await expect(
        store.createEdge({
          from_id: context.id,
          to_id: context.id,
          type: 'references',
        }),
      ).rejects.toThrow(GraphError);
    });

    it('should detect cycles in blocks edges', async () => {
      const a = await store.createNode({ type: 'task', title: 'A', status: 'open' });
      const b = await store.createNode({ type: 'task', title: 'B', status: 'open' });
      const c = await store.createNode({ type: 'task', title: 'C', status: 'open' });

      // A blocks B
      await store.createEdge({ from_id: a.id, to_id: b.id, type: 'blocks' });
      // B blocks C
      await store.createEdge({ from_id: b.id, to_id: c.id, type: 'blocks' });

      // C blocks A would create a cycle
      await expect(
        store.createEdge({ from_id: c.id, to_id: a.id, type: 'blocks' }),
      ).rejects.toThrow('cycle');
    });
  });

  describe('tag operations', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should add tags', async () => {
      const node = await store.createNode({ type: 'context', title: 'Context' });

      await store.addTags(node.id, ['tag1', 'tag2']);

      const updated = await store.getNode(node.id);
      expect(updated?.tags).toContain('tag1');
      expect(updated?.tags).toContain('tag2');
    });

    it('should remove tags', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'Context',
        tags: ['keep', 'remove'],
      });

      await store.removeTags(node.id, ['remove']);

      const updated = await store.getNode(node.id);
      expect(updated?.tags).toContain('keep');
      expect(updated?.tags).not.toContain('remove');
    });

    it('should set tags (replace all)', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'Context',
        tags: ['old1', 'old2'],
      });

      await store.setTags(node.id, ['new1', 'new2']);

      const updated = await store.getNode(node.id);
      expect(updated?.tags).toContain('new1');
      expect(updated?.tags).toContain('new2');
      expect(updated?.tags).not.toContain('old1');
      expect(updated?.tags).not.toContain('old2');
    });
  });

  describe('query engine', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should expose query engine', () => {
      expect(store.query).toBeDefined();
      expect(typeof store.query.nodes).toBe('function');
      expect(typeof store.query.ready).toBe('function');
    });

    it('should return all edges when filter is empty', async () => {
      const context = await store.createNode({ type: 'context', title: 'Context' });
      const task1 = await store.createNode({ type: 'task', title: 'Task 1', status: 'open' });
      const task2 = await store.createNode({ type: 'task', title: 'Task 2', status: 'open' });

      await store.createEdge({ from_id: task1.id, to_id: context.id, type: 'implements' });
      await store.createEdge({ from_id: task1.id, to_id: task2.id, type: 'blocks' });

      const edges = await store.query.edges({});
      expect(edges).toHaveLength(2);
    });

    it('should filter edges by type', async () => {
      const context = await store.createNode({ type: 'context', title: 'Context' });
      const task1 = await store.createNode({ type: 'task', title: 'Task 1', status: 'open' });
      const task2 = await store.createNode({ type: 'task', title: 'Task 2', status: 'open' });

      await store.createEdge({ from_id: task1.id, to_id: context.id, type: 'implements' });
      await store.createEdge({ from_id: task1.id, to_id: task2.id, type: 'blocks' });

      const blocksEdges = await store.query.edges({ type: 'blocks' });
      expect(blocksEdges).toHaveLength(1);
      expect(blocksEdges[0].type).toBe('blocks');
    });

    it('should query created nodes', async () => {
      await store.createNode({ type: 'context', title: 'Context 1' });
      await store.createNode({ type: 'context', title: 'Context 2' });

      const contexts = await store.query.nodes({ type: 'context' });
      expect(contexts).toHaveLength(2);
    });
  });

  describe('transactions', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should execute operations in transaction', async () => {
      const result = await store.transaction(async (tx) => {
        const context = await tx.createNode({ type: 'context', title: 'Context' });
        const task = await tx.createNode({
          type: 'task',
          title: 'Task',
          status: 'open',
        });
        await tx.createEdge({
          from_id: task.id,
          to_id: context.id,
          type: 'implements',
        });
        return { context, task };
      });

      expect(result.context.type).toBe('context');
      expect(result.task.type).toBe('task');

      // Verify persisted
      const context = await store.getNode(result.context.id);
      expect(context).not.toBeNull();
    });
  });

  describe('reload', () => {
    it('should sync new nodes from JSONL', async () => {
      await store.initialize();

      // Add a node directly to jsonlData (simulating external change, e.g. git pull)
      jsonlData = {
        nodes: [
          {
            id: 'c-new1',
            uuid: 'uuid-new1',
            type: 'context',
            title: 'Externally Added Context',
            created_at: '2024-06-01T00:00:00Z',
            updated_at: '2024-06-01T00:00:00Z',
            archived: false,
          },
        ],
        edges: [],
      };

      await store.reload();

      const node = await store.getNode('c-new1');
      expect(node).not.toBeNull();
      expect(node?.title).toBe('Externally Added Context');
    });

    it('should update existing nodes', async () => {
      // Pre-populate and initialize
      jsonlData = {
        nodes: [
          {
            id: 'c-upd1',
            uuid: 'uuid-upd1',
            type: 'context',
            title: 'Original Title',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          },
        ],
        edges: [],
      };
      await store.initialize();

      // Verify initial state
      const before = await store.getNode('c-upd1');
      expect(before?.title).toBe('Original Title');

      // Modify the node in jsonlData (simulating external edit)
      jsonlData = {
        nodes: [
          {
            id: 'c-upd1',
            uuid: 'uuid-upd1',
            type: 'context',
            title: 'Updated Title',
            content: 'New content added externally',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-06-01T00:00:00Z',
            archived: false,
          },
        ],
        edges: [],
      };

      await store.reload();

      const after = await store.getNode('c-upd1');
      expect(after).not.toBeNull();
      expect(after?.title).toBe('Updated Title');
      expect(after?.content).toBe('New content added externally');
    });

    it('should remove deleted nodes', async () => {
      // Pre-populate and initialize
      jsonlData = {
        nodes: [
          {
            id: 'c-del1',
            uuid: 'uuid-del1',
            type: 'context',
            title: 'Will Be Removed',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          },
        ],
        edges: [],
      };
      await store.initialize();

      // Confirm the node exists
      const before = await store.getNode('c-del1');
      expect(before).not.toBeNull();

      // Remove the node from jsonlData (simulating external deletion)
      jsonlData = { nodes: [], edges: [] };

      await store.reload();

      const after = await store.getNode('c-del1');
      expect(after).toBeNull();
    });

    it('should sync tags', async () => {
      await store.initialize();

      // Add a node with tags in jsonlData
      jsonlData = {
        nodes: [
          {
            id: 'c-tag1',
            uuid: 'uuid-tag1',
            type: 'context',
            title: 'Tagged Context',
            created_at: '2024-06-01T00:00:00Z',
            updated_at: '2024-06-01T00:00:00Z',
            archived: false,
            tags: ['urgent', 'backend'],
          },
        ],
        edges: [],
      };

      await store.reload();

      const tags = await storage.getTags('c-tag1');
      expect(tags).toContain('urgent');
      expect(tags).toContain('backend');
    });

    it('should update nodeCount so createNode generates unique IDs', async () => {
      await store.initialize();

      // Reload with several nodes
      jsonlData = {
        nodes: [
          {
            id: 'c-a1',
            uuid: 'uuid-a1',
            type: 'context',
            title: 'Context A',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          },
          {
            id: 'c-b2',
            uuid: 'uuid-b2',
            type: 'context',
            title: 'Context B',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          },
          {
            id: 't-c3',
            uuid: 'uuid-c3',
            type: 'task',
            title: 'Task C',
            status: 'open',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          },
        ],
        edges: [],
      };

      await store.reload();

      // Create a new node — its ID should not collide with existing nodes
      const newNode = await store.createNode({
        type: 'context',
        title: 'After Reload',
      });

      expect(newNode.id).toMatch(/^c-[a-z0-9]+$/);
      // The new node should have a different ID from all existing ones
      expect(newNode.id).not.toBe('c-a1');
      expect(newNode.id).not.toBe('c-b2');
    });
  });

  describe('setNodeResolver', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should enable cross-provider blocker resolution (active external blocks)', async () => {
      // Create a local task
      const task = await store.createNode({
        type: 'task',
        title: 'My Task',
        status: 'open',
      });

      // Create a blocks edge from an external URI to the local task
      // We need to add the edge directly to storage because createEdge validates both endpoints
      const edgeId = 'x-ext1';
      await storage.createEdge({
        id: edgeId,
        uuid: 'uuid-ext-edge1',
        from_id: 'global://g-123',
        to_id: task.id,
        type: 'blocks',
        created_at: '2024-06-01T00:00:00Z',
      });

      // Set a resolver that returns an active (open) external node
      const resolver: NodeResolver = async (idOrUri: string) => {
        if (idOrUri === 'global://g-123') {
          return {
            id: 'global://g-123',
            uuid: 'uuid-g123',
            type: 'task',
            title: 'External Blocker',
            status: 'open',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          };
        }
        return null;
      };

      store.setNodeResolver(resolver);

      // The task should NOT be ready because it has an active external blocker
      const readyTasks = await store.query.ready();
      const readyIds = readyTasks.map((t) => t.id);
      expect(readyIds).not.toContain(task.id);
    });

    it('should include task in ready when external blocker is closed', async () => {
      // Create a local task
      const task = await store.createNode({
        type: 'task',
        title: 'My Task',
        status: 'open',
      });

      // Create a blocks edge from an external URI to the local task
      await storage.createEdge({
        id: 'x-ext2',
        uuid: 'uuid-ext-edge2',
        from_id: 'global://g-456',
        to_id: task.id,
        type: 'blocks',
        created_at: '2024-06-01T00:00:00Z',
      });

      // Set a resolver that returns a closed external node
      const resolver: NodeResolver = async (idOrUri: string) => {
        if (idOrUri === 'global://g-456') {
          return {
            id: 'global://g-456',
            uuid: 'uuid-g456',
            type: 'task',
            title: 'External Blocker (Done)',
            status: 'closed',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-06-01T00:00:00Z',
            archived: false,
          };
        }
        return null;
      };

      store.setNodeResolver(resolver);

      // The task SHOULD be ready because the external blocker is closed
      const readyTasks = await store.query.ready();
      const readyIds = readyTasks.map((t) => t.id);
      expect(readyIds).toContain(task.id);
    });

    it('should use the latest resolver when called multiple times', async () => {
      const task = await store.createNode({
        type: 'task',
        title: 'Resolver Test Task',
        status: 'open',
      });

      await storage.createEdge({
        id: 'x-ext3',
        uuid: 'uuid-ext-edge3',
        from_id: 'global://g-789',
        to_id: task.id,
        type: 'blocks',
        created_at: '2024-06-01T00:00:00Z',
      });

      // First resolver: blocker is active
      const firstResolver: NodeResolver = async (idOrUri: string) => {
        if (idOrUri === 'global://g-789') {
          return {
            id: 'global://g-789',
            uuid: 'uuid-g789',
            type: 'task',
            title: 'Active Blocker',
            status: 'open',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
          };
        }
        return null;
      };
      store.setNodeResolver(firstResolver);

      const readyBefore = await store.query.ready();
      expect(readyBefore.map((t) => t.id)).not.toContain(task.id);

      // Second resolver: blocker is now closed
      const secondResolver: NodeResolver = async (idOrUri: string) => {
        if (idOrUri === 'global://g-789') {
          return {
            id: 'global://g-789',
            uuid: 'uuid-g789',
            type: 'task',
            title: 'Closed Blocker',
            status: 'closed',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-06-01T00:00:00Z',
            archived: false,
          };
        }
        return null;
      };
      store.setNodeResolver(secondResolver);

      const readyAfter = await store.query.ready();
      expect(readyAfter.map((t) => t.id)).toContain(task.id);
    });

    it('should resolve external URIs via query.blockers', async () => {
      // Create a local task that is blocked by an external node
      const task = await store.createNode({
        type: 'task',
        title: 'Blocked Task',
        status: 'open',
      });

      // Create a blocks edge from an external URI
      await storage.createEdge({
        id: 'x-ext4',
        uuid: 'uuid-ext-edge4',
        from_id: 'beads://./bd-1',
        to_id: task.id,
        type: 'blocks',
        created_at: '2024-06-01T00:00:00Z',
      });

      // Set a resolver that returns the external node
      const resolver: NodeResolver = async (idOrUri: string) => {
        if (idOrUri === 'beads://./bd-1') {
          return {
            id: 'beads://./bd-1',
            uuid: 'uuid-bd1',
            type: 'task',
            title: 'External Bead Blocker',
            status: 'in_progress',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-03-01T00:00:00Z',
            archived: false,
          };
        }
        return null;
      };

      store.setNodeResolver(resolver);

      const blockers = await store.query.blockers(task.id);
      expect(blockers).toHaveLength(1);
      expect(blockers[0].title).toBe('External Bead Blocker');
    });
  });
});
