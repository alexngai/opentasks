/**
 * Tests for DebouncedFlusher
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import {
  createDebouncedFlusher,
  type DebouncedFlusher,
  type DebounceConfig,
  type FlushCallback,
} from '../debounce.js';

describe('DebouncedFlusher', () => {
  let flusher: DebouncedFlusher;
  let flushCallback: Mock<FlushCallback>;

  const config: DebounceConfig = {
    debounceMs: 100,
    maxDelayMs: 500,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn<FlushCallback>().mockResolvedValue(undefined);
    flusher = createDebouncedFlusher(config, flushCallback);
  });

  afterEach(() => {
    vi.useRealTimers();
    flusher.cancel();
  });

  describe('markDirty', () => {
    it('should set dirty flag', () => {
      expect(flusher.hasPending()).toBe(false);

      flusher.markDirty();

      expect(flusher.hasPending()).toBe(true);
    });

    it('should be idempotent', () => {
      flusher.markDirty();
      flusher.markDirty();
      flusher.markDirty();

      expect(flusher.hasPending()).toBe(true);
    });
  });

  describe('schedule', () => {
    it('should flush after debounce delay', async () => {
      flusher.markDirty();
      flusher.schedule();

      expect(flushCallback).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(config.debounceMs + 10);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should reset debounce timer on multiple calls', async () => {
      flusher.markDirty();
      flusher.schedule();

      // Advance halfway
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2);

      flusher.schedule();

      // Advance halfway again (would be past original debounce)
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2);

      // Should not have flushed yet (debounce was reset)
      expect(flushCallback).not.toHaveBeenCalled();

      // Advance remaining time
      await vi.advanceTimersByTimeAsync(config.debounceMs / 2 + 10);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should force flush at max delay', async () => {
      flusher.markDirty();
      flusher.schedule();

      // Keep resetting debounce but stay under max delay
      // debounceMs = 100, maxDelayMs = 500
      // Advance 80ms at a time, which is less than debounce
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(80);
        flusher.schedule();
      }

      // Should not have flushed yet (320ms < 500ms maxDelay)
      expect(flushCallback).not.toHaveBeenCalled();

      // Advance to max delay (need another 180ms to reach 500ms)
      await vi.advanceTimersByTimeAsync(200);

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should mark hasPending when scheduled', () => {
      flusher.schedule();

      expect(flusher.hasPending()).toBe(true);
    });
  });

  describe('flush', () => {
    it('should flush immediately when dirty', async () => {
      flusher.markDirty();

      await flusher.flush();

      expect(flushCallback).toHaveBeenCalled();
    });

    it('should clear dirty flag after flush', async () => {
      flusher.markDirty();

      await flusher.flush();

      expect(flusher.hasPending()).toBe(false);
    });

    it('should not flush when not dirty', async () => {
      await flusher.flush();

      expect(flushCallback).not.toHaveBeenCalled();
    });

    it('should deduplicate concurrent flush calls', async () => {
      flusher.markDirty();

      // Call flush multiple times concurrently
      const promise1 = flusher.flush();
      const promise2 = flusher.flush();
      const promise3 = flusher.flush();

      await Promise.all([promise1, promise2, promise3]);

      // Should only call flush callback once
      expect(flushCallback).toHaveBeenCalledTimes(1);
    });

    it('should clear scheduled timers on immediate flush', async () => {
      flusher.markDirty();
      flusher.schedule();

      // Flush immediately
      await flusher.flush();

      expect(flushCallback).toHaveBeenCalledTimes(1);

      // Advance past debounce - should not flush again
      await vi.advanceTimersByTimeAsync(config.debounceMs + 10);

      expect(flushCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('should cancel pending flush', async () => {
      flusher.markDirty();
      flusher.schedule();

      flusher.cancel();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(config.debounceMs + 10);

      expect(flushCallback).not.toHaveBeenCalled();
    });

    it('should clear dirty flag', () => {
      flusher.markDirty();

      flusher.cancel();

      expect(flusher.hasPending()).toBe(false);
    });

    it('should cancel max delay timer', async () => {
      flusher.markDirty();
      flusher.schedule();

      flusher.cancel();

      // Advance past max delay
      await vi.advanceTimersByTimeAsync(config.maxDelayMs + 10);

      expect(flushCallback).not.toHaveBeenCalled();
    });
  });

  describe('hasPending', () => {
    it('should return false initially', () => {
      expect(flusher.hasPending()).toBe(false);
    });

    it('should return true when dirty', () => {
      flusher.markDirty();

      expect(flusher.hasPending()).toBe(true);
    });

    it('should return true when scheduled', () => {
      flusher.schedule();

      expect(flusher.hasPending()).toBe(true);
    });

    it('should return false after flush', async () => {
      flusher.markDirty();
      await flusher.flush();

      expect(flusher.hasPending()).toBe(false);
    });

    it('should return false after cancel', () => {
      flusher.markDirty();
      flusher.schedule();
      flusher.cancel();

      expect(flusher.hasPending()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle flush during flush gracefully', async () => {
      let flushCount = 0;
      const slowFlush = vi.fn().mockImplementation(async () => {
        flushCount++;
        // Simulate slow flush
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const slowFlusher = createDebouncedFlusher(config, slowFlush);
      slowFlusher.markDirty();

      // Start first flush
      const promise1 = slowFlusher.flush();

      // Mark dirty again during flush
      slowFlusher.markDirty();

      // Second flush should wait for first
      const promise2 = slowFlusher.flush();

      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([promise1, promise2]);

      // Only one flush should have happened
      expect(flushCount).toBe(1);

      slowFlusher.cancel();
    });

    it('should allow new flush after previous completes', async () => {
      flusher.markDirty();
      await flusher.flush();

      expect(flushCallback).toHaveBeenCalledTimes(1);

      // Mark dirty again and flush
      flusher.markDirty();
      await flusher.flush();

      expect(flushCallback).toHaveBeenCalledTimes(2);
    });
  });
});
