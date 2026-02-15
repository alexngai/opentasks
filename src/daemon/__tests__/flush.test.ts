/**
 * Tests for Daemon Flush Manager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDaemonFlushManager,
  type DaemonFlushManager,
  type FlushManagerConfig,
  type FlushOperation,
} from '../flush.js';

describe('DaemonFlushManager', () => {
  let flushManager: DaemonFlushManager;
  let flushCallback: ReturnType<typeof vi.fn<FlushOperation>>;
  let flushedNodeIds: string[][];

  const config: FlushManagerConfig = {
    debounceMs: 100,
    maxDelayMs: 500,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    flushedNodeIds = [];
    flushCallback = vi.fn<FlushOperation>().mockImplementation(async (nodeIds) => {
      flushedNodeIds.push([...nodeIds]);
    });
    flushManager = createDaemonFlushManager(config, flushCallback);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('markDirty', () => {
    it('should track dirty nodes', () => {
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('s-abc2');

      expect(flushManager.getDirtyNodes()).toContain('s-abc1');
      expect(flushManager.getDirtyNodes()).toContain('s-abc2');
    });

    it('should deduplicate dirty nodes', () => {
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('s-abc1');

      expect(flushManager.getDirtyNodes()).toHaveLength(1);
    });

    it('should set hasPendingChanges to true', () => {
      expect(flushManager.hasPendingChanges()).toBe(false);

      flushManager.markDirty('s-abc1');

      expect(flushManager.hasPendingChanges()).toBe(true);
    });
  });

  describe('schedule', () => {
    it('should flush after debounce delay', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      expect(flushCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      expect(flushCallback).toHaveBeenCalled();
      expect(flushedNodeIds[0]).toContain('s-abc1');
    });

    it('should reset debounce timer on multiple calls', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      await vi.advanceTimersByTimeAsync(config.debounceMs! / 2);

      flushManager.markDirty('s-abc2');
      flushManager.schedule();

      await vi.advanceTimersByTimeAsync(config.debounceMs! / 2);

      expect(flushCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(config.debounceMs! / 2 + 10);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should force flush at max delay', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(80);
        flushManager.schedule();
      }

      expect(flushCallback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should not schedule when paused', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.pause();
      flushManager.schedule();

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  describe('flush', () => {
    it('should flush immediately', async () => {
      flushManager.markDirty('s-abc1');

      await flushManager.flush();

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should clear dirty nodes after flush', async () => {
      flushManager.markDirty('s-abc1');

      await flushManager.flush();

      expect(flushManager.getDirtyNodes()).toHaveLength(0);
    });

    it('should pass all dirty node IDs to callback', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('s-abc2');
      flushManager.markDirty('i-xyz3');

      await flushManager.flush();

      expect(flushedNodeIds[0]).toHaveLength(3);
      expect(flushedNodeIds[0]).toContain('s-abc1');
      expect(flushedNodeIds[0]).toContain('s-abc2');
      expect(flushedNodeIds[0]).toContain('i-xyz3');
    });

    it('should not flush when paused', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.pause();

      await flushManager.flush();

      expect(flushCallback).not.toHaveBeenCalled();
    });

    it('should not call callback when no dirty nodes', async () => {
      await flushManager.flush();

      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  describe('pause/resume', () => {
    it('should set paused state', () => {
      expect(flushManager.paused).toBe(false);

      flushManager.pause();

      expect(flushManager.paused).toBe(true);
    });

    it('should resume from paused state', () => {
      flushManager.pause();

      flushManager.resume();

      expect(flushManager.paused).toBe(false);
    });

    it('should preserve dirty nodes when paused', () => {
      flushManager.markDirty('s-abc1');
      flushManager.pause();

      expect(flushManager.getDirtyNodes()).toContain('s-abc1');
    });

    it('should reschedule flush on resume if dirty', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.pause();

      flushManager.resume();

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should not reschedule on resume if not dirty', async () => {
      flushManager.pause();
      flushManager.resume();

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      expect(flushCallback).not.toHaveBeenCalled();
    });

    it('should cancel pending scheduled flush on pause', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      flushManager.pause();

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  describe('finalFlush', () => {
    it('should flush all dirty nodes', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('s-abc2');

      await flushManager.finalFlush();

      expect(flushCallback).toHaveBeenCalled();
      expect(flushedNodeIds[0]).toHaveLength(2);
    });

    it('should ignore paused state', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.pause();

      await flushManager.finalFlush();

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should cancel pending scheduled flush', async () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      await flushManager.finalFlush();

      expect(flushCallback).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(config.debounceMs! + 10);

      // Should not flush again
      expect(flushCallback).toHaveBeenCalledTimes(1);
    });

    it('should not call callback when no dirty nodes', async () => {
      await flushManager.finalFlush();

      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  describe('hasPendingChanges', () => {
    it('should return false initially', () => {
      expect(flushManager.hasPendingChanges()).toBe(false);
    });

    it('should return true when dirty nodes exist', () => {
      flushManager.markDirty('s-abc1');

      expect(flushManager.hasPendingChanges()).toBe(true);
    });

    it('should return true when flush is scheduled', () => {
      flushManager.markDirty('s-abc1');
      flushManager.schedule();

      expect(flushManager.hasPendingChanges()).toBe(true);
    });

    it('should return false after flush', async () => {
      flushManager.markDirty('s-abc1');

      await flushManager.flush();

      expect(flushManager.hasPendingChanges()).toBe(false);
    });
  });

  describe('getDirtyNodes', () => {
    it('should return empty array initially', () => {
      expect(flushManager.getDirtyNodes()).toEqual([]);
    });

    it('should return all dirty node IDs', () => {
      flushManager.markDirty('s-abc1');
      flushManager.markDirty('i-xyz2');

      const dirtyNodes = flushManager.getDirtyNodes();

      expect(dirtyNodes).toHaveLength(2);
      expect(dirtyNodes).toContain('s-abc1');
      expect(dirtyNodes).toContain('i-xyz2');
    });
  });
});
