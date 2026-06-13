/**
 * Event Manager
 *
 * Durable, replayable in-memory event stream for the daemon's watch channel.
 * Each emitted change event gets a monotonic `seq` within a per-process
 * `epoch`; the last N are retained in a ring buffer so a reconnecting subscriber
 * can replay what it missed via `since(cursor)`.
 *
 * Scope (P3 M2): single process, in-memory. It survives client disconnects
 * within the buffer window, NOT daemon restarts — a restart starts a fresh
 * epoch, so any cursor from a prior epoch resolves to `resync` and the client
 * does a full re-query. A durable on-disk log is intentionally deferred; the
 * ring buffer covers the reconnect-gap case that matters for agents.
 */

import { randomUUID } from 'node:crypto';
import type { ProviderNodeChangeEvent } from '../providers/traits/Watchable.js';

/** Default ring-buffer capacity (number of events retained for replay). */
export const DEFAULT_EVENT_BUFFER_SIZE = 1024;

/** A change event stamped with its position in the stream. */
export interface StampedEvent {
  /** Monotonic sequence within `epoch`, starting at 1. */
  seq: number;
  /** Per-daemon-process identity; changes on restart. */
  epoch: string;
  /** ISO timestamp the event entered the stream (stream time, not node time). */
  emittedAt: string;
  /** The underlying graph change. */
  event: ProviderNodeChangeEvent;
}

/**
 * The `watch.event` notification payload as seen by subscribers: the underlying
 * change, plus its stream position when an event manager is active. `seq`/`epoch`
 * are absent on the unstamped path (no event manager wired — the M1 behavior),
 * so consumers must treat them as optional.
 */
export type WatchEventPayload = ProviderNodeChangeEvent & {
  seq?: number;
  epoch?: string;
};

/** Opaque resume position a client persists between connections. */
export interface EventCursor {
  epoch: string;
  seq: number;
}

/**
 * Result of `since`. `resync: true` means the cursor cannot be served — either
 * the epoch changed (daemon restarted) or the requested events were evicted
 * from the ring buffer — and the caller should re-query current state instead
 * of relying on the delta.
 */
export type SinceResult =
  | { epoch: string; resync?: false; events: StampedEvent[] }
  | { epoch: string; resync: true };

export interface EventManager {
  /** This process's epoch. */
  readonly epoch: string;
  /** Stamp + buffer an event, returning the stamped form for broadcast. */
  emit(event: ProviderNodeChangeEvent): StampedEvent;
  /** Replay events with `seq > cursor.seq` for the same epoch, or signal resync. */
  since(cursor: EventCursor): SinceResult;
  /** Latest cursor: epoch + highest assigned seq (seq 0 if nothing emitted). */
  current(): EventCursor;
}

export interface EventManagerOptions {
  /** Ring-buffer capacity (default {@link DEFAULT_EVENT_BUFFER_SIZE}). */
  bufferSize?: number;
  /** Override the epoch (for tests / determinism). Defaults to a random UUID. */
  epoch?: string;
}

/**
 * Create an in-memory event manager.
 */
export function createEventManager(options: EventManagerOptions = {}): EventManager {
  const bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_EVENT_BUFFER_SIZE);
  const epoch = options.epoch ?? randomUUID();
  const buffer: StampedEvent[] = []; // ascending by seq
  let latestSeq = 0;

  return {
    epoch,

    emit(event: ProviderNodeChangeEvent): StampedEvent {
      latestSeq += 1;
      const stamped: StampedEvent = {
        seq: latestSeq,
        epoch,
        emittedAt: new Date().toISOString(),
        event,
      };
      buffer.push(stamped);
      if (buffer.length > bufferSize) buffer.shift();
      return stamped;
    },

    since(cursor: EventCursor): SinceResult {
      // A malformed seq (NaN, Infinity, negative, non-integer) can't be served
      // as a delta — NaN comparisons would otherwise slip through as an empty
      // "you're caught up" result. Force a resync so the caller re-queries.
      if (!Number.isInteger(cursor.seq) || cursor.seq < 0) {
        return { epoch, resync: true };
      }
      // Different epoch → seq space reset under the client; full resync.
      if (cursor.epoch !== epoch) {
        return { epoch, resync: true };
      }
      // Caller is at or ahead of the head → nothing to replay.
      if (cursor.seq >= latestSeq) {
        return { epoch, events: [] };
      }
      // The oldest seq we can still serve. If the event right after the cursor
      // (cursor.seq + 1) was already evicted, we can't guarantee a complete
      // delta → resync.
      const oldestBuffered = buffer.length > 0 ? buffer[0].seq : latestSeq + 1;
      if (cursor.seq + 1 < oldestBuffered) {
        return { epoch, resync: true };
      }
      const events = buffer.filter((e) => e.seq > cursor.seq);
      return { epoch, events };
    },

    current(): EventCursor {
      return { epoch, seq: latestSeq };
    },
  };
}
