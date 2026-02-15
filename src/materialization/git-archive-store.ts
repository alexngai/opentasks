/**
 * Git Archive Store
 *
 * Archives materialized snapshots as commits on a git orphan branch.
 * Uses git's content-addressed storage for deduplication and versioning.
 *
 * Tree layout:
 *   <graphId>/sessions/<session-id>/session.json
 *   <graphId>/sessions/<session-id>/edges.json
 *   <graphId>/sessions/<session-id>/checkpoints/<checkpoint-id>.json
 */

import { execSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type {
  MaterializationSnapshot,
  SessionSnapshot,
  CheckpointSnapshot,
  ArchiveResult,
  BatchArchiveResult,
  ArchiveFilter,
  ArchiveListEntry,
  StoreStatus,
  GitArchiveStoreConfig,
  GitArchiveStoreExtended,
} from './types.js'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a git command in a repo directory.
 * Returns stdout as a string.
 */
function git(repoPath: string, args: string, options?: { allowFailure?: boolean }): string {
  try {
    return execSync(`git -C "${repoPath}" ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (options?.allowFailure) return ''
    throw error
  }
}

/**
 * Extract session ID from a snapshot URI
 */
function extractSessionId(uri: string): string | null {
  const match = uri.match(/entire:\/\/session\/(.+)/)
  return match ? match[1] : null
}

/**
 * Extract checkpoint ID from a snapshot URI
 */
function extractCheckpointId(uri: string): string | null {
  const match = uri.match(/entire:\/\/checkpoint\/(.+)/)
  return match ? match[1] : null
}

// ============================================================================
// Git Archive Store Implementation
// ============================================================================

/**
 * Create a git archive store
 */
export function createGitArchiveStore(config: GitArchiveStoreConfig): GitArchiveStoreExtended {
  const {
    branch,
    remote,
    pushPolicy,
    sourceRepoPath,
  } = config

  // Determine the repo to commit to
  const repoPath = config.repoPath ?? path.dirname(sourceRepoPath)
  let initialized = false
  let lastArchiveAt: string | undefined
  let lastError: string | undefined

  /**
   * Ensure the orphan branch exists
   */
  function ensureBranch(): void {
    // Check if branch exists
    const exists = git(repoPath, `rev-parse --verify ${branch}`, { allowFailure: true })
    if (exists) return

    // Create orphan branch with an initial empty commit
    // We use git's low-level commands to avoid checkout issues
    const emptyTree = git(repoPath, 'hash-object -t tree /dev/null')
    const commitHash = git(
      repoPath,
      `commit-tree ${emptyTree} -m "Initialize opentasks archive"`
    )
    git(repoPath, `update-ref refs/heads/${branch} ${commitHash}`)
  }

  /**
   * Write a file into the archive branch using git plumbing.
   *
   * This avoids needing a working tree checkout by using:
   *   1. git hash-object -w  (write blob)
   *   2. git read-tree        (load current tree)
   *   3. git update-index     (add/update file)
   *   4. git write-tree       (create new tree)
   *   5. git commit-tree      (create commit)
   *   6. git update-ref       (advance branch)
   */
  function commitFiles(
    files: Array<{ path: string; content: string }>,
    message: string
  ): string {
    // Set up a temporary index
    const indexFile = path.join(repoPath, '.git', `index-archive-${Date.now()}`)
    const env = `GIT_INDEX_FILE="${indexFile}"`

    try {
      // Read current tree from the branch into temp index
      const currentCommit = git(repoPath, `rev-parse ${branch}`, { allowFailure: true })
      if (currentCommit) {
        execSync(`${env} git -C "${repoPath}" read-tree ${branch}`, {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      }

      // Write each file as a blob and update the index
      for (const file of files) {
        // Write content to a temp file, then hash it
        const tmpFile = path.join(repoPath, '.git', `tmp-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        fs.writeFileSync(tmpFile, file.content, 'utf-8')
        try {
          const blobHash = git(repoPath, `hash-object -w "${tmpFile}"`)
          execSync(
            `${env} git -C "${repoPath}" update-index --add --cacheinfo 100644,${blobHash},"${file.path}"`,
            {
              encoding: 'utf-8',
              timeout: 10000,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          )
        } finally {
          try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
        }
      }

      // Write the tree
      const treeHash = execSync(`${env} git -C "${repoPath}" write-tree`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()

      // Create the commit
      const parentArg = currentCommit ? `-p ${currentCommit}` : ''
      const commitHash = git(repoPath, `commit-tree ${treeHash} ${parentArg} -m "${message}"`)

      // Update the branch ref
      git(repoPath, `update-ref refs/heads/${branch} ${commitHash}`)

      return commitHash
    } finally {
      // Clean up temporary index
      try { fs.unlinkSync(indexFile) } catch { /* ignore */ }
    }
  }

  /**
   * Read a file from the archive branch at a given path
   */
  function readFile(filePath: string): string | null {
    try {
      return git(repoPath, `show ${branch}:"${filePath}"`)
    } catch {
      return null
    }
  }

  /**
   * List files matching a pattern in the archive branch
   */
  function listFiles(prefix: string): string[] {
    try {
      const output = git(repoPath, `ls-tree -r --name-only ${branch} -- "${prefix}"`)
      return output ? output.split('\n').filter(Boolean) : []
    } catch {
      return []
    }
  }

  /**
   * Push to remote if configured
   */
  function pushToRemote(): void {
    if (!remote) return
    try {
      git(repoPath, `push ${remote} ${branch}`)
    } catch (error) {
      // Retry with fetch + rebase for conflict resolution
      try {
        git(repoPath, `fetch ${remote} ${branch}`)
        // Get the current local and remote refs
        const localRef = git(repoPath, `rev-parse ${branch}`)
        const remoteRef = git(repoPath, `rev-parse ${remote}/${branch}`, { allowFailure: true })

        if (remoteRef && localRef !== remoteRef) {
          // Rebase our commits onto remote (safe — paths don't overlap across graphIds)
          git(repoPath, `rebase ${remote}/${branch} ${branch}`)
          git(repoPath, `push ${remote} ${branch}`)
        }
      } catch {
        lastError = `Push to remote '${remote}' failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  /**
   * Determine the archive file path for a snapshot
   */
  function snapshotFilePath(snapshot: MaterializationSnapshot): string {
    const graphId = snapshot.provenance.graphId

    if (snapshot.entityType === 'session') {
      const sessionId = extractSessionId(snapshot.uri)
      return `${graphId}/sessions/${sessionId}/session.json`
    }

    if (snapshot.entityType === 'checkpoint') {
      const cpSnapshot = snapshot as CheckpointSnapshot
      const sessionId = extractSessionId(cpSnapshot.sessionUri)
      const checkpointId = extractCheckpointId(snapshot.uri)
      return `${graphId}/sessions/${sessionId}/checkpoints/${checkpointId}.json`
    }

    // Generic fallback
    const safeUri = snapshot.uri.replace(/[^a-zA-Z0-9-_]/g, '_')
    return `${graphId}/other/${safeUri}.json`
  }

  return {
    name: 'git-archive',
    type: 'git',
    enabled: true,

    async archive(snapshot: MaterializationSnapshot): Promise<ArchiveResult> {
      try {
        const files: Array<{ path: string; content: string }> = []

        // Main snapshot file
        files.push({
          path: snapshotFilePath(snapshot),
          content: JSON.stringify(snapshot, null, 2),
        })

        // For sessions, also write edges.json
        if (snapshot.entityType === 'session') {
          const sessionSnapshot = snapshot as SessionSnapshot
          const sessionId = extractSessionId(snapshot.uri)
          const graphId = snapshot.provenance.graphId

          if (sessionSnapshot.edges.length > 0) {
            files.push({
              path: `${graphId}/sessions/${sessionId}/edges.json`,
              content: JSON.stringify(sessionSnapshot.edges, null, 2),
            })
          }
        }

        // Build commit message
        const entityDesc = snapshot.entityType === 'checkpoint'
          ? `checkpoint ${extractCheckpointId(snapshot.uri)}`
          : `session ${extractSessionId(snapshot.uri)}`
        const message = `archive: ${snapshot.provenance.graphId} ${entityDesc}`

        commitFiles(files, message)
        lastArchiveAt = new Date().toISOString()
        lastError = undefined

        // Push if policy dictates
        if (pushPolicy === 'immediate') {
          pushToRemote()
        }

        return { stored: true, uri: snapshot.uri }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        lastError = errorMsg
        return { stored: false, uri: snapshot.uri, error: errorMsg }
      }
    },

    async archiveBatch(snapshots: MaterializationSnapshot[]): Promise<BatchArchiveResult> {
      const results: ArchiveResult[] = []
      for (const snapshot of snapshots) {
        results.push(await this.archive(snapshot))
      }
      return {
        results,
        successCount: results.filter(r => r.stored).length,
        failureCount: results.filter(r => !r.stored).length,
      }
    },

    async retrieve(uri: string): Promise<MaterializationSnapshot | null> {
      // Determine which file to read based on URI
      // We need to scan graphId directories since we may not know the graphId
      const sessionId = extractSessionId(uri)
      const checkpointId = extractCheckpointId(uri)

      if (!sessionId && !checkpointId) return null

      // List all graphId directories
      try {
        const topLevel = git(repoPath, `ls-tree --name-only ${branch}`, { allowFailure: true })
        if (!topLevel) return null

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          let filePath: string

          if (checkpointId) {
            // Need to find which session contains this checkpoint
            const cpFiles = listFiles(`${graphId}/sessions/`)
              .filter(f => f.endsWith(`/${checkpointId}.json`) && f.includes('/checkpoints/'))

            if (cpFiles.length > 0) {
              filePath = cpFiles[0]
            } else {
              continue
            }
          } else {
            filePath = `${graphId}/sessions/${sessionId}/session.json`
          }

          const content = readFile(filePath)
          if (content) {
            try {
              return JSON.parse(content) as MaterializationSnapshot
            } catch {
              continue
            }
          }
        }
      } catch {
        return null
      }

      return null
    },

    async list(filter?: ArchiveFilter): Promise<ArchiveListEntry[]> {
      const entries: ArchiveListEntry[] = []

      try {
        const topLevel = git(repoPath, `ls-tree --name-only ${branch}`, { allowFailure: true })
        if (!topLevel) return entries

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          // Filter by graphId if specified
          if (filter?.graphId && filter.graphId !== '*' && filter.graphId !== graphId) continue

          // List session directories
          const sessionFiles = listFiles(`${graphId}/sessions/`)
            .filter(f => f.endsWith('/session.json'))

          for (const sessionFile of sessionFiles) {
            const content = readFile(sessionFile)
            if (!content) continue

            try {
              const snapshot = JSON.parse(content) as MaterializationSnapshot

              // Apply filters
              if (filter?.source && snapshot.source !== filter.source) continue
              if (filter?.entityType && snapshot.entityType !== filter.entityType) continue
              if (filter?.archivedAfter && snapshot.archivedAt < filter.archivedAfter) continue
              if (filter?.archivedBefore && snapshot.archivedAt > filter.archivedBefore) continue

              entries.push({
                uri: snapshot.uri,
                entityType: snapshot.entityType,
                graphId,
                archivedAt: snapshot.archivedAt,
                title: snapshot.node.title,
                status: snapshot.node.status,
              })
            } catch {
              continue
            }
          }
        }
      } catch {
        // Best-effort listing
      }

      return entries
    },

    async initialize(): Promise<void> {
      if (initialized) return

      // If using a separate repo, ensure it exists
      if (config.repoPath && !fs.existsSync(config.repoPath)) {
        if (remote) {
          // Clone from remote
          const parentDir = path.dirname(config.repoPath)
          fs.mkdirSync(parentDir, { recursive: true })
          execSync(`git clone --bare "${remote}" "${config.repoPath}"`, {
            encoding: 'utf-8',
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        } else {
          // Create new bare repo
          fs.mkdirSync(config.repoPath, { recursive: true })
          execSync(`git init --bare "${config.repoPath}"`, {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        }
      }

      ensureBranch()
      initialized = true
    },

    async close(): Promise<void> {
      // Push any remaining commits if policy allows
      if (pushPolicy === 'on-session-end' || pushPolicy === 'immediate') {
        try {
          pushToRemote()
        } catch {
          // Best-effort on close
        }
      }
    },

    async status(): Promise<StoreStatus> {
      return {
        healthy: initialized,
        message: initialized ? 'Git archive store initialized' : 'Not initialized',
        lastArchiveAt,
        lastError,
      }
    },

    // ========================================================================
    // Extended: Point-in-time queries
    // ========================================================================

    async findByCodeCommit(commitSha: string): Promise<CheckpointSnapshot | null> {
      try {
        const topLevel = git(repoPath, `ls-tree --name-only ${branch}`, { allowFailure: true })
        if (!topLevel) return null

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          // Find all checkpoint files
          const cpFiles = listFiles(`${graphId}/sessions/`)
            .filter(f => f.includes('/checkpoints/') && f.endsWith('.json'))

          for (const cpFile of cpFiles) {
            const content = readFile(cpFile)
            if (!content) continue

            try {
              const snapshot = JSON.parse(content) as CheckpointSnapshot
              if (snapshot.codeCommit === commitSha) {
                return snapshot
              }
            } catch {
              continue
            }
          }
        }
      } catch {
        return null
      }

      return null
    },

    async getSessionAt(
      sessionId: string,
      options: { afterCheckpoint: string }
    ): Promise<SessionSnapshot | null> {
      try {
        const topLevel = git(repoPath, `ls-tree --name-only ${branch}`, { allowFailure: true })
        if (!topLevel) return null

        for (const graphId of topLevel.split('\n').filter(Boolean)) {
          const sessionPath = `${graphId}/sessions/${sessionId}/session.json`
          const cpPath = `${graphId}/sessions/${sessionId}/checkpoints/${options.afterCheckpoint}.json`

          // Find the commit that added this checkpoint
          const logOutput = git(
            repoPath,
            `log --format="%H" ${branch} -- "${cpPath}"`,
            { allowFailure: true }
          )
          if (!logOutput) continue

          const archiveCommit = logOutput.split('\n')[0]?.trim()
          if (!archiveCommit) continue

          // Read session.json from that specific commit
          try {
            const sessionContent = git(
              repoPath,
              `show ${archiveCommit}:"${sessionPath}"`,
              { allowFailure: true }
            )
            if (sessionContent) {
              return JSON.parse(sessionContent) as SessionSnapshot
            }
          } catch {
            continue
          }
        }
      } catch {
        return null
      }

      return null
    },

    async listGraphs(): Promise<string[]> {
      try {
        const topLevel = git(repoPath, `ls-tree --name-only ${branch}`, { allowFailure: true })
        if (!topLevel) return []
        return topLevel.split('\n').filter(Boolean)
      } catch {
        return []
      }
    },

    async getSessionHistory(
      sessionId: string,
      graphId: string
    ): Promise<Array<{ commitSha: string; message: string; timestamp: string }>> {
      try {
        const sessionDir = `${graphId}/sessions/${sessionId}/`
        const logOutput = git(
          repoPath,
          `log --format="%H|%s|%aI" ${branch} -- "${sessionDir}"`,
          { allowFailure: true }
        )
        if (!logOutput) return []

        return logOutput.split('\n').filter(Boolean).map(line => {
          const [commitSha, message, timestamp] = line.split('|')
          return { commitSha, message, timestamp }
        })
      } catch {
        return []
      }
    },
  }
}
