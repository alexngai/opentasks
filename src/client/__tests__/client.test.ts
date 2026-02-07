/**
 * Tests for OpenTasks Client
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { OpenTasksClient, ClientError, createClient } from '../client.js'
import { createIPCServer, type IPCServer } from '../../daemon/ipc.js'
import { registerToolsMethods } from '../../daemon/methods/tools.js'
import { createDaemonFlushManager, type DaemonFlushManager } from '../../daemon/flush.js'
import type { GraphStore } from '../../graph/store.js'
import type { LinkResult, QueryResult, AnnotateResult } from '../../tools/types.js'
import type { LocationResolver, LocationState } from '../../daemon/location-state.js'

describe('OpenTasksClient', () => {
  let tempDir: string
  let socketPath: string
  let server: IPCServer
  let mockStore: GraphStore
  let flushManager: DaemonFlushManager
  let nodeCounter: number
  let edgeCounter: number

  // Sample data
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

  const sampleFeedback = {
    id: 'f-test1',
    uuid: 'uuid-3',
    type: 'feedback' as const,
    title: 'Test Feedback',
    target_id: 's-test1',
    feedback_type: 'comment' as const,
    resolved: false,
    dismissed: false,
    content: 'This is test feedback',
    priority: 0,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const sampleEdge = {
    id: 'x-test1',
    uuid: 'uuid-4',
    from_id: 'i-test1',
    to_id: 's-test1',
    type: 'implements' as const,
    created_at: '2024-01-01T00:00:00Z',
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-client-test-'))
    socketPath = path.join(tempDir, 'daemon.sock')

    nodeCounter = 0
    edgeCounter = 0

    // Create mock store
    const nodes = new Map<string, any>()
    nodes.set(sampleSpec.id, { ...sampleSpec })
    nodes.set(sampleIssue.id, { ...sampleIssue })
    nodes.set(sampleFeedback.id, { ...sampleFeedback })

    const edges = new Map<string, any>()
    edges.set(sampleEdge.id, { ...sampleEdge })

    mockStore = {
      getNode: vi.fn().mockImplementation(async (id: string) => {
        return nodes.get(id) || null
      }),
      createNode: vi.fn().mockImplementation(async (input: any) => {
        const node = {
          ...input,
          id: `f-new${++nodeCounter}`,
          uuid: `uuid-new${nodeCounter}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        nodes.set(node.id, node)
        return node
      }),
      updateNode: vi.fn().mockImplementation(async (id: string, updates: any) => {
        const existing = nodes.get(id)
        if (!existing) throw new Error('Node not found')
        const updated = { ...existing, ...updates }
        nodes.set(id, updated)
        return updated
      }),
      createEdge: vi.fn().mockImplementation(async (input: any) => {
        const edge = {
          ...input,
          id: `x-new${++edgeCounter}`,
          uuid: `uuid-edge${edgeCounter}`,
          created_at: new Date().toISOString(),
        }
        edges.set(edge.id, edge)
        return edge
      }),
      deleteEdge: vi.fn().mockImplementation(async (id: string) => {
        edges.delete(id)
      }),
      getEdge: vi.fn().mockImplementation(async (id: string) => {
        return edges.get(id) || null
      }),
      query: {
        nodes: vi.fn().mockResolvedValue([sampleSpec, sampleIssue]),
        edges: vi.fn().mockResolvedValue([sampleEdge]),
        ready: vi.fn().mockResolvedValue([sampleIssue]),
        blockers: vi.fn().mockResolvedValue([sampleSpec]),
        blocking: vi.fn().mockResolvedValue([sampleIssue]),
        feedback: vi.fn().mockResolvedValue([sampleFeedback]),
      },
    } as unknown as GraphStore

    // Create flush manager
    flushManager = createDaemonFlushManager(
      { debounceMs: 100, maxDelayMs: 500 },
      async () => {
        // No-op for tests
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
    registerToolsMethods({ server, locationResolver })

    await server.start()
  })

  afterEach(async () => {
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

  describe('connection lifecycle', () => {
    it('should connect to daemon', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.connect()

      expect(client.connected).toBe(true)

      client.disconnect()
    })

    it('should disconnect cleanly', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.connect()
      expect(client.connected).toBe(true)

      client.disconnect()
      expect(client.connected).toBe(false)
    })

    it('should auto-connect on first request', async () => {
      const client = new OpenTasksClient({ socketPath, autoConnect: true })

      expect(client.connected).toBe(false)

      // First request should auto-connect
      await client.query({ nodes: {} })

      expect(client.connected).toBe(true)

      client.disconnect()
    })

    it('should throw when not connected and autoConnect=false', async () => {
      const client = new OpenTasksClient({ socketPath, autoConnect: false })

      await expect(client.query({ nodes: {} })).rejects.toThrow(ClientError)
      await expect(client.query({ nodes: {} })).rejects.toThrow('Not connected')
    })

    it('should not reconnect if already connected', async () => {
      const client = new OpenTasksClient({ socketPath })

      await client.connect()
      await client.connect() // Should be a no-op

      expect(client.connected).toBe(true)

      client.disconnect()
    })

    it('should handle disconnect when not connected', () => {
      const client = new OpenTasksClient({ socketPath })

      // Should not throw
      client.disconnect()
      expect(client.connected).toBe(false)
    })
  })

  describe('link()', () => {
    it('should create an edge', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.link({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
      })

      expect(result.success).toBe(true)
      expect(result.edgeId).toBeDefined()

      client.disconnect()
    })

    it('should remove an edge', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.link({
        fromId: 'i-test1',
        toId: 's-test1',
        type: 'implements',
        remove: true,
      })

      expect(result.success).toBe(true)

      client.disconnect()
    })
  })

  describe('query()', () => {
    it('should query nodes', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.query({ nodes: {} })

      expect(result.items).toBeDefined()
      expect(result.items.length).toBeGreaterThan(0)

      client.disconnect()
    })

    it('should query edges', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.query({ edges: {} })

      expect(result.items).toBeDefined()

      client.disconnect()
    })

    it('should respect verbose flag', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.query({ nodes: {}, verbose: true })

      const item = result.items[0] as any
      expect(item.uuid).toBeDefined()

      client.disconnect()
    })

    it('should respect pagination', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.query({ nodes: {}, limit: 1 })

      expect(result.items).toHaveLength(1)
      expect(result.hasMore).toBe(true)

      client.disconnect()
    })
  })

  describe('annotate()', () => {
    it('should create feedback', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.annotate({
        targetId: 's-test1',
        create: { content: 'New feedback' },
      })

      expect(result.success).toBe(true)
      expect(result.feedbackId).toBeDefined()

      client.disconnect()
    })

    it('should resolve feedback', async () => {
      const client = new OpenTasksClient({ socketPath })

      const result = await client.annotate({
        targetId: 's-test1',
        resolve: 'f-test1',
      })

      expect(result.success).toBe(true)

      client.disconnect()
    })
  })

  describe('convenience methods', () => {
    describe('ready()', () => {
      it('should return ready issues', async () => {
        const client = new OpenTasksClient({ socketPath })

        const result = await client.ready()

        expect(Array.isArray(result)).toBe(true)
        expect(mockStore.query.ready).toHaveBeenCalled()

        client.disconnect()
      })

      it('should pass options', async () => {
        const client = new OpenTasksClient({ socketPath })

        await client.ready({ priority: 1 })

        expect(mockStore.query.ready).toHaveBeenCalledWith(
          expect.objectContaining({ priority: 1 })
        )

        client.disconnect()
      })
    })

    describe('blockers()', () => {
      it('should return blocking nodes', async () => {
        const client = new OpenTasksClient({ socketPath })

        const result = await client.blockers('i-test1')

        expect(Array.isArray(result)).toBe(true)
        expect(mockStore.query.blockers).toHaveBeenCalledWith('i-test1', expect.any(Object))

        client.disconnect()
      })

      it('should pass options', async () => {
        const client = new OpenTasksClient({ socketPath })

        await client.blockers('i-test1', { transitive: true })

        expect(mockStore.query.blockers).toHaveBeenCalledWith('i-test1', {
          transitive: true,
          activeOnly: undefined,
        })

        client.disconnect()
      })
    })

    describe('blocking()', () => {
      it('should return blocked nodes', async () => {
        const client = new OpenTasksClient({ socketPath })

        const result = await client.blocking('s-test1')

        expect(Array.isArray(result)).toBe(true)
        expect(mockStore.query.blocking).toHaveBeenCalledWith('s-test1', expect.any(Object))

        client.disconnect()
      })
    })

    describe('feedback()', () => {
      it('should return feedback for node', async () => {
        const client = new OpenTasksClient({ socketPath })

        const result = await client.feedback('s-test1')

        expect(Array.isArray(result)).toBe(true)
        expect(mockStore.query.feedback).toHaveBeenCalledWith('s-test1', expect.any(Object))

        client.disconnect()
      })

      it('should pass options', async () => {
        const client = new OpenTasksClient({ socketPath })

        await client.feedback('s-test1', { type: 'suggestion', resolved: true })

        expect(mockStore.query.feedback).toHaveBeenCalledWith('s-test1', {
          type: 'suggestion',
          resolved: true,
          includeDismissed: undefined,
        })

        client.disconnect()
      })
    })
  })

  describe('createClient factory', () => {
    it('should create a client instance', async () => {
      const client = createClient({ socketPath })

      expect(client).toBeInstanceOf(OpenTasksClient)

      await client.connect()
      expect(client.connected).toBe(true)

      client.disconnect()
    })
  })

  describe('error handling', () => {
    it('should throw ClientError on connection failure', async () => {
      const client = new OpenTasksClient({
        socketPath: '/nonexistent/path/daemon.sock',
        autoConnect: false,
      })

      await expect(client.connect()).rejects.toThrow(ClientError)
      await expect(client.connect()).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
      })
    })
  })
})
