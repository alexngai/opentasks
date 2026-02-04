/**
 * Daemon Lifecycle Integration Tests
 *
 * Tests real daemon startup, shutdown, lock management,
 * and registry operations with actual file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import {
  checkExistingDaemon,
} from '../../../src/daemon/lifecycle.js'
import { createRegistryManager } from '../../../src/daemon/registry.js'
import {
  SLOW_TESTS,
  withTempDir,
  sleep,
  type TempDirContext,
} from '../helpers/index.js'
import { createTestDaemon, type TestDaemonOptions } from './helpers.js'

describe.skipIf(!SLOW_TESTS)('Daemon Lifecycle Integration', () => {
  let tempDir: TempDirContext
  let locationPath: string
  let registryPath: string

  beforeEach(async () => {
    tempDir = await withTempDir('daemon-lifecycle-')
    locationPath = tempDir.resolve('.opentasks')
    registryPath = tempDir.resolve('registry.json')
    await mkdir(locationPath, { recursive: true })
  })

  afterEach(async () => {
    await tempDir.cleanup()
  })

  describe('daemon startup', () => {
    it('should start successfully with valid config', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()

      const status = daemon.getStatus()
      expect(status.state).toBe('running')
      expect(status.pid).toBe(process.pid)
      expect(status.socketPath).toBe(path.join(locationPath, 'daemon.sock'))

      await daemon.stop()
    })

    it('should create lock file on start', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()

      const lockPath = path.join(locationPath, 'daemon.lock')
      expect(existsSync(lockPath)).toBe(true)

      const lockContents = JSON.parse(await readFile(lockPath, 'utf8'))
      expect(lockContents.pid).toBe(process.pid)
      expect(lockContents.socketPath).toBe(daemon.socketPath)

      await daemon.stop()
    })

    it('should register in global registry on start', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()

      const registryContents = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(registryContents.daemons).toHaveLength(1)
      expect(registryContents.daemons[0].locationPath).toBe(locationPath)
      expect(registryContents.daemons[0].pid).toBe(process.pid)

      await daemon.stop()
    })

    it('should reject start when already running', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()
      await expect(daemon.start()).rejects.toThrow('already')

      await daemon.stop()
    })

    it('should detect existing lock via checkExistingDaemon', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      // Before start, no daemon running
      let result = await checkExistingDaemon(locationPath)
      expect(result.running).toBe(false)

      await daemon.start()

      // After start, daemon is running
      result = await checkExistingDaemon(locationPath)
      expect(result.running).toBe(true)
      expect(result.pid).toBe(process.pid)
      expect(result.socketPath).toBe(daemon.socketPath)

      await daemon.stop()

      // After stop, no daemon running
      result = await checkExistingDaemon(locationPath)
      expect(result.running).toBe(false)
    })
  })

  describe('daemon shutdown', () => {
    it('should stop gracefully', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()
      expect(daemon.getStatus().state).toBe('running')

      await daemon.stop()
      expect(daemon.getStatus().state).toBe('stopped')
    })

    it('should release lock on stop', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()
      const lockPath = path.join(locationPath, 'daemon.lock')
      expect(existsSync(lockPath)).toBe(true)

      await daemon.stop()

      // Lock file should be removed
      expect(existsSync(lockPath)).toBe(false)
    })

    it('should unregister from global registry on stop', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()

      let registryContents = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(registryContents.daemons).toHaveLength(1)

      await daemon.stop()

      registryContents = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(registryContents.daemons).toHaveLength(0)
    })

    it('should handle stop when not started', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      // Should not throw
      await daemon.stop()
      expect(daemon.getStatus().state).toBe('stopped')
    })

    it('should handle multiple stop calls', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()
      await daemon.stop()
      await daemon.stop() // Should not throw
      await daemon.stop()

      expect(daemon.getStatus().state).toBe('stopped')
    })
  })

  describe('stale lock recovery', () => {
    it('should recover from stale lock file (dead PID)', async () => {
      // Create a lock file with a dead PID
      const lockPath = path.join(locationPath, 'daemon.lock')
      const staleLock = {
        pid: 99999, // Likely dead PID
        parentPid: 1,
        startedAt: new Date().toISOString(),
        version: '0.0.1',
        socketPath: path.join(locationPath, 'daemon.sock'),
        databasePath: path.join(locationPath, 'cache.db'),
      }
      await writeFile(lockPath, JSON.stringify(staleLock, null, 2))

      // New daemon should be able to start
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()
      expect(daemon.getStatus().state).toBe('running')

      await daemon.stop()
    })

    it('should detect stale daemon via checkExistingDaemon', async () => {
      // Create a lock file with a dead PID
      const lockPath = path.join(locationPath, 'daemon.lock')
      const staleLock = {
        pid: 99999,
        parentPid: 1,
        startedAt: new Date().toISOString(),
        version: '0.0.1',
        socketPath: path.join(locationPath, 'daemon.sock'),
        databasePath: path.join(locationPath, 'cache.db'),
      }
      await writeFile(lockPath, JSON.stringify(staleLock, null, 2))

      const result = await checkExistingDaemon(locationPath)
      expect(result.running).toBe(false)
    })
  })

  describe('registry operations', () => {
    it('should support multiple daemons in registry', async () => {
      // Create two separate locations
      const location1 = tempDir.resolve('.opentasks1')
      const location2 = tempDir.resolve('.opentasks2')
      await mkdir(location1, { recursive: true })
      await mkdir(location2, { recursive: true })

      const daemon1 = createTestDaemon({
        locationPath: location1,
        registryPath,
      })
      const daemon2 = createTestDaemon({
        locationPath: location2,
        registryPath,
      })

      await daemon1.start()
      await daemon2.start()

      const registryContents = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(registryContents.daemons).toHaveLength(2)

      const locations = registryContents.daemons.map((d: any) => d.locationPath)
      expect(locations).toContain(location1)
      expect(locations).toContain(location2)

      await daemon1.stop()
      await daemon2.stop()
    })

    it('should cleanup stale registry entries', async () => {
      // Manually add a stale entry to registry
      const registryManager = createRegistryManager(registryPath)
      await registryManager.register({
        locationPath: '/fake/path/.opentasks',
        socketPath: '/fake/path/daemon.sock',
        pid: 99999, // Dead PID
        version: '0.0.1',
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      })

      // Verify stale entry exists
      let entries = await registryManager.list()
      expect(entries).toHaveLength(1)

      // Cleanup should remove it
      const removed = await registryManager.cleanup()
      expect(removed).toBe(1)

      entries = await registryManager.list()
      expect(entries).toHaveLength(0)
    })

    it('should find daemon by location', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon.start()

      const registryManager = createRegistryManager(registryPath)
      const entry = await registryManager.find(locationPath)

      expect(entry).not.toBeNull()
      expect(entry?.pid).toBe(process.pid)
      expect(entry?.locationPath).toBe(locationPath)

      await daemon.stop()
    })
  })

  describe('concurrent daemon attempts', () => {
    it('should only allow one daemon per location', async () => {
      const daemon1 = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon1.start()

      // Second daemon should fail
      const daemon2 = createTestDaemon({
        locationPath,
        registryPath,
      })

      await expect(daemon2.start()).rejects.toThrow('already running')

      await daemon1.stop()
    })

    it('should allow restart after clean shutdown', async () => {
      const daemon1 = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon1.start()
      await daemon1.stop()

      // Same location should be available now
      const daemon2 = createTestDaemon({
        locationPath,
        registryPath,
      })

      await daemon2.start()
      expect(daemon2.getStatus().state).toBe('running')

      await daemon2.stop()
    })
  })

  describe('daemon status', () => {
    it('should report correct status through lifecycle', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
      })

      // Initially stopped
      expect(daemon.getStatus().state).toBe('stopped')

      await daemon.start()

      // After start
      const runningStatus = daemon.getStatus()
      expect(runningStatus.state).toBe('running')
      expect(runningStatus.pid).toBe(process.pid)
      expect(runningStatus.startedAt).toBeTruthy()
      expect(runningStatus.socketPath).toBe(path.join(locationPath, 'daemon.sock'))

      await daemon.stop()

      // After stop
      expect(daemon.getStatus().state).toBe('stopped')
    })
  })

  describe('shutdown timeout', () => {
    it('should respect custom shutdown timeout', async () => {
      const daemon = createTestDaemon({
        locationPath,
        registryPath,
        shutdownTimeoutMs: 100,
      })

      await daemon.start()

      // Normal stop should complete well within timeout
      const start = Date.now()
      await daemon.stop()
      const elapsed = Date.now() - start

      // Should complete quickly (not hit timeout)
      expect(elapsed).toBeLessThan(100)
    })
  })
})
