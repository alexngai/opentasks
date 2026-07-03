/**
 * Tests for IPC Server
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createIPCServer, createIPCClient, type IPCServer, type IPCClient } from '../ipc.js';
import { registerLifecycleMethods } from '../methods/lifecycle.js';
import type { DaemonStatus } from '../types.js';

describe('IPCServer', () => {
  let tempDir: string;
  let socketPath: string;
  let server: IPCServer;
  let client: IPCClient;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-ipc-test-'));
    socketPath = path.join(tempDir, 'test.sock');
    server = createIPCServer(socketPath);
    client = createIPCClient(socketPath);
  });

  afterEach(async () => {
    // Cleanup
    try {
      client.disconnect();
    } catch {
      // Ignore
    }

    try {
      await server.stop();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('start/stop', () => {
    it('should start server on socket', async () => {
      await server.start();

      const exists = await fs
        .access(socketPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('should stop server and close connections', async () => {
      await server.start();
      await client.connect();

      await server.stop();

      // Wait for disconnect to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.connected).toBe(false);
    });

    it('should throw when starting twice', async () => {
      await server.start();

      await expect(server.start()).rejects.toThrow('Server already started');
    });

    it('should be idempotent for stop', async () => {
      await server.start();

      await server.stop();
      await server.stop();
      await server.stop();
    });

    it('should remove stale socket file on start', async () => {
      // Create stale socket file
      await fs.writeFile(socketPath, 'stale');

      await server.start();

      // Should be able to connect
      await client.connect();
      expect(client.connected).toBe(true);
    });
  });

  describe('handle', () => {
    it('should register method handler', async () => {
      server.handle('test', async () => ({ success: true }));
      await server.start();
      await client.connect();

      const result = await client.request('test');

      expect(result).toEqual({ success: true });
    });

    it('should pass params to handler', async () => {
      server.handle('echo', async (params: { message: string }) => {
        return { echo: params.message };
      });
      await server.start();
      await client.connect();

      const result = await client.request<{ echo: string }>('echo', { message: 'hello' });

      expect(result.echo).toBe('hello');
    });

    it('should handle async handlers', async () => {
      server.handle('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { done: true };
      });
      await server.start();
      await client.connect();

      const result = await client.request<{ done: boolean }>('slow');

      expect(result.done).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return method not found for unknown method', async () => {
      await server.start();
      await client.connect();

      await expect(client.request('unknown')).rejects.toThrow('Method not found');
    });

    it('should return detailed error for handler exceptions', async () => {
      server.handle('error', async () => {
        throw new Error('Test error');
      });
      await server.start();
      await client.connect();

      await expect(client.request('error')).rejects.toThrow('Test error');
    });
  });

  describe('connection tracking', () => {
    it('should track connection count', async () => {
      await server.start();

      expect(server.getConnectionCount()).toBe(0);

      await client.connect();
      expect(server.getConnectionCount()).toBe(1);

      const client2 = createIPCClient(socketPath);
      await client2.connect();
      expect(server.getConnectionCount()).toBe(2);

      client.disconnect();
      // Wait for disconnect to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.getConnectionCount()).toBe(1);

      client2.disconnect();
    });
  });

  describe('multiple requests', () => {
    it('should handle concurrent requests', async () => {
      server.handle('echo', async (params: { n: number }) => {
        return { n: params.n };
      });
      await server.start();
      await client.connect();

      const promises = Array.from({ length: 10 }, (_, i) =>
        client.request<{ n: number }>('echo', { n: i }),
      );

      const results = await Promise.all(promises);

      for (let i = 0; i < 10; i++) {
        expect(results[i].n).toBe(i);
      }
    });

    it('should handle requests from multiple clients', async () => {
      server.handle('whoami', async (params: { id: string }) => {
        return { id: params.id };
      });
      await server.start();

      const clients = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const c = createIPCClient(socketPath);
          await c.connect();
          return c;
        }),
      );

      const results = await Promise.all(
        clients.map((c, i) => c.request<{ id: string }>('whoami', { id: `client${i}` })),
      );

      expect(results[0].id).toBe('client0');
      expect(results[1].id).toBe('client1');
      expect(results[2].id).toBe('client2');

      for (const c of clients) {
        c.disconnect();
      }
    });
  });
});

describe('Lifecycle Methods', () => {
  let tempDir: string;
  let socketPath: string;
  let server: IPCServer;
  let client: IPCClient;
  let shutdownCalled: boolean;

  const testStatus: DaemonStatus = {
    state: 'running',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    socketPath: '/test/path',
    pendingFlush: false,
    connectionCount: 0,
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-lifecycle-ipc-test-'));
    socketPath = path.join(tempDir, 'test.sock');
    server = createIPCServer(socketPath);
    client = createIPCClient(socketPath);
    shutdownCalled = false;

    registerLifecycleMethods({
      server,
      getStatus: () => testStatus,
      shutdown: async () => {
        shutdownCalled = true;
      },
      version: '1.0.0',
      startedAt: new Date(),
    });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    try {
      client.disconnect();
    } catch {
      // Ignore
    }

    try {
      await server.stop();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('ping', () => {
    it('should return pong', async () => {
      const result = await client.request<{ pong: boolean }>('ping');

      expect(result.pong).toBe(true);
    });
  });

  describe('health', () => {
    it('should return health information', async () => {
      const result = await client.request<{
        status: string;
        uptime: number;
        memory: { heapUsed: number };
        version: string;
      }>('health');

      expect(result.status).toBe('healthy');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.memory.heapUsed).toBeGreaterThan(0);
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('status', () => {
    it('should return daemon status', async () => {
      const result = await client.request<DaemonStatus>('status');

      expect(result.state).toBe('running');
      expect(result.pid).toBe(process.pid);
    });
  });

  describe('shutdown', () => {
    it('should trigger shutdown handler', async () => {
      const result = await client.request<{ success: boolean }>('shutdown');

      expect(result.success).toBe(true);

      // Wait for setImmediate to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(shutdownCalled).toBe(true);
    });
  });
});

describe('IPCClient', () => {
  let tempDir: string;
  let socketPath: string;
  let server: IPCServer;
  let client: IPCClient;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-client-test-'));
    socketPath = path.join(tempDir, 'test.sock');
    server = createIPCServer(socketPath);
    client = createIPCClient(socketPath);
  });

  afterEach(async () => {
    try {
      client.disconnect();
    } catch {
      // Ignore
    }

    try {
      await server.stop();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('connect', () => {
    it('should connect to server', async () => {
      await server.start();

      await client.connect();

      expect(client.connected).toBe(true);
    });

    it('should throw when connecting to non-existent socket', async () => {
      await expect(client.connect()).rejects.toThrow();
    });

    it('should throw when connecting twice', async () => {
      await server.start();
      await client.connect();

      await expect(client.connect()).rejects.toThrow('Already connected');
    });
  });

  describe('disconnect', () => {
    it('should disconnect from server', async () => {
      await server.start();
      await client.connect();

      client.disconnect();

      expect(client.connected).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('request', () => {
    it('should throw when not connected', async () => {
      await expect(client.request('test')).rejects.toThrow('Not connected');
    });
  });
});
