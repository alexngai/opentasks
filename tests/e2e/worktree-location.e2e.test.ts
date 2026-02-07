/**
 * E2E Tests: Worktree + Location Resolution with Real Git Repos
 *
 * Tests the full worktree lifecycle using real git repositories
 * and temp filesystems. Exercises:
 *   - Location identity generation from git repos
 *   - Connection creation/health checking
 *   - URI resolution with real paths
 *   - Worktree setup/teardown
 *   - Merge driver installation
 *   - Redirect rules with real config files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import {
  generateLocationHash,
  generateLocationHashFallback,
  generateLocationIdentity,
  getGitRemoteUrl,
  getGitRoot,
  isValidLocationHash,
} from '../../src/core/location.js'
import {
  resolveLocationTarget,
  resolveOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
} from '../../src/core/uri.js'
import {
  createConnection,
  checkConnectionHealth,
  checkAllConnectionHealth,
  addConnection,
  removeConnection,
  type Connection,
} from '../../src/core/connections.js'
import {
  resolveOperationRedirect,
  type RedirectRule,
} from '../../src/core/redirects.js'
import {
  worktreeSetup,
  worktreeTeardown,
  findWorktree,
  listWorktrees,
  readWorktreeRegistry,
  getGitCommonDir,
  getCurrentBranch,
  type WorktreeEntry,
} from '../../src/core/worktree.js'
import {
  mergeJsonl,
  parseJsonlToMap,
  installMergeDriver,
} from '../../src/core/merge-driver.js'
import { SLOW_TESTS } from '../integration/helpers/flags.js'

/**
 * Helper: create a git repo with an initial commit
 */
