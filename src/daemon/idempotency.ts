/**
 * Idempotency Store (P3 M3, F9)
 *
 * In-memory map from a client-supplied idempotency key to the node id created
 * for it, with a TTL window. A create retried with the same key inside the
 * window returns the original node instead of creating a duplicate — the common
 * "agent retried after a timeout / dropped ack" case.
 *
 * `run()` dedupes both SEQUENTIAL retries (via the TTL map) and CONCURRENT
 * in-flight retries (via a reservation): two requests carrying the same key that
 * arrive before either completes share a single create, so the get→create gap
 * can't produce duplicates.
 *
 * Per-process and best-effort: it does not survive a daemon restart, and it
 * dedupes creates only (not arbitrary mutations). Bounded in size so a flood of
 * unique keys can't grow it without limit.
 */

export interface IdempotencyStore {
  /** The node id previously created for `key`, or undefined if none / expired. */
  get(key: string): string | undefined;
  /** Record that `key` produced `nodeId`. */
  set(key: string, nodeId: string): void;
  /**
   * Run `create` at most once per `key`, across both sequential retries (within
   * the TTL window) and concurrent in-flight requests:
   * - completed mapping present + node still exists → re-fetch and return it;
   * - another create with this key in flight → await it and return its node;
   * - otherwise → reserve the key synchronously (closing the get→create gap),
   *   create, record the mapping, and return the new node.
   * If a recorded node was deleted since, or a concurrent creator failed, the
   * caller recreates. `fetch` returns the current node for an id (or null/undefined
   * if gone).
   */
  run<T extends { id: string }>(
    key: string,
    create: () => Promise<T>,
    fetch: (id: string) => Promise<T | null | undefined>,
  ): Promise<T>;
}

export interface IdempotencyStoreOptions {
  /** How long a key maps to its node id (default 10 minutes). */
  ttlMs?: number;
  /** Max retained keys; the oldest are evicted past this (default 10_000). */
  max?: number;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_MAX = 10_000;

/**
 * Create an in-memory idempotency store.
 */
export function createIdempotencyStore(
  options: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const max = Math.max(1, options.max ?? DEFAULT_IDEMPOTENCY_MAX);
  // Insertion-ordered (Map preserves it); value carries expiry for lazy TTL.
  const entries = new Map<string, { nodeId: string; expiresAt: number }>();
  // In-flight reservations: key → promise resolving to the created node id (or
  // null if that creator failed). Lets concurrent callers share one create.
  const inflight = new Map<string, Promise<string | null>>();

  const store: IdempotencyStore = {
    get(key: string): string | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.nodeId;
    },

    set(key: string, nodeId: string): void {
      // Re-insert so recency order reflects this write (oldest-evicted-first).
      entries.delete(key);
      entries.set(key, { nodeId, expiresAt: Date.now() + ttlMs });
      // Bound memory: drop oldest entries until under the cap.
      while (entries.size > max) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    async run<T extends { id: string }>(
      key: string,
      create: () => Promise<T>,
      fetch: (id: string) => Promise<T | null | undefined>,
    ): Promise<T> {
      // Sequential-retry fast path: a completed mapping within the TTL window.
      const doneId = store.get(key);
      if (doneId !== undefined) {
        const existing = await fetch(doneId);
        if (existing) return existing;
        // Stale mapping (node deleted since) — fall through to recreate.
      }

      // Concurrent + recreate loop. Each iteration either joins an in-flight
      // create or becomes the owner. The owner reserves SYNCHRONOUSLY (no await
      // between the inflight check and the set), so a concurrent caller can't
      // also become an owner — closing the get→create TOCTOU.
      for (;;) {
        const pending = inflight.get(key);
        if (pending) {
          const id = await pending;
          if (id) {
            const existing = await fetch(id);
            if (existing) return existing;
          }
          // The owner failed, or its node is already gone — re-check: someone
          // else may now own the key, otherwise we become the owner.
          continue;
        }

        let settle!: (id: string | null) => void;
        const reservation = new Promise<string | null>((resolve) => {
          settle = resolve;
        });
        inflight.set(key, reservation);
        try {
          const node = await create();
          store.set(key, node.id);
          settle(node.id);
          return node;
        } catch (err) {
          // Release the reservation so a retry can proceed, then propagate.
          settle(null);
          throw err;
        } finally {
          inflight.delete(key);
        }
      }
    },
  };

  return store;
}
