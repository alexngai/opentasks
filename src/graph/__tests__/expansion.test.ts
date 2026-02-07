import { describe, it, expect, vi } from 'vitest'
import {
  createQueryExpander,
  type ExpansionMode,
} from '../expansion.js'
import type { Storage } from '../../storage/interface.js'
import type { LocationProvider } from '../../providers/location.js'
import type { ProviderNode } from '../../providers/types.js'

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
    getReady: vi.fn().mockResolvedValue([
      { id: 'i-local', uuid: 'uuid1', type: 'issue', title: 'Local Issue', status: 'open', created_at: '2025-01-01', updated_at: '2025-01-01' },
    ]),
    runInTransaction: vi.fn(),
    markDirty: vi.fn(),
    getDirtyNodes: vi.fn().mockResolvedValue([]),
    clearDirty: vi.fn(),
    close: vi.fn(),
  }
}

function mockLocationProvider(hash: string, readyNodes: ProviderNode[] = []): LocationProvider {
  return {
    name: `opentasks-${hash}`,
    schemes: ['opentasks'],
    capabilities: { read: true, write: false, search: true, watch: false },
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
  }
}

describe('createQueryExpander', () => {
  it('returns only local results with mode=none', async () => {
    const storage = mockStorage()
    const expander = createQueryExpander(storage, 'local1', new Map())

    const result = await expander.expandedReady({ expand: 'none' })
    expect(result.local).toHaveLength(1)
    expect(result.local[0].id).toBe('i-local')
    expect(result.connected).toEqual({})
    expect(result.completeness).toBe('full')
  })

  it('queries connected locations with mode=connections', async () => {
    const storage = mockStorage()
    const remoteNodes: ProviderNode[] = [
      { id: 'i-remote', uri: 'opentasks://remote1/i-remote', type: 'issue', title: 'Remote Issue', fetchedAt: '2025-01-01' },
    ]
    const providers = new Map<string, LocationProvider>()
    providers.set('remote1', mockLocationProvider('remote1', remoteNodes))

    const expander = createQueryExpander(storage, 'local1', providers)

    const result = await expander.expandedReady({ expand: 'connections' })
    expect(result.local).toHaveLength(1)
    expect(result.connected['remote1']).toHaveLength(1)
    expect(result.connected['remote1'][0].id).toBe('i-remote')
    expect(result.queriedLocations).toContain('local1')
    expect(result.queriedLocations).toContain('remote1')
    expect(result.completeness).toBe('full')
  })

  it('marks partial when providers fail', async () => {
    const storage = mockStorage()
    const failingProvider = mockLocationProvider('failing1')
    ;(failingProvider.ready as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable'))

    const providers = new Map<string, LocationProvider>()
    providers.set('failing1', failingProvider)

    const expander = createQueryExpander(storage, 'local1', providers)

    const result = await expander.expandedReady({ expand: 'all' })
    expect(result.unreachableLocations).toContain('failing1')
    expect(result.completeness).toBe('partial')
  })

  it('expandedQuery uses filter', async () => {
    const storage = mockStorage()
    const providers = new Map<string, LocationProvider>()

    const expander = createQueryExpander(storage, 'local1', providers)

    await expander.expandedQuery({ type: 'issue', status: 'open' })
    expect(storage.queryNodes).toHaveBeenCalledWith({
      type: 'issue',
      status: 'open',
    })
  })

  it('respects maxLocations', async () => {
    const storage = mockStorage()
    const providers = new Map<string, LocationProvider>()
    for (let i = 0; i < 20; i++) {
      providers.set(`loc${i}`, mockLocationProvider(`loc${i}`))
    }

    const expander = createQueryExpander(storage, 'local1', providers)
    const result = await expander.expandedReady({ expand: 'all', maxLocations: 5 })

    expect(result.queriedLocations.length).toBeLessThanOrEqual(6) // local + 5
  })
})
