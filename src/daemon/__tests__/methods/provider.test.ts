/**
 * Tests for Provider Method Handlers
 *
 * Tests provider.list and provider.info, including taskCapabilities enrichment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createIPCServer,
  createIPCClient,
  type IPCServer,
  type IPCClient,
} from '../../ipc.js'
import { registerProviderMethods } from '../../methods/provider.js'
import type { GraphStore } from '../../../graph/store.js'
import type { ProviderAwareStore } from '../../../graph/provider-store.js'
import type { Provider, ProviderNode, ProviderRegistry } from '../../../providers/types.js'
import { createProviderRegistry } from '../../../providers/registry.js'
import type { LocationResolver, LocationState } from '../../location-state.js'
import { createDaemonFlushManager, type DaemonFlushManager } from '../../flush.js'
import type { TaskManageable, TaskAction } from '../../../providers/traits/TaskManageable.js'

describe('Provider Methods', () => {
  let tempDir: string
  let socketPath: string
  let server: IPCServer
  let client: IPCClient
  let mockStore: GraphStore
  let registry: ProviderRegistry
  let flushManager: DaemonFlushManager

  // A basic provider (no task support)
  const basicProvider: Provider = {
    name: 'basic',
    schemes: ['basic'],
    capabilities: { read: true, write: false, search: false, watch: false, mount: false, feedback: false },
    parseUri: () => null,
    buildUri: (id) => `basic://${id}`,
    isValidUri: () => false,
    get: async () => null,
    list: async () => [],
    create: async () => ({} as ProviderNode),
    update: async () => ({} as ProviderNode),
    delete: async () => {},
  }

  // A task-capable provider
  const taskProvider: Provider & TaskManageable = {
    name: 'beads',
    schemes: ['beads', 'bd'],
    capabilities: { read: true, write: true, search: true, watch: false, mount: true, feedback: false },
    parseUri: (uri) => {
      if (uri.startsWith('beads://')) return { scheme: 'beads', id: uri.slice(8), isRelative: false }
      return null
    },
    buildUri: (id) => `beads://${id}`,
    isValidUri: (uri) => uri.startsWith('beads://'),
    get: async () => null,
    list: async () => [],
    create: async () => ({} as ProviderNode),
    update: async () => ({} as ProviderNode),
    delete: async () => {},

    taskCapabilities: {
      actions: ['start', 'complete', 'block', 'reopen'] as TaskAction[],
      supportsAssignment: true,
      supportsReadyQuery: true,
      statusModel: ['open', 'in_progress', 'blocked', 'done'],
    },
    transitionTask: async () => ({} as ProviderNode),
    readyTasks: async () => [],
    assignTask: async () => ({} as ProviderNode),
    validActions: async () => ['start', 'complete'] as TaskAction[],
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-provider-methods-test-'))
    socketPath = path.join(tempDir, 'test.sock')

    registry = createProviderRegistry()

    mockStore = {
      getNode: vi.fn(),
      query: { nodes: vi.fn().mockResolvedValue([]) },
    } as unknown as GraphStore

    flushManager = createDaemonFlushManager(
      { debounceMs: 100, maxDelayMs: 500 },
      async () => {}
    )

    const mockProviderStore = {
      ...mockStore,
      providers: registry,
      defaultProvider: 'native',
    } as unknown as ProviderAwareStore

    server = createIPCServer(socketPath)
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: mockStore,
      providerStore: mockProviderStore,
      flushManager,
      watcher: {} as any,
      primary: true,
      healthy: true,
    } as LocationState
    const locationResolver: LocationResolver = {
      resolve: () => locationState,
      getDefault: () => locationState,
      list: () => [{ hash: 'primary', opentasksPath: tempDir, primary: true, healthy: true }],
      has: () => true,
      add: () => {},
      remove: async () => {},
    }
    registerProviderMethods({ server, locationResolver })

    await server.start()
    client = createIPCClient(socketPath)
    await client.connect()
  })

  afterEach(async () => {
    try { client.disconnect() } catch {}
    try { await server.stop() } catch {}
    try { await fs.rm(tempDir, { recursive: true, force: true }) } catch {}
  })

  describe('provider.list', () => {
    it('should list providers without taskCapabilities for non-task providers', async () => {
      registry.register(basicProvider)

      const result = await client.request<any>('provider.list', {})

      const basic = result.providers.find((p: any) => p.name === 'basic')
      expect(basic).toBeDefined()
      expect(basic.capabilities.read).toBe(true)
      expect(basic.capabilities.write).toBe(false)
      expect(basic.taskCapabilities).toBeUndefined()
    })

    it('should include taskCapabilities for task-capable providers', async () => {
      registry.register(taskProvider)

      const result = await client.request<any>('provider.list', {})

      const beads = result.providers.find((p: any) => p.name === 'beads')
      expect(beads).toBeDefined()
      expect(beads.taskCapabilities).toBeDefined()
      expect(beads.taskCapabilities.actions).toEqual(['start', 'complete', 'block', 'reopen'])
      expect(beads.taskCapabilities.supportsAssignment).toBe(true)
      expect(beads.taskCapabilities.supportsReadyQuery).toBe(true)
      expect(beads.taskCapabilities.statusModel).toEqual(['open', 'in_progress', 'blocked', 'done'])
    })

    it('should list mixed providers correctly', async () => {
      registry.register(basicProvider)
      registry.register(taskProvider)

      const result = await client.request<any>('provider.list', {})

      expect(result.providers).toHaveLength(2)

      const basic = result.providers.find((p: any) => p.name === 'basic')
      const beads = result.providers.find((p: any) => p.name === 'beads')

      expect(basic.taskCapabilities).toBeUndefined()
      expect(beads.taskCapabilities).toBeDefined()
    })

    it('should include schemes in provider summary', async () => {
      registry.register(taskProvider)

      const result = await client.request<any>('provider.list', {})

      const beads = result.providers.find((p: any) => p.name === 'beads')
      expect(beads.schemes).toEqual(['beads', 'bd'])
    })
  })

  describe('provider.info', () => {
    it('should return taskCapabilities for task-capable provider', async () => {
      registry.register(taskProvider)

      const result = await client.request<any>('provider.info', { name: 'beads' })

      expect(result.provider).toBeDefined()
      expect(result.provider.taskCapabilities).toBeDefined()
      expect(result.provider.taskCapabilities.actions).toContain('start')
      expect(result.provider.taskCapabilities.supportsAssignment).toBe(true)
    })

    it('should not include taskCapabilities for non-task provider', async () => {
      registry.register(basicProvider)

      const result = await client.request<any>('provider.info', { name: 'basic' })

      expect(result.provider).toBeDefined()
      expect(result.provider.taskCapabilities).toBeUndefined()
    })

    it('should return error for missing provider', async () => {
      const result = await client.request<any>('provider.info', { name: 'nonexistent' })

      expect(result.provider).toBeNull()
      expect(result.error).toContain('not found')
    })

    it('should return error for missing name', async () => {
      const result = await client.request<any>('provider.info', {})

      expect(result.provider).toBeNull()
      expect(result.error).toContain('Missing required parameter')
    })
  })
})
