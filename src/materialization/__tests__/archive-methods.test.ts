/**
 * Tests for Archive IPC Method Handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerArchiveMethods } from '../../daemon/methods/archive.js'
import type { LocationState, LocationResolver } from '../../daemon/location-state.js'

// ============================================================================
// Mock IPC Server
// ============================================================================

type HandlerFn = (params: unknown) => Promise<unknown>

function createMockServer() {
  const handlers = new Map<string, HandlerFn>()
  return {
    handle<P, R>(method: string, handler: (params: P) => Promise<R>): void {
      handlers.set(method, handler as HandlerFn)
    },
    call(method: string, params: unknown): Promise<unknown> {
      const handler = handlers.get(method)
      if (!handler) throw new Error(`No handler for ${method}`)
      return handler(params)
    },
    start: vi.fn(),
    stop: vi.fn(),
  }
}

// ============================================================================
// Mock LocationState
// ============================================================================

function createMockLocationState(withArchiver: boolean): LocationState {
  const mockArchiver = withArchiver ? {
    onSessionEvent: vi.fn().mockResolvedValue({ uri: 'test://uri', stores: [{ storeName: 'git', stored: true }] }),
    archiveNode: vi.fn().mockResolvedValue({ uri: 'test://uri', stores: [{ storeName: 'git', stored: true }] }),
    rematerialize: vi.fn().mockResolvedValue(true),
    rematerializeAll: vi.fn().mockResolvedValue({ restored: 2, failed: 0, skipped: 1, errors: [] }),
    listArchived: vi.fn().mockResolvedValue([
      { uri: 'entire://session/abc', entityType: 'session', graphId: 'test', archivedAt: '2026-01-01T00:00:00Z' },
    ]),
    setMaterializationProvider: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } : undefined

  return {
    hash: 'test-hash',
    opentasksPath: '/test/.opentasks',
    store: {} as never,
    flushManager: {
      markDirty: vi.fn(),
      schedule: vi.fn(),
      finalFlush: vi.fn(),
    } as never,
    watcher: {} as never,
    primary: true,
    healthy: true,
    archiver: mockArchiver,
  }
}

function createMockResolver(state: LocationState): LocationResolver {
  return {
    resolve: () => state,
    getDefault: () => state,
    list: () => [{ hash: state.hash, opentasksPath: state.opentasksPath, primary: true, healthy: true }],
    has: () => true,
    add: vi.fn(),
    remove: vi.fn(),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Archive IPC Methods', () => {
  let server: ReturnType<typeof createMockServer>

  describe('with archiver enabled', () => {
    let state: LocationState

    beforeEach(() => {
      server = createMockServer()
      state = createMockLocationState(true)
      const resolver = createMockResolver(state)
      registerArchiveMethods({ server: server as never, locationResolver: resolver })
    })

    it('archive.list should call archiver.listArchived', async () => {
      const result = await server.call('archive.list', { filter: { graphId: 'test' } })
      expect(state.archiver!.listArchived).toHaveBeenCalledWith({ graphId: 'test' })
      expect(result).toEqual([
        expect.objectContaining({ uri: 'entire://session/abc' }),
      ])
    })

    it('archive.list should work without params', async () => {
      const result = await server.call('archive.list', undefined)
      expect(state.archiver!.listArchived).toHaveBeenCalledWith(undefined)
      expect(result).toBeDefined()
    })

    it('archive.rematerialize should restore a node', async () => {
      const result = await server.call('archive.rematerialize', { uri: 'entire://session/abc' })
      expect(state.archiver!.rematerialize).toHaveBeenCalledWith('entire://session/abc', state.store)
      expect(result).toEqual({ success: true })
      expect(state.flushManager.schedule).toHaveBeenCalled()
    })

    it('archive.rematerialize should require URI', async () => {
      await expect(server.call('archive.rematerialize', {})).rejects.toThrow('uri')
    })

    it('archive.rematerializeAll should restore missing nodes', async () => {
      const result = await server.call('archive.rematerializeAll', {})
      expect(state.archiver!.rematerializeAll).toHaveBeenCalledWith(state.store)
      expect(result).toEqual({ restored: 2, failed: 0, skipped: 1, errors: [] })
      expect(state.flushManager.schedule).toHaveBeenCalled()
    })

    it('archive.node should archive a specific node', async () => {
      const result = await server.call('archive.node', { uri: 'entire://session/abc' })
      expect(state.archiver!.archiveNode).toHaveBeenCalledWith('entire://session/abc', state.store)
      expect(result).toEqual(expect.objectContaining({ uri: 'test://uri' }))
    })

    it('archive.node should require URI', async () => {
      await expect(server.call('archive.node', {})).rejects.toThrow('uri')
    })

    it('archive.push should push to remote', async () => {
      const result = await server.call('archive.push', {})
      expect(state.archiver!.close).toHaveBeenCalled()
      expect(state.archiver!.initialize).toHaveBeenCalled()
      expect(result).toEqual({ pushed: true })
    })

    it('archive.status should show enabled', async () => {
      const result = await server.call('archive.status', {}) as Record<string, unknown>
      expect(result.enabled).toBe(true)
    })
  })

  describe('without archiver', () => {
    beforeEach(() => {
      server = createMockServer()
      const state = createMockLocationState(false)
      const resolver = createMockResolver(state)
      registerArchiveMethods({ server: server as never, locationResolver: resolver })
    })

    it('archive.list should return empty array', async () => {
      const result = await server.call('archive.list', {})
      expect(result).toEqual([])
    })

    it('archive.rematerialize should return not enabled', async () => {
      const result = await server.call('archive.rematerialize', { uri: 'test://abc' })
      expect(result).toEqual({ success: false, error: 'Archive functionality not enabled' })
    })

    it('archive.rematerializeAll should return zero results', async () => {
      const result = await server.call('archive.rematerializeAll', {})
      expect(result).toEqual({ restored: 0, failed: 0, skipped: 0, errors: [] })
    })

    it('archive.status should show disabled', async () => {
      const result = await server.call('archive.status', {}) as Record<string, unknown>
      expect(result.enabled).toBe(false)
    })
  })
})
