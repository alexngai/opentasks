/**
 * HTTP Webhook Remote Store
 *
 * Posts materialization snapshots to an HTTP endpoint.
 * Supports basic authentication, custom headers, and event filtering.
 */

import type {
  RemoteStore,
  RemoteStoreConfig,
  MaterializationSnapshot,
  ArchiveResult,
  BatchArchiveResult,
  ArchiveFilter,
  ArchiveListEntry,
  StoreStatus,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

interface HttpStoreConfig {
  /** Target URL for snapshot POST */
  url: string;

  /** Custom headers (e.g. Authorization) */
  headers?: Record<string, string>;

  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;

  /** HTTP method for archive (default: POST) */
  method?: string;

  /** Whether to send batch as array vs individual requests */
  batchMode?: 'array' | 'individual';
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an HTTP webhook remote store
 */
export function createHttpRemoteStore(storeConfig: RemoteStoreConfig): RemoteStore {
  const config = storeConfig.config as HttpStoreConfig;
  const url = config.url;
  const headers = config.headers ?? {};
  const timeout = config.timeout ?? 10000;
  const method = config.method ?? 'POST';
  const batchMode = config.batchMode ?? 'individual';

  let lastArchiveAt: string | undefined;
  let lastError: string | undefined;

  if (!url) {
    throw new Error('HTTP remote store requires a "url" in config');
  }

  /**
   * POST a snapshot to the webhook
   */
  async function postSnapshot(snapshot: MaterializationSnapshot): Promise<ArchiveResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const errorMsg = `HTTP ${response.status}: ${errorText || response.statusText}`;
        lastError = errorMsg;
        return { stored: false, uri: snapshot.uri, error: errorMsg };
      }

      lastArchiveAt = new Date().toISOString();
      lastError = undefined;
      return { stored: true, uri: snapshot.uri };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      lastError = errorMsg;
      return { stored: false, uri: snapshot.uri, error: errorMsg };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: storeConfig.name,
    type: storeConfig.type,
    enabled: storeConfig.enabled,
    events: storeConfig.events,

    async archive(snapshot: MaterializationSnapshot): Promise<ArchiveResult> {
      return postSnapshot(snapshot);
    },

    async archiveBatch(snapshots: MaterializationSnapshot[]): Promise<BatchArchiveResult> {
      if (batchMode === 'array') {
        // Send all snapshots as a single array POST
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout * 2);

        try {
          const response = await fetch(url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers,
            },
            body: JSON.stringify(snapshots),
            signal: controller.signal,
          });

          const stored = response.ok;
          const results = snapshots.map((s) => ({
            stored,
            uri: s.uri,
            error: stored ? undefined : `HTTP ${response.status}`,
          }));

          return {
            results,
            successCount: stored ? snapshots.length : 0,
            failureCount: stored ? 0 : snapshots.length,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            results: snapshots.map((s) => ({ stored: false, uri: s.uri, error: errorMsg })),
            successCount: 0,
            failureCount: snapshots.length,
          };
        } finally {
          clearTimeout(timer);
        }
      }

      // Individual mode: send each snapshot separately
      const results: ArchiveResult[] = [];
      for (const snapshot of snapshots) {
        results.push(await postSnapshot(snapshot));
      }
      return {
        results,
        successCount: results.filter((r) => r.stored).length,
        failureCount: results.filter((r) => !r.stored).length,
      };
    },

    async retrieve(_uri: string): Promise<MaterializationSnapshot | null> {
      // HTTP webhook stores are write-only by default.
      // A read-capable implementation would need a GET endpoint.
      return null;
    },

    async list(_filter?: ArchiveFilter): Promise<ArchiveListEntry[]> {
      // HTTP webhook stores don't support listing.
      return [];
    },

    async initialize(): Promise<void> {
      // Validate URL is reachable (optional health check)
    },

    async close(): Promise<void> {
      // Nothing to close for HTTP
    },

    async status(): Promise<StoreStatus> {
      return {
        healthy: !lastError,
        message: lastError ? `Last error: ${lastError}` : 'OK',
        lastArchiveAt,
        lastError,
      };
    },
  };
}
