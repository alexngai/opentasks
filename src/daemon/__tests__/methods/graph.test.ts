/**
 * Tests for Graph Method Handlers
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
import { registerGraphMethods } from '../../methods/graph.js'
import { createDaemonFlushManager, type DaemonFlushManager } from '../../flush.js'
import type { GraphStore } from '../../../graph/store.js'
import type { CreateNodeInput } from '../../../graph/types.js'
import type { LocationResolver, LocationState } from '../../location-state.js'

describe('Graph Methods', () => {
  let tempDir: string
  let socketPath: string
  let server: IPCServer
  let client: IPCClient
  let mockStore: GraphStore
  let flushManager: DaemonFlushManager
  let flushedNodeIds: string[][]

  // Sample nodes for testing
  const sampleContext = {
    id: 'c-test1',
    type: 'context' as const,
    title: 'Test Context',
    description: 'A test context',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: 2,
    archived: false,
    tags: [],
  }

  const sampleTask = {
    id: 't-test1',
    type: 'task' as const,
    title: 'Test Task',
    description: 'A test task',
    status: 'open' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    priority: 1,
    archived: false,
    tags: [],
  }

  const sampleEdge = {
    id: 'e-test1',
    from_id: 't-test1',
    to_id: 'c-test1',
    type: 'implements' as const,
    createdAt: new Date().toISOString(),
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-graph-methods-test-'))
    socketPath = path.join(tempDir, 'test.sock')

    // Create mock store
    const nodes = new Map<string, unknown>()
    nodes.set(sampleContext.id, sampleContext)
    nodes.set(sampleTask.id, sampleTask)

    const edges = new Map<string, unknown>()
    edges.set(sampleEdge.id, sampleEdge)

    // Mock query engine with nodes method
    const mockQueryNodes = vi.fn().mockImplementation(async (filter: { type?: string }) => {
      const results = Array.from(nodes.values()).filter((n: any) => {
        if (filter?.type && n.type !== filter.type) return false
        return true
      })
      return results
    })

    mockStore = {
      query: {
        nodes: mockQueryNodes,
      },
      getNode: vi.fn().mockImplementation(async (id) => {
        return nodes.get(id) || null
      }),
      createNode: vi.fn().mockImplementation(async (input: CreateNodeInput) => {
        const node = {
          ...input,
          id: input.type === 'context' ? 'c-new1' : 't-new1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        nodes.set(node.id, node)
        return node
      }),
      updateNode: vi.fn().mockImplementation(async (id: string, updates: Record<string, unknown>) => {
        const existing = nodes.get(id) as any
        if (!existing) throw new Error('Node not found')
        const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() }
        nodes.set(id, updated)
        return updated
      }),
      deleteNode: vi.fn().mockImplementation(async (id) => {
        nodes.delete(id)
      }),
      createEdge: vi.fn().mockImplementation(async (input) => {
        const edge = {
          ...input,
          id: 'e-new1',
          createdAt: new Date().toISOString(),
        }
        edges.set(edge.id, edge)
        return edge
      }),
      getEdge: vi.fn().mockImplementation(async (id) => {
        return edges.get(id) || null
      }),
      deleteEdge: vi.fn().mockImplementation(async (id) => {
        edges.delete(id)
      }),
    } as unknown as GraphStore

    // Create flush manager
    flushedNodeIds = []
    flushManager = createDaemonFlushManager(
      { debounceMs: 100, maxDelayMs: 500 },
      async (nodeIds) => {
        flushedNodeIds.push([...nodeIds])
      }
    )

    // Create server and register methods
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

    // Create client
    client = createIPCClient(socketPath)
    await client.connect()
  })

  afterEach(async () => {
    try {
      client.disconnect()
    } catch {
      // Ignore
    }

    try {
      await server.stop()
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  describe('graph.query', () => {
    it('should query nodes by type', async () => {
      const result = await client.request<unknown[]>('graph.query', { type: 'context' })

      expect(mockStore.query.nodes).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'context' })
      )
      expect(result).toHaveLength(1)
    })

    it('should query all nodes when no type specified', async () => {
      const result = await client.request<unknown[]>('graph.query', {})

      expect(mockStore.query.nodes).toHaveBeenCalled()
      expect(result).toHaveLength(2)
    })

    it('should pass filter and pagination options', async () => {
      await client.request('graph.query', {
        type: 'task',
        filter: { status: 'open' },
        limit: 10,
        offset: 5,
      })

      expect(mockStore.query.nodes).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task',
          status: 'open',
          limit: 10,
          offset: 5,
        })
      )
    })
  })

  describe('graph.get', () => {
    it('should get node by ID', async () => {
      const result = await client.request('graph.get', { id: 'c-test1' })

      expect(mockStore.getNode).toHaveBeenCalledWith('c-test1')
      expect(result).toEqual(sampleContext)
    })

    it('should return null for non-existent node', async () => {
      const result = await client.request('graph.get', { id: 'nonexistent' })

      expect(result).toBeNull()
    })

    it('should throw when id missing', async () => {
      await expect(client.request('graph.get', {})).rejects.toThrow()
    })
  })

  describe('graph.create', () => {
    it('should create a node', async () => {
      const input: CreateNodeInput = {
        type: 'context',
        title: 'New Context',
        content: 'Description',
      }

      const result = await client.request<{ id: string }>('graph.create', input)

      expect(mockStore.createNode).toHaveBeenCalledWith(input)
      expect(result.id).toBe('c-new1')
    })

    it('should mark node dirty and schedule flush', async () => {
      const input: CreateNodeInput = {
        type: 'context',
        title: 'New Context',
      }

      await client.request('graph.create', input)

      expect(flushManager.getDirtyNodes()).toContain('c-new1')
      expect(flushManager.hasPendingChanges()).toBe(true)
    })
  })

  describe('graph.update', () => {
    it('should update a node', async () => {
      const result = await client.request<{ title: string }>('graph.update', {
        id: 'c-test1',
        title: 'Updated Title',
      })

      expect(mockStore.updateNode).toHaveBeenCalledWith('c-test1', { title: 'Updated Title' })
      expect(result.title).toBe('Updated Title')
    })

    it('should mark node dirty', async () => {
      await client.request('graph.update', { id: 'c-test1', title: 'Updated' })

      expect(flushManager.getDirtyNodes()).toContain('c-test1')
    })

    it('should throw when id missing', async () => {
      await expect(client.request('graph.update', { title: 'No ID' })).rejects.toThrow()
    })
  })

  describe('graph.delete', () => {
    it('should delete a node', async () => {
      await client.request('graph.delete', { id: 'c-test1' })

      expect(mockStore.deleteNode).toHaveBeenCalledWith('c-test1', undefined)
    })

    it('should pass delete options', async () => {
      await client.request('graph.delete', {
        id: 'c-test1',
        options: { hard: true },
      })

      expect(mockStore.deleteNode).toHaveBeenCalledWith('c-test1', { hard: true })
    })

    it('should mark deletion and schedule flush', async () => {
      await client.request('graph.delete', { id: 'c-test1' })

      expect(flushManager.getDirtyNodes()).toContain('__deleted__:s-test1')
    })
  })

  describe('graph.createEdge', () => {
    it('should create an edge', async () => {
      await client.request('graph.createEdge', {
        from_id: 't-test1',
        to_id: 'c-test1',
        type: 'implements',
      })

      expect(mockStore.createEdge).toHaveBeenCalledWith({
        from_id: 't-test1',
        to_id: 'c-test1',
        type: 'implements',
        metadata: undefined,
      })
    })

    it('should mark both nodes dirty', async () => {
      await client.request('graph.createEdge', {
        from_id: 't-test1',
        to_id: 'c-test1',
        type: 'implements',
      })

      const dirty = flushManager.getDirtyNodes()
      expect(dirty).toContain('t-test1')
      expect(dirty).toContain('c-test1')
    })
  })

  describe('graph.deleteEdge', () => {
    it('should delete an edge by ID', async () => {
      await client.request('graph.deleteEdge', { id: 'e-test1' })

      expect(mockStore.getEdge).toHaveBeenCalledWith('e-test1')
      expect(mockStore.deleteEdge).toHaveBeenCalledWith('e-test1')
    })

    it('should mark both nodes dirty when edge exists', async () => {
      await client.request('graph.deleteEdge', { id: 'e-test1' })

      const dirty = flushManager.getDirtyNodes()
      expect(dirty).toContain('t-test1')
      expect(dirty).toContain('c-test1')
    })

    it('should throw when id missing', async () => {
      await expect(
        client.request('graph.deleteEdge', {})
      ).rejects.toThrow()
    })
  })

  describe('flush', () => {
    it('should force immediate flush', async () => {
      // Mark some nodes dirty first
      flushManager.markDirty('c-test1')
      flushManager.markDirty('t-test1')

      const result = await client.request<{ success: boolean }>('flush')

      expect(result.success).toBe(true)
      expect(flushedNodeIds.length).toBeGreaterThan(0)
    })
  })
})