function createGitRepo(dir: string, remoteName?: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' })
  execSync('git config commit.gpgSign false', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf-8')
  execSync('git add .', { cwd: dir, stdio: 'pipe' })
  execSync('git commit --no-gpg-sign -m "init"', { cwd: dir, stdio: 'pipe' })
  if (remoteName) {
    execSync(`git remote add origin ${remoteName}`, { cwd: dir, stdio: 'pipe' })
  }
}

/**
 * Helper: create .opentasks in a directory with proper config
 */
function createOpentasksDir(
  repoDir: string,
  hash: string,
  name: string,
  role: string = 'manager',
  extraConfig: Record<string, unknown> = {}
): string {
  const opentasksDir = path.join(repoDir, '.opentasks')
  fs.mkdirSync(opentasksDir, { recursive: true })
  const config = {
    version: '1.0',
    location: { hash, uuid: `uuid-${name}`, name },
    role,
    connections: [],
    redirects: [],
    ...extraConfig,
  }
  fs.writeFileSync(
    path.join(opentasksDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8'
  )
  fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '', 'utf-8')
  return opentasksDir
}

describe.skipIf(!SLOW_TESTS)('E2E: Worktree + Location Resolution', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-e2e-wt-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('Location identity with real git repos', () => {
    it('generates deterministic hash from git remote + path', () => {
      const repoDir = path.join(tmpDir, 'repo')
      createGitRepo(repoDir, 'git@github.com:user/test-repo.git')

      const remoteUrl = getGitRemoteUrl(repoDir)
      expect(remoteUrl).toBe('git@github.com:user/test-repo.git')

      const gitRoot = getGitRoot(repoDir)
      expect(gitRoot).toBe(repoDir)

      const hash1 = generateLocationHash(remoteUrl!, '.')
      const hash2 = generateLocationHash(remoteUrl!, '.')
      expect(hash1).toBe(hash2)
      expect(isValidLocationHash(hash1)).toBe(true)
    })

    it('generateLocationIdentity auto-detects git remote', () => {
      const repoDir = path.join(tmpDir, 'auto-repo')
      createGitRepo(repoDir, 'git@github.com:org/auto-repo.git')

      const opentasksDir = path.join(repoDir, '.opentasks')
      fs.mkdirSync(opentasksDir, { recursive: true })

      const identity = generateLocationIdentity(opentasksDir, 'auto-test')
      expect(isValidLocationHash(identity.hash)).toBe(true)
      expect(identity.name).toBe('auto-test')
      expect(identity.uuid).toBeTruthy()

      // Same call should produce same hash
      const identity2 = generateLocationIdentity(opentasksDir)
      expect(identity2.hash).toBe(identity.hash)
    })

    it('falls back to path-based hash when no remote', () => {
      const repoDir = path.join(tmpDir, 'no-remote')
      createGitRepo(repoDir) // no remote

      const remoteUrl = getGitRemoteUrl(repoDir)
      expect(remoteUrl).toBeNull()

      const opentasksDir = path.join(repoDir, '.opentasks')
      fs.mkdirSync(opentasksDir, { recursive: true })

      const identity = generateLocationIdentity(opentasksDir)
      expect(isValidLocationHash(identity.hash)).toBe(true)
    })

    it('different remotes produce different hashes', () => {
      const repo1 = path.join(tmpDir, 'repo1')
      const repo2 = path.join(tmpDir, 'repo2')
      createGitRepo(repo1, 'git@github.com:user/repo1.git')
      createGitRepo(repo2, 'git@github.com:user/repo2.git')

      const hash1 = generateLocationHash('git@github.com:user/repo1.git', '.')
      const hash2 = generateLocationHash('git@github.com:user/repo2.git', '.')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('Connection creation with real filesystem', () => {
    it('creates connection from one location to another', () => {
      const repo1 = path.join(tmpDir, 'mgr-repo')
      const repo2 = path.join(tmpDir, 'wkr-repo')
      createGitRepo(repo1, 'git@github.com:user/manager.git')
      createGitRepo(repo2, 'git@github.com:user/worker.git')

      const mgrHash = generateLocationHash('git@github.com:user/manager.git', '.')
      const wkrHash = generateLocationHash('git@github.com:user/worker.git', '.')

      const mgrDir = createOpentasksDir(repo1, mgrHash, 'manager')
      const wkrDir = createOpentasksDir(repo2, wkrHash, 'worker', 'worker')

      // Create connection from manager → worker
      const conn = createConnection(wkrDir, 'child', mgrDir)
      expect(conn.hash).toBe(wkrHash)
      expect(conn.name).toBe('worker')
      expect(conn.role).toBe('child')

      // Health check
      const status = checkConnectionHealth(conn, mgrDir)
      expect(status.health).toBe('reachable')
    })

    it('add and remove connections', () => {
      const mgrHash = generateLocationHashFallback('/tmp/mgr')
      const wkr1Hash = generateLocationHashFallback('/tmp/wkr1')
      const wkr2Hash = generateLocationHashFallback('/tmp/wkr2')

      let connections: Connection[] = []

      connections = addConnection(connections, {
        hash: wkr1Hash,
        path: '/tmp/wkr1/.opentasks',
        role: 'child',
        name: 'worker-1',
      })
      expect(connections).toHaveLength(1)

      connections = addConnection(connections, {
        hash: wkr2Hash,
        path: '/tmp/wkr2/.opentasks',
        role: 'child',
        name: 'worker-2',
      })
      expect(connections).toHaveLength(2)

      // Adding same hash replaces
      connections = addConnection(connections, {
        hash: wkr1Hash,
        path: '/tmp/wkr1-v2/.opentasks',
        role: 'child',
        name: 'worker-1-v2',
      })
      expect(connections).toHaveLength(2)
      expect(connections.find(c => c.hash === wkr1Hash)?.name).toBe('worker-1-v2')

      // Remove
      connections = removeConnection(connections, wkr1Hash)
      expect(connections).toHaveLength(1)
      expect(connections[0].hash).toBe(wkr2Hash)
    })
  })

  describe('URI resolution with real git repo paths', () => {
    it('resolves cross-location URIs between real repos', () => {
      const repo1 = path.join(tmpDir, 'uri-mgr')
      const repo2 = path.join(tmpDir, 'uri-wkr')
      createGitRepo(repo1, 'git@github.com:user/uri-mgr.git')
      createGitRepo(repo2, 'git@github.com:user/uri-wkr.git')

      const mgrHash = generateLocationHash('git@github.com:user/uri-mgr.git', '.')
      const wkrHash = generateLocationHash('git@github.com:user/uri-wkr.git', '.')

      const mgrDir = createOpentasksDir(repo1, mgrHash, 'manager')
      const wkrDir = createOpentasksDir(repo2, wkrHash, 'worker', 'worker')

      const mgrLoc = { hash: mgrHash, uuid: 'uuid-mgr', name: 'manager' }
      const connections: Connection[] = [
        { hash: wkrHash, path: wkrDir, role: 'child', name: 'worker' },
      ]

      // Build and resolve cross-location URI
      const uri = buildOpentasksUri(wkrHash, 'i-task1')
      const resolved = resolveOpentasksUri(uri, connections, mgrLoc, mgrDir)
      expect(resolved.hash).toBe(wkrHash)
      expect(resolved.nodeId).toBe('i-task1')
      expect(resolved.isLocal).toBe(false)
      expect(resolved.opentasksPath).toBe(wkrDir)
    })

    it('resolves local URI with real paths', () => {
      const repo = path.join(tmpDir, 'local-repo')
      createGitRepo(repo, 'git@github.com:user/local.git')

      const hash = generateLocationHash('git@github.com:user/local.git', '.')
      const opDir = createOpentasksDir(repo, hash, 'local')
      const loc = { hash, uuid: 'uuid-local', name: 'local' }

      const localUri = buildLocalUri('s-spec1')
      const resolved = resolveOpentasksUri(localUri, [], loc, opDir)
      expect(resolved.isLocal).toBe(true)
      expect(resolved.nodeId).toBe('s-spec1')
      expect(resolved.hash).toBe(hash)
    })

    it('resolves absolute path URI', () => {
      const repo = path.join(tmpDir, 'abs-repo')
      createGitRepo(repo, 'git@github.com:user/abs.git')

      const hash = generateLocationHash('git@github.com:user/abs.git', '.')
      const opDir = createOpentasksDir(repo, hash, 'abs')
      const loc = { hash, uuid: 'uuid-abs', name: 'abs' }

      const absUri = `opentasks://${opDir}/i-abs1`
      const resolved = resolveOpentasksUri(absUri, [], loc, opDir)
      expect(resolved.isLocal).toBe(true)
      expect(resolved.nodeId).toBe('i-abs1')
    })
  })

  describe('Worktree setup and teardown with real git repos', () => {
    it('worktreeSetup creates worktree with correct config', () => {
      const repoDir = path.join(tmpDir, 'wt-repo')
      createGitRepo(repoDir, 'git@github.com:user/wt-repo.git')

      const mgrHash = generateLocationHash('git@github.com:user/wt-repo.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      const worktreePath = path.join(tmpDir, 'wt-worker')

      const entry = worktreeSetup(worktreePath, mgrDir, {
        branch: 'feature-test',
        role: 'worker',
        redirectTo: '.',
      })

      // Verify entry
      expect(entry.role).toBe('worker')
      expect(entry.hash).toBeTruthy()
      expect(isValidLocationHash(entry.hash)).toBe(true)
      expect(entry.redirectTarget).toBe(mgrHash)

      // Verify files created
      expect(fs.existsSync(path.join(worktreePath, '.opentasks', 'config.json'))).toBe(true)
      expect(fs.existsSync(path.join(worktreePath, '.opentasks', 'graph.jsonl'))).toBe(true)
      expect(fs.existsSync(path.join(worktreePath, '.opentasks', '.gitignore'))).toBe(true)

      // Verify config
      const config = JSON.parse(
        fs.readFileSync(path.join(worktreePath, '.opentasks', 'config.json'), 'utf-8')
      )
      expect(config.role).toBe('worker')
      expect(config.location.hash).toBe(entry.hash)
      expect(config.connections).toHaveLength(1)
      expect(config.connections[0].hash).toBe(mgrHash)
      expect(config.connections[0].role).toBe('parent')

      // Verify redirect rules
      expect(config.redirects).toHaveLength(1)
      expect(config.redirects[0].pattern).toBe('*')
      expect(config.redirects[0].target).toContain(mgrHash)

      // Verify manager config updated with connection
      const mgrConfig = JSON.parse(
        fs.readFileSync(path.join(mgrDir, 'config.json'), 'utf-8')
      )
      const childConn = mgrConfig.connections.find((c: Connection) => c.hash === entry.hash)
      expect(childConn).toBeTruthy()
      expect(childConn.role).toBe('child')

      // Verify worktree registry
      const gitCommonDir = getGitCommonDir(repoDir)
      expect(gitCommonDir).toBeTruthy()
      const registry = readWorktreeRegistry(gitCommonDir!)
      const registeredEntry = registry.worktrees.find(w => w.hash === entry.hash)
      expect(registeredEntry).toBeTruthy()
      expect(registeredEntry?.role).toBe('worker')
    })

    it('worktreeTeardown removes worktree and connections', () => {
      const repoDir = path.join(tmpDir, 'teardown-repo')
      createGitRepo(repoDir, 'git@github.com:user/teardown.git')

      const mgrHash = generateLocationHash('git@github.com:user/teardown.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      const worktreePath = path.join(tmpDir, 'teardown-worker')

      const entry = worktreeSetup(worktreePath, mgrDir, {
        branch: 'feature-teardown',
        role: 'worker',
      })

      // Verify setup
      expect(fs.existsSync(path.join(worktreePath, '.opentasks'))).toBe(true)

      // Teardown
      const removed = worktreeTeardown(entry.hash, mgrDir, {
        removeGitWorktree: true,
      })

      expect(removed).not.toBeNull()
      expect(removed!.hash).toBe(entry.hash)

      // Verify .opentasks removed
      expect(fs.existsSync(path.join(worktreePath, '.opentasks'))).toBe(false)

      // Verify connection removed from manager
      const mgrConfig = JSON.parse(
        fs.readFileSync(path.join(mgrDir, 'config.json'), 'utf-8')
      )
      expect(mgrConfig.connections.find((c: Connection) => c.hash === entry.hash)).toBeUndefined()

      // Verify unregistered from registry
      const gitCommonDir = getGitCommonDir(repoDir)
      const registry = readWorktreeRegistry(gitCommonDir!)
      expect(registry.worktrees.find(w => w.hash === entry.hash)).toBeUndefined()
    })

    it('worktreeSetup with manager role (no redirect)', () => {
      const repoDir = path.join(tmpDir, 'mgr-setup-repo')
      createGitRepo(repoDir, 'git@github.com:user/mgr-setup.git')

      const mgrHash = generateLocationHash('git@github.com:user/mgr-setup.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      const worktreePath = path.join(tmpDir, 'mgr-worker')

      const entry = worktreeSetup(worktreePath, mgrDir, {
        branch: 'manager-branch',
        role: 'manager',
      })

      expect(entry.role).toBe('manager')
      expect(entry.redirectTarget).toBeUndefined()

      const config = JSON.parse(
        fs.readFileSync(path.join(worktreePath, '.opentasks', 'config.json'), 'utf-8')
      )
      expect(config.redirects).toEqual([])
    })
  })

  describe('Full lifecycle: setup → redirect → merge → teardown', () => {
    it('complete worktree lifecycle with data flow', () => {
      const repoDir = path.join(tmpDir, 'lifecycle-repo')
      createGitRepo(repoDir, 'git@github.com:user/lifecycle.git')

      const mgrHash = generateLocationHash('git@github.com:user/lifecycle.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      // 1. Setup worker worktree
      const workerPath = path.join(tmpDir, 'lifecycle-worker')
      const entry = worktreeSetup(workerPath, mgrDir, {
        branch: 'feature-lifecycle',
        role: 'worker',
        redirectTo: '.',
      })

      // 2. Read worker config to get redirect rules and connections
      const workerConfig = JSON.parse(
        fs.readFileSync(path.join(workerPath, '.opentasks', 'config.json'), 'utf-8')
      )
      const workerLoc = {
        hash: workerConfig.location.hash,
        uuid: workerConfig.location.uuid,
        name: workerConfig.location.name,
      }
      const workerConnections = workerConfig.connections as Connection[]
      const workerRedirects = workerConfig.redirects as RedirectRule[]

      // 3. Verify redirect: writes from worker → manager
      const result = resolveOperationRedirect(
        'write',
        'i-task1',
        workerRedirects,
        workerConnections,
        workerLoc,
        path.join(workerPath, '.opentasks')
      )
      expect(result.redirected).toBe(true)
      expect(result.targetLocation?.hash).toBe(mgrHash)

      // 4. Simulate graph data in both locations
      const mgrGraphPath = path.join(mgrDir, 'graph.jsonl')
      const wkrGraphPath = path.join(workerPath, '.opentasks', 'graph.jsonl')

      // Manager creates a spec
      fs.writeFileSync(mgrGraphPath, JSON.stringify({
        id: 's-spec1',
        title: 'API Spec',
        status: 'draft',
        updated_at: '2025-06-01T10:00:00Z',
      }) + '\n')

      // Worker creates an issue
      fs.writeFileSync(wkrGraphPath, JSON.stringify({
        id: 'i-issue1',
        title: 'Bug Fix',
        status: 'open',
        updated_at: '2025-06-01T11:00:00Z',
      }) + '\n')

      // 5. Merge worker data into manager (simulating git merge)
      const basePath = path.join(tmpDir, 'lifecycle-base.jsonl')
      fs.writeFileSync(basePath, '', 'utf-8') // empty base

      const exitCode = mergeJsonl(basePath, mgrGraphPath, wkrGraphPath)
      expect(exitCode).toBe(0)

      const merged = parseJsonlToMap(mgrGraphPath)
      expect(merged.has('s-spec1')).toBe(true)
      expect(merged.has('i-issue1')).toBe(true)

      // 6. Cross-location URI resolution
      const mgrLoc = { hash: mgrHash, uuid: 'uuid-mgr', name: 'main' }
      const mgrConnections: Connection[] = [
        { hash: entry.hash, path: path.join(workerPath, '.opentasks'), role: 'child', name: 'worker' },
      ]

      const crossUri = buildOpentasksUri(entry.hash, 'i-issue1')
      const resolved = resolveOpentasksUri(crossUri, mgrConnections, mgrLoc, mgrDir)
      expect(resolved.hash).toBe(entry.hash)
      expect(resolved.nodeId).toBe('i-issue1')
      expect(resolved.isLocal).toBe(false)

      // 7. Verify worktree listing
      const gitCommonDir = getGitCommonDir(repoDir)!
      const worktrees = listWorktrees(gitCommonDir)
      const workerEntry = worktrees.find(w => w.hash === entry.hash)
      expect(workerEntry).toBeTruthy()
      expect(workerEntry?.status).toBe('active')
      expect(workerEntry?.branch).toBe('feature-lifecycle')

      // 8. Teardown
      worktreeTeardown(entry.hash, mgrDir, { removeGitWorktree: true })

      const afterTeardown = listWorktrees(gitCommonDir)
      expect(afterTeardown.find(w => w.hash === entry.hash)).toBeUndefined()
    })
  })

  describe('Multiple worktrees with shared registry', () => {
    it('manages multiple workers from same manager', () => {
      const repoDir = path.join(tmpDir, 'multi-repo')
      createGitRepo(repoDir, 'git@github.com:user/multi.git')

      const mgrHash = generateLocationHash('git@github.com:user/multi.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      // Create 3 worker worktrees
      const workers: WorktreeEntry[] = []
      for (let i = 0; i < 3; i++) {
        const workerPath = path.join(tmpDir, `multi-worker-${i}`)
        const entry = worktreeSetup(workerPath, mgrDir, {
          branch: `feature-${i}`,
          role: 'worker',
          redirectTo: '.',
        })
        workers.push(entry)
      }

      // Verify registry has all 3 workers
      const gitCommonDir = getGitCommonDir(repoDir)!
      const worktrees = listWorktrees(gitCommonDir)
      // Registry includes only workers (manager not auto-registered)
      expect(worktrees.length).toBeGreaterThanOrEqual(3)

      // All workers should be active
      for (const worker of workers) {
        const wt = worktrees.find(w => w.hash === worker.hash)
        expect(wt).toBeTruthy()
        expect(wt?.status).toBe('active')
      }

      // Manager config should have all 3 connections
      const mgrConfig = JSON.parse(
        fs.readFileSync(path.join(mgrDir, 'config.json'), 'utf-8')
      )
      expect(mgrConfig.connections).toHaveLength(3)

      // Teardown middle worker
      worktreeTeardown(workers[1].hash, mgrDir, { removeGitWorktree: true })

      const afterTeardown = listWorktrees(gitCommonDir)
      expect(afterTeardown.find(w => w.hash === workers[1].hash)).toBeUndefined()
      expect(afterTeardown.find(w => w.hash === workers[0].hash)).toBeTruthy()
      expect(afterTeardown.find(w => w.hash === workers[2].hash)).toBeTruthy()

      // Manager connections updated
      const mgrConfigAfter = JSON.parse(
        fs.readFileSync(path.join(mgrDir, 'config.json'), 'utf-8')
      )
      expect(mgrConfigAfter.connections).toHaveLength(2)
    })
  })

  describe('Merge driver installation', () => {
    it('installMergeDriver creates .gitattributes entry', () => {
      const repoDir = path.join(tmpDir, 'merge-install')
      createGitRepo(repoDir)

      installMergeDriver(repoDir)

      const attrPath = path.join(repoDir, '.gitattributes')
      expect(fs.existsSync(attrPath)).toBe(true)

      const content = fs.readFileSync(attrPath, 'utf-8')
      expect(content).toContain('merge=opentasks')
      expect(content).toContain('graph.jsonl')
    })

    it('installMergeDriver is idempotent', () => {
      const repoDir = path.join(tmpDir, 'merge-idempotent')
      createGitRepo(repoDir)

      installMergeDriver(repoDir)
      installMergeDriver(repoDir)

      const content = fs.readFileSync(path.join(repoDir, '.gitattributes'), 'utf-8')
      // Should only contain one merge=opentasks entry
      const matches = content.match(/merge=opentasks/g)
      expect(matches).toHaveLength(1)
    })

    it('worktreeSetup installs merge driver', () => {
      const repoDir = path.join(tmpDir, 'wt-merge')
      createGitRepo(repoDir, 'git@github.com:user/wt-merge.git')

      const mgrHash = generateLocationHash('git@github.com:user/wt-merge.git', '.')
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      const workerPath = path.join(tmpDir, 'wt-merge-worker')
      worktreeSetup(workerPath, mgrDir, {
        branch: 'feature-merge',
        role: 'worker',
      })

      // Merge driver should be installed in worker worktree
      const attrPath = path.join(workerPath, '.gitattributes')
      expect(fs.existsSync(attrPath)).toBe(true)
      const content = fs.readFileSync(attrPath, 'utf-8')
      expect(content).toContain('merge=opentasks')
    })
  })

  describe('Git common dir and branch detection', () => {
    it('getGitCommonDir returns .git for main repo', () => {
      const repoDir = path.join(tmpDir, 'common-dir')
      createGitRepo(repoDir)

      const commonDir = getGitCommonDir(repoDir)
      expect(commonDir).toBeTruthy()
      expect(commonDir).toBe(path.join(repoDir, '.git'))
    })

    it('getCurrentBranch returns current branch name', () => {
      const repoDir = path.join(tmpDir, 'branch-test')
      createGitRepo(repoDir)

      // Default branch should be something (usually main or master)
      const branch = getCurrentBranch(repoDir)
      expect(branch).toBeTruthy()
      expect(typeof branch).toBe('string')
    })

    it('getCurrentBranch returns name of created branch', () => {
      const repoDir = path.join(tmpDir, 'branch-create')
      createGitRepo(repoDir)

      execSync('git checkout -b test-branch', { cwd: repoDir, stdio: 'pipe' })
      expect(getCurrentBranch(repoDir)).toBe('test-branch')
    })

    it('getGitCommonDir returns null for non-git directory', () => {
      const nonGitDir = path.join(tmpDir, 'non-git')
      fs.mkdirSync(nonGitDir, { recursive: true })

      expect(getGitCommonDir(nonGitDir)).toBeNull()
    })
  })

  describe('Error handling', () => {
    it('worktreeSetup throws when not in git repo', () => {
      const nonGitDir = path.join(tmpDir, 'no-git')
      fs.mkdirSync(nonGitDir, { recursive: true })
      const fakeOpentasks = path.join(nonGitDir, '.opentasks')
      fs.mkdirSync(fakeOpentasks, { recursive: true })

      expect(() =>
        worktreeSetup(path.join(tmpDir, 'target'), fakeOpentasks)
      ).toThrow()
    })

    it('worktreeSetup throws when manager config is missing', () => {
      const repoDir = path.join(tmpDir, 'no-config')
      createGitRepo(repoDir)

      const fakeOpentasks = path.join(repoDir, '.opentasks')
      fs.mkdirSync(fakeOpentasks, { recursive: true })
      // No config.json

      expect(() =>
        worktreeSetup(path.join(tmpDir, 'target2'), fakeOpentasks)
      ).toThrow('Cannot read manager location identity')
    })

    it('worktreeTeardown throws for non-existent worktree', () => {
      const repoDir = path.join(tmpDir, 'teardown-err')
      createGitRepo(repoDir)

      const mgrHash = generateLocationHashFallback(path.join(repoDir, '.opentasks'))
      const mgrDir = createOpentasksDir(repoDir, mgrHash, 'main')

      expect(() =>
        worktreeTeardown('nonexistent', mgrDir)
      ).toThrow('Worktree not found')
    })
  })
})
