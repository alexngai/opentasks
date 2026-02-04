/**
 * Tests for Daemon Lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createDaemon,
  checkExistingDaemon,
  type Daemon,
  type DaemonConfig,
} from '../lifecycle.js'
import { createLockManager } from '../lock.js'
import { createRegistryManager } from '../registry.js'
import { DaemonError } from '../types.js'

describe('Daemon Lifecycle', () => {
  let tempDir: string
  let locationPath: string
  let registryPath: string
  let daemon: Daemon | null

  const createTestConfig = (overrides: Partial<DaemonConfig> = {}): DaemonConfig => ({
    locationPath,
    version: '1.0.0',
    registryPath,
    shutdownTimeoutMs: 1000,
    ...overrides,
  })

  beforeEach(async () => {
    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-lifecycle-test-'))
    locationPath = path.join(tempDir, '.opentasks')
    registryPath = path.join(tempDir, 'registry', 'registry.json')
    await fs.mkdir(locationPath, { recursive: true })

    daemon = null
  })

  afterEach(async () => {
    // Stop daemon if running
    if (daemon) {
      try {
        await daemon.stop()
      } catch {
        // Ignore stop errors in cleanup
      }
      daemon = null
    }

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('checkExistingDaemon', () => {
    it('should return running: false when no daemon exists', async () => {
      const result = await checkExistingDaemon(locationPath)

      expect(result.running).toBe(false)
      expect(result.socketPath).toBeUndefined()
      expect(result.pid).toBeUndefined()
    })

    it('should return running: true when daemon lock is held', async () => {
      // Start a daemon
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      const result = await checkExistingDaemon(locationPath)

      expect(result.running).toBe(true)
      expect(result.socketPath).toBe(daemon.socketPath)
      expect(result.pid).toBe(process.pid)
    })

    it('should return running: false for stale lock', async () => {
      // Create a stale lock file manually
      const lockManager = createLockManager(locationPath)
      const lockPath = lockManager.lockPath
      const staleLock = {
        pid: 999999999, // Non-existent PID
        parentPid: 1,
        version: '0.0.1',
        startedAt: new Date().toISOString(),
        socketPath: '/tmp/stale.sock',
        databasePath: '/tmp/stale.db',
      }
      await fs.writeFile(lockPath, JSON.stringify(staleLock), 'utf8')

      const result = await checkExistingDaemon(locationPath)

      expect(result.running).toBe(false)
    })
  })

  describe('createDaemon', () => {
    it('should create daemon with correct paths', () => {
      daemon = createDaemon(createTestConfig())

      expect(daemon.socketPath).toBe(path.join(locationPath, 'daemon.sock'))
      expect(daemon.locationPath).toBe(locationPath)
    })

    it('should start in stopped state', () => {
      daemon = createDaemon(createTestConfig())

      const status = daemon.getStatus()
      expect(status.state).toBe('stopped')
    })
  })

  describe('start', () => {
    it('should start daemon and acquire lock', async () => {
      daemon = createDaemon(createTestConfig())

      await daemon.start()

      const status = daemon.getStatus()
      expect(status.state).toBe('running')
      expect(status.pid).toBe(process.pid)
    })

    it('should register in global registry', async () => {
      daemon = createDaemon(createTestConfig())
      const registryManager = createRegistryManager(registryPath)

      await daemon.start()

      const entry = await registryManager.find(locationPath)
      expect(entry).not.toBeNull()
      expect(entry!.pid).toBe(process.pid)
      expect(entry!.socketPath).toBe(daemon.socketPath)
    })

    it('should set startedAt timestamp', async () => {
      daemon = createDaemon(createTestConfig())
      const beforeStart = new Date().toISOString()

      await daemon.start()

      const status = daemon.getStatus()
      expect(status.startedAt).toBeTruthy()
      expect(status.startedAt >= beforeStart).toBe(true)
    })

    it('should throw when daemon already running', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      await expect(daemon.start()).rejects.toThrow(DaemonError)
      await expect(daemon.start()).rejects.toMatchObject({
        code: 'DAEMON_ALREADY_RUNNING',
      })
    })

    it('should throw when another daemon holds lock', async () => {
      // Start first daemon
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      // Try to start second daemon for same location
      const daemon2 = createDaemon(createTestConfig())

      await expect(daemon2.start()).rejects.toThrow(DaemonError)
      await expect(daemon2.start()).rejects.toMatchObject({
        code: 'DAEMON_ALREADY_RUNNING',
      })
    })

    it('should clean up stale socket file', async () => {
      // Create stale socket file
      const socketPath = path.join(locationPath, 'daemon.sock')
      await fs.writeFile(socketPath, 'stale', 'utf8')

      daemon = createDaemon(createTestConfig())
      await daemon.start()

      // Socket file should be removed (it will be recreated by IPC server later)
      const exists = await fs.access(socketPath).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })
  })

  describe('stop', () => {
    it('should stop running daemon', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      await daemon.stop()

      const status = daemon.getStatus()
      expect(status.state).toBe('stopped')
    })

    it('should release lock on stop', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      await daemon.stop()

      const lockManager = createLockManager(locationPath)
      const isHeld = await lockManager.isHeld()
      expect(isHeld).toBe(false)
    })

    it('should unregister from global registry on stop', async () => {
      daemon = createDaemon(createTestConfig())
      const registryManager = createRegistryManager(registryPath)

      await daemon.start()
      await daemon.stop()

      const entry = await registryManager.find(locationPath)
      expect(entry).toBeNull()
    })

    it('should be idempotent (multiple stops ok)', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      await daemon.stop()
      await daemon.stop()
      await daemon.stop()

      const status = daemon.getStatus()
      expect(status.state).toBe('stopped')
    })

    it('should not fail when already stopped', async () => {
      daemon = createDaemon(createTestConfig())

      // Never started, so already stopped
      await expect(daemon.stop()).resolves.not.toThrow()
    })

    it('should clear startedAt on stop', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      await daemon.stop()

      const status = daemon.getStatus()
      expect(status.startedAt).toBe('')
    })
  })

  describe('getStatus', () => {
    it('should return correct status when stopped', () => {
      daemon = createDaemon(createTestConfig())

      const status = daemon.getStatus()

      expect(status.state).toBe('stopped')
      expect(status.pid).toBe(process.pid)
      expect(status.socketPath).toBe(path.join(locationPath, 'daemon.sock'))
      expect(status.startedAt).toBe('')
      expect(status.pendingFlush).toBe(false)
      expect(status.connectionCount).toBe(0)
    })

    it('should return correct status when running', async () => {
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      const status = daemon.getStatus()

      expect(status.state).toBe('running')
      expect(status.startedAt).toBeTruthy()
    })
  })

  describe('restart scenario', () => {
    it('should allow restart after stop', async () => {
      daemon = createDaemon(createTestConfig())

      await daemon.start()
      expect(daemon.getStatus().state).toBe('running')

      await daemon.stop()
      expect(daemon.getStatus().state).toBe('stopped')

      await daemon.start()
      expect(daemon.getStatus().state).toBe('running')
    })
  })

  describe('error handling', () => {
    it('should clean up on start failure', async () => {
      // Start first daemon to hold lock
      daemon = createDaemon(createTestConfig())
      await daemon.start()

      // Second daemon should fail but not leave partial state
      const daemon2 = createDaemon(createTestConfig())
      await expect(daemon2.start()).rejects.toThrow()

      // daemon2 should be in stopped state
      expect(daemon2.getStatus().state).toBe('stopped')
    })
  })

  describe('OpenTasksConfig integration', () => {
    it('should use custom socket path from config', () => {
      daemon = createDaemon(
        createTestConfig({
          openTasksConfig: {
            daemon: { socketPath: 'custom.sock' },
          },
        })
      )

      expect(daemon.socketPath).toBe(path.join(locationPath, 'custom.sock'))
    })

    it('should use default socket path when config not provided', () => {
      daemon = createDaemon(createTestConfig())

      expect(daemon.socketPath).toBe(path.join(locationPath, 'daemon.sock'))
    })

    it('should use default socket path when daemon config is partial', () => {
      daemon = createDaemon(
        createTestConfig({
          openTasksConfig: {
            storage: { jsonlPath: 'custom.jsonl' },
          },
        })
      )

      expect(daemon.socketPath).toBe(path.join(locationPath, 'daemon.sock'))
    })
  })
})
