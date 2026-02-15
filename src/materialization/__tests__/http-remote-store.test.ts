/**
 * Tests for HTTP Remote Store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpRemoteStore } from '../http-remote-store.js'
import type { RemoteStoreConfig, MaterializationSnapshot } from '../types.js'

// ============================================================================
// Helpers
// ============================================================================

function makeSnapshot(overrides?: Partial<MaterializationSnapshot>): MaterializationSnapshot {
  return {
    version: 1,
    uri: 'entire://session/test-123',
    source: 'entire',
    entityType: 'session',
    createdAt: '2026-01-01T00:00:00Z',
    archivedAt: '2026-01-01T01:00:00Z',
    node: {
      title: 'Test Session',
      content: 'Test content',
      external_data: { agent: 'claude' },
    },
    provenance: {
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
    },
    ...overrides,
  }
}

function makeConfig(overrides?: Partial<RemoteStoreConfig>): RemoteStoreConfig {
  return {
    type: 'http',
    name: 'test-webhook',
    enabled: true,
    config: {
      url: 'https://example.com/ingest',
    },
    events: ['session.ended'],
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('HTTP Remote Store', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('creation', () => {
    it('should create a store with valid config', () => {
      const store = createHttpRemoteStore(makeConfig())
      expect(store.name).toBe('test-webhook')
      expect(store.type).toBe('http')
      expect(store.enabled).toBe(true)
      expect(store.events).toEqual(['session.ended'])
    })

    it('should throw if URL is missing', () => {
      expect(() => createHttpRemoteStore(makeConfig({
        config: {},
      }))).toThrow('url')
    })
  })

  describe('archive', () => {
    it('should POST snapshot to URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })
      globalThis.fetch = fetchMock

      const store = createHttpRemoteStore(makeConfig())
      const snapshot = makeSnapshot()
      const result = await store.archive(snapshot)

      expect(result.stored).toBe(true)
      expect(result.uri).toBe('entire://session/test-123')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/ingest',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      )

      // Verify body
      const callArgs = fetchMock.mock.calls[0]
      const body = JSON.parse(callArgs[1].body)
      expect(body.uri).toBe('entire://session/test-123')
    })

    it('should handle HTTP errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server Error',
      })

      const store = createHttpRemoteStore(makeConfig())
      const result = await store.archive(makeSnapshot())

      expect(result.stored).toBe(false)
      expect(result.error).toContain('500')
    })

    it('should handle network errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

      const store = createHttpRemoteStore(makeConfig())
      const result = await store.archive(makeSnapshot())

      expect(result.stored).toBe(false)
      expect(result.error).toContain('ECONNREFUSED')
    })

    it('should include custom headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })
      globalThis.fetch = fetchMock

      const store = createHttpRemoteStore(makeConfig({
        config: {
          url: 'https://example.com/ingest',
          headers: { 'Authorization': 'Bearer token123' },
        },
      }))
      await store.archive(makeSnapshot())

      expect(fetchMock.mock.calls[0][1].headers).toEqual(
        expect.objectContaining({
          'Authorization': 'Bearer token123',
        })
      )
    })
  })

  describe('archiveBatch', () => {
    it('should send individual requests by default', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })
      globalThis.fetch = fetchMock

      const store = createHttpRemoteStore(makeConfig())
      const result = await store.archiveBatch([makeSnapshot(), makeSnapshot({ uri: 'entire://session/test-456' })])

      expect(result.successCount).toBe(2)
      expect(result.failureCount).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('should send array when batchMode is array', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })
      globalThis.fetch = fetchMock

      const store = createHttpRemoteStore(makeConfig({
        config: {
          url: 'https://example.com/ingest',
          batchMode: 'array',
        },
      }))
      const result = await store.archiveBatch([makeSnapshot(), makeSnapshot()])

      expect(result.successCount).toBe(2)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Body should be an array
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(Array.isArray(body)).toBe(true)
    })
  })

  describe('retrieve', () => {
    it('should return null (write-only store)', async () => {
      const store = createHttpRemoteStore(makeConfig())
      const result = await store.retrieve('entire://session/test-123')
      expect(result).toBeNull()
    })
  })

  describe('list', () => {
    it('should return empty array (write-only store)', async () => {
      const store = createHttpRemoteStore(makeConfig())
      const result = await store.list()
      expect(result).toEqual([])
    })
  })

  describe('status', () => {
    it('should report healthy when no errors', async () => {
      const store = createHttpRemoteStore(makeConfig())
      const status = await store.status()
      expect(status.healthy).toBe(true)
    })

    it('should report unhealthy after error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

      const store = createHttpRemoteStore(makeConfig())
      await store.archive(makeSnapshot())

      const status = await store.status()
      expect(status.healthy).toBe(false)
      expect(status.lastError).toContain('ECONNREFUSED')
    })

    it('should clear error after success', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'OK' })
      globalThis.fetch = fetchMock

      const store = createHttpRemoteStore(makeConfig())
      await store.archive(makeSnapshot())
      await store.archive(makeSnapshot())

      const status = await store.status()
      expect(status.healthy).toBe(true)
      expect(status.lastArchiveAt).toBeDefined()
    })
  })
})
