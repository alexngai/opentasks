/**
 * Tests for OpenTasks Client Graph CRUD Methods
 *
 * Tests createNode, getNode, updateNode, deleteNode, and call() methods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { OpenTasksClient, ClientError } from '../client.js'
import { createIPCServer, type IPCServer } from '../../daemon/ipc.js'
import { registerGraphMethods } from '../../daemon/methods/graph.js'
import { createDaemonFlushManager, type DaemonFlushManager } from '../../daemon/flush.js'
import type { GraphStore } from '../../graph/store.js'
import type { LocationResolver, LocationState } from '../../daemon/location-state.js'

describe('OpenTasksClient CRUD', () => {
  let tempDir: string
  let socketPath: string
  let server: IPCServer
  let mockStore: GraphStore
  let flushManager: DaemonFlushManager
  let nodes: Map<string, any>
  let edges: Map<string, any>
  let nodeCounter: number

  const sampleSpec = {
    id: 's-test1',
    uuid: 'uuid-1',
    type: 'spec' as const,
    title: 'Test Spec',
    content: 'Test content',
    priority: 2,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const sampleIssue = {
    id: 'i-test1',
    uuid: 'uuid-2',
    type: 'issue' as const,
    title: 'Test Issue',
    status: 'open' as const,
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-client-crud-test-'))
    socketPath = path.join(tempDir, 'daemon.sock')

    nodeCounter = 0

    // Create mock data
    nodes = new Map<string, any>()
    nodes.set(sampleSpec.id, { ...sampleSpec })
    nodes.set(sampleIssue.id, { ...sampleIssue })

    edges = new Map<string, any>()

    mockStore = {
      getNode: vi.fn().mockImplementation(async (id: string) => {
        return nodes.get(id) || null
      }),
      createNode: vi.fn().mockImplementation(async (input: any) => {
        const prefix = input.type === 'spec' ? 's' : input.type === 'issue' ? 'i' : input.type === 'external' ? 'e' : 'f'
        const node = {
          ...input,
          id: `${prefix}-new${++nodeCounter}`,
          uuid: `uuid-new${nodeCounter}`,
          archived: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        nodes.set(node.id, node)
        return node
      }),
      updateNode: vi.fn().mockImplementation(async (id: string, updates: any) => {
        const existing = nodes.get(id)
        if (!existing) throw new Error(`Node not found: ${id}`)
        const updated = { ...existing, ...updates, updated_at: new Date().toISOString() }
        nodes.set(id, updated)
        return updated
      }),
      deleteNode: vi.fn().mockImplementation(async (id: string, options?: any) => {
        const existing = nodes.get(id)
        if (!existing) throw new Error(`Node not found: ${id}`)
        if (options?.hard) {
          nodes.delete(id)
        } else {
          existing.archived = true
          nodes.set(id, existing)
        }
      }),
      createEdge: vi.fn(),
      deleteEdge: vi.fn(),
      getEdge: vi.fn(),
      query: {
        nodes: vi.fn().mockResolvedValue([]),
        edges: vi.fn().mockResolvedValue([]),
        ready: vi.fn().mockResolvedValue([]),
        blockers: vi.fn().mockResolvedValue([]),
        blocking: vi.fn().mockResolvedValue([]),
        feedback: vi.fn().mockResolvedValue([]),
      },
    } as unknown as GraphStore

    flushManager = createDaemonFlushManager(
      { debounceMs: 100, maxDelayMs: 500 },
      async () => {}
    )

    server = createIPCServer(socketPath)
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: mockStore,
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

    registerGraphMethods({ server, locationResolver })

    await server.start()
  })

  afterEach(async () => {
    try { await server.stop() } catch { /* ignore */ }
    try { await fs.rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ==========================================================================
  // createNode
  // ==========================================================================

  describe('createNode()', () => {
    it('should create a node and return it', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.createNode({
        type: 'issue',
        title: 'New Issue',
        status: 'open',
      }) as any

      expect(result.id).toMatch(/^i-/)
      expect(result.type).toBe('issue')
      expect(result.title).toBe('New Issue')
      expect(result.status).toBe('open')
      expect(result.created_at).toBeDefined()

      client.disconnect()
    })

    it('should create an external node with all fields', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.createNode({
        type: 'external',
        title: 'Slack Message',
        uri: 'slack://C04ABCD/p123',
        source: 'slack',
        tags: ['bug-report'],
        metadata: { author: 'alex' },
      }) as any

      expect(result.id).toMatch(/^e-/)
      expect(result.uri).toBe('slack://C04ABCD/p123')
      expect(result.source).toBe('slack')
      expect(result.tags).toEqual(['bug-report'])
      expect(result.metadata).toEqual({ author: 'alex' })

      client.disconnect()
    })

    it('should create a spec with content and priority', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.createNode({
        type: 'spec',
        title: 'Auth Spec',
        content: '## Requirements',
        priority: 1,
      }) as any

      expect(result.id).toMatch(/^s-/)
      expect(result.content).toBe('## Requirements')
      expect(result.priority).toBe(1)

      client.disconnect()
    })

    it('should call store.createNode with correct params', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.createNode({
        type: 'issue',
        title: 'Test',
        status: 'open',
        tags: ['a', 'b'],
        priority: 2,
      })

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'issue',
          title: 'Test',
          status: 'open',
          tags: ['a', 'b'],
          priority: 2,
        })
      )

      client.disconnect()
    })
  })

  // ==========================================================================
  // getNode
  // ==========================================================================

  describe('getNode()', () => {
    it('should get an existing node', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.getNode('s-test1') as any

      expect(result.id).toBe('s-test1')
      expect(result.type).toBe('spec')
      expect(result.title).toBe('Test Spec')

      client.disconnect()
    })

    it('should return null for non-existent node', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.getNode('x-nonexistent')

      expect(result).toBeNull()

      client.disconnect()
    })

    it('should call store.getNode with the ID', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.getNode('i-test1')

      expect(mockStore.getNode).toHaveBeenCalledWith('i-test1')

      client.disconnect()
    })
  })

  // ==========================================================================
  // updateNode
  // ==========================================================================

  describe('updateNode()', () => {
    it('should update and return the node', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.updateNode('i-test1', {
        status: 'closed',
      }) as any

      expect(result.id).toBe('i-test1')
      expect(result.status).toBe('closed')

      client.disconnect()
    })

    it('should update title', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.updateNode('s-test1', {
        title: 'Updated Title',
      }) as any

      expect(result.title).toBe('Updated Title')

      client.disconnect()
    })

    it('should update archived flag', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.updateNode('i-test1', {
        archived: true,
      }) as any

      expect(result.archived).toBe(true)

      client.disconnect()
    })

    it('should update metadata', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.updateNode('i-test1', {
        metadata: { reviewed: true },
      }) as any

      expect(result.metadata).toEqual({ reviewed: true })

      client.disconnect()
    })

    it('should throw for non-existent node', async () => {
      const client = new OpenTasksClient({ socketPath })

      await expect(
        client.updateNode('x-nonexistent', { title: 'fail' })
      ).rejects.toThrow()

      client.disconnect()
    })

    it('should call store.updateNode with correct params', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.updateNode('i-test1', { status: 'in_progress' })

      expect(mockStore.updateNode).toHaveBeenCalledWith(
        'i-test1',
        expect.objectContaining({ status: 'in_progress' })
      )

      client.disconnect()
    })
  })

  // ==========================================================================
  // deleteNode
  // ==========================================================================

  describe('deleteNode()', () => {
    it('should soft delete a node', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.deleteNode('i-test1')

      expect(mockStore.deleteNode).toHaveBeenCalledWith('i-test1', undefined)

      client.disconnect()
    })

    it('should hard delete with options', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.deleteNode('i-test1', { hard: true })

      // The handler passes { id, options } where options is { hard: true }
      expect(mockStore.deleteNode).toHaveBeenCalled()

      client.disconnect()
    })

    it('should return void', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.deleteNode('i-test1')

      expect(result).toBeUndefined()

      client.disconnect()
    })

    it('should throw for non-existent node', async () => {
      const client = new OpenTasksClient({ socketPath })

      await expect(
        client.deleteNode('x-nonexistent')
      ).rejects.toThrow()

      client.disconnect()
    })
  })

  // ==========================================================================
  // call (generic RPC)
  // ==========================================================================

  describe('call()', () => {
    it('should call graph.get by method name', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.call<any>('graph.get', { id: 's-test1' })

      expect(result.id).toBe('s-test1')
      expect(result.type).toBe('spec')

      client.disconnect()
    })

    it('should call graph.create by method name', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.call<any>('graph.create', {
        type: 'issue',
        title: 'Via call()',
        status: 'open',
      })

      expect(result.id).toBeDefined()
      expect(result.title).toBe('Via call()')

      client.disconnect()
    })

    it('should throw for unknown method', async () => {
      const client = new OpenTasksClient({ socketPath })

      await expect(
        client.call('nonexistent.method', {})
      ).rejects.toThrow()

      client.disconnect()
    })

    it('should auto-connect when not connected', async () => {
      const client = new OpenTasksClient({ socketPath, autoConnect: true })

      expect(client.connected).toBe(false)

      await client.call('graph.get', { id: 's-test1' })

      expect(client.connected).toBe(true)

      client.disconnect()
    })

    it('should throw NOT_CONNECTED when autoConnect is false', async () => {
      const client = new OpenTasksClient({ socketPath, autoConnect: false })

      await expect(
        client.call('graph.get', { id: 's-test1' })
      ).rejects.toThrow(ClientError)

      await expect(
        client.call('graph.get', { id: 's-test1' })
      ).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    })
  })

  // ==========================================================================
  // Integration: create then read
  // ==========================================================================

  describe('integration', () => {
    it('should create a node then retrieve it', async () => {
      const client = new OpenTasksClient({ socketPath })

      const created = await client.createNode({
        type: 'issue',
        title: 'Roundtrip Test',
        status: 'open',
        priority: 2,
      }) as any

      const fetched = await client.getNode(created.id) as any

      expect(fetched.id).toBe(created.id)
      expect(fetched.title).toBe('Roundtrip Test')
      expect(fetched.priority).toBe(2)

      client.disconnect()
    })

    it('should create, update, and get consistent state', async () => {
      const client = new OpenTasksClient({ socketPath })

      const created = await client.createNode({
        type: 'issue',
        title: 'Lifecycle',
        status: 'open',
      }) as any

      await client.updateNode(created.id, { status: 'in_progress' })

      const fetched = await client.getNode(created.id) as any
      expect(fetched.status).toBe('in_progress')

      await client.updateNode(created.id, { status: 'closed' })

      const closed = await client.getNode(created.id) as any
      expect(closed.status).toBe('closed')

      client.disconnect()
    })

    it('should create and soft delete, then verify archived', async () => {
      const client = new OpenTasksClient({ socketPath })

      const created = await client.createNode({
        type: 'issue',
        title: 'To Delete',
        status: 'open',
      }) as any

      await client.deleteNode(created.id)

      const fetched = await client.getNode(created.id) as any
      expect(fetched.archived).toBe(true)

      client.disconnect()
    })

    it('should create and hard delete, then verify gone', async () => {
      const client = new OpenTasksClient({ socketPath })

      const created = await client.createNode({
        type: 'issue',
        title: 'To Hard Delete',
        status: 'open',
      }) as any

      await client.deleteNode(created.id, { hard: true })

      const fetched = await client.getNode(created.id)
      expect(fetched).toBeNull()

      client.disconnect()
    })
  })
})
