/**
 * Git Graph Syncer
 *
 * Handles automated git operations for graph.jsonl to enable
 * cross-machine replication of the OpenTasks graph.
 *
 * Supports manual sync (`opentasks sync`) and optional auto-commit/push.
 * Delegates conflict resolution to the JSONL merge driver in
 * `src/core/merge-driver.ts`.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { installMergeDriver } from '../core/merge-driver.js';

// ============================================================================
// Types
// ============================================================================

export interface GitGraphSyncerConfig {
  /** Path to the .opentasks/ directory */
  opentasksPath: string;

  /** Git remote name (null = no push/pull) */
  remote?: string | null;

  /** Commit after flush (default: false) */
  autoCommit?: boolean;

  /** Push after commit (default: false) */
  autoPush?: boolean;

  /** Minimum interval between pushes in ms (default: 60000) */
  pushDebounceMs?: number;

  /** Git command timeout in ms (default: 30000) */
  timeout?: number;
}

export interface CommitResult {
  /** Whether a commit was created */
  committed: boolean;

  /** Commit hash if created */
  hash?: string;
}

export interface PushResult {
  /** Whether push succeeded */
  pushed: boolean;

  /** Error message if push failed */
  error?: string;
}

export interface PullResult {
  /** Whether pull succeeded */
  pulled: boolean;

  /** Whether new changes were received */
  hasChanges: boolean;

  /** Error message if pull failed */
  error?: string;
}

export interface SyncCycleResult {
  commit: CommitResult;
  pull: PullResult;
  push: PushResult;
}

/**
 * Health snapshot exposing the syncer's recent success/failure state.
 * Used by operators to surface "your pushes have been failing for X
 * minutes" in UIs without needing to run `sync.now` to check.
 */
export interface SyncerHealth {
  /** Message from the most recent failed op, or null if last op succeeded. */
  lastError: string | null;

  /** ISO timestamp of the most recent failure, or null. */
  lastErrorAt: string | null;

  /** Which operation failed: 'commit' | 'pull' | 'push' | null. */
  lastErrorOp: 'commit' | 'pull' | 'push' | null;

  /** ISO timestamp of the last fully-successful sync cycle. */
  lastSuccessAt: string | null;

  /** Cumulative count of failed ops (commit/pull/push) since process start. */
  errorCount: number;
}

export interface GitGraphSyncer {
  /** Commit graph.jsonl if it has uncommitted changes */
  commitIfDirty(): Promise<CommitResult>;

  /** Push to remote */
  push(): Promise<PushResult>;

  /** Pull from remote */
  pull(): Promise<PullResult>;

  /** Full sync cycle: commit + pull + push */
  sync(): Promise<SyncCycleResult>;

  /** Install the JSONL merge driver for this repo */
  installMergeDriver(): void;

  /** Start periodic auto-sync timer */
  startAutoSync(): void;

  /** Stop periodic auto-sync timer */
  stopAutoSync(): void;

  /** Whether auto-sync is running */
  isAutoSyncRunning(): boolean;

