/**
 * Step 4 of the attempt/verify schema: the `attempts` MCP scope
 * (record_attempt + list_attempts). See docs/ATTEMPT-VERIFY-SCHEMA.md §10.
 *
 * Drives the real MCP server over an in-memory transport with a mocked
 * OpenTasksClient, so we assert the handler logic (create vs update,
 * terminal→closed, metadata merge, fromId→discovered-from, list filters).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMCPServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const mockClient = {
  link: vi.fn(),
  query: vi.fn(),
  createNode: vi.fn(),
  getNode: vi.fn(),
  updateNode: vi.fn(),
};

vi.mock('../../client/client.js', () => ({
  OpenTasksClient: function () {
    return mockClient;
  },
}));

async function testClient() {
  const server = createMCPServer({ scopes: ['attempts'] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return { parsed: text ? JSON.parse(text) : null, isError: result.isError };
}

describe('attempts scope MCP tools (step 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.createNode.mockResolvedValue({ id: 'a-new', type: 'attempt' });
    mockClient.updateNode.mockResolvedValue({ id: 'a-1', type: 'attempt' });
    mockClient.link.mockResolvedValue({ success: true });
    mockClient.query.mockResolvedValue({ items: [] });
  });

  it('registers record_attempt and list_attempts', async () => {
    const names = (await (await testClient()).listTools()).tools.map((t) => t.name);
    expect(names).toContain('record_attempt');
    expect(names).toContain('list_attempts');
  });

  describe('record_attempt — create', () => {
    it('creates an in_progress attempt with a default pending outcome', async () => {
      await call(await testClient(), 'record_attempt', { taskId: 't-1', agent: 'A' });
      expect(mockClient.createNode).toHaveBeenCalledTimes(1);
      expect(mockClient.createNode.mock.calls[0][0]).toMatchObject({
        type: 'attempt',
        target_id: 't-1',
        assignee: 'A',
        status: 'in_progress',
        metadata: { attempt: { outcome: 'pending' } },
      });
    });

    it('closes the attempt + stores evidence on a terminal outcome', async () => {
      await call(await testClient(), 'record_attempt', {
        taskId: 't-1',
        agent: 'A',
        outcome: 'success',
        evidence: { kind: 'test', ref: 'suiteX', detail: '12/12' },
      });
      const arg = mockClient.createNode.mock.calls[0][0];
      expect(arg.status).toBe('closed');
      expect(arg.metadata.attempt).toMatchObject({
        outcome: 'success',
        evidence: { kind: 'test', ref: 'suiteX' },
      });
    });

    it('links discovered-from when fromId is given', async () => {
      await call(await testClient(), 'record_attempt', { taskId: 't-1', agent: 'A', fromId: 'a-prev' });
      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 'a-new',
        toId: 'a-prev',
        type: 'discovered-from',
      });
    });
  });

  describe('record_attempt — update', () => {
    it('merges into the existing metadata.attempt and closes on a terminal outcome', async () => {
      mockClient.getNode.mockResolvedValue({
        id: 'a-1',
        metadata: { attempt: { outcome: 'pending', summary: 'wip' } },
      });
      await call(await testClient(), 'record_attempt', {
        taskId: 't-1',
        agent: 'A',
        id: 'a-1',
        outcome: 'failure',
        failureReason: 'compile error',
      });
      expect(mockClient.getNode).toHaveBeenCalledWith('a-1');
      const [id, updates] = mockClient.updateNode.mock.calls[0];
      expect(id).toBe('a-1');
      expect(updates.status).toBe('closed');
      expect(updates.metadata.attempt).toMatchObject({
        outcome: 'failure',
        summary: 'wip', // preserved from the existing attempt
        failureReason: 'compile error',
      });
    });

    it('errors when the attempt to update does not exist', async () => {
      mockClient.getNode.mockResolvedValue(null);
      const { isError } = await call(await testClient(), 'record_attempt', {
        taskId: 't-1',
        agent: 'A',
        id: 'a-missing',
      });
      expect(isError).toBe(true);
    });
  });

  describe('list_attempts', () => {
    const attempts = [
      { id: 'a-1', type: 'attempt', target_id: 't-1', assignee: 'A', status: 'in_progress', metadata: { attempt: { outcome: 'pending' } } },
      { id: 'a-2', type: 'attempt', target_id: 't-1', assignee: 'B', status: 'closed', metadata: { attempt: { outcome: 'success' } } },
    ];

    it('queries attempt nodes (verbose) and attaches verifications', async () => {
      mockClient.query
        .mockResolvedValueOnce({ items: attempts })
        .mockResolvedValueOnce({ items: [{ from_id: 'a-9', to_id: 'a-2', type: 'verifies', metadata: { verdict: 'pass' } }] });
      const { parsed } = await call(await testClient(), 'list_attempts', { taskId: 't-1' });
      expect(mockClient.query).toHaveBeenCalledWith({ nodes: { type: 'attempt' }, verbose: true });
      expect(parsed.count).toBe(2);
      expect(parsed.items.find((n: { id: string }) => n.id === 'a-2').verifications).toHaveLength(1);
    });

    it('inProgress shortcut queries status=in_progress', async () => {
      mockClient.query.mockResolvedValue({ items: [attempts[0]] });
      await call(await testClient(), 'list_attempts', { inProgress: true });
      expect(mockClient.query).toHaveBeenCalledWith({
        nodes: { type: 'attempt', status: 'in_progress' },
        verbose: true,
      });
    });

    it('unverified filter returns only unevidenced success attempts', async () => {
      mockClient.query
        .mockResolvedValueOnce({ items: attempts })
        .mockResolvedValueOnce({ items: [] }); // no verify edges
      const { parsed } = await call(await testClient(), 'list_attempts', { unverified: true });
      expect(parsed.items.map((n: { id: string }) => n.id)).toEqual(['a-2']);
    });
  });
});
