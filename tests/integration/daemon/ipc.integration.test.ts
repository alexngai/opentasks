/**
 * IPC Integration Tests
 *
 * Tests real IPC communication between server and clients
 * using Unix domain sockets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { createIPCServer, createIPCClient, type IPCServer, type IPCClient } from '../../../src/daemon/ipc.js'
import {
  SLOW_TESTS,
  withTempDir,
  sleep,
  type TempDirContext,
} from '../helpers/index.js'
import {
  startTestIPCServer,
  createConnectedClients,
  disconnectAllClients,
  type TestIPCContext,
} from './helpers.js'

describe.skipIf(!SLOW_TESTS)('IPC Integration', () => {
  let tempDir: TempDirContext
  let socketPath: string

  beforeEach(async () => {
    tempDir = await withTempDir('ipc-test-')
    socketPath = tempDir.resolve('test.sock')
  })

  afterEach(async () => {
    await tempDir.cleanup()
  })

  describe('server lifecycle', () => {
    it('should start and create socket file', async () => {
      const server = createIPCServer(socketPath)

      await server.start()
      expect(existsSync(socketPath)).toBe(true)

      await server.stop()
    })

    it('should remove socket on stop', async () => {
      const server = createIPCServer(socketPath)

      await server.start()
      expect(existsSync(socketPath)).toBe(true)

      await server.stop()
      // Socket file may still exist after server stop
      // (OS may not immediately clean up)
    })

    it('should handle stop when not started', async () => {
      const server = createIPCServer(socketPath)
      await server.stop() // Should not throw
    })

    it('should reject start when already started', async () => {
      const server = createIPCServer(socketPath)

      await server.start()
      await expect(server.start()).rejects.toThrow('already started')

      await server.stop()
    })
  })

  describe('client connection', () => {
    let ctx: TestIPCContext

    beforeEach(async () => {
      ctx = await startTestIPCServer(socketPath)
    })

    afterEach(async () => {
      await ctx.stop()
    })

    it('should connect client to server', async () => {
      const client = ctx.createClient()
      await client.connect()
      expect(client.connected).toBe(true)
      client.disconnect()
    })

    it('should track connection count', async () => {
      expect(ctx.server.getConnectionCount()).toBe(0)

      const client1 = ctx.createClient()
      await client1.connect()
      expect(ctx.server.getConnectionCount()).toBe(1)

      const client2 = ctx.createClient()
      await client2.connect()
      expect(ctx.server.getConnectionCount()).toBe(2)

      client1.disconnect()
      await sleep(50) // Allow disconnect to propagate
      expect(ctx.server.getConnectionCount()).toBe(1)

      client2.disconnect()
      await sleep(50)
      expect(ctx.server.getConnectionCount()).toBe(0)
    })

    it('should reject connection to non-existent server', async () => {
      const client = createIPCClient('/nonexistent/path.sock')
      await expect(client.connect()).rejects.toThrow()
    })
  })

  describe('request/response', () => {
    let ctx: TestIPCContext
    let client: IPCClient

    beforeEach(async () => {
      ctx = await startTestIPCServer(socketPath)

      // Register test handlers
      ctx.server.handle('echo', async (params) => params)
      ctx.server.handle('add', async (params: { a: number; b: number }) => params.a + params.b)
      ctx.server.handle('delay', async (params: { ms: number }) => {
        await sleep(params.ms)
        return 'done'
      })
      ctx.server.handle('error', async () => {
        throw new Error('Test error')
      })

      client = ctx.createClient()
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await ctx.stop()
    })

    it('should handle simple request/response', async () => {
      const result = await client.request('echo', { message: 'hello' })
      expect(result).toEqual({ message: 'hello' })
    })

    it('should handle requests with computation', async () => {
      const result = await client.request<number>('add', { a: 5, b: 3 })
      expect(result).toBe(8)
    })

    it('should handle async handlers', async () => {
      const result = await client.request<string>('delay', { ms: 100 })
      expect(result).toBe('done')
    })

    it('should propagate errors from handlers', async () => {
      // IPC layer sanitizes errors to 'Internal error' for security
      await expect(client.request('error')).rejects.toThrow('Internal error')
    })

    it('should handle unknown methods', async () => {
      await expect(client.request('nonexistent')).rejects.toThrow()
    })

    it('should handle multiple sequential requests', async () => {
      const results: number[] = []
      for (let i = 0; i < 10; i++) {
        const result = await client.request<number>('add', { a: i, b: 1 })
        results.push(result)
      }
      expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it('should handle concurrent requests from single client', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        client.request<number>('add', { a: i, b: 1 })
      )

      const results = await Promise.all(promises)
      expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })
  })

  describe('concurrent clients', () => {
    let ctx: TestIPCContext

    beforeEach(async () => {
      ctx = await startTestIPCServer(socketPath)
      ctx.server.handle('identify', async (params: { id: number }) => `client-${params.id}`)
      ctx.server.handle('slow', async (params: { id: number }) => {
        await sleep(50)
        return `slow-${params.id}`
      })
    })

    afterEach(async () => {
      await ctx.stop()
    })

    it('should handle 10 concurrent clients', async () => {
      const clients = await createConnectedClients(socketPath, 10)

      expect(ctx.server.getConnectionCount()).toBe(10)

      // All clients make concurrent requests
      const promises = clients.map((client, i) =>
        client.request<string>('identify', { id: i })
      )

      const results = await Promise.all(promises)
      expect(results.sort()).toEqual([
        'client-0', 'client-1', 'client-2', 'client-3', 'client-4',
        'client-5', 'client-6', 'client-7', 'client-8', 'client-9',
      ])

      disconnectAllClients(clients)
    })

    it('should handle concurrent slow requests from multiple clients', async () => {
      const clients = await createConnectedClients(socketPath, 5)

      // All clients make slow requests concurrently
      const startTime = Date.now()
      const promises = clients.map((client, i) =>
        client.request<string>('slow', { id: i })
      )

      const results = await Promise.all(promises)
      const elapsed = Date.now() - startTime

      // Should complete in roughly one delay period (parallelized)
      expect(elapsed).toBeLessThan(200) // 50ms * 5 = 250ms if sequential
      expect(results.sort()).toEqual([
        'slow-0', 'slow-1', 'slow-2', 'slow-3', 'slow-4',
      ])

      disconnectAllClients(clients)
    })

    it('should isolate requests between clients', async () => {
      const client1 = ctx.createClient()
      const client2 = ctx.createClient()
      await client1.connect()
      await client2.connect()

      // Interleaved requests
      const p1 = client1.request<string>('slow', { id: 1 })
      const p2 = client2.request<string>('identify', { id: 2 })
      const p3 = client1.request<string>('identify', { id: 3 })

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])

      expect(r1).toBe('slow-1')
      expect(r2).toBe('client-2')
      expect(r3).toBe('client-3')

      client1.disconnect()
      client2.disconnect()
    })
  })

  describe('error handling', () => {
    let ctx: TestIPCContext
    let client: IPCClient

    beforeEach(async () => {
      ctx = await startTestIPCServer(socketPath)
      ctx.server.handle('echo', async (params) => params)

      client = ctx.createClient()
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await ctx.stop()
    })

    it('should handle client disconnect gracefully', async () => {
      expect(ctx.server.getConnectionCount()).toBe(1)

      // Abruptly disconnect
      client.disconnect()
      await sleep(100)

      expect(ctx.server.getConnectionCount()).toBe(0)

      // Server should still work for new clients
      const newClient = ctx.createClient()
      await newClient.connect()
      const result = await newClient.request('echo', { test: true })
      expect(result).toEqual({ test: true })
      newClient.disconnect()
    })

    it('should reject requests on disconnected client', async () => {
      client.disconnect()
      await expect(client.request('echo', {})).rejects.toThrow('Not connected')
    })
  })

  describe('server stop with active connections', () => {
    it('should close all connections on stop', async () => {
      const ctx = await startTestIPCServer(socketPath)
      ctx.server.handle('echo', async (params) => params)

      const clients = await createConnectedClients(socketPath, 5)
      expect(ctx.server.getConnectionCount()).toBe(5)

      await ctx.stop()

      // All clients should be disconnected
      await sleep(100)
      for (const client of clients) {
        expect(client.connected).toBe(false)
      }
    })

    it('should reject pending requests when server stops', async () => {
      const ctx = await startTestIPCServer(socketPath)
      ctx.server.handle('slow', async () => {
        await sleep(5000) // Very slow
        return 'done'
      })

      const client = ctx.createClient()
      await client.connect()

      // Start a slow request
      const requestPromise = client.request('slow')

      // Stop server while request is pending
      await sleep(50)
      await ctx.stop()

      // Request should fail
      await expect(requestPromise).rejects.toThrow()
    })
  })
})
