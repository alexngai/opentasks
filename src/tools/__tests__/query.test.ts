/**
 * Tests for Query Tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { query } from '../query.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node, Edge, Feedback, Task } from '../../schema/index.js';

describe('query tool', () => {
  let mockStore: GraphStore;

  // Sample data
  const sampleContext: Node = {
    id: 'c-test1',
    uuid: 'uuid-1',
    type: 'context',
    title: 'Test Context',
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleTask: Task = {
    id: 't-test1',
    uuid: 'uuid-2',
    type: 'task',
    title: 'Test Task',
    status: 'open',
    priority: 2,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleFeedback: Feedback = {
    id: 'f-test1',
    uuid: 'uuid-3',
    type: 'feedback',
    title: 'Test Feedback',
    target_id: 'c-test1',
    feedback_type: 'comment',
    resolved: false,
    dismissed: false,
    content: 'This is a test feedback comment that might be quite long in practice',
    priority: 0,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleEdge: Edge = {
    id: 'x-test1',
    uuid: 'uuid-4',
    from_id: 't-test1',
    to_id: 'c-test1',
    type: 'implements',
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    mockStore = {
      query: {
        nodes: vi.fn().mockResolvedValue([sampleContext, sampleTask]),
        edges: vi.fn().mockResolvedValue([sampleEdge]),
        ready: vi.fn().mockResolvedValue([sampleTask]),
        blockers: vi.fn().mockResolvedValue([sampleContext]),
        blocking: vi.fn().mockResolvedValue([sampleTask]),
        feedback: vi.fn().mockResolvedValue([sampleFeedback]),
        unresolvedFeedback: vi.fn().mockResolvedValue([sampleFeedback]),
      },
    } as unknown as GraphStore;
  });

  describe('query type validation', () => {
    it('should error when no query type specified', async () => {
      await expect(query(mockStore, {})).rejects.toThrow('No query type specified');
    });

    it('should error when multiple query types specified', async () => {
      await expect(
        query(mockStore, {
          nodes: {},
          edges: {},
        }),
      ).rejects.toThrow('Multiple query types specified');
    });

    it('should accept single query type', async () => {
      const result = await query(mockStore, { nodes: {} });
      expect(result.items).toBeDefined();
    });
  });

  describe('nodes query', () => {
    it('should query nodes with filter', async () => {
      const result = await query(mockStore, {
        nodes: { type: 'context' },
      });

      expect(mockStore.query.nodes).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'context' }),
      );
      expect(result.items).toHaveLength(2);
    });

    it('should return reduced output by default', async () => {
      const result = await query(mockStore, { nodes: {} });

      const item = result.items[0] as any;
      expect(item.id).toBe('c-test1');
      expect(item.type).toBe('context');
      expect(item.title).toBe('Test Context');
      // Should NOT have full node properties
      expect(item.uuid).toBeUndefined();
      expect(item.created_at).toBeUndefined();
    });

    it('should return full objects when verbose=true', async () => {
      const result = await query(mockStore, { nodes: {}, verbose: true });

      const item = result.items[0] as any;
      expect(item.id).toBe('c-test1');
      expect(item.uuid).toBe('uuid-1');
      expect(item.created_at).toBeDefined();
    });
  });

  describe('edges query', () => {
    it('should query edges with filter', async () => {
      const result = await query(mockStore, {
        edges: { from_id: 't-test1' },
      });

      expect(mockStore.query.edges).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('should return reduced edge output by default', async () => {
      const result = await query(mockStore, { edges: {} });

      const item = result.items[0] as any;
      expect(item.id).toBe('x-test1');
      expect(item.fromId).toBe('t-test1');
      expect(item.toId).toBe('c-test1');
      expect(item.type).toBe('implements');
      // Should NOT have full edge properties
      expect(item.uuid).toBeUndefined();
      expect(item.created_at).toBeUndefined();
    });
  });

  describe('ready query', () => {
    it('should return ready tasks', async () => {
      const result = await query(mockStore, { ready: {} });

      expect(mockStore.query.ready).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('should pass ready options', async () => {
      await query(mockStore, {
        ready: { priority: 1, assignee: 'user1' },
      });

      expect(mockStore.query.ready).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 1,
          assignee: 'user1',
        }),
      );
    });
  });

  describe('blockers query', () => {
    it('should return blockers for node', async () => {
      const result = await query(mockStore, {
        blockers: { nodeId: 't-test1' },
      });

      expect(mockStore.query.blockers).toHaveBeenCalledWith('t-test1', expect.any(Object));
      expect(result.items).toHaveLength(1);
    });

    it('should pass blocker options', async () => {
      await query(mockStore, {
        blockers: { nodeId: 't-test1', transitive: true, activeOnly: false },
      });

      expect(mockStore.query.blockers).toHaveBeenCalledWith('t-test1', {
        transitive: true,
        activeOnly: false,
      });
    });
  });

  describe('blocking query', () => {
    it('should return nodes blocked by node', async () => {
      const result = await query(mockStore, {
        blocking: { nodeId: 'c-test1' },
      });

      expect(mockStore.query.blocking).toHaveBeenCalledWith('c-test1', expect.any(Object));
      expect(result.items).toHaveLength(1);
    });
  });

  describe('feedback query', () => {
    it('should return feedback for node', async () => {
      const result = await query(mockStore, {
        feedback: { nodeId: 'c-test1' },
      });

      expect(mockStore.query.feedback).toHaveBeenCalledWith('c-test1', expect.any(Object));
      expect(result.items).toHaveLength(1);
    });

    it('should pass feedback options', async () => {
      await query(mockStore, {
        feedback: {
          nodeId: 'c-test1',
          type: 'suggestion',
          resolved: true,
          includeDismissed: true,
        },
      });

      expect(mockStore.query.feedback).toHaveBeenCalledWith('c-test1', {
        type: 'suggestion',
        resolved: true,
        includeDismissed: true,
      });
    });

    it('should return reduced feedback output by default', async () => {
      const result = await query(mockStore, {
        feedback: { nodeId: 'c-test1' },
      });

      const item = result.items[0] as any;
      expect(item.id).toBe('f-test1');
      expect(item.targetId).toBe('c-test1');
      expect(item.feedbackType).toBe('comment');
      expect(item.resolved).toBe(false);
      expect(item.dismissed).toBe(false);
      expect(item.contentPreview).toBeDefined();
      // Should NOT have full feedback properties
      expect(item.uuid).toBeUndefined();
    });
  });

  describe('unresolvedFeedback query', () => {
    it('should return all unresolved feedback', async () => {
      const result = await query(mockStore, {
        unresolvedFeedback: {},
      });

      expect(mockStore.query.unresolvedFeedback).toHaveBeenCalledWith(undefined);
      expect(result.items).toHaveLength(1);
    });

    it('should filter by targetId when provided', async () => {
      await query(mockStore, {
        unresolvedFeedback: { targetId: 'c-test1' },
      });

      expect(mockStore.query.unresolvedFeedback).toHaveBeenCalledWith('c-test1');
    });

    it('should return reduced feedback output', async () => {
      const result = await query(mockStore, {
        unresolvedFeedback: {},
      });

      const item = result.items[0] as any;
      expect(item.id).toBe('f-test1');
      expect(item.targetId).toBe('c-test1');
      expect(item.feedbackType).toBe('comment');
      expect(item.resolved).toBe(false);
      // Should NOT have full feedback properties
      expect(item.uuid).toBeUndefined();
    });
  });

  describe('pagination', () => {
    beforeEach(() => {
      // Return many items for pagination tests
      const manyNodes = Array.from({ length: 100 }, (_, i) => ({
        ...sampleContext,
        id: `c-test${i}`,
        title: `Test Context ${i}`,
      }));
      mockStore.query.nodes = vi.fn().mockResolvedValue(manyNodes);
    });

    it('should respect limit', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      });

      expect(result.items).toHaveLength(10);
    });

    it('should respect offset', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
        offset: 5,
      });

      expect(result.items).toHaveLength(10);
      expect((result.items[0] as any).id).toBe('c-test5');
    });

    it('should calculate hasMore correctly when more items exist', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      });

      expect(result.hasMore).toBe(true);
    });

    it('should calculate hasMore correctly when no more items', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 100,
      });

      expect(result.hasMore).toBe(false);
    });

    it('should include total count', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      });

      expect(result.total).toBe(100);
    });

    it('should use default limit of 50', async () => {
      const result = await query(mockStore, { nodes: {} });

      expect(result.items).toHaveLength(50);
    });
  });

  describe('contextSummary query', () => {
    const closedTask: Task = {
      id: 't-closed1',
      uuid: 'uuid-closed1',
      type: 'task',
      title: 'Completed Task',
      status: 'closed',
      priority: 1,
      archived: false,
      tags: ['api'],
      branch: 'main',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-10T00:00:00Z',
    };

    const activeTask: Task = {
      id: 't-active1',
      uuid: 'uuid-active1',
      type: 'task',
      title: 'Active Task',
      status: 'in_progress',
      priority: 2,
      archived: false,
      tags: ['api'],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-09T00:00:00Z',
    };

    const blockedTask: Task = {
      id: 't-blocked1',
      uuid: 'uuid-blocked1',
      type: 'task',
      title: 'Blocked Task',
      status: 'blocked',
      priority: 0,
      archived: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-08T00:00:00Z',
    };

    const activeContext: Node = {
      id: 'c-active1',
      uuid: 'uuid-ctx1',
      type: 'context',
      title: 'API Design Spec',
      status: 'active',
      priority: 1,
      archived: false,
      tags: ['api'],
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-05T00:00:00Z',
    };

    beforeEach(() => {
      // Set up mock to return different results based on filter
      mockStore.query.nodes = vi.fn().mockImplementation((filter: any) => {
        const status = filter.status;
        const has = (s: string) =>
          status === s || (Array.isArray(status) && status.includes(s));
        // Terminal/"recently concluded" query is now status:['closed','failed','abandoned'].
        if (filter.type === 'task' && has('closed')) {
          return Promise.resolve([closedTask]);
        }
        if (filter.type === 'task' && has('in_progress')) {
          return Promise.resolve([activeTask]);
        }
        if (filter.type === 'task' && filter.status === 'blocked') {
          return Promise.resolve([blockedTask]);
        }
        if (filter.type === 'context') {
          return Promise.resolve([activeContext]);
        }
        return Promise.resolve([]);
      });
      mockStore.query.unresolvedFeedback = vi.fn().mockResolvedValue([sampleFeedback]);
    });

    it('should return structured context summary', async () => {
      const result = await query(mockStore, { contextSummary: {} });

      expect(result.contextSummary).toBeDefined();
      expect(result.contextSummary!.recentlyCompleted).toHaveLength(1);
      expect(result.contextSummary!.recentlyCompleted[0].id).toBe('t-closed1');
      expect(result.contextSummary!.recentlyCompleted[0].relevance).toBe('recent-closed');
      expect(result.contextSummary!.activeTasks).toHaveLength(1);
      expect(result.contextSummary!.activeTasks[0].id).toBe('t-active1');
      expect(result.contextSummary!.blockedTasks).toHaveLength(1);
      expect(result.contextSummary!.blockedTasks[0].id).toBe('t-blocked1');
      expect(result.contextSummary!.relatedContexts).toHaveLength(1);
      expect(result.contextSummary!.relatedContexts[0].id).toBe('c-active1');
      expect(result.contextSummary!.unresolvedFeedback).toHaveLength(1);
    });

    it('should return items as empty array', async () => {
      const result = await query(mockStore, { contextSummary: {} });
      expect(result.items).toEqual([]);
    });

    it('groups failed/abandoned tasks as recently-concluded, not active (P2.5)', async () => {
      const failedTask: Task = {
        id: 't-failed1', uuid: 'uuid-failed1', type: 'task', title: 'Failed Task',
        status: 'failed', priority: 1, archived: false,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-11T00:00:00Z',
      };
      const abandonedTask: Task = {
        id: 't-aband1', uuid: 'uuid-aband1', type: 'task', title: 'Abandoned Task',
        status: 'abandoned', priority: 1, archived: false,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-12T00:00:00Z',
      };
      mockStore.query.nodes = vi.fn().mockImplementation((filter: any) => {
        const status = filter.status;
        const has = (s: string) =>
          status === s || (Array.isArray(status) && status.includes(s));
        // Terminal query (status:['closed','failed','abandoned']) returns all three.
        if (filter.type === 'task' && has('closed')) {
          return Promise.resolve([closedTask, failedTask, abandonedTask]);
        }
        if (filter.type === 'task' && has('in_progress')) return Promise.resolve([activeTask]);
        if (filter.type === 'task' && filter.status === 'blocked') return Promise.resolve([blockedTask]);
        if (filter.type === 'context') return Promise.resolve([activeContext]);
        return Promise.resolve([]);
      });

      const result = await query(mockStore, { contextSummary: {} });
      const completedIds = result.contextSummary!.recentlyCompleted.map((b) => b.id);
      expect(completedIds).toContain('t-failed1');
      expect(completedIds).toContain('t-aband1');
      const activeIds = result.contextSummary!.activeTasks.map((b) => b.id);
      expect(activeIds).not.toContain('t-failed1');
      expect(activeIds).not.toContain('t-aband1');
    });

    it('should filter by tags', async () => {
      const result = await query(mockStore, {
        contextSummary: { tags: ['api'] },
      });

      // closedTask has tag 'api', so it should be included
      expect(result.contextSummary!.recentlyCompleted).toHaveLength(1);
      // activeTask has tag 'api'
      expect(result.contextSummary!.activeTasks).toHaveLength(1);
      // blockedTask has no tags, should be filtered out
      expect(result.contextSummary!.blockedTasks).toHaveLength(0);
    });

    it('should filter by branch', async () => {
      const result = await query(mockStore, {
        contextSummary: { branch: 'main' },
      });

      // Only closedTask has branch 'main'
      expect(result.contextSummary!.recentlyCompleted).toHaveLength(1);
      // activeTask has no branch, should be filtered out
      expect(result.contextSummary!.activeTasks).toHaveLength(0);
    });

    it('should respect limit per section', async () => {
      const manyClosedTasks = Array.from({ length: 20 }, (_, i) => ({
        ...closedTask,
        id: `t-closed${i}`,
        title: `Completed Task ${i}`,
      }));
      mockStore.query.nodes = vi.fn().mockImplementation((filter: any) => {
        const status = filter.status;
        const has = (s: string) =>
          status === s || (Array.isArray(status) && status.includes(s));
        if (filter.type === 'task' && has('closed')) {
          return Promise.resolve(manyClosedTasks);
        }
        return Promise.resolve([]);
      });
      mockStore.query.unresolvedFeedback = vi.fn().mockResolvedValue([]);

      const result = await query(mockStore, {
        contextSummary: { limit: 5 },
      });

      expect(result.contextSummary!.recentlyCompleted).toHaveLength(5);
    });

    it('should include breadcrumb fields', async () => {
      const result = await query(mockStore, { contextSummary: {} });

      const breadcrumb = result.contextSummary!.recentlyCompleted[0];
      expect(breadcrumb.id).toBe('t-closed1');
      expect(breadcrumb.type).toBe('task');
      expect(breadcrumb.title).toBe('Completed Task');
      expect(breadcrumb.status).toBe('closed');
      expect(breadcrumb.priority).toBe(1);
      expect(breadcrumb.relevance).toBe('recent-closed');
      expect(breadcrumb.tags).toEqual(['api']);
      expect(breadcrumb.branch).toBe('main');
      expect(breadcrumb.updatedAt).toBe('2024-01-10T00:00:00Z');
    });

    it('should include total breadcrumb count', async () => {
      const result = await query(mockStore, { contextSummary: {} });

      expect(result.total).toBe(5); // 1 closed + 1 active + 1 blocked + 1 context + 1 feedback
    });

    describe('with taskId', () => {
      beforeEach(() => {
        // Add context and tasks query mocks for task-centric queries
        (mockStore.query as any).context = vi.fn().mockResolvedValue([activeContext]);
        (mockStore.query as any).tasks = vi.fn().mockResolvedValue([closedTask, activeTask]);
        mockStore.query.blockers = vi.fn().mockResolvedValue([blockedTask]);
        mockStore.query.unresolvedFeedback = vi.fn().mockResolvedValue([sampleFeedback]);

        // Broader queries still return results
        mockStore.query.nodes = vi.fn().mockResolvedValue([]);
      });

      it('should gather task-centric context', async () => {
        const result = await query(mockStore, {
          contextSummary: { taskId: 't-target1' },
        });

        const summary = result.contextSummary!;

        // Context nodes the task implements
        expect(summary.relatedContexts).toHaveLength(1);
        expect(summary.relatedContexts[0].id).toBe('c-active1');
        expect(summary.relatedContexts[0].relevance).toBe('implements');

        // Blockers
        expect(summary.blockedTasks.some((b) => b.id === 't-blocked1')).toBe(true);

        // Sibling tasks (via shared context)
        expect(summary.recentlyCompleted.some((b) => b.id === 't-closed1')).toBe(true);
        expect(summary.activeTasks.some((b) => b.id === 't-active1')).toBe(true);

        // Unresolved feedback on target
        expect(summary.unresolvedFeedback).toHaveLength(1);
      });

      it('should call context query with taskId', async () => {
        await query(mockStore, {
          contextSummary: { taskId: 't-target1' },
        });

        expect((mockStore.query as any).context).toHaveBeenCalledWith('t-target1');
      });

      it('should call blockers query with taskId', async () => {
        await query(mockStore, {
          contextSummary: { taskId: 't-target1' },
        });

        expect(mockStore.query.blockers).toHaveBeenCalledWith('t-target1', { activeOnly: true });
      });
    });
  });
});
