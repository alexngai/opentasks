/**
 * Tests for Provider Factory from Configuration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createProvidersFromConfig } from '../from-config.js'
import { getDefaults } from '../../config/defaults.js'
import type { OpenTasksConfig } from '../../config/schema.js'
import type { GraphStore } from '../../graph/types.js'

// Create a minimal mock GraphStore
function createMockGraphStore(): GraphStore {
  return {
    createNode: vi.fn(),
    getNode: vi.fn().mockResolvedValue(null),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    listNodes: vi.fn().mockResolvedValue([]),
    createEdge: vi.fn(),
    getEdge: vi.fn().mockResolvedValue(null),
    deleteEdge: vi.fn(),
    listEdges: vi.fn().mockResolvedValue([]),
    getBlockers: vi.fn().mockResolvedValue([]),
    getReady: vi.fn().mockResolvedValue([]),
    getFeedback: vi.fn().mockResolvedValue([]),
    searchNodes: vi.fn().mockResolvedValue([]),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    getNodesByTag: vi.fn().mockResolvedValue([]),
    markDirty: vi.fn(),
    getDirty: vi.fn().mockReturnValue(new Set()),
    clearDirty: vi.fn(),
  } as unknown as GraphStore
}

describe('createProvidersFromConfig', () => {
  let graphStore: GraphStore
  let defaultConfig: OpenTasksConfig

  beforeEach(() => {
    graphStore = createMockGraphStore()
    defaultConfig = getDefaults()
  })

  describe('native provider', () => {
    it('always creates native provider', async () => {
      const result = await createProvidersFromConfig({
        config: defaultConfig,
        graphStore,
      })

      expect(result.providers.some((p) => p.name === 'native')).toBe(true)
      expect(result.registry.get('native')).toBeDefined()
    })
  })

  describe('beads provider', () => {
    it('skips beads when disabled', async () => {
      const config: OpenTasksConfig = {
        ...defaultConfig,
        providers: {
          ...defaultConfig.providers,
          beads: { ...defaultConfig.providers.beads, enabled: false },
        },
      }

      const result = await createProvidersFromConfig({
        config,
        graphStore,
      })

      expect(result.providers.some((p) => p.name === 'beads')).toBe(false)
      expect(result.skipped).toContain('beads')
    })

    it('skips beads when enabled but executable not found', async () => {
      const config: OpenTasksConfig = {
        ...defaultConfig,
        providers: {
          ...defaultConfig.providers,
          beads: {
            ...defaultConfig.providers.beads,
            enabled: true,
            executable: 'nonexistent-bd-command-12345',
          },
        },
      }

      const result = await createProvidersFromConfig({
        config,
        graphStore,
      })

      expect(result.providers.some((p) => p.name === 'beads')).toBe(false)
      expect(result.skipped).toContain('beads')
    })
  })

  describe('claude provider', () => {
    it('creates claude when enabled', async () => {
      const result = await createProvidersFromConfig({
        config: defaultConfig,
        graphStore,
      })

      expect(result.providers.some((p) => p.name === 'claude')).toBe(true)
      expect(result.registry.get('claude')).toBeDefined()
    })

    it('skips claude when disabled', async () => {
      const config: OpenTasksConfig = {
        ...defaultConfig,
        providers: {
          ...defaultConfig.providers,
          claudeTasks: { enabled: false },
        },
      }

      const result = await createProvidersFromConfig({
        config,
        graphStore,
      })

      expect(result.providers.some((p) => p.name === 'claude')).toBe(false)
      expect(result.skipped).toContain('claude')
    })
  })

  describe('result structure', () => {
    it('returns registry with all providers', async () => {
      const result = await createProvidersFromConfig({
        config: defaultConfig,
        graphStore,
      })

      expect(result.registry).toBeDefined()
      expect(result.registry.list().length).toBeGreaterThan(0)
    })

    it('returns list of created providers', async () => {
      const result = await createProvidersFromConfig({
        config: defaultConfig,
        graphStore,
      })

      expect(Array.isArray(result.providers)).toBe(true)
      expect(result.providers.length).toBeGreaterThan(0)
    })

    it('returns list of skipped providers', async () => {
      const config: OpenTasksConfig = {
        ...defaultConfig,
        providers: {
          beads: { ...defaultConfig.providers.beads, enabled: false },
          claudeTasks: { enabled: false },
          sudocode: { ...defaultConfig.providers.sudocode, enabled: false },
        },
      }

      const result = await createProvidersFromConfig({
        config,
        graphStore,
      })

      expect(result.skipped).toContain('beads')
      expect(result.skipped).toContain('claude')
      expect(result.skipped).toContain('sudocode')
    })

    it('returns empty failed array on success', async () => {
      const result = await createProvidersFromConfig({
        config: defaultConfig,
        graphStore,
      })

      expect(result.failed).toEqual([])
    })
  })
})
