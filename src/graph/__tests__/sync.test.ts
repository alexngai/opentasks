/**
 * Tests for Sync Manager
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest'
import { createSyncManager, type SyncManager, type SyncConfig, type FlushCallback } from '../sync.js'
import type { Storage } from '../../storage/interface.js'

describe('SyncManager', () => {
  let storage: Storage
  let syncManager: SyncManager
  let flushCallback: Mock<FlushCallback>

  const config: SyncConfig = {
    debounceMs: 100,
    maxDelayMs: 500,
  }

  beforeEach(() => {
    vi.useFakeTimers()

    // Create mock storage
    const dirtyNodes = new Set<string>()
    storage = {
      markDirty: vi.fn().mockImplementation(async (nodeId: string) => {
        dirtyNodes.add(nodeId)
      }),
      getDirtyNodes: vi.fn().mockImplementation(async () => {
        return Array.from(dirtyNodes)
      }),
      clearDirty: vi.fn().mockImplementation(async (nodeIds: string[]) => {
        for (const id of nodeIds) {
          dirtyNodes.delete(id)
        }
      }),
    } as unknown as Storage

    flushCallback = vi.fn<FlushCallback>().mockResolvedValue(undefined)
    syncManager = createSyncManager(config, storage, flushCallback)
  })

  afterEach(() => {
    vi.useRealTimers()
    syncManager.cancel()
  })

  describe('markDirty', () => {
    it('should track dirty nodes', () => {
      syncManager.markDirty('s-abc1')
      syncManager.markDirty('s-abc2')

      expect(syncManager.hasPendingChanges()).toBe(true)
    })
  })

  describe('scheduleFlush', () => {
    it('should flush after debounce delay', async () => {
      syncManager.markDirty('s-abc1')
      syncManager.scheduleFlush()

      expect(flushCallback).not.toHaveBeenCalled()

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(config.debounceMs + 10)

      expect(flushCallback).toHaveBeenCalled()
    })

    it('should reset debounce timer on multiple calls', async () => {
      syncManager.markDirty('s-abc1')
      syncManager.scheduleFlush()

      // Advance halfway
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2)

      syncManager.markDirty('s-abc2')
      syncManager.scheduleFlush()

      // Advance halfway again (would be past original debounce)
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2)

      // Should not have flushed yet (debounce was reset)
      expect(flushCallback).not.toHaveBeenCalled()

      // Advance remaining time
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2 + 10)

      expect(flushCallback).toHaveBeenCalled()
    })

    it('should force flush at max delay', async () => {
      syncManager.markDirty('s-abc1')
      syncManager.scheduleFlush()

      // Keep resetting debounce but stay under max delay
      // debounceMs = 100, maxDelayMs = 500
      // Advance 80ms at a time, which is less than debounce
      // After 4 iterations: 320ms total (still under 500ms max)
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(80)
        syncManager.scheduleFlush()
      }

      // Should not have flushed yet (320ms < 500ms maxDelay)
      expect(flushCallback).not.toHaveBeenCalled()

      // Advance to max delay (need another 180ms to reach 500ms)
      await vi.advanceTimersByTimeAsync(200)

      expect(flushCallback).toHaveBeenCalled()
    })
  })

  describe('flush', () => {
    it('should flush immediately', async () => {
      syncManager.markDirty('s-abc1')

      await syncManager.flush()

      expect(flushCallback).toHaveBeenCalled()
    })

    it('should clear pending changes after flush', async () => {
      syncManager.markDirty('s-abc1')

      await syncManager.flush()

      expect(syncManager.hasPendingChanges()).toBe(false)
    })

    it('should not flush when no pending changes', async () => {
      await syncManager.flush()

      expect(flushCallback).not.toHaveBeenCalled()
    })

    it('should deduplicate concurrent flush calls', async () => {
      syncManager.markDirty('s-abc1')

      // Call flush multiple times concurrently
      const promise1 = syncManager.flush()
      const promise2 = syncManager.flush()
      const promise3 = syncManager.flush()

      await Promise.all([promise1, promise2, promise3])

      // Should only call flush callback once
      expect(flushCallback).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('should cancel pending flush', async () => {
      syncManager.markDirty('s-abc1')
      syncManager.scheduleFlush()

      syncManager.cancel()

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(config.debounceMs + 10)

      expect(flushCallback).not.toHaveBeenCalled()
    })

    it('should clear pending changes', () => {
      syncManager.markDirty('s-abc1')

      syncManager.cancel()

      expect(syncManager.hasPendingChanges()).toBe(false)
    })
  })
})
