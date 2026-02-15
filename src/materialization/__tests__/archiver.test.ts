/**
 * Tests for Materialization Archiver
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMaterializationArchiver } from '../archiver.js';
import type {
  MaterializationStore,
  RemoteStore,
  ArchivePolicy,
  MaterializationSnapshot,
} from '../types.js';
import type { GraphStore } from '../../graph/store.js';

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockStore(): GraphStore {
  return {
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
    },
    createNode: vi.fn().mockResolvedValue({ id: 'x-new1' }),
    updateNode: vi.fn(),
    createEdge: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    initialize: vi.fn(),
  } as unknown as GraphStore;
}

function createMockGitStore(): MaterializationStore {
  return {
    name: 'git-archive',
    type: 'git',
    enabled: true,
    archive: vi.fn().mockResolvedValue({ stored: true, uri: 'test://uri' }),
    archiveBatch: vi.fn().mockResolvedValue({ results: [], successCount: 0, failureCount: 0 }),
    retrieve: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

function createMockRemoteStore(overrides: Partial<RemoteStore> = {}): RemoteStore {
  return {
    name: 'test-remote',
    type: 'http',
    enabled: true,
    events: ['session.ended'],
    archive: vi.fn().mockResolvedValue({ stored: true, uri: 'test://uri' }),
    archiveBatch: vi.fn().mockResolvedValue({ results: [], successCount: 0, failureCount: 0 }),
    retrieve: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ healthy: true }),
    ...overrides,
  };
}

const DEFAULT_POLICY: ArchivePolicy = {
  archiveOnStart: false,
  archiveOnCheckpoint: true,
  archiveOnEnd: true,
  materializeBeforeArchive: true,
};

// ============================================================================
// Tests
// ============================================================================

describe('MaterializationArchiver', () => {
  let mockGraphStore: GraphStore;
  let mockGitStore: MaterializationStore;

  beforeEach(() => {
    mockGraphStore = createMockStore();
    mockGitStore = createMockGitStore();
  });

  describe('onSessionEvent', () => {
    it('should skip archival when policy disables the event type', async () => {
      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [],
        policy: { ...DEFAULT_POLICY, archiveOnStart: false },
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'started',
        'entire://session/abc123',
        mockGraphStore,
      );

      expect(result.stores).toEqual([]);
      expect(mockGitStore.archive).not.toHaveBeenCalled();
    });

    it('should archive on ended when policy allows', async () => {
      const queryNodes = mockGraphStore.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-abc1',
          uuid: 'u1',
          type: 'external',
          title: 'Session: abc123',
          uri: 'entire://session/abc123',
          source: 'entire',
          materialized: true,
          created_at: '2026-02-14T10:00:00Z',
          updated_at: '2026-02-14T10:15:00Z',
          external_data: { agent: 'claude', phase: 'ENDED' },
          metadata: { entityType: 'session' },
        },
      ]);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/abc123',
        mockGraphStore,
      );

      expect(result.stores.length).toBe(1);
      expect(result.stores[0].stored).toBe(true);
      expect(mockGitStore.archive).toHaveBeenCalledTimes(1);
    });

    it('should return error when node not found', async () => {
      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/nonexistent',
        mockGraphStore,
      );

      expect(result.stores[0].stored).toBe(false);
      expect(result.stores[0].error).toContain('not found');
    });
  });

  describe('fan-out', () => {
    it('should archive to both git and remote stores', async () => {
      const remoteStore = createMockRemoteStore({ events: ['session.ended'] });

      const queryNodes = mockGraphStore.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-abc1',
          uuid: 'u1',
          type: 'external',
          title: 'Session: abc123',
          uri: 'entire://session/abc123',
          source: 'entire',
          materialized: true,
          created_at: '2026-02-14T10:00:00Z',
          updated_at: '2026-02-14T10:15:00Z',
          external_data: { agent: 'claude' },
          metadata: { entityType: 'session' },
        },
      ]);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/abc123',
        mockGraphStore,
      );

      expect(result.stores.length).toBe(2);
      expect(mockGitStore.archive).toHaveBeenCalledTimes(1);
      expect(remoteStore.archive).toHaveBeenCalledTimes(1);
    });

    it('should skip disabled remote stores', async () => {
      const remoteStore = createMockRemoteStore({ enabled: false });

      const queryNodes = mockGraphStore.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-abc1',
          uuid: 'u1',
          type: 'external',
          title: 'Session',
          uri: 'entire://session/abc123',
          source: 'entire',
          materialized: true,
          created_at: '2026-02-14T10:00:00Z',
          updated_at: '2026-02-14T10:00:00Z',
          external_data: {},
          metadata: { entityType: 'session' },
        },
      ]);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/abc123',
        mockGraphStore,
      );

      expect(result.stores.length).toBe(1); // Only git store
      expect(remoteStore.archive).not.toHaveBeenCalled();
    });

    it('should filter remote stores by event type', async () => {
      const remoteStore = createMockRemoteStore({ events: ['session.started'] });

      const queryNodes = mockGraphStore.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-abc1',
          uuid: 'u1',
          type: 'external',
          title: 'Session',
          uri: 'entire://session/abc123',
          source: 'entire',
          materialized: true,
          created_at: '2026-02-14T10:00:00Z',
          updated_at: '2026-02-14T10:00:00Z',
          external_data: {},
          metadata: { entityType: 'session' },
        },
      ]);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/abc123',
        mockGraphStore,
      );

      // Remote store only wants 'session.started', this is 'session.ended'
      expect(result.stores.length).toBe(1);
      expect(remoteStore.archive).not.toHaveBeenCalled();
    });

    it('should isolate failures per store', async () => {
      const failingRemote = createMockRemoteStore({
        events: ['session.ended'],
        archive: vi.fn().mockRejectedValue(new Error('Network failure')),
      });

      const queryNodes = mockGraphStore.query.nodes as ReturnType<typeof vi.fn>;
      queryNodes.mockResolvedValue([
        {
          id: 'x-abc1',
          uuid: 'u1',
          type: 'external',
          title: 'Session',
          uri: 'entire://session/abc123',
          source: 'entire',
          materialized: true,
          created_at: '2026-02-14T10:00:00Z',
          updated_at: '2026-02-14T10:00:00Z',
          external_data: {},
          metadata: { entityType: 'session' },
        },
      ]);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [failingRemote],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.onSessionEvent(
        'ended',
        'entire://session/abc123',
        mockGraphStore,
      );

      // Git store should succeed, remote should fail
      expect(result.stores.length).toBe(2);
      expect(result.stores[0].stored).toBe(true); // git
      expect(result.stores[1].stored).toBe(false); // remote
      expect(result.stores[1].error).toContain('Network failure');
    });
  });

  describe('rematerialize', () => {
    it('should reconstruct node from git archive', async () => {
      const snapshot: MaterializationSnapshot = {
        version: 1,
        uri: 'entire://session/abc123',
        source: 'entire',
        entityType: 'session',
        createdAt: '2026-02-14T10:00:00Z',
        archivedAt: '2026-02-14T10:15:00Z',
        node: {
          title: 'Session: abc123',
          status: 'closed',
          external_data: { agent: 'claude' },
        },
        provenance: {
          graphId: 'test',
          graphPath: '/test/.opentasks',
        },
      };

      (mockGitStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot);

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.rematerialize('entire://session/abc123', mockGraphStore);

      expect(result).toBe(true);
      expect(mockGraphStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'entire://session/abc123',
          source: 'entire',
          title: 'Session: abc123',
        }),
      );
    });

    it('should try remote stores when git has no data', async () => {
      const remoteSnapshot: MaterializationSnapshot = {
        version: 1,
        uri: 'entire://session/abc123',
        source: 'entire',
        entityType: 'session',
        createdAt: '2026-02-14T10:00:00Z',
        archivedAt: '2026-02-14T10:15:00Z',
        node: {
          title: 'Session: abc123',
          external_data: { agent: 'claude' },
        },
        provenance: { graphId: 'test', graphPath: '/test' },
      };

      const remoteStore = createMockRemoteStore({
        retrieve: vi.fn().mockResolvedValue(remoteSnapshot),
      });

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.rematerialize('entire://session/abc123', mockGraphStore);

      expect(result).toBe(true);
      expect(remoteStore.retrieve).toHaveBeenCalledWith('entire://session/abc123');
    });

    it('should return false when snapshot not in any store', async () => {
      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const result = await archiver.rematerialize('entire://session/nonexistent', mockGraphStore);

      expect(result).toBe(false);
    });
  });

  describe('listArchived', () => {
    it('should merge results from all stores', async () => {
      (mockGitStore.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          uri: 'entire://session/abc',
          entityType: 'session',
          graphId: 'test',
          archivedAt: '2026-02-14T10:00:00Z',
        },
      ]);

      const remoteStore = createMockRemoteStore({
        list: vi
          .fn()
          .mockResolvedValue([
            {
              uri: 'entire://session/def',
              entityType: 'session',
              graphId: 'test',
              archivedAt: '2026-02-14T11:00:00Z',
            },
          ]),
      });

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const entries = await archiver.listArchived();

      expect(entries.length).toBe(2);
      expect(entries[0].uri).toBe('entire://session/abc');
      expect(entries[1].uri).toBe('entire://session/def');
    });

    it('should deduplicate by URI (prefer git)', async () => {
      (mockGitStore.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          uri: 'entire://session/abc',
          entityType: 'session',
          graphId: 'test',
          archivedAt: '2026-02-14T10:00:00Z',
        },
      ]);

      const remoteStore = createMockRemoteStore({
        list: vi
          .fn()
          .mockResolvedValue([
            {
              uri: 'entire://session/abc',
              entityType: 'session',
              graphId: 'test',
              archivedAt: '2026-02-14T11:00:00Z',
            },
          ]),
      });

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      const entries = await archiver.listArchived();

      expect(entries.length).toBe(1);
      expect(entries[0].archivedAt).toBe('2026-02-14T10:00:00Z'); // git version
    });
  });

  describe('lifecycle', () => {
    it('should initialize all stores', async () => {
      const remoteStore = createMockRemoteStore();

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      await archiver.initialize();

      expect(mockGitStore.initialize).toHaveBeenCalled();
      expect(remoteStore.initialize).toHaveBeenCalled();
    });

    it('should close all stores', async () => {
      const remoteStore = createMockRemoteStore();

      const archiver = createMaterializationArchiver({
        gitStore: mockGitStore,
        remoteStores: [remoteStore],
        policy: DEFAULT_POLICY,
        graphId: 'test',
        graphPath: '/test/.opentasks',
      });

      await archiver.close();

      expect(mockGitStore.close).toHaveBeenCalled();
      expect(remoteStore.close).toHaveBeenCalled();
    });
  });
});
