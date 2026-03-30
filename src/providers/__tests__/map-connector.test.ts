/**
 * Tests for the MAP Connector.
 *
 * Verifies that incoming opentasks/*.request notifications are
 * correctly forwarded to the OpenTasksClient and responses are sent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMAPConnector, MAP_CONNECTOR_METHODS } from '../map-connector.js';
import type { MAPConnector } from '../map-connector.js';

// Mock OpenTasksClient
function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({
      items: [{ id: 't-1', type: 'task', title: 'Test', status: 'open', archived: false }],
      total: 1,
      hasMore: false,
    }),
    link: vi.fn().mockResolvedValue({ success: true }),
    annotate: vi.fn().mockResolvedValue({ success: true }),
    task: vi.fn().mockResolvedValue({ success: true, data: { type: 'transition', node: { id: 't-1' }, provider: 'native', action: 'start' } }),
    // Stubs for other methods
    connect: vi.fn(),
    disconnect: vi.fn(),
    get connected() { return true; },
    ready: vi.fn(),
    blockers: vi.fn(),
    createNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
  } as any;
}

describe('MAPConnector', () => {
  let client: ReturnType<typeof createMockClient>;
  let send: ReturnType<typeof vi.fn>;
  let connector: MAPConnector;

  beforeEach(() => {
    client = createMockClient();
    send = vi.fn();
    connector = createMAPConnector({ client, send, agentId: 'test' });
  });

  describe('query.request', () => {
    it('forwards query to client and sends response', async () => {
      connector.handleNotification(MAP_CONNECTOR_METHODS.QUERY_REQUEST, {
        request_id: 'req-1',
        query: { nodes: { type: 'task', status: 'open' } },
      });

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 10));

      expect(client.query).toHaveBeenCalledWith({ nodes: { type: 'task', status: 'open' } });
      expect(send).toHaveBeenCalledWith(
        MAP_CONNECTOR_METHODS.QUERY_RESPONSE,
        expect.objectContaining({
          request_id: 'req-1',
          items: expect.any(Array),
          hasMore: false,
        }),
      );
    });

    it('sends error response on failure', async () => {
      client.query.mockRejectedValue(new Error('Daemon down'));

      connector.handleNotification(MAP_CONNECTOR_METHODS.QUERY_REQUEST, {
        request_id: 'req-2',
        query: { nodes: {} },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(send).toHaveBeenCalledWith(
        MAP_CONNECTOR_METHODS.QUERY_RESPONSE,
        expect.objectContaining({
          request_id: 'req-2',
          error: 'Daemon down',
        }),
      );
    });
  });

  describe('link.request', () => {
    it('forwards link to client and sends response', async () => {
      connector.handleNotification(MAP_CONNECTOR_METHODS.LINK_REQUEST, {
        request_id: 'req-3',
        link: { fromId: 't-1', toId: 't-2', type: 'blocks' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.link).toHaveBeenCalledWith({ fromId: 't-1', toId: 't-2', type: 'blocks' });
      expect(send).toHaveBeenCalledWith(
        MAP_CONNECTOR_METHODS.LINK_RESPONSE,
        expect.objectContaining({ request_id: 'req-3', success: true }),
      );
    });
  });

  describe('annotate.request', () => {
    it('forwards annotate to client and sends response', async () => {
      connector.handleNotification(MAP_CONNECTOR_METHODS.ANNOTATE_REQUEST, {
        request_id: 'req-4',
        annotate: { target_id: 't-1', create: { content: 'Looks good' } },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.annotate).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(
        MAP_CONNECTOR_METHODS.ANNOTATE_RESPONSE,
        expect.objectContaining({ request_id: 'req-4', success: true }),
      );
    });
  });

  describe('task.request', () => {
    it('forwards task operation to client and sends response', async () => {
      connector.handleNotification(MAP_CONNECTOR_METHODS.TASK_REQUEST, {
        request_id: 'req-5',
        task: { transition: { id: 't-1', action: 'start' } },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.task).toHaveBeenCalledWith({ transition: { id: 't-1', action: 'start' } });
      expect(send).toHaveBeenCalledWith(
        MAP_CONNECTOR_METHODS.TASK_RESPONSE,
        expect.objectContaining({ request_id: 'req-5', success: true }),
      );
    });
  });

  describe('lifecycle', () => {
    it('ignores requests without request_id', async () => {
      connector.handleNotification(MAP_CONNECTOR_METHODS.QUERY_REQUEST, {
        query: { nodes: {} },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('ignores requests after stop', async () => {
      connector.stop();

      connector.handleNotification(MAP_CONNECTOR_METHODS.QUERY_REQUEST, {
        request_id: 'req-6',
        query: { nodes: {} },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(client.query).not.toHaveBeenCalled();
    });

    it('reports active state', () => {
      expect(connector.active).toBe(true);
      connector.stop();
      expect(connector.active).toBe(false);
    });

    it('ignores unknown methods', async () => {
      connector.handleNotification('opentasks/unknown.request', {
        request_id: 'req-7',
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(send).not.toHaveBeenCalled();
    });
  });
});
