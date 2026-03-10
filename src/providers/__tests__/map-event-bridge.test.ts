/**
 * Tests for MAP Event Bridge
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMAPEventBridge, type MAPEventSender, type MAPConnection } from '../map-event-bridge.js';
import type { ProviderChangeEvent } from '../traits/Watchable.js';

describe('MAPEventBridge', () => {
  let send: MAPEventSender;
  let events: Array<{ type: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    events = [];
    send = vi.fn((type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
    });
  });

  // ======================================================================
  // Direct Emit Methods
  // ======================================================================

  describe('emitTaskCreated', () => {
    it('emits task.created with full task info', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCreated({
        id: 'task-1',
        title: 'Fix bug',
        status: 'open',
        description: 'Something is broken',
        assignee: 'agent-alice',
        meta: { priority: 1 },
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.created');
      expect(events[0].data.task).toEqual({
        id: 'task-1',
        title: 'Fix bug',
        status: 'open',
        description: 'Something is broken',
        assignee: 'agent-alice',
        meta: { priority: 1 },
      });
    });

    it('emits task.created with minimal task info', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCreated({ id: 'task-2' });

      expect(events).toHaveLength(1);
      expect(events[0].data.task).toEqual({ id: 'task-2' });
    });

    it('maps OpenTasks status to MAP status', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCreated({ id: 'task-3', status: 'closed' });

      expect((events[0].data.task as Record<string, unknown>).status).toBe('completed');
    });
  });

  describe('emitTaskStatus', () => {
    it('emits task.status with mapped statuses', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskStatus('task-1', 'open', 'in_progress');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.status');
      expect(events[0].data).toMatchObject({
        taskId: 'task-1',
        previous: 'open',
        current: 'in_progress',
      });
    });

    it('also emits task.completed when status is completed', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskStatus('task-1', 'in_progress', 'completed');

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task.status');
      expect(events[1].type).toBe('task.completed');
      expect(events[1].data.taskId).toBe('task-1');
    });

    it('also emits task.completed when status is closed', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskStatus('task-1', 'in_progress', 'closed');

      expect(events).toHaveLength(2);
      expect(events[1].type).toBe('task.completed');
    });

    it('maps closed to completed in the wire event', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskStatus('task-1', 'open', 'closed');

      expect(events[0].data.current).toBe('completed');
    });
  });

  describe('emitTaskAssigned', () => {
    it('emits task.assigned', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskAssigned('task-1', 'agent-bob');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.assigned');
      expect(events[0].data).toMatchObject({
        taskId: 'task-1',
        agentId: 'agent-bob',
      });
    });
  });

  describe('emitTaskCompleted', () => {
    it('emits task.completed without result', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCompleted('task-1');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.completed');
      expect(events[0].data).toEqual({ taskId: 'task-1' });
    });

    it('emits task.completed with result', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCompleted('task-1', { output: 'done' });

      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        taskId: 'task-1',
        result: { output: 'done' },
      });
    });
  });

  // ======================================================================
  // Origin Stamping
  // ======================================================================

  describe('origin stamping', () => {
    it('stamps _origin when agentId is provided', () => {
      const bridge = createMAPEventBridge({ send, agentId: 'agent-alice' });

      bridge.emitTaskCreated({ id: 'task-1' });

      expect(events[0].data._origin).toBe('agent-alice');
    });

    it('does not stamp _origin when agentId is omitted', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCreated({ id: 'task-1' });

      expect(events[0].data._origin).toBeUndefined();
    });
  });

  // ======================================================================
  // Filter
  // ======================================================================

  describe('filter', () => {
    it('suppresses events when filter returns false', () => {
      const bridge = createMAPEventBridge({
        send,
        filter: (type) => type !== 'task.assigned',
      });

      bridge.emitTaskCreated({ id: 'task-1' });
      bridge.emitTaskAssigned('task-1', 'agent-bob');
      bridge.emitTaskStatus('task-1', 'open', 'in_progress');

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task.created');
      expect(events[1].type).toBe('task.status');
    });

    it('filter receives event data', () => {
      const filterFn = vi.fn().mockReturnValue(true);
      const bridge = createMAPEventBridge({ send, filter: filterFn });

      bridge.emitTaskCreated({ id: 'task-1', title: 'Test' });

      expect(filterFn).toHaveBeenCalledWith(
        'task.created',
        expect.objectContaining({ task: expect.objectContaining({ id: 'task-1' }) }),
      );
    });
  });

  // ======================================================================
  // Lifecycle
  // ======================================================================

  describe('lifecycle', () => {
    it('starts active', () => {
      const bridge = createMAPEventBridge({ send });
      expect(bridge.active).toBe(true);
    });

    it('stops emitting after stop()', () => {
      const bridge = createMAPEventBridge({ send });

      bridge.emitTaskCreated({ id: 'task-1' });
      bridge.stop();
      bridge.emitTaskCreated({ id: 'task-2' });

      expect(events).toHaveLength(1);
      expect(bridge.active).toBe(false);
    });
  });

  // ======================================================================
  // Provider Change Handler
  // ======================================================================

  describe('handleProviderChange', () => {
    it('translates node created event to task.created', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'open',
            content: 'Details here',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.created');
      expect((events[0].data.task as Record<string, unknown>).id).toBe('task-1');
      expect((events[0].data.task as Record<string, unknown>).title).toBe('Fix bug');
    });

    it('translates status change to task.status', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'in_progress',
            fetchedAt: new Date().toISOString(),
          },
          changedFields: ['status'],
          previousValues: { status: 'open' },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.status');
      expect(events[0].data.previous).toBe('open');
      expect(events[0].data.current).toBe('in_progress');
    });

    it('translates completion to task.status + task.completed', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'completed',
            fetchedAt: new Date().toISOString(),
          },
          changedFields: ['status'],
          previousValues: { status: 'in_progress' },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task.status');
      expect(events[1].type).toBe('task.completed');
    });

    it('translates assignee change to task.assigned', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'open',
            rawData: { assignee: 'agent-bob' },
            fetchedAt: new Date().toISOString(),
          },
          changedFields: ['assignee'],
          previousValues: { assignee: null },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.assigned');
      expect(events[0].data.agentId).toBe('agent-bob');
    });

    it('translates node deleted to task.status failed', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'deleted',
          nodeId: 'task-1',
          uri: 'native://task-1',
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.status');
      expect(events[0].data.current).toBe('failed');
    });

    it('skips edge events', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'edge',
        event: {
          type: 'created',
          edge: { from: 'a', to: 'b', type: 'blocks' },
          sourceUri: 'native://a',
          targetUri: 'native://b',
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(0);
    });

    it('skips changes from the MAP provider (echo prevention)', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'task-1',
          uri: 'map://default/task-1',
          node: {
            id: 'task-1',
            uri: 'map://default/task-1',
            type: 'task',
            title: 'Remote task',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('map', event);

      expect(events).toHaveLength(0);
    });

    it('skips non-task node types', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'created',
          nodeId: 'ctx-1',
          uri: 'native://ctx-1',
          node: {
            id: 'ctx-1',
            uri: 'native://ctx-1',
            type: 'context',
            title: 'Some context',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(0);
    });

    it('handles update without changedFields (best effort)', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'in_progress',
            fetchedAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      // Best effort: emits status event from current node state
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task.status');
      expect(events[0].data.current).toBe('in_progress');
    });

    it('handles both status and assignee changes in one event', () => {
      const bridge = createMAPEventBridge({ send });

      const event: ProviderChangeEvent = {
        kind: 'node',
        event: {
          type: 'updated',
          nodeId: 'task-1',
          uri: 'native://task-1',
          node: {
            id: 'task-1',
            uri: 'native://task-1',
            type: 'task',
            title: 'Fix bug',
            status: 'in_progress',
            rawData: { assignee: 'agent-alice' },
            fetchedAt: new Date().toISOString(),
          },
          changedFields: ['status', 'assignee'],
          previousValues: { status: 'open', assignee: null },
          timestamp: new Date().toISOString(),
        },
      };

      bridge.handleProviderChange('native', event);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task.status');
      expect(events[1].type).toBe('task.assigned');
    });
  });

  // ======================================================================
  // Connection-based usage (shared MAP connection)
  // ======================================================================

  describe('connection mode', () => {
    it('sends events via connection.send() with scope', () => {
      const sentMessages: Array<{ to: unknown; payload: unknown }> = [];
      const connection: MAPConnection = {
        send: vi.fn(async (to, payload) => {
          sentMessages.push({ to, payload });
        }),
      };

      const bridge = createMAPEventBridge({
        connection,
        scope: 'swarm:team-a',
        agentId: 'agent-alice',
      });

      bridge.emitTaskCreated({ id: 'task-1', title: 'Fix bug' });

      expect(connection.send).toHaveBeenCalledTimes(1);
      expect(sentMessages[0].to).toEqual({ scope: 'swarm:team-a' });
      expect(sentMessages[0].payload).toMatchObject({
        type: 'task.created',
        _origin: 'agent-alice',
      });
    });

    it('sends events without scope when scope is empty', () => {
      const sentMessages: Array<{ to: unknown; payload: unknown }> = [];
      const connection: MAPConnection = {
        send: vi.fn(async (to, payload) => {
          sentMessages.push({ to, payload });
        }),
      };

      const bridge = createMAPEventBridge({ connection });

      bridge.emitTaskCreated({ id: 'task-1' });

      expect(sentMessages[0].to).toEqual({});
    });

    it('works with all emit methods', () => {
      const connection: MAPConnection = {
        send: vi.fn(async () => {}),
      };

      const bridge = createMAPEventBridge({
        connection,
        scope: 'swarm:test',
      });

      bridge.emitTaskCreated({ id: 'task-1' });
      bridge.emitTaskStatus('task-1', 'open', 'in_progress');
      bridge.emitTaskAssigned('task-1', 'agent-bob');
      bridge.emitTaskCompleted('task-1');

      // task.status doesn't trigger extra task.completed (in_progress is not terminal)
      expect(connection.send).toHaveBeenCalledTimes(4);
    });

    it('applies filter in connection mode', () => {
      const connection: MAPConnection = {
        send: vi.fn(async () => {}),
      };

      const bridge = createMAPEventBridge({
        connection,
        scope: 'swarm:test',
        filter: (type) => type !== 'task.assigned',
      });

      bridge.emitTaskCreated({ id: 'task-1' });
      bridge.emitTaskAssigned('task-1', 'agent-bob');

      expect(connection.send).toHaveBeenCalledTimes(1);
    });

    it('silently handles connection.send() failures', () => {
      const connection: MAPConnection = {
        send: vi.fn(async () => {
          throw new Error('connection lost');
        }),
      };

      const bridge = createMAPEventBridge({ connection, scope: 'test' });

      // Should not throw
      expect(() => bridge.emitTaskCreated({ id: 'task-1' })).not.toThrow();
    });

    it('throws if neither send nor connection provided', () => {
      expect(() => createMAPEventBridge({} as any)).toThrow(
        'requires either `send` or `connection`',
      );
    });

    it('prefers send over connection when both provided', () => {
      const directSend = vi.fn();
      const connection: MAPConnection = {
        send: vi.fn(async () => {}),
      };

      const bridge = createMAPEventBridge({
        send: directSend,
        connection,
        scope: 'test',
      });

      bridge.emitTaskCreated({ id: 'task-1' });

      expect(directSend).toHaveBeenCalledTimes(1);
      expect(connection.send).not.toHaveBeenCalled();
    });
  });
});
