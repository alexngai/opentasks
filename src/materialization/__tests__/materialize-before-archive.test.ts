/**
 * Tests for materializeBeforeArchive feature
 */

import { describe, it, expect, vi } from 'vitest';
import { createMaterializationArchiver } from '../archiver.js';
import type { MaterializationStore, MaterializationProvider, MaterializationSnapshot } from '../types.js';
import type { ExternalNode } from '../../schema/nodes.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockGitStore(): MaterializationStore {
  return {
    name: 'git-archive',
    type: 'git',
    enabled: true,
    archive: vi.fn().mockResolvedValue({ stored: true, uri: 'test://uri' }),
    archiveBatch: vi.fn(),
    retrieve: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    initialize: vi.fn(),
    close: vi.fn(),
    status: vi.fn(),
  };
}

function createMockGraphStore(nodes: ExternalNode[] = []) {
  return {
    query: {
      nodes: vi.fn().mockImplementation(async ({ search }: { search?: string }) => {
        return nodes.filter((n) => !search || n.uri === search);
      }),
      edges: vi.fn().mockResolvedValue([]),
    },
    createNode: vi.fn().mockResolvedValue({ id: 'new-node' }),
    updateNode: vi.fn(),
    getNode: vi.fn(),
  };
}

function createMockExternalNode(overrides?: Partial<ExternalNode>): ExternalNode {
  return {
    id: 'node-123',
    uuid: 'uuid-123',
    type: 'external',
    uri: 'sessionlog://session/test-session',
    source: 'sessionlog',
    title: 'Test Session',
    content: 'Test content',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    materialized: false,
    external_data: { agent: 'claude', tokenUsage: { input: 100 } },
    tags: [],
    ...overrides,
  } as ExternalNode;
}

// ============================================================================
// Tests
// ============================================================================

describe('materializeBeforeArchive', () => {
  it('should call materializationProvider before building snapshot', async () => {
    const originalNode = createMockExternalNode({
      external_data: { agent: 'claude', tokenUsage: { input: 100 } },
    });

    const materializedNode = createMockExternalNode({
      external_data: {
        agent: 'claude',
        tokenUsage: { input: 500, output: 1000 },
        filesTouched: ['src/main.ts'],
        summary: 'Full session data',
      },
      materialized: true,
    });

    const gitStore = createMockGitStore();
    const graphStore = createMockGraphStore([originalNode]);

    const provider: MaterializationProvider = {
      materializeNode: vi.fn().mockResolvedValue(materializedNode),
    };

    const archiver = createMaterializationArchiver({
      gitStore,
      remoteStores: [],
      policy: {
        archiveOnStart: false,
        archiveOnCheckpoint: true,
        archiveOnEnd: true,
        materializeBeforeArchive: true,
      },
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
      materializationProvider: provider,
    });

    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);

    // Should have called materializeNode
    expect(provider.materializeNode).toHaveBeenCalledWith('sessionlog://session/test-session');

    // The archive should have received the materialized snapshot (with full data)
    expect(gitStore.archive).toHaveBeenCalled();
    const archivedSnapshot = (gitStore.archive as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MaterializationSnapshot;
    expect(archivedSnapshot.node.external_data).toEqual(materializedNode.external_data);
  });

  it('should skip materialization when policy is false', async () => {
    const node = createMockExternalNode();
    const gitStore = createMockGitStore();
    const graphStore = createMockGraphStore([node]);

    const provider: MaterializationProvider = {
      materializeNode: vi.fn(),
    };

    const archiver = createMaterializationArchiver({
      gitStore,
      remoteStores: [],
      policy: {
        archiveOnStart: false,
        archiveOnCheckpoint: true,
        archiveOnEnd: true,
        materializeBeforeArchive: false,
      },
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
      materializationProvider: provider,
    });

    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);

    // Should NOT have called materializeNode
    expect(provider.materializeNode).not.toHaveBeenCalled();
    // But should still archive
    expect(gitStore.archive).toHaveBeenCalled();
  });

  it('should skip materialization when no provider is set', async () => {
    const node = createMockExternalNode();
    const gitStore = createMockGitStore();
    const graphStore = createMockGraphStore([node]);

    const archiver = createMaterializationArchiver({
      gitStore,
      remoteStores: [],
      policy: {
        archiveOnStart: false,
        archiveOnCheckpoint: true,
        archiveOnEnd: true,
        materializeBeforeArchive: true,
      },
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
      // No materializationProvider
    });

    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);

    // Should still archive with existing data
    expect(gitStore.archive).toHaveBeenCalled();
  });

  it('should fall back to existing data when materialization fails', async () => {
    const node = createMockExternalNode({
      external_data: { agent: 'claude', minimal: true },
    });
    const gitStore = createMockGitStore();
    const graphStore = createMockGraphStore([node]);

    const provider: MaterializationProvider = {
      materializeNode: vi.fn().mockRejectedValue(new Error('Provider unavailable')),
    };

    const archiver = createMaterializationArchiver({
      gitStore,
      remoteStores: [],
      policy: {
        archiveOnStart: false,
        archiveOnCheckpoint: true,
        archiveOnEnd: true,
        materializeBeforeArchive: true,
      },
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
      materializationProvider: provider,
    });

    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);

    // Should still archive with existing (minimal) data
    expect(gitStore.archive).toHaveBeenCalled();
    const archivedSnapshot = (gitStore.archive as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MaterializationSnapshot;
    expect(archivedSnapshot.node.external_data).toEqual({ agent: 'claude', minimal: true });
  });

  it('setMaterializationProvider should update provider at runtime', async () => {
    const node = createMockExternalNode();
    const gitStore = createMockGitStore();
    const graphStore = createMockGraphStore([node]);

    const archiver = createMaterializationArchiver({
      gitStore,
      remoteStores: [],
      policy: {
        archiveOnStart: false,
        archiveOnCheckpoint: true,
        archiveOnEnd: true,
        materializeBeforeArchive: true,
      },
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
    });

    // Initially no provider — should archive without materialization
    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);
    expect(gitStore.archive).toHaveBeenCalledTimes(1);

    // Set provider
    const materializedNode = createMockExternalNode({
      external_data: { full: true },
      materialized: true,
    });
    const provider: MaterializationProvider = {
      materializeNode: vi.fn().mockResolvedValue(materializedNode),
    };
    archiver.setMaterializationProvider(provider);

    // Now should materialize before archive
    await archiver.onSessionEvent('ended', 'sessionlog://session/test-session', graphStore as never);
    expect(provider.materializeNode).toHaveBeenCalled();
    expect(gitStore.archive).toHaveBeenCalledTimes(2);
  });
});
