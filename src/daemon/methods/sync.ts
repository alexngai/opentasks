/**
 * Git Sync Method Handlers
 *
 * JSON-RPC method handlers for manual git sync operations + status inspection.
 * The daemon runs auto-sync in the background when `sync.git.autoCommit` or
 * `sync.git.autoPush` are enabled in config; these methods expose the same
 * operations for on-demand triggers (e.g., from an external signal like a
 * MAP `context.updated` event telling us a peer pushed changes we should pull).
 */

import type { IPCServer } from '../ipc.js';
import type { GitGraphSyncer, SyncCycleResult, PullResult } from '../../graph/git-graph-syncer.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Resolver for the active syncer — returns null when no git sync is configured */
  getSyncer(): GitGraphSyncer | null;

  /** Static snapshot of the sync config (for sync.status) */
  getSyncStatus(): {
    enabled: boolean;
    remote?: string;
    autoCommit: boolean;
    autoPush: boolean;
    pullOnStartup: boolean;
    autoSyncRunning: boolean;
  };

  /**
   * Reload the syncer from the current on-disk config. Called from `sync.reload`
   * when an external writer (e.g., OpenHive's PATCH /resources/:id/git-sync
   * endpoint) has rewritten `.opentasks/config.json` and we need the running
   * daemon to pick up the new settings without a restart.
   *
   * Returns the new status snapshot after the swap. When `config.json` can't
   * be read or `sync.git.enabled` is false, the syncer is torn down and
   * subsequent `sync.now` / `sync.pull` calls return `ran: false`.
   */
  reloadSyncer(): Promise<ReturnType<SyncMethodsOptions['getSyncStatus']>>;
}

export interface SyncNowResult {
  /** Whether the syncer is available */
  ran: boolean;

  /** Present when ran=true */
  result?: SyncCycleResult;

  /** Present when ran=false */
  reason?: string;
}

export interface SyncPullOnlyResult {
  ran: boolean;
  result?: PullResult;
  reason?: string;
}

export interface SyncReloadResult {
  /** Whether a reload was actually applied (config file read + syncer rebuilt). */
  reloaded: boolean;

  /** New post-reload status. Mirrors `sync.status`. */
  status: ReturnType<SyncMethodsOptions['getSyncStatus']>;

  /** Populated on failure (e.g., config.json missing or unreadable). */
  error?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register sync.now / sync.pull / sync.status method handlers on an IPC server.
 *
 * sync.now      — runs the full cycle (commitIfDirty → pull → push)
 * sync.pull     — pulls only; used when the hub signals "peer pushed, catch up"
 * sync.status   — inspection; returns the active config + autoSync state
 */
export function registerSyncMethods(options: SyncMethodsOptions): void {
  const { server, getSyncer, getSyncStatus, reloadSyncer } = options;

  server.handle<Record<string, never>, SyncNowResult>('sync.now', async () => {
    const syncer = getSyncer();
    if (!syncer) {
      return { ran: false, reason: 'git sync is not enabled for this daemon' };
    }
    const result = await syncer.sync();
    return { ran: true, result };
  });

  server.handle<Record<string, never>, SyncPullOnlyResult>('sync.pull', async () => {
    const syncer = getSyncer();
    if (!syncer) {
      return { ran: false, reason: 'git sync is not enabled for this daemon' };
    }
    const result = await syncer.pull();
    return { ran: true, result };
  });

  server.handle<Record<string, never>, ReturnType<SyncMethodsOptions['getSyncStatus']>>(
    'sync.status',
    async () => {
      return getSyncStatus();
    },
  );

  server.handle<Record<string, never>, SyncReloadResult>('sync.reload', async () => {
    try {
      const status = await reloadSyncer();
      return { reloaded: true, status };
    } catch (err) {
      return {
        reloaded: false,
        status: getSyncStatus(),
        error: (err as Error).message,
      };
    }
  });
}
