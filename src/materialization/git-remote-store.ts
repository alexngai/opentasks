/**
 * Git Remote Store
 *
 * A RemoteStore implementation that archives snapshots to a remote git
 * repository. Unlike the local GitArchiveStore, this store manages its
 * own bare repo clone and pushes to a remote URL.
 *
 * Supports both reads and writes — retrieve() and list() fetch from
 * the remote before reading, so this store can serve as a durable,
 * queryable archive that survives across machines.
 *
 * Tree layout (same as GitArchiveStore):
 *   <graphId>/sessions/<session-id>/session.json
 *   <graphId>/sessions/<session-id>/edges.json
 *   <graphId>/sessions/<session-id>/checkpoints/<checkpoint-id>.json
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type {
  RemoteStore,
  RemoteStoreConfig,
  MaterializationSnapshot,
  SessionSnapshot,
  CheckpointSnapshot,
  ArchiveResult,
  BatchArchiveResult,
  ArchiveFilter,
  ArchiveListEntry,
  StoreStatus,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

interface GitRemoteStoreConfig {
  /** Remote git URL (SSH or HTTPS) */
  url: string;

  /** Branch name for archive commits (default: 'opentasks/archive') */
  branch?: string;

  /**
   * Local path for the bare repo cache.
   * If not set, a temp directory under os.tmpdir() is used.
   */
  cachePath?: string;

  /**
   * When to push to remote:
   * - 'immediate': push after every archive() call
   * - 'on-close': push once on close()
   * Default: 'immediate'
   */
  pushPolicy?: 'immediate' | 'on-close';

  /** Git command timeout in milliseconds (default: 30000) */
  timeout?: number;

  /**
   * Whether to fetch from remote before read operations.
   * Default: true
   */
  fetchBeforeRead?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a git command in a repo directory.
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

function extractSessionId(uri: string): string | null {
  const match = uri.match(/sessionlog:\/\/session\/(.+)/);
  return match ? match[1] : null;
}

