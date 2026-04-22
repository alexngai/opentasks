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
    },

    async push(): Promise<PushResult> {
      if (!repoRoot || !remote) {
        return { pushed: false, error: remote ? 'Not a git repository' : 'No remote configured' };
      }

      try {
        // Get current branch
        const branch = git(repoRoot, 'rev-parse --abbrev-ref HEAD', { timeout });
        if (!branch) {
          return { pushed: false, error: 'Could not determine current branch' };
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
            return {
              pushed: false,
              error: `Push failed after rebase: ${(retryError as Error).message}`,
            };
          }
        }

        lastPushTime = Date.now();
        return { pushed: true };
      } catch (error) {
        return { pushed: false, error: (error as Error).message };
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
          return { pulled: false, hasChanges: false, error: 'Could not determine current branch' };
        }

        // Record current HEAD before pull
        const headBefore = git(repoRoot, 'rev-parse HEAD', { allowFailure: true, timeout });

        git(repoRoot, `pull --no-edit ${remote} ${branch}`, { timeout });

        // Check if HEAD changed
        const headAfter = git(repoRoot, 'rev-parse HEAD', { allowFailure: true, timeout });
        const hasChanges = headBefore !== headAfter;

        return { pulled: true, hasChanges };
      } catch (error) {
        return { pulled: false, hasChanges: false, error: (error as Error).message };
      }
    },

    async sync(): Promise<SyncCycleResult> {
      const commit = await this.commitIfDirty();
      const pull = await this.pull();
      const push = await this.push();
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
  };
}
