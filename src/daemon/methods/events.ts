/**
 * Event Method Handlers (P3 M2)
 *
 * JSON-RPC methods for the replayable event stream. A subscriber that
 * reconnects (or starts with a saved cursor) calls `events.since(cursor)` to
 * backfill the change events it missed within the buffer window; `events.current`
 * returns the head cursor so a fresh subscriber can establish a baseline without
 * waiting for the first event.
 */

import type { IPCServer } from '../ipc.js';
import type { EventManager, EventCursor, SinceResult } from '../events.js';

export interface EventMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** The daemon's event manager (shared with the watch broadcaster) */
  eventManager: EventManager;
}

/**
 * Register event-stream method handlers on an IPC server.
 */
export function registerEventMethods(options: EventMethodsOptions): void {
  const { server, eventManager } = options;

  // events.since - replay events after a cursor, or signal resync
  server.handle<{ cursor: EventCursor }, SinceResult>('events.since', async (params) => {
    const cursor = params?.cursor;
    // A missing/garbage cursor can't be served as a delta — force a resync so
    // the caller re-queries rather than silently receiving nothing.
    if (!cursor || typeof cursor.seq !== 'number' || typeof cursor.epoch !== 'string') {
      return { epoch: eventManager.epoch, resync: true };
    }
    return eventManager.since(cursor);
  });

  // events.current - head cursor (epoch + latest seq)
  server.handle<undefined, EventCursor>('events.current', async () => {
    return eventManager.current();
  });
}