function extractCheckpointId(uri: string): string | null {
  const match = uri.match(/sessionlog:\/\/checkpoint\/(.+)/);
  return match ? match[1] : null;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a git remote store
 */
export function createGitRemoteStore(storeConfig: RemoteStoreConfig): RemoteStore {
  const config = storeConfig.config as unknown as GitRemoteStoreConfig;
  const remoteUrl = config.url;
  const branch = config.branch ?? 'opentasks/archive';
  const pushPolicy = config.pushPolicy ?? 'immediate';
  const timeout = config.timeout ?? 30000;
  const fetchBeforeRead = config.fetchBeforeRead ?? true;

  if (!remoteUrl) {
    throw new Error('Git remote store requires a "url" in config');
  }

  // Determine cache path — use configured path or derive from URL
  const cachePath =
    config.cachePath ??
    path.join(
      process.env.OPENTASKS_CACHE_DIR ?? path.join(os.tmpdir(), 'opentasks'),
      'git-remote-stores',
      remoteUrl.replace(/[^a-zA-Z0-9-_]/g, '_'),
    );

  let initialized = false;
  let hasPendingCommits = false;
  let lastArchiveAt: string | undefined;
  let lastError: string | undefined;

  /**
   * Ensure the bare repo cache exists and is connected to the remote
   */
  function ensureRepo(): void {
    if (fs.existsSync(path.join(cachePath, 'HEAD'))) {
      // Bare repo already exists
      return;
    }

    // Ensure parent directory exists (let git create cachePath itself)
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });

    // Try to clone from remote
    try {
      execSync(`git clone --bare "${remoteUrl}" "${cachePath}"`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Remote might not exist yet or be empty — init a bare repo
      fs.mkdirSync(cachePath, { recursive: true });
      execSync(`git init --bare "${cachePath}"`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Add the remote
      git(cachePath, `remote add origin "${remoteUrl}"`, { allowFailure: true, timeout });
    }
  }

  /**
   * Ensure the archive branch exists locally
   */
  function ensureBranch(): void {
    const exists = git(cachePath, `rev-parse --verify ${branch}`, { allowFailure: true, timeout });
    if (exists) return;

    // Try to fetch the branch from remote
    try {
      git(cachePath, `fetch origin ${branch}`, { timeout: 60000 });
      git(cachePath, `branch ${branch} FETCH_HEAD`, { allowFailure: true, timeout });
      return;
    } catch {
      // Branch doesn't exist on remote either — create orphan
    }

    const emptyTree = git(cachePath, 'hash-object -t tree /dev/null', { timeout });
    const commitHash = git(
      cachePath,
      `commit-tree ${emptyTree} -m "Initialize opentasks archive"`,
      { timeout },
    );
    git(cachePath, `update-ref refs/heads/${branch} ${commitHash}`, { timeout });
  }

  /**
   * Fetch latest from remote (best-effort)
   */
  function fetchFromRemote(): void {
    try {
      git(cachePath, `fetch origin ${branch}`, { timeout: 60000 });
      // Fast-forward local branch if possible
      const localRef = git(cachePath, `rev-parse ${branch}`, { allowFailure: true, timeout });
      const remoteRef = git(cachePath, `rev-parse FETCH_HEAD`, { allowFailure: true, timeout });
      if (remoteRef && localRef !== remoteRef) {
        // Merge remote changes (fast-forward when possible)
        git(cachePath, `update-ref refs/heads/${branch} ${remoteRef} ${localRef}`, {
          allowFailure: true,
          timeout,
        });
      }
    } catch {
      // Fetch failure is non-fatal for reads — use stale cache
    }
  }

  /**
   * Push local commits to remote
   */
  function pushToRemote(): void {
    try {
      git(cachePath, `push origin ${branch}`, { timeout: 60000 });
      hasPendingCommits = false;
    } catch {
      // Retry with fetch + rebase for conflict resolution
      try {
        git(cachePath, `fetch origin ${branch}`, { timeout: 60000 });
        const localRef = git(cachePath, `rev-parse ${branch}`, { allowFailure: true, timeout });
        const remoteRef = git(cachePath, `rev-parse origin/${branch}`, {
          allowFailure: true,
          timeout,
        });

        if (remoteRef && localRef !== remoteRef) {
          git(cachePath, `rebase origin/${branch} ${branch}`, { timeout });
          git(cachePath, `push origin ${branch}`, { timeout: 60000 });
          hasPendingCommits = false;
        }
      } catch (error) {
        lastError = `Push to remote failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  /**
   * Commit files to the local archive branch
   */
  function commitFiles(files: Array<{ path: string; content: string }>, message: string): string {
    const indexFile = path.join(cachePath, `index-archive-${Date.now()}`);
    const env = `GIT_INDEX_FILE="${indexFile}"`;

    try {
      // Read current tree into temp index
      const currentCommit = git(cachePath, `rev-parse ${branch}`, { allowFailure: true, timeout });
      if (currentCommit) {
        execSync(`${env} git -C "${cachePath}" read-tree ${branch}`, {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      for (const file of files) {
        const tmpFile = path.join(
          cachePath,
          `tmp-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        fs.writeFileSync(tmpFile, file.content, 'utf-8');
        try {
          const blobHash = git(cachePath, `hash-object -w "${tmpFile}"`, { timeout });
          execSync(
            `${env} git -C "${cachePath}" update-index --add --cacheinfo 100644,${blobHash},"${file.path}"`,
            {
              encoding: 'utf-8',
              timeout: 10000,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
        } finally {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            /* ignore */
          }
        }
      }

      const treeHash = execSync(`${env} git -C "${cachePath}" write-tree`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const parentArg = currentCommit ? `-p ${currentCommit}` : '';
      const commitHash = git(cachePath, `commit-tree ${treeHash} ${parentArg} -m "${message}"`, {
        timeout,
      });

      git(cachePath, `update-ref refs/heads/${branch} ${commitHash}`, { timeout });

      return commitHash;
    } finally {
      try {
        fs.unlinkSync(indexFile);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Read a file from the archive branch
   */
  function readFile(filePath: string): string | null {
    try {
      return git(cachePath, `show ${branch}:"${filePath}"`, { timeout });
    } catch {
      return null;
    }
  }

  /**
   * List files under a prefix in the archive branch
   */
  function listFiles(prefix: string): string[] {
    try {
      const output = git(cachePath, `ls-tree -r --name-only ${branch} -- "${prefix}"`, { timeout });
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Determine the archive file path for a snapshot
   */
  function snapshotFilePath(snapshot: MaterializationSnapshot): string {
    const graphId = snapshot.provenance.graphId;

    if (snapshot.entityType === 'session') {
      const sessionId = extractSessionId(snapshot.uri);
      return `${graphId}/sessions/${sessionId}/session.json`;
    }

    if (snapshot.entityType === 'checkpoint') {
      const cpSnapshot = snapshot as CheckpointSnapshot;
      const sessionId = extractSessionId(cpSnapshot.sessionUri);
      const checkpointId = extractCheckpointId(snapshot.uri);
      return `${graphId}/sessions/${sessionId}/checkpoints/${checkpointId}.json`;
    }

    const safeUri = snapshot.uri.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${graphId}/other/${safeUri}.json`;
  }

  // ==========================================================================
  // RemoteStore implementation
  // ==========================================================================

  return {
    name: storeConfig.name,
    type: storeConfig.type,
    enabled: storeConfig.enabled,
    events: storeConfig.events,

    async archive(snapshot: MaterializationSnapshot): Promise<ArchiveResult> {
      try {
        const files: Array<{ path: string; content: string }> = [];

        files.push({
          path: snapshotFilePath(snapshot),
          content: JSON.stringify(snapshot, null, 2),
        });

        if (snapshot.entityType === 'session') {
          const sessionSnapshot = snapshot as SessionSnapshot;
          const sessionId = extractSessionId(snapshot.uri);
          const graphId = snapshot.provenance.graphId;

          if (sessionSnapshot.edges?.length > 0) {
            files.push({
              path: `${graphId}/sessions/${sessionId}/edges.json`,
              content: JSON.stringify(sessionSnapshot.edges, null, 2),
            });
          }
        }

        const entityDesc =
          snapshot.entityType === 'checkpoint'
            ? `checkpoint ${extractCheckpointId(snapshot.uri)}`
            : `session ${extractSessionId(snapshot.uri)}`;
        const message = `archive: ${snapshot.provenance.graphId} ${entityDesc}`;

        commitFiles(files, message);
        hasPendingCommits = true;
        lastArchiveAt = new Date().toISOString();
        lastError = undefined;

        if (pushPolicy === 'immediate') {
          pushToRemote();
        }

        return { stored: true, uri: snapshot.uri };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = errorMsg;
        return { stored: false, uri: snapshot.uri, error: errorMsg };
      }
    },

    async archiveBatch(snapshots: MaterializationSnapshot[]): Promise<BatchArchiveResult> {
      const results: ArchiveResult[] = [];
      for (const snapshot of snapshots) {
        results.push(await this.archive(snapshot));
      }
      return {
        results,
        successCount: results.filter((r) => r.stored).length,
        failureCount: results.filter((r) => !r.stored).length,
      };
    },

    async retrieve(uri: string): Promise<MaterializationSnapshot | null> {
      if (fetchBeforeRead) {
        fetchFromRemote();
      }

      const sessionId = extractSessionId(uri);
      const checkpointId = extractCheckpointId(uri);
      if (!sessionId && !checkpointId) return null;

      try {
        const topLevel = git(cachePath, `ls-tree --name-only ${branch}`, {
          allowFailure: true,
          timeout,
        });
        if (!topLevel) return null;

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          let filePath: string;

          if (checkpointId) {
            const cpFiles = listFiles(`${graphId}/sessions/`).filter(
              (f) => f.endsWith(`/${checkpointId}.json`) && f.includes('/checkpoints/'),
            );

            if (cpFiles.length > 0) {
              filePath = cpFiles[0];
            } else {
              continue;
            }
          } else {
            filePath = `${graphId}/sessions/${sessionId}/session.json`;
          }

          const content = readFile(filePath);
          if (content) {
            try {
              return JSON.parse(content) as MaterializationSnapshot;
            } catch {
              continue;
            }
          }
        }
      } catch {
        return null;
      }

      return null;
    },

    async list(filter?: ArchiveFilter): Promise<ArchiveListEntry[]> {
      if (fetchBeforeRead) {
        fetchFromRemote();
      }

      const entries: ArchiveListEntry[] = [];

      try {
        const topLevel = git(cachePath, `ls-tree --name-only ${branch}`, {
          allowFailure: true,
          timeout,
        });
        if (!topLevel) return entries;

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          if (filter?.graphId && filter.graphId !== '*' && filter.graphId !== graphId) continue;

          const sessionFiles = listFiles(`${graphId}/sessions/`).filter((f) =>
            f.endsWith('/session.json'),
          );

          for (const sessionFile of sessionFiles) {
            const content = readFile(sessionFile);
            if (!content) continue;

            try {
              const snapshot = JSON.parse(content) as MaterializationSnapshot;

              if (filter?.source && snapshot.source !== filter.source) continue;
              if (filter?.entityType && snapshot.entityType !== filter.entityType) continue;
              if (filter?.archivedAfter && snapshot.archivedAt < filter.archivedAfter) continue;
              if (filter?.archivedBefore && snapshot.archivedAt > filter.archivedBefore) continue;

              entries.push({
                uri: snapshot.uri,
                entityType: snapshot.entityType,
                graphId,
                archivedAt: snapshot.archivedAt,
                title: snapshot.node.title,
                status: snapshot.node.status,
              });
            } catch {
              continue;
            }
          }
        }
      } catch {
        // Best-effort listing
      }

      return entries;
    },

    async initialize(): Promise<void> {
      if (initialized) return;

      ensureRepo();
      ensureBranch();
      initialized = true;
    },

    async close(): Promise<void> {
      if (hasPendingCommits) {
        try {
          pushToRemote();
        } catch {
          // Best-effort on close
        }
      }
    },

    async status(): Promise<StoreStatus> {
      return {
        healthy: initialized && !lastError,
        message: !initialized ? 'Not initialized' : lastError ? `Last error: ${lastError}` : 'OK',
        lastArchiveAt,
        lastError,
      };
    },
  };
}
