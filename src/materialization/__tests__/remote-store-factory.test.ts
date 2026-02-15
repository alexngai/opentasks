/**
 * Tests for Remote Store Factory
 */

import { describe, it, expect, vi } from 'vitest'
import { createRemoteStoresFromConfig, registerRemoteStoreFactory } from '../remote-store-factory.js'
import type { RemoteStoreConfig, RemoteStore } from '../types.js'

// Mock fetch for HTTP store creation
globalThis.fetch = vi.fn()

describe('Remote Store Factory', () => {
  describe('createRemoteStoresFromConfig', () => {
    it('should create HTTP remote store', () => {
      const configs: RemoteStoreConfig[] = [{
        type: 'http',
        name: 'analytics',
        enabled: true,
        config: { url: 'https://example.com/ingest' },
        events: ['session.ended'],
      }]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(1)
      expect(stores[0].name).toBe('analytics')
      expect(stores[0].type).toBe('http')
    })

    it('should create webhook remote store (alias for http)', () => {
      const configs: RemoteStoreConfig[] = [{
        type: 'webhook',
        name: 'my-webhook',
        enabled: true,
        config: { url: 'https://example.com/hook' },
        events: ['session.ended'],
      }]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(1)
      expect(stores[0].name).toBe('my-webhook')
    })

    it('should skip disabled stores', () => {
      const configs: RemoteStoreConfig[] = [{
        type: 'http',
        name: 'disabled-store',
        enabled: false,
        config: { url: 'https://example.com/ingest' },
        events: ['session.ended'],
      }]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(0)
    })

    it('should skip unknown store types', () => {
      const configs: RemoteStoreConfig[] = [{
        type: 'unknown-type',
        name: 'mystery-store',
        enabled: true,
        config: {},
        events: [],
      }]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(0)
    })

    it('should handle multiple stores', () => {
      const configs: RemoteStoreConfig[] = [
        {
          type: 'http',
          name: 'analytics',
          enabled: true,
          config: { url: 'https://analytics.example.com' },
          events: ['session.ended'],
        },
        {
          type: 'http',
          name: 'audit',
          enabled: true,
          config: { url: 'https://audit.example.com' },
          events: ['session.started', 'session.ended'],
        },
      ]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(2)
      expect(stores[0].name).toBe('analytics')
      expect(stores[1].name).toBe('audit')
    })

    it('should skip stores that fail to create', () => {
      const configs: RemoteStoreConfig[] = [{
        type: 'http',
        name: 'bad-config',
        enabled: true,
        config: {}, // Missing url — will throw
        events: [],
      }]

      const stores = createRemoteStoresFromConfig(configs)
      expect(stores).toHaveLength(0)
    })
  })

  describe('registerRemoteStoreFactory', () => {
    it('should register and use custom factory', () => {
      const customStore: RemoteStore = {
        name: 'custom',
        type: 'custom',
        enabled: true,
        events: [],
        archive: vi.fn(),
        archiveBatch: vi.fn(),
        retrieve: vi.fn(),
        list: vi.fn(),
        initialize: vi.fn(),
        close: vi.fn(),
        status: vi.fn(),
      }

      registerRemoteStoreFactory('custom', () => customStore)

      const stores = createRemoteStoresFromConfig([{
        type: 'custom',
        name: 'my-custom',
        enabled: true,
        config: {},
        events: [],
      }])

      expect(stores).toHaveLength(1)
      expect(stores[0]).toBe(customStore)
    })
  })
})
