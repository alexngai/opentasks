import { describe, it, expect, vi } from 'vitest';
import { createQueryExpander, type ExpansionMode } from '../expansion.js';
import type { Storage } from '../../storage/interface.js';
import type { LocationProvider } from '../../providers/location.js';
import type { ProviderNode } from '../../providers/types.js';
import type { NodeResolver } from '../query.js';
import type { StoredNode } from '../../schema/storage.js';

function mockStorage(): Storage {
  return {
    createNode: vi.fn(),
    getNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    queryNodes: vi.fn().mockResolvedValue([]),
    createEdge: vi.fn(),
    getEdge: vi.fn(),
    deleteEdge: vi.fn(),
    getEdgesFrom: vi.fn().mockResolvedValue([]),
    getEdgesTo: vi.fn().mockResolvedValue([]),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    getTagsForNodes: vi.fn().mockResolvedValue(new Map()),
    getNodesByTag: vi.fn().mockResolvedValue([]),
    getReady: vi
      .fn()
      .mockResolvedValue([
        {
          id: 't-local',
          uuid: 'uuid1',
          type: 'task',
          title: 'Local Task',
          status: 'open',
          created_at: '2025-01-01',
          updated_at: '2025-01-01',
        },
      ]),
    runInTransaction: vi.fn(),
    markDirty: vi.fn(),
    getDirtyNodes: vi.fn().mockResolvedValue([]),
    clearDirty: vi.fn(),
    close: vi.fn(),
  };
}

function mockLocationProvider(hash: string, readyNodes: ProviderNode[] = []): LocationProvider {
  return {
    name: `opentasks-${hash}`,
    schemes: ['opentasks'],
    capabilities: {
      read: true,
      write: false,
      search: true,
      watch: false,
      mount: false,
      feedback: false,
    },
    parseUri: vi.fn().mockReturnValue(null),
    buildUri: vi.fn().mockReturnValue(''),
    isValidUri: vi.fn().mockReturnValue(false),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(readyNodes),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ready: vi.fn().mockResolvedValue(readyNodes),
    close: vi.fn(),
  };
}