  /**
   * Snapshot of recent success/failure state. Read-only — updated
   * automatically by commit/pull/push/sync calls (including the auto-
   * sync timer). Surfaces silent failures that would otherwise only
   * appear in stderr.
   */
  getHealth(): SyncerHealth;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a git command in the repo containing the .opentasks directory.
 */
function git(
  repoPath: string,
  args: string,
  options?: { allowFailure?: boolean; timeout?: number },
): string {
  const timeout = options?.timeout ?? 30000;
  try {
    return execSync(`git -C "${repoPath}" ${args}`, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options?.allowFailure) return '';
    throw error;
  }
}

/**
 * Find the git working tree root for a given .opentasks path.
 * The .opentasks dir may be inside a repo, or the repo root itself.
 */
function findRepoRoot(opentasksPath: string, timeout: number): string | null {
  try {
    return git(opentasksPath, 'rev-parse --show-toplevel', { timeout });
  } catch {
    // Not inside a git repo
    return null;
  }
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a git graph syncer for the given .opentasks directory.
 */
export function createGitGraphSyncer(config: GitGraphSyncerConfig): GitGraphSyncer {
  const {
    opentasksPath: rawOpentasksPath,
    remote = null,
    autoCommit = false,
    autoPush = false,
    pushDebounceMs = 60000,
    timeout = 30000,
  } = config;

  let autoSyncInterval: ReturnType<typeof setInterval> | null = null;
  let isSyncing = false;
  let lastPushTime = 0;

  // Health snapshot — updated by each op. Callers read via getHealth().
  // `lastError` is sticky across successful reads: a caller sees "last
  // push failed 5 minutes ago" even if the intervening commits worked.
  // `lastSuccessAt` is updated only when a FULL sync cycle succeeds
  // (commit + pull + push all clean) so it tracks "are we actually
  // converging with the remote" rather than "did any op succeed."
  const health: SyncerHealth = {
    lastError: null,
    lastErrorAt: null,
    lastErrorOp: null,
    lastSuccessAt: null,
    errorCount: 0,
  };
  function recordError(op: 'commit' | 'pull' | 'push', message: string): void {
    health.lastError = message;
    health.lastErrorAt = new Date().toISOString();
    health.lastErrorOp = op;
    health.errorCount += 1;
  }
  function clearError(): void {
    health.lastError = null;
    health.lastErrorAt = null;
    health.lastErrorOp = null;
  }

  // Resolve symlinks on the input path so `path.relative(repoRoot, graphFile)`
  // compares paths in the same namespace. Without this, macOS's `/tmp →
  // /private/tmp` (and similar) causes `git rev-parse --show-toplevel` to
  // return a `/private/...` path while our stored input is `/var/...`, and
  // the computed relative path ends up as `../../../../private/...` which
  // git rejects as "outside repository" — silently, since callers use
  // `allowFailure: true`. Fall back to the raw input if realpath fails
  // (e.g., directory doesn't exist yet).
  let opentasksPath = rawOpentasksPath;
  try {
    opentasksPath = fs.realpathSync(rawOpentasksPath);
  } catch {
    /* keep the raw path */
  }

  const graphFile = path.join(opentasksPath, 'graph.jsonl');

  // Resolve the repo root once
  const repoRoot = findRepoRoot(opentasksPath, timeout);

  /**
   * Get the relative path of graph.jsonl from the repo root
   */
  function getRelativeGraphPath(): string {
    if (!repoRoot) return 'graph.jsonl';
    return path.relative(repoRoot, graphFile);
  }

  return {
    async commitIfDirty(): Promise<CommitResult> {
      if (!repoRoot) {
        return { committed: false };
      }

      try {
        // Check if graph.jsonl has changes.
        //
        // `--untracked-files=all` is load-bearing: git's default behavior
        // groups untracked paths at the directory level, so
        // `status --porcelain -- ".opentasks/graph.jsonl"` returns empty
        // when `.opentasks/` itself is untracked (common on first commit
        // of a fresh repo). Asking for `all` surfaces the individual file.
        const status = git(
          repoRoot,
          `status --porcelain --untracked-files=all -- "${getRelativeGraphPath()}"`,
          { allowFailure: true, timeout },
        );

        if (!status.trim()) {
          return { committed: false };
        }

        // Stage and commit
        git(repoRoot, `add -- "${getRelativeGraphPath()}"`, { timeout });

        const timestamp = new Date().toISOString();
        const message = `opentasks: sync graph ${timestamp}`;
        git(repoRoot, `commit -m "${message}" -- "${getRelativeGraphPath()}"`, { timeout });

        // Get the commit hash
        const hash = git(repoRoot, 'rev-parse HEAD', { allowFailure: true, timeout });

        return { committed: true, hash: hash || undefined };
      } catch (error) {
        recordError('commit', (error as Error).message);
        throw error;
      }
    },

    async push(): Promise<PushResult> {
      if (!repoRoot || !remote) {
        const err = remote ? 'Not a git repository' : 'No remote configured';
        recordError('push', err);
        return { pushed: false, error: err };
      }

      try {
        // Get current branch
        const branch = git(repoRoot, 'rev-parse --abbrev-ref HEAD', { timeout });
        if (!branch) {
          const err = 'Could not determine current branch';
          recordError('push', err);
          return { pushed: false, error: err };
        }

        try {
          git(repoRoot, `push ${remote} ${branch}`, { timeout });
        } catch {
          // Push failed — try fetch + rebase + retry
          try {
            git(repoRoot, `fetch ${remote} ${branch}`, { timeout });
            git(repoRoot, `rebase ${remote}/${branch}`, { timeout });
            git(repoRoot, `push ${remote} ${branch}`, { timeout });
          } catch (retryError) {
            // Abort rebase if it's in progress
            git(repoRoot, 'rebase --abort', { allowFailure: true, timeout });
            const err = `Push failed after rebase: ${(retryError as Error).message}`;
            recordError('push', err);
            return { pushed: false, error: err };
          }
        }

        lastPushTime = Date.now();
        if (health.lastErrorOp === 'push') clearError();
        return { pushed: true };
      } catch (error) {
        const err = (error as Error).message;
        recordError('push', err);
        return { pushed: false, error: err };
      }
    },

    async pull(): Promise<PullResult> {
      if (!repoRoot || !remote) {
        return {
          pulled: false,
          hasChanges: false,
          error: remote ? 'Not a git repository' : 'No remote configured',
        };
      }

      try {
        const branch = git(repoRoot, 'rev-parse --abbrev-ref HEAD', { timeout });
        if (!branch) {
          const err = 'Could not determine current branch';
          recordError('pull', err);
          return { pulled: false, hasChanges: false, error: err };
        }

        // Record current HEAD before pull
        const headBefore = git(repoRoot, 'rev-parse HEAD', { allowFailure: true, timeout });

        git(repoRoot, `pull --no-edit ${remote} ${branch}`, { timeout });

        // Check if HEAD changed
        const headAfter = git(repoRoot, 'rev-parse HEAD', { allowFailure: true, timeout });
        const hasChanges = headBefore !== headAfter;

        if (health.lastErrorOp === 'pull') clearError();
        return { pulled: true, hasChanges };
      } catch (error) {
        const err = (error as Error).message;
        recordError('pull', err);
        return { pulled: false, hasChanges: false, error: err };
      }
    },

    async sync(): Promise<SyncCycleResult> {
      let commit: CommitResult = { committed: false };
      try {
        commit = await this.commitIfDirty();
      } catch {
        // commitIfDirty records its own error; surface an empty result so
        // the cycle continues to attempt pull/push (they may still succeed
        // and the operator gets partial progress visibility).
      }
      const pull = await this.pull();
      const push = await this.push();

      // The cycle counts as "successful" only when no op errored.
      // `commitIfDirty` returning `committed: false` with no error is OK
      // (nothing to commit), but an error on it means we caught above.
      if (!health.lastError) {
        health.lastSuccessAt = new Date().toISOString();
      }

      return { commit, pull, push };
    },

    installMergeDriver(): void {
      if (!repoRoot) return;

      // Check if graph.jsonl exists before installing
      if (!fs.existsSync(graphFile)) return;

      installMergeDriver(opentasksPath);
    },

    startAutoSync(): void {
      if (autoSyncInterval) return;
      if (!autoCommit && !autoPush) return;

      const interval = Math.max(pushDebounceMs, 10000); // minimum 10s

      autoSyncInterval = setInterval(async () => {
        if (isSyncing) return;
        isSyncing = true;

        try {
          if (autoCommit) {
            await this.commitIfDirty();
          }

          if (autoPush && remote && Date.now() - lastPushTime >= pushDebounceMs) {
            await this.push();
          }
        } catch {
          // Auto-sync should be resilient — don't crash
        } finally {
          isSyncing = false;
        }
      }, interval);
    },

    stopAutoSync(): void {
      if (autoSyncInterval) {
        clearInterval(autoSyncInterval);
        autoSyncInterval = null;
      }
    },

    isAutoSyncRunning(): boolean {
      return autoSyncInterval !== null;
    },

    getHealth(): SyncerHealth {
      // Snapshot copy so callers can't mutate our internal state.
      return {
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        lastErrorOp: health.lastErrorOp,
        lastSuccessAt: health.lastSuccessAt,
        errorCount: health.errorCount,
      };
    },
  };
}
