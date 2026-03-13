/**
 * Tests for Snapshot Assembly
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildSessionSnapshot,
  buildCheckpointSnapshot,
  buildSnapshot,
  buildProvenance,
} from '../snapshot.js';
import type { ExternalNode } from '../../schema/nodes.js';
import type { GraphStore } from '../../graph/store.js';
import type { SnapshotProvenance } from '../types.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockExternalNode(overrides: Partial<ExternalNode> = {}): ExternalNode {
  return {
    id: 'x-abc1',
    uuid: 'uuid-1',
    type: 'external',
    title: 'Session: 2026-02-14-abc123',
    uri: 'sessionlog://session/2026-02-14-abc123',
    source: 'sessionlog',
    materialized: true,
    created_at: '2026-02-14T10:00:00.000Z',
    updated_at: '2026-02-14T10:15:00.000Z',
    external_status: 'active',
    external_data: {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'feature/auth',
      tokenUsage: { input: 12000, output: 3000 },
      filesTouched: ['src/auth.ts'],
    },
    metadata: {
      entityType: 'session',
    },
    ...overrides,
  };
}

function createMockStore(): GraphStore {
  return {
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
    },
    createNode: vi.fn(),
    updateNode: vi.fn(),
    createEdge: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    initialize: vi.fn(),
  } as unknown as GraphStore;
}

const mockProvenance: SnapshotProvenance = {
  graphId: 'test-repo',
  graphPath: '/test/.opentasks',
  gitRemote: 'https://github.com/test/repo',
  gitBranch: 'main',
  gitHead: 'deadbeef',
};

// ============================================================================
// Tests
// ============================================================================

describe('Snapshot Assembly', () => {
  describe('buildProvenance', () => {
    it('should build provenance with graphId and path', () => {
      const prov = buildProvenance({
        graphId: 'my-repo',
        opentasksPath: '/nonexistent/path/.opentasks',
      });

      expect(prov.graphId).toBe('my-repo');
      expect(prov.graphPath).toBe('/nonexistent/path/.opentasks');
    });
  });

  describe('buildSessionSnapshot', () => {
    it('should build a session snapshot with all fields', async () => {
      const node = createMockExternalNode();
      const store = createMockStore();

      const snapshot = await buildSessionSnapshot(node, store, mockProvenance);

      expect(snapshot.version).toBe(1);
      expect(snapshot.uri).toBe('sessionlog://session/2026-02-14-abc123');
      expect(snapshot.source).toBe('sessionlog');
      expect(snapshot.entityType).toBe('session');
      expect(snapshot.createdAt).toBe('2026-02-14T10:00:00.000Z');
      expect(snapshot.archivedAt).toBeTruthy();
      expect(snapshot.node.title).toBe('Session: 2026-02-14-abc123');
      expect(snapshot.node.external_data).toHaveProperty('agent', 'claude-code');
      expect(snapshot.provenance.graphId).toBe('test-repo');
      expect(snapshot.edges).toEqual([]);
      expect(snapshot.checkpointIds).toEqual([]);
    });

    it('should extract checkpoint IDs from contains edges', async () => {
      const node = createMockExternalNode();
      const store = createMockStore();
      const queryEdges = store.query.edges as ReturnType<typeof vi.fn>;

      queryEdges
        .mockResolvedValueOnce([
          {
            id: 'x-e1',
            uuid: 'u1',
            from_id: 'x-abc1',
            to_id: 'x-cp1',
            type: 'contains',
            created_at: '2026-02-14T10:05:00.000Z',
          },
        ])
        .mockResolvedValueOnce([]);

      // Mock node lookup for to_id resolution
      const queryNodes = store.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-cp1',
          type: 'external',
          uri: 'sessionlog://checkpoint/cp-001',
        },
      ]);

      const snapshot = await buildSessionSnapshot(node, store, mockProvenance);

      expect(snapshot.checkpointIds).toContain('cp-001');
      expect(snapshot.edges.length).toBe(1);
      expect(snapshot.edges[0].edgeType).toBe('contains');
    });
  });

  describe('buildCheckpointSnapshot', () => {
    it('should build a checkpoint snapshot with code commit', async () => {
      const node = createMockExternalNode({
        uri: 'sessionlog://checkpoint/cp-001',
        title: 'Checkpoint: cp-001',
        external_data: {
          sessionId: '2026-02-14-abc123',
          commitHash: 'fa3bc91',
          filesModified: ['src/auth.ts'],
        },
        metadata: {
          entityType: 'checkpoint',
          sessionId: '2026-02-14-abc123',
        },
      });
      const store = createMockStore();

      const snapshot = await buildCheckpointSnapshot(node, store, mockProvenance);

      expect(snapshot.entityType).toBe('checkpoint');
      expect(snapshot.codeCommit).toBe('fa3bc91');
      expect(snapshot.sessionUri).toBe('sessionlog://session/2026-02-14-abc123');
    });
  });

  describe('buildSnapshot', () => {
    it('should dispatch to session builder for session nodes', async () => {
      const node = createMockExternalNode({
        metadata: { entityType: 'session' },
      });
      const store = createMockStore();

      const snapshot = await buildSnapshot(node, store, mockProvenance);

      expect(snapshot.entityType).toBe('session');
      expect('edges' in snapshot).toBe(true);
    });

    it('should dispatch to checkpoint builder for checkpoint nodes', async () => {
      const node = createMockExternalNode({
        uri: 'sessionlog://checkpoint/cp-001',
        external_data: {
          sessionId: '2026-02-14-abc123',
          commitHash: 'xyz',
        },
        metadata: { entityType: 'checkpoint', sessionId: '2026-02-14-abc123' },
      });
      const store = createMockStore();

      const snapshot = await buildSnapshot(node, store, mockProvenance);

      expect(snapshot.entityType).toBe('checkpoint');
      expect('codeCommit' in snapshot).toBe(true);
    });

    it('should handle unknown entity types', async () => {
      const node = createMockExternalNode({
        metadata: { entityType: 'unknown-type' },
      });
      const store = createMockStore();

      const snapshot = await buildSnapshot(node, store, mockProvenance);

      expect(snapshot.entityType).toBe('unknown-type');
    });
  });
});
