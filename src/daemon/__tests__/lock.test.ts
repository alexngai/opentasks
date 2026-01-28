/**
 * Tests for Lock Manager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createLockManager, type LockManager } from '../lock.js'
import { DaemonError, type LockMetadata } from '../types.js'

describe('LockManager', () => {
  let tempDir: string
  let locationPath: string
  let lockManager: LockManager

  const testMetadata: LockMetadata = {
    version: '1.0.0',
    socketPath: '/tmp/test.sock',
    databasePath: '/tmp/test.db',
  }

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-lock-test-'))
    locationPath = path.join(tempDir, '.opentasks')
    await fs.mkdir(locationPath, { recursive: true })
    lockManager = createLockManager(locationPath)
  })

  afterEach(async () => {
    // Release lock if held
    try {
      await lockManager.release()
    } catch {
      // Ignore if not held
    }

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('acquire', () => {
    it('should acquire lock when none exists', async () => {
      await lockManager.acquire(testMetadata)

      const lock = await lockManager.read()
      expect(lock).not.toBeNull()
      expect(lock!.pid).toBe(process.pid)
      expect(lock!.version).toBe(testMetadata.version)
      expect(lock!.socketPath).toBe(testMetadata.socketPath)
    })

    it('should write all metadata to lock file', async () => {
      await lockManager.acquire(testMetadata)

      const lock = await lockManager.read()
      expect(lock).not.toBeNull()
      expect(lock!.pid).toBe(process.pid)
      expect(lock!.parentPid).toBe(process.ppid)
      expect(lock!.version).toBe(testMetadata.version)
      expect(lock!.socketPath).toBe(testMetadata.socketPath)
      expect(lock!.databasePath).toBe(testMetadata.databasePath)
      expect(lock!.startedAt).toBeTruthy()
      // Verify startedAt is valid ISO date
      expect(() => new Date(lock!.startedAt)).not.toThrow()
    })

    it('should throw when acquiring lock twice from same process', async () => {
      await lockManager.acquire(testMetadata)

      await expect(lockManager.acquire(testMetadata)).rejects.toThrow(DaemonError)
      await expect(lockManager.acquire(testMetadata)).rejects.toMatchObject({
        code: 'LOCK_HELD',
      })
    })

    it('should create location directory if missing', async () => {
      const newLocation = path.join(tempDir, 'new-location', '.opentasks')
      const newManager = createLockManager(newLocation)

      await newManager.acquire(testMetadata)

      const exists = await fs.access(newLocation).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      await newManager.release()
    })

    it('should steal stale lock from dead process', async () => {
      // Write a fake lock file with non-existent PID
      const staleLock = {
        pid: 999999999, // Very unlikely to be a real PID
        parentPid: 1,
        version: '0.0.1',
        startedAt: new Date().toISOString(),
        socketPath: '/tmp/old.sock',
        databasePath: '/tmp/old.db',
      }
      const lockPath = path.join(locationPath, 'daemon.lock')
      await fs.writeFile(lockPath, JSON.stringify(staleLock), 'utf8')

      // Should be able to acquire despite stale lock
      await lockManager.acquire(testMetadata)

      const lock = await lockManager.read()
      expect(lock!.pid).toBe(process.pid)
    })
  })

  describe('release', () => {
    it('should release held lock', async () => {
      await lockManager.acquire(testMetadata)
      await lockManager.release()

      const lock = await lockManager.read()
      expect(lock).toBeNull()
    })

    it('should remove lock file on release', async () => {
      await lockManager.acquire(testMetadata)
      const lockPath = lockManager.lockPath

      await lockManager.release()

      const exists = await fs.access(lockPath).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('should throw when releasing unheld lock', async () => {
      await expect(lockManager.release()).rejects.toThrow(DaemonError)
      await expect(lockManager.release()).rejects.toMatchObject({
        code: 'LOCK_NOT_HELD',
      })
    })

    it('should allow re-acquiring after release', async () => {
      await lockManager.acquire(testMetadata)
      await lockManager.release()

      // Should be able to acquire again
      await lockManager.acquire(testMetadata)

      const lock = await lockManager.read()
      expect(lock!.pid).toBe(process.pid)
    })
  })

  describe('isHeld', () => {
    it('should return false when no lock exists', async () => {
      const held = await lockManager.isHeld()
      expect(held).toBe(false)
    })

    it('should return true when lock held by live process', async () => {
      await lockManager.acquire(testMetadata)

      const held = await lockManager.isHeld()
      expect(held).toBe(true)
    })

    it('should return false when lock held by dead process', async () => {
      // Write a fake lock file with non-existent PID
      const staleLock = {
        pid: 999999999,
        parentPid: 1,
        version: '0.0.1',
        startedAt: new Date().toISOString(),
        socketPath: '/tmp/old.sock',
        databasePath: '/tmp/old.db',
      }
      const lockPath = path.join(locationPath, 'daemon.lock')
      await fs.writeFile(lockPath, JSON.stringify(staleLock), 'utf8')

      const held = await lockManager.isHeld()
      expect(held).toBe(false)
    })

    it('should return false after release', async () => {
      await lockManager.acquire(testMetadata)
      await lockManager.release()

      const held = await lockManager.isHeld()
      expect(held).toBe(false)
    })
  })

  describe('read', () => {
    it('should return null when no lock file exists', async () => {
      const lock = await lockManager.read()
      expect(lock).toBeNull()
    })

    it('should return lock contents when file exists', async () => {
      await lockManager.acquire(testMetadata)

      const lock = await lockManager.read()
      expect(lock).not.toBeNull()
      expect(lock!.pid).toBe(process.pid)
    })

    it('should return null for invalid JSON', async () => {
      const lockPath = path.join(locationPath, 'daemon.lock')
      await fs.writeFile(lockPath, 'not valid json', 'utf8')

      const lock = await lockManager.read()
      expect(lock).toBeNull()
    })
  })

  describe('lockPath', () => {
    it('should return correct lock file path', () => {
      expect(lockManager.lockPath).toBe(path.join(locationPath, 'daemon.lock'))
    })
  })

  describe('concurrent access', () => {
    it('should prevent concurrent acquisition from different managers', async () => {
      const manager1 = createLockManager(locationPath)
      const manager2 = createLockManager(locationPath)

      await manager1.acquire(testMetadata)

      // Second manager should fail since first holds lock with our PID
      await expect(manager2.acquire(testMetadata)).rejects.toThrow(DaemonError)

      await manager1.release()
    })
  })
})
