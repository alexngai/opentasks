/**
 * Tests for Graph Edge Cases
 *
 * Tests circular dependencies, self-referential edges, deep hierarchies,
 * and other edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGraphStore, type GraphStore } from '../store.js';
import { createSQLitePersister } from '../../storage/sqlite.js';
import type { Storage } from '../../storage/interface.js';
import type { StoredNode, StoredEdge } from '../../schema/storage.js';

// ============================================================================
// Test Setup
// ============================================================================

describe('Graph Edge Cases', () => {
  let tempDir: string;
  let storage: Storage;
  let store: GraphStore;

  // JSONL mock that keeps data in memory
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-edge-test-'));

    // createSQLitePersister takes basePath and creates cache.db inside it
    // It also calls initialize() internally
    storage = createSQLitePersister(tempDir);

    jsonlNodes = [];
    jsonlEdges = [];

    store = createGraphStore({ basePath: tempDir }, storage, jsonlLoad, jsonlSave);

    await store.initialize();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // ==========================================================================
  // Circular Dependencies
  // ==========================================================================

  describe('Circular Dependencies', () => {
    it('should detect direct cycle (A blocks B, B blocks A)', async () => {
      const taskA = await store.createNode({
        type: 'task',
        title: 'Task A',
        status: 'open',
      });

      const taskB = await store.createNode({
        type: 'task',
        title: 'Task B',
        status: 'open',
      });

      // A blocks B
      await store.createEdge({
        from_id: taskA.id,
        to_id: taskB.id,
        type: 'blocks',
      });

      // B blocks A should fail
      await expect(
        store.createEdge({
          from_id: taskB.id,
          to_id: taskA.id,
          type: 'blocks',
        }),
      ).rejects.toThrow(/cycle/i);
    });

    it('should detect transitive cycle (A→B→C→A)', async () => {
      const taskA = await store.createNode({
        type: 'task',
        title: 'Task A',
        status: 'open',
      });

      const taskB = await store.createNode({
        type: 'task',
        title: 'Task B',
        status: 'open',
      });

      const taskC = await store.createNode({
        type: 'task',
        title: 'Task C',
        status: 'open',
      });

      // A → B → C
      await store.createEdge({
        from_id: taskA.id,
        to_id: taskB.id,
        type: 'blocks',
      });

      await store.createEdge({
        from_id: taskB.id,
        to_id: taskC.id,
        type: 'blocks',
      });

      // C → A should fail
      await expect(
        store.createEdge({
          from_id: taskC.id,
          to_id: taskA.id,
          type: 'blocks',
        }),
      ).rejects.toThrow(/cycle/i);
    });

    it('should allow non-blocking cycles (implements is not checked for cycles)', async () => {
      const context = await store.createNode({
        type: 'context',
        title: 'Context',
      });

      const task = await store.createNode({
        type: 'task',
        title: 'Task',
        status: 'open',
      });

      // Task implements Context
      await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'implements',
      });

      // Context references Task (different edge type, should be allowed)
      const edge = await store.createEdge({
        from_id: context.id,
        to_id: task.id,
        type: 'references',
      });

      expect(edge).toBeDefined();
      expect(edge.id).toBeDefined();
    });
  });

  // ==========================================================================
  // Self-Referential Edges
  // ==========================================================================

  describe('Self-Referential Edges', () => {
    it('should reject self-referential blocks edge', async () => {
      const task = await store.createNode({
        type: 'task',
        title: 'Self-blocking Task',
        status: 'open',
      });

      // Task blocks itself should fail
      await expect(
        store.createEdge({
          from_id: task.id,
          to_id: task.id,
          type: 'blocks',
        }),
      ).rejects.toThrow(); // Either cycle detection or validation should catch this
    });

    it('should reject self-referential implements edge', async () => {
      const context = await store.createNode({
        type: 'context',
        title: 'Self-implementing Context',
      });

      // Context implements itself should fail validation
      await expect(
        store.createEdge({
          from_id: context.id,
          to_id: context.id,
          type: 'implements',
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Deep Hierarchies
  // ==========================================================================

  describe('Deep Hierarchies', () => {
    it('should handle 10-level blocking chain', async () => {
      const tasks: Awaited<ReturnType<typeof store.createNode>>[] = [];

      // Create 10 tasks
      for (let i = 0; i < 10; i++) {
        const task = await store.createNode({
          type: 'task',
          title: `Task ${i}`,
          status: 'open',
        });
        tasks.push(task);
      }

      // Create chain: 0→1→2→...→9
      for (let i = 0; i < 9; i++) {
        await store.createEdge({
          from_id: tasks[i].id,
          to_id: tasks[i + 1].id,
          type: 'blocks',
        });
      }

      // Query blockers for task 9 (should include all predecessors transitively)
      const blockers = await store.query.blockers(tasks[9].id, {
        transitive: true,
      });

      expect(blockers.length).toBe(9); // 0-8 all block 9 transitively
    });

    it('should handle 50-level parent hierarchy', async () => {
      let parentId: string | undefined;

      // Create deep parent chain
      for (let i = 0; i < 50; i++) {
        const node = await store.createNode({
          type: 'context',
          title: `Level ${i}`,
          parent_id: parentId,
        });
        parentId = node.id;
      }

      // Should be able to retrieve the deepest node
      const deepest = await store.getNode(parentId!);
      expect(deepest).not.toBeNull();
      expect(deepest?.title).toBe('Level 49');
    });

    it('should query children of a parent', async () => {
      const parent = await store.createNode({
        type: 'context',
        title: 'Parent',
      });

      // Create 5 children
      for (let i = 0; i < 5; i++) {
        await store.createNode({
          type: 'context',
          title: `Child ${i}`,
          parent_id: parent.id,
        });
      }

      // Query children
      const children = await store.query.nodes({ parent_id: parent.id });

      expect(children.length).toBe(5);
    });
  });

  // ==========================================================================
  // Dangling References
  // ==========================================================================

  describe('Dangling References', () => {
    it('should allow edge to external URI (non-local ID)', async () => {
      // The system allows edges to non-local IDs (treated as external URIs)
      // This is by design - edges can reference external resources
      const task = await store.createNode({
        type: 'task',
        title: 'Real Task',
        status: 'open',
      });

      // "nonexistent-id" doesn't match local ID pattern (x-xxx) so it's treated as external
      const edge = await store.createEdge({
        from_id: task.id,
        to_id: 'github://org/repo/issues/123',
        type: 'references',
      });

      expect(edge).toBeDefined();
      expect(edge.to_id).toBe('github://org/repo/issues/123');
    });

    it('should reject edge to non-existent LOCAL node', async () => {
      // Local node references (matching pattern like t-xxx) are validated
      const task = await store.createNode({
        type: 'task',
        title: 'Real Task',
        status: 'open',
      });

      // t-xxxx format is a local ID - should be validated
      await expect(
        store.createEdge({
          from_id: task.id,
          to_id: 't-nonexistent',
          type: 'blocks',
        }),
      ).rejects.toThrow();
    });

    it('should reject edge from non-existent LOCAL node', async () => {
      const task = await store.createNode({
        type: 'task',
        title: 'Real Task',
        status: 'open',
      });

      await expect(
        store.createEdge({
          from_id: 't-nonexistent',
          to_id: task.id,
          type: 'blocks',
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Multiple Edges Between Same Nodes
  // ==========================================================================

  describe('Multiple Edges Between Same Nodes', () => {
    it('should allow different edge types between same nodes', async () => {
      const context = await store.createNode({
        type: 'context',
        title: 'Context',
      });

      const task = await store.createNode({
        type: 'task',
        title: 'Task',
        status: 'open',
      });

      // Task implements Context
      const edge1 = await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'implements',
      });

      // Task also references Context
      const edge2 = await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'references',
      });

      expect(edge1.id).not.toBe(edge2.id);
      expect(edge1.type).toBe('implements');
      expect(edge2.type).toBe('references');
    });

    it('should handle querying multiple edge types', async () => {
      const context = await store.createNode({
        type: 'context',
        title: 'Context',
      });

      const task = await store.createNode({
        type: 'task',
        title: 'Task',
        status: 'open',
      });

      await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'implements',
      });

      await store.createEdge({
        from_id: task.id,
        to_id: context.id,
        type: 'references',
      });

      // Query all edges from task
      const allEdges = await store.query.edges({ from_id: task.id });
      expect(allEdges.length).toBe(2);

      // Query only implements edges
      const implementsEdges = await store.query.edges({
        from_id: task.id,
        type: 'implements',
      });
      expect(implementsEdges.length).toBe(1);
    });
  });

  // ==========================================================================
  // Concurrent Operations
  // ==========================================================================

  describe('Concurrent Operations', () => {
    it('should handle concurrent node creation', async () => {
      // Create 10 nodes concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.createNode({
          type: 'task',
          title: `Concurrent Task ${i}`,
          status: 'open',
        }),
      );

      const nodes = await Promise.all(promises);

      // All nodes should have unique IDs
      const ids = nodes.map((n) => n.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    it('should handle concurrent edge creation', async () => {
      // Create nodes first
      const nodes = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.createNode({
            type: 'task',
            title: `Task ${i}`,
            status: 'open',
          }),
        ),
      );

      // Create edges concurrently (0→1, 0→2, 0→3, 0→4)
      const edgePromises = nodes.slice(1).map((target) =>
        store.createEdge({
          from_id: nodes[0].id,
          to_id: target.id,
          type: 'references',
        }),
      );

      const edges = await Promise.all(edgePromises);

      // All edges should be created
      expect(edges.length).toBe(4);
      expect(new Set(edges.map((e) => e.id)).size).toBe(4);
    });
  });

  // ==========================================================================
  // Empty and Boundary Values
  // ==========================================================================

  describe('Empty and Boundary Values', () => {
    it('should handle empty title', async () => {
      // Empty title should be rejected by validation
      await expect(
        store.createNode({
          type: 'task',
          title: '',
          status: 'open',
        }),
      ).rejects.toThrow();
    });

    it('should handle title at max length (500 chars)', async () => {
      // System has a 500 character limit for titles
      const longTitle = 'A'.repeat(500);

      const node = await store.createNode({
        type: 'task',
        title: longTitle,
        status: 'open',
      });

      expect(node.title).toBe(longTitle);
    });

    it('should reject title exceeding max length', async () => {
      const tooLongTitle = 'A'.repeat(501);

      await expect(
        store.createNode({
          type: 'task',
          title: tooLongTitle,
          status: 'open',
        }),
      ).rejects.toThrow(/exceeds maximum length/i);
    });

    it('should handle special characters in title', async () => {
      const specialTitle = '测试 "quotes" <tags> & symbols 🎉';

      const node = await store.createNode({
        type: 'context',
        title: specialTitle,
      });

      expect(node.title).toBe(specialTitle);
    });

    it('should handle null content', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'No Content',
      });

      expect(node.content).toBeUndefined();
    });

    it('should handle empty content', async () => {
      const node = await store.createNode({
        type: 'context',
        title: 'Empty Content',
        content: '',
      });

      expect(node.content).toBe('');
    });
  });

  // ==========================================================================
  // Priority Edge Cases
  // ==========================================================================

  describe('Priority Edge Cases', () => {
    it('should handle priority 0 (highest)', async () => {
      const node = await store.createNode({
        type: 'task',
        title: 'Critical',
        status: 'open',
        priority: 0,
      });

      expect(node.priority).toBe(0);
    });

    it('should handle priority 4 (lowest)', async () => {
      const node = await store.createNode({
        type: 'task',
        title: 'Low Priority',
        status: 'open',
        priority: 4,
      });

      expect(node.priority).toBe(4);
    });

    it('should reject priority out of range', async () => {
      await expect(
        store.createNode({
          type: 'task',
          title: 'Invalid Priority',
          status: 'open',
          priority: 5,
        }),
      ).rejects.toThrow();

      await expect(
        store.createNode({
          type: 'task',
          title: 'Invalid Priority',
          status: 'open',
          priority: -1,
        }),
      ).rejects.toThrow();
    });
  });
});
