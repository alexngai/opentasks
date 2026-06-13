/**
 * Idempotency Store (P3 M3, F9)
 *
 * In-memory map from a client-supplied idempotency key to the node id created
 * for it, with a TTL window. A create retried with the same key inside the
 * window returns the original node instead of creating a duplicate — the common
 * "agent retried after a timeout / dropped ack" case.
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

  return {
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
  };
}