describe('createQueryExpander', () => {
  it('returns only local results with mode=none', async () => {
    const storage = mockStorage();
    const expander = createQueryExpander(storage, 'local1', new Map());

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(1);
    expect(result.local[0].id).toBe('t-local');
    expect(result.connected).toEqual({});
    expect(result.completeness).toBe('full');
  });

  it('queries connected locations with mode=connections', async () => {
    const storage = mockStorage();
    const remoteNodes: ProviderNode[] = [
      {
        id: 't-remote',
        uri: 'opentasks://remote1/t-remote',
        type: 'task',
        title: 'Remote Task',
        fetchedAt: '2025-01-01',
      },
    ];
    const providers = new Map<string, LocationProvider>();
    providers.set('remote1', mockLocationProvider('remote1', remoteNodes));

    const expander = createQueryExpander(storage, 'local1', providers);

    const result = await expander.expandedReady({ expand: 'connections' });
    expect(result.local).toHaveLength(1);
    expect(result.connected['remote1']).toHaveLength(1);
    expect(result.connected['remote1'][0].id).toBe('t-remote');
    expect(result.queriedLocations).toContain('local1');
    expect(result.queriedLocations).toContain('remote1');
    expect(result.completeness).toBe('full');
  });

  it('marks partial when providers fail', async () => {
    const storage = mockStorage();
    const failingProvider = mockLocationProvider('failing1');
    (failingProvider.ready as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable'));

    const providers = new Map<string, LocationProvider>();
    providers.set('failing1', failingProvider);

    const expander = createQueryExpander(storage, 'local1', providers);

    const result = await expander.expandedReady({ expand: 'all' });
    expect(result.unreachableLocations).toContain('failing1');
    expect(result.completeness).toBe('partial');
  });

  it('expandedQuery uses filter', async () => {
    const storage = mockStorage();
    const providers = new Map<string, LocationProvider>();

    const expander = createQueryExpander(storage, 'local1', providers);

    await expander.expandedQuery({ type: 'task', status: 'open' });
    expect(storage.queryNodes).toHaveBeenCalledWith({
      type: 'task',
      status: 'open',
    });
  });

  it('respects maxLocations', async () => {
    const storage = mockStorage();
    const providers = new Map<string, LocationProvider>();
    for (let i = 0; i < 20; i++) {
      providers.set(`loc${i}`, mockLocationProvider(`loc${i}`));
    }

    const expander = createQueryExpander(storage, 'local1', providers);
    const result = await expander.expandedReady({ expand: 'all', maxLocations: 5 });

    expect(result.queriedLocations.length).toBeLessThanOrEqual(6); // local + 5
  });
});

describe('cross-location blocker filtering', () => {
  const readyTask: StoredNode = {
    id: 't-1',
    uuid: 'uuid-t1',
    type: 'task',
    title: 'Ready Task',
    status: 'open',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
  };

  function mockBlockerStorage(
    blockerEdges: { id: string; uuid: string; from_id: string; to_id: string; type: string; created_at: string }[] = [],
  ): Storage {
    return {
      createNode: vi.fn(),
      getNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      queryNodes: vi.fn().mockResolvedValue([]),
      createEdge: vi.fn(),
      getEdge: vi.fn(),
      deleteEdge: vi.fn(),
      getEdgesFrom: vi.fn().mockResolvedValue([]),
      getEdgesTo: vi.fn().mockImplementation(async (nodeId: string, type?: string) => {
        if (nodeId === 't-1' && type === 'blocks') {
          return blockerEdges;
        }
        return [];
      }),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      getTags: vi.fn().mockResolvedValue([]),
      getTagsForNodes: vi.fn().mockResolvedValue(new Map()),
      getNodesByTag: vi.fn().mockResolvedValue([]),
      getReady: vi.fn().mockResolvedValue([readyTask]),
      runInTransaction: vi.fn(),
      markDirty: vi.fn(),
      getDirtyNodes: vi.fn().mockResolvedValue([]),
      clearDirty: vi.fn(),
      close: vi.fn(),
    };
  }

  function makeBlockerNode(overrides: Partial<StoredNode> = {}): StoredNode {
    return {
      id: 'g-1',
      uuid: 'uuid-g1',
      type: 'task',
      title: 'Global Blocker',
      status: 'open',
      archived: false,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      ...overrides,
    };
  }

  const globalBlockerEdge = {
    id: 'x-1',
    uuid: 'uuid-x1',
    from_id: 'global://g-1',
    to_id: 't-1',
    type: 'blocks',
    created_at: '2025-01-01',
  };

  it('excludes task with active global blocker', async () => {
    const storage = mockBlockerStorage([globalBlockerEdge]);
    const nodeResolver: NodeResolver = vi.fn().mockResolvedValue(makeBlockerNode());
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(0);
    expect(nodeResolver).toHaveBeenCalledWith('global://g-1');
  });

  it('includes task when global blocker is closed', async () => {
    const storage = mockBlockerStorage([globalBlockerEdge]);
    const nodeResolver: NodeResolver = vi.fn().mockResolvedValue(
      makeBlockerNode({ status: 'closed' }),
    );
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(1);
    expect(result.local[0].id).toBe('t-1');
  });

  it('includes task when global blocker is completed', async () => {
    const storage = mockBlockerStorage([globalBlockerEdge]);
    const nodeResolver: NodeResolver = vi.fn().mockResolvedValue(
      makeBlockerNode({ status: 'completed' }),
    );
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(1);
    expect(result.local[0].id).toBe('t-1');
  });

  it('excludes task with active opentasks:// blocker', async () => {
    const opentasksBlockerEdge = {
      id: 'x-2',
      uuid: 'uuid-x2',
      from_id: 'opentasks://abc123/t-remote',
      to_id: 't-1',
      type: 'blocks',
      created_at: '2025-01-01',
    };
    const storage = mockBlockerStorage([opentasksBlockerEdge]);
    const nodeResolver: NodeResolver = vi.fn().mockResolvedValue(
      makeBlockerNode({ id: 't-remote', status: 'in_progress' }),
    );
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(0);
    expect(nodeResolver).toHaveBeenCalledWith('opentasks://abc123/t-remote');
  });

  it('includes task with no external blockers', async () => {
    // No blocker edges at all
    const storage = mockBlockerStorage([]);
    const nodeResolver: NodeResolver = vi.fn();
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(1);
    expect(result.local[0].id).toBe('t-1');
    expect(nodeResolver).not.toHaveBeenCalled();
  });

  it('works without nodeResolver (backward compatible)', async () => {
    const storage = mockBlockerStorage([globalBlockerEdge]);
    // No nodeResolver passed - 4th argument omitted
    const expander = createQueryExpander(storage, 'local1', new Map());

    const result = await expander.expandedReady({ expand: 'none' });
    // Without resolver, post-filter is skipped entirely, task is returned as-is
    expect(result.local).toHaveLength(1);
    expect(result.local[0].id).toBe('t-1');
  });

  it('filtering applies even in mode: none', async () => {
    const storage = mockBlockerStorage([globalBlockerEdge]);
    const nodeResolver: NodeResolver = vi.fn().mockResolvedValue(makeBlockerNode());
    const expander = createQueryExpander(storage, 'local1', new Map(), nodeResolver);

    const result = await expander.expandedReady({ expand: 'none' });
    expect(result.local).toHaveLength(0);
    expect(result.connected).toEqual({});
  });
});
