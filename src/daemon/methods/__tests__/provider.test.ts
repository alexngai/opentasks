/**
 * Tests for Provider Method Handlers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerProviderMethods } from '../provider.js'
import type { IPCServer } from '../../ipc.js'
import type { DaemonFlushManager } from '../../flush.js'
import type { GraphStore } from '../../../graph/store.js'
import type { LocationResolver, LocationState } from '../../location-state.js'
import { createProviderAwareStore } from '../../../graph/provider-store.js'
import type { Provider } from '../../../providers/types.js'

// ============================================================================
// Mocks
// ============================================================================

function createMockServer() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>()

  return {
    handle: vi.fn((method: string, handler: (params: unknown) => Promise<unknown>) => {
      handlers.set(method, handler)
    }),
    call: async (method: string, params?: unknown) => {
      const handler = handlers.get(method)
      if (!handler) {
        throw new Error(`Method not found: ${method}`)
      }
      return handler(params)
    },
    handlers,
  } as unknown as IPCServer & { call: (method: string, params?: unknown) => Promise<unknown> }
}

function createMockStore() {
  return {
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
    },
    getNode: vi.fn().mockResolvedValue(null),
    createNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    getEdge: vi.fn(),
    createEdge: vi.fn(),
    deleteEdge: vi.fn(),
    restoreNode: vi.fn(),
    addTags: vi.fn(),
    removeTags: vi.fn(),
    setTags: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
    flush: vi.fn(),
    transaction: vi.fn(),
  } as unknown as GraphStore
}

function createMockFlushManager() {
  return {
    markDirty: vi.fn(),
    schedule: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonFlushManager
}

// ============================================================================
// Tests
// ============================================================================

describe('Provider Method Handlers', () => {
  let server: ReturnType<typeof createMockServer>
  let baseStore: GraphStore
  let flushManager: DaemonFlushManager

  beforeEach(() => {
    server = createMockServer()
    baseStore = createMockStore()
    flushManager = createMockFlushManager()
  })

  function setupWithProvider(defaultProvider: string = 'native', extraProviders: Provider[] = []) {
    const providerStore = createProviderAwareStore(baseStore, { defaultProvider })
    for (const p of extraProviders) {
      providerStore.providers.register(p)
    }

    const state: LocationState = {
      hash: 'test',
      opentasksPath: '/test/.opentasks',
      store: baseStore,
      providerStore,
      flushManager,
      watcher: null as any,
      primary: true,
      healthy: true,
    }

    const locationResolver: LocationResolver = {
      resolve: () => state,
      getDefault: () => state,
      list: () => [{ hash: 'test', opentasksPath: '/test/.opentasks', primary: true, healthy: true }],
      has: () => true,
      add: vi.fn(),
      remove: vi.fn(),
    } as unknown as LocationResolver

    registerProviderMethods({ server: server as unknown as IPCServer, locationResolver })
    return { state, providerStore }
  }

  describe('provider.list', () => {
    it('should list registered providers', async () => {
      setupWithProvider('native')

      const result = await server.call('provider.list', {}) as any
      expect(result.defaultProvider).toBe('native')
      expect(result.providers).toBeInstanceOf(Array)
      // Should at least have the native provider (auto-registered)
      const native = result.providers.find((p: any) => p.name === 'native')
      expect(native).toBeDefined()
      expect(native.capabilities.mount).toBe(true)
      expect(native.capabilities.feedback).toBe(true)
      expect(native.isDefault).toBe(true)
    })

    it('should show external providers', async () => {
      const mockBeads: Provider = {
        name: 'beads',
        schemes: ['beads', 'bd'],
        capabilities: { read: true, write: true, search: true, watch: false, mount: true, feedback: false },
        parseUri: vi.fn(),
        buildUri: vi.fn(),
        isValidUri: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      }

      setupWithProvider('beads', [mockBeads])

      const result = await server.call('provider.list', {}) as any
      expect(result.defaultProvider).toBe('beads')

      const beads = result.providers.find((p: any) => p.name === 'beads')
      expect(beads).toBeDefined()
      expect(beads.schemes).toEqual(['beads', 'bd'])
      expect(beads.capabilities.mount).toBe(true)
      expect(beads.capabilities.feedback).toBe(false)
      expect(beads.isDefault).toBe(true)

      const native = result.providers.find((p: any) => p.name === 'native')
      expect(native).toBeDefined()
      expect(native.isDefault).toBe(false)
    })
  })

  describe('provider.info', () => {
    it('should return info for a known provider', async () => {
      setupWithProvider('native')

      const result = await server.call('provider.info', { name: 'native' }) as any
      expect(result.provider).toBeDefined()
      expect(result.provider.name).toBe('native')
      expect(result.provider.capabilities.mount).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should return error for unknown provider', async () => {
      setupWithProvider('native')

      const result = await server.call('provider.info', { name: 'nonexistent' }) as any
      expect(result.provider).toBeNull()
      expect(result.error).toContain('not found')
    })

    it('should return error when name is missing', async () => {
      setupWithProvider('native')

      const result = await server.call('provider.info', {}) as any
      expect(result.provider).toBeNull()
      expect(result.error).toContain('Missing')
    })
  })

  describe('without providerStore', () => {
    it('should return empty list when no providerStore', async () => {
      const state: LocationState = {
        hash: 'test',
        opentasksPath: '/test/.opentasks',
        store: baseStore,
        // no providerStore
        flushManager,
        watcher: null as any,
        primary: true,
        healthy: true,
      }

      const locationResolver: LocationResolver = {
        resolve: () => state,
        getDefault: () => state,
        list: () => [],
        has: () => true,
        add: vi.fn(),
        remove: vi.fn(),
      } as unknown as LocationResolver

      registerProviderMethods({ server: server as unknown as IPCServer, locationResolver })

      const result = await server.call('provider.list', {}) as any
      expect(result.providers).toEqual([])
      expect(result.defaultProvider).toBe('native')
    })
  })
})
