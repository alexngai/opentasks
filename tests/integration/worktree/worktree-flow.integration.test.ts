/**
 * Worktree Flow Integration Tests (Phase 2 + Phase 3)
 *
 * Exercises the full lifecycle:
 *   1. Location identity generation
 *   2. Connection creation and health checking
 *   3. URI parsing and resolution
 *   4. Redirect rules
 *   5. Worktree registry (register/find/list/unregister)
 *   6. Merge driver (three-way merge on JSONL files)
 *   7. Conditional redirect rules
 *   8. File locking for concurrent JSONL writes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'
import {
  generateLocationHash,
  generateLocationHashFallback,
  isValidLocationHash,
} from '../../../src/core/location.js'
import {
  parseOpentasksUri,
  resolveOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
  isOpentasksUri,
} from '../../../src/core/uri.js'
import {
  createConnection,
  checkConnectionHealth,
  addConnection,
  removeConnection,
  checkAllConnectionHealth,
  type Connection,
} from '../../../src/core/connections.js'
import {
  matchPattern,
  findRedirectRule,
  resolveOperationRedirect,
  type RedirectRule,
} from '../../../src/core/redirects.js'
import {
  readWorktreeRegistry,
  writeWorktreeRegistry,
  registerWorktree,
  unregisterWorktree,
  findWorktree,
  listWorktrees,
  type WorktreeEntry,
} from '../../../src/core/worktree.js'
import {
  parseJsonlToMap,
  writeJsonlFromMap,
  fieldLevelMerge,
  mergeJsonl,
} from '../../../src/core/merge-driver.js'
import {
  evaluateConditions,
  findConditionalRedirectRule,
  type ConditionalRedirectRule,
} from '../../../src/core/conditional-redirects.js'
import { FileLock, withFileLock } from '../../../src/storage/file-lock.js'

describe.skipIf(!SLOW_TESTS)('Worktree Flow Integration', () => {
  let tempDir: TempDirContext

  beforeEach(async () => {
    tempDir = await withTempDir('worktree-flow-')
  })

  afterEach(async () => {
    await tempDir.cleanup()
  })

  describe('Phase 2: Location identity + connections + URIs', () => {
    it('generates deterministic hashes from remote + path', () => {
      const hash1 = generateLocationHash('git@github.com:user/repo.git', '.')
      const hash2 = generateLocationHash('git@github.com:user/repo.git', '.')
      const hash3 = generateLocationHash('git@github.com:user/other.git', '.')

      expect(hash1).toBe(hash2)
      expect(hash1).not.toBe(hash3)
      expect(isValidLocationHash(hash1)).toBe(true)
    })

    it('generates fallback hashes from absolute paths', () => {
      const hash1 = generateLocationHashFallback('/home/user/repo/.opentasks')
      const hash2 = generateLocationHashFallback('/home/user/other/.opentasks')

      expect(hash1).not.toBe(hash2)
      expect(isValidLocationHash(hash1)).toBe(true)
      expect(isValidLocationHash(hash2)).toBe(true)
    })

    it('creates and health-checks connections via config.json', async () => {
      // Create two simulated .opentasks directories
      const managerDir = await tempDir.mkdir('manager/.opentasks')
      const workerDir = await tempDir.mkdir('worker/.opentasks')

      const managerHash = generateLocationHashFallback(managerDir)
      const workerHash = generateLocationHashFallback(workerDir)

      // Write config.json files
      await tempDir.writeFile('manager/.opentasks/config.json', JSON.stringify({
        location: { hash: managerHash, uuid: 'uuid-manager', name: 'manager' },
      }))
      await tempDir.writeFile('worker/.opentasks/config.json', JSON.stringify({
        location: { hash: workerHash, uuid: 'uuid-worker', name: 'worker' },
      }))

      // Create connection from manager → worker
      const conn = createConnection(workerDir, 'child', managerDir)
      expect(conn.hash).toBe(workerHash)
      expect(conn.name).toBe('worker')

      // Health check should be reachable
      const status = checkConnectionHealth(conn, managerDir)
      expect(status.health).toBe('reachable')

      // Health check with wrong hash should report mismatch
      const badConn = { ...conn, hash: 'badh4sh1' }
      const badStatus = checkConnectionHealth(badConn, managerDir)
      expect(badStatus.health).toBe('hash-mismatch')

      // Unreachable path
      const unreachableConn = { ...conn, path: '/nonexistent/.opentasks' }
      const unreachableStatus = checkConnectionHealth(unreachableConn)
      expect(unreachableStatus.health).toBe('unreachable')
    })

    it('parses and resolves opentasks:// URIs end-to-end', async () => {
      const managerDir = await tempDir.mkdir('mgr/.opentasks')
      const workerDir = await tempDir.mkdir('wkr/.opentasks')

      const managerHash = generateLocationHashFallback(managerDir)
      const workerHash = generateLocationHashFallback(workerDir)

      const currentLocation = { hash: managerHash, uuid: 'u1', name: 'mgr' }
      const connections: Connection[] = [{
        hash: workerHash,
        path: workerDir,
        role: 'child',
        name: 'wkr',
      }]

      // Parse hash-based URI
      const uri1 = buildOpentasksUri(workerHash, 'i-test123')
      expect(isOpentasksUri(uri1)).toBe(true)
      const parsed1 = parseOpentasksUri(uri1)
      expect(parsed1?.locationHash).toBe(workerHash)
      expect(parsed1?.nodeId).toBe('i-test123')

      // Resolve to connected location
      const resolved1 = resolveOpentasksUri(uri1, connections, currentLocation, managerDir)
      expect(resolved1.hash).toBe(workerHash)
      expect(resolved1.isLocal).toBe(false)

      // Parse and resolve local URI
      const localUri = buildLocalUri('s-spec1')
      const resolved2 = resolveOpentasksUri(localUri, connections, currentLocation, managerDir)
      expect(resolved2.hash).toBe(managerHash)
      expect(resolved2.isLocal).toBe(true)

      // Parse absolute path URI
      const absUri = `opentasks://${managerDir}/i-abs1`
      const parsed3 = parseOpentasksUri(absUri)
      expect(parsed3?.absolutePath).toBe(managerDir)
      const resolved3 = resolveOpentasksUri(absUri, connections, currentLocation, managerDir)
      expect(resolved3.isLocal).toBe(true)
    })

    it('redirect rules route operations to correct targets', async () => {
      const managerDir = await tempDir.mkdir('mgr/.opentasks')
      const workerDir = await tempDir.mkdir('wkr/.opentasks')

      const managerHash = generateLocationHashFallback(managerDir)
      const workerHash = generateLocationHashFallback(workerDir)

      const currentLocation = { hash: workerHash, uuid: 'u2', name: 'wkr' }
      const connections: Connection[] = [{
        hash: managerHash,
        path: managerDir,
        role: 'parent',
        name: 'mgr',
      }]

      const rules: RedirectRule[] = [
        {
          operations: ['read', 'write'],
          pattern: 's-*',
          target: `opentasks://${managerHash}/`,
          priority: 10,
          fallback: 'error',
        },
        {
          operations: ['read'],
          pattern: '*',
          target: `opentasks://${managerHash}/`,
          priority: 100,
          fallback: 'local',
        },
      ]

      // Write to spec → redirected to manager
      const result1 = resolveOperationRedirect(
        'write', 's-spec1', rules, connections, currentLocation, workerDir
      )
      expect(result1.redirected).toBe(true)
      expect(result1.resolved?.hash).toBe(managerHash)

      // Read anything → redirected to manager
      const result2 = resolveOperationRedirect(
        'read', 'i-issue1', rules, connections, currentLocation, workerDir
      )
      expect(result2.redirected).toBe(true)

      // Write non-spec → no redirect (no matching rule)
      const result3 = resolveOperationRedirect(
        'write', 'i-issue1', rules, connections, currentLocation, workerDir
      )
      expect(result3.redirected).toBe(false)
    })
  })

  describe('Phase 3: Worktree registry', () => {
    let gitCommonDir: string

    beforeEach(async () => {
      gitCommonDir = await tempDir.mkdir('.git')
      await tempDir.mkdir('.git/opentasks')
    })

    it('full registry lifecycle: register → find → list → unregister', () => {
      const entry1: WorktreeEntry = {
        path: tempDir.resolve('worktree-a'),
        opentasksPath: tempDir.resolve('worktree-a/.opentasks'),
        hash: 'aaaa1111',
        branch: 'feature-a',
        role: 'worker',
      }
      const entry2: WorktreeEntry = {
        path: tempDir.resolve('worktree-b'),
        opentasksPath: tempDir.resolve('worktree-b/.opentasks'),
        hash: 'bbbb2222',
        branch: 'feature-b',
        role: 'worker',
      }

      // Register both
      registerWorktree(gitCommonDir, entry1)
      registerWorktree(gitCommonDir, entry2)

      // List should show both
      const registry = readWorktreeRegistry(gitCommonDir)
      expect(registry.worktrees).toHaveLength(2)

      // Find by hash
      const found1 = findWorktree(gitCommonDir, 'aaaa1111')
      expect(found1?.branch).toBe('feature-a')

      // Find by path
      const found2 = findWorktree(gitCommonDir, tempDir.resolve('worktree-b'))
      expect(found2?.hash).toBe('bbbb2222')

      // Create the .opentasks dir for entry1 to test status
      fs.mkdirSync(entry1.opentasksPath, { recursive: true })

      // List with status
      const list = listWorktrees(gitCommonDir)
      expect(list).toHaveLength(2)
      const active = list.find(w => w.hash === 'aaaa1111')
      const unreachable = list.find(w => w.hash === 'bbbb2222')
      expect(active?.status).toBe('active')
      expect(unreachable?.status).toBe('unreachable')

      // Unregister entry1
      const removed = unregisterWorktree(gitCommonDir, 'aaaa1111')
      expect(removed?.hash).toBe('aaaa1111')

      const after = readWorktreeRegistry(gitCommonDir)
      expect(after.worktrees).toHaveLength(1)
      expect(after.worktrees[0].hash).toBe('bbbb2222')
    })

    it('re-register updates existing entry', () => {
      registerWorktree(gitCommonDir, {
        path: '/path/a',
        opentasksPath: '/path/a/.opentasks',
        hash: 'cccc3333',
        branch: 'main',
        role: 'manager',
      })

      registerWorktree(gitCommonDir, {
        path: '/path/a-v2',
        opentasksPath: '/path/a-v2/.opentasks',
        hash: 'cccc3333',
        branch: 'develop',
        role: 'worker',
      })

      const registry = readWorktreeRegistry(gitCommonDir)
      expect(registry.worktrees).toHaveLength(1)
      expect(registry.worktrees[0].branch).toBe('develop')
      expect(registry.worktrees[0].path).toBe('/path/a-v2')
    })
  })

  describe('Phase 3: JSONL three-way merge', () => {
    it('handles full merge scenario: additions, modifications, and deletions', () => {
      // Base has 3 issues
      const basePath = tempDir.resolve('base.jsonl')
      const oursPath = tempDir.resolve('ours.jsonl')
      const theirsPath = tempDir.resolve('theirs.jsonl')

      const baseEntries = [
        { id: 'i-1', title: 'Issue 1', status: 'open', priority: 1, updated_at: '2025-01-01T00:00:00Z' },
        { id: 'i-2', title: 'Issue 2', status: 'open', priority: 2, updated_at: '2025-01-01T00:00:00Z' },
        { id: 'i-3', title: 'Issue 3', status: 'open', priority: 3, updated_at: '2025-01-01T00:00:00Z' },
      ]

      // Ours: changed i-1 status to closed, added i-4, deleted i-3
      const oursEntries = [
        { id: 'i-1', title: 'Issue 1', status: 'closed', priority: 1, updated_at: '2025-01-01T02:00:00Z' },
        { id: 'i-2', title: 'Issue 2', status: 'open', priority: 2, updated_at: '2025-01-01T00:00:00Z' },
        { id: 'i-4', title: 'New Our Issue', status: 'open', priority: 1, updated_at: '2025-01-01T01:00:00Z' },
      ]

      // Theirs: changed i-2 title, added i-5, changed i-3 priority
      const theirsEntries = [
        { id: 'i-1', title: 'Issue 1', status: 'open', priority: 1, updated_at: '2025-01-01T00:00:00Z' },
        { id: 'i-2', title: 'Updated Issue 2', status: 'open', priority: 2, updated_at: '2025-01-01T01:00:00Z' },
        { id: 'i-3', title: 'Issue 3', status: 'open', priority: 5, updated_at: '2025-01-01T01:00:00Z' },
        { id: 'i-5', title: 'New Their Issue', status: 'open', priority: 1, updated_at: '2025-01-01T01:00:00Z' },
      ]

      fs.writeFileSync(basePath, baseEntries.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(oursPath, oursEntries.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(theirsPath, theirsEntries.map(e => JSON.stringify(e)).join('\n') + '\n')

      const exitCode = mergeJsonl(basePath, oursPath, theirsPath)
      expect(exitCode).toBe(0)

      const result = parseJsonlToMap(oursPath)

      // i-1: ours changed status to closed, theirs didn't → closed
      expect(result.get('i-1')?.status).toBe('closed')

      // i-2: theirs changed title → Updated Issue 2
      expect(result.get('i-2')?.title).toBe('Updated Issue 2')

      // i-3: ours deleted but theirs modified → keep theirs' modification
      expect(result.has('i-3')).toBe(true)
      expect(result.get('i-3')?.priority).toBe(5)

      // i-4: added by ours → present
      expect(result.has('i-4')).toBe(true)
      expect(result.get('i-4')?.title).toBe('New Our Issue')

      // i-5: added by theirs → present
      expect(result.has('i-5')).toBe(true)
      expect(result.get('i-5')?.title).toBe('New Their Issue')
    })

    it('field-level merge resolves concurrent edits on same node', () => {
      const base = {
        id: 'i-conflict',
        title: 'Original',
        status: 'open',
        priority: 1,
        assignee: 'alice',
        updated_at: '2025-01-01T00:00:00Z',
      }
      const ours = {
        id: 'i-conflict',
        title: 'Original',
        status: 'closed',
        priority: 1,
        assignee: 'alice',
        updated_at: '2025-01-01T01:00:00Z',
      }
      const theirs = {
        id: 'i-conflict',
        title: 'Updated Title',
        status: 'open',
        priority: 3,
        assignee: 'bob',
        updated_at: '2025-01-01T02:00:00Z',
      }

      const merged = fieldLevelMerge(base, ours, theirs)

      // title: only theirs changed → theirs
      expect(merged.title).toBe('Updated Title')
      // status: ours closed, theirs kept open → ours
      expect(merged.status).toBe('closed')
      // priority: only theirs changed → theirs
      expect(merged.priority).toBe(3)
      // assignee: both changed (base: alice, ours: alice, theirs: bob)
      // → only theirs changed, so theirs wins
      expect(merged.assignee).toBe('bob')
      // updated_at: always latest
      expect(merged.updated_at).toBe('2025-01-01T02:00:00Z')
    })

    it('writeJsonlFromMap orders nodes before edges', () => {
      const map = new Map<string, Record<string, unknown>>()
      map.set('x-edge1', { id: 'x-edge1', from_id: 'i-1', to_id: 'i-2', type: 'blocks' })
      map.set('i-1', { id: 'i-1', title: 'Issue 1' })
      map.set('s-spec1', { id: 's-spec1', title: 'Spec 1' })
      map.set('x-edge2', { id: 'x-edge2', from_id: 'i-2', to_id: 's-spec1', type: 'implements' })
      map.set('i-2', { id: 'i-2', title: 'Issue 2' })

      const outputPath = tempDir.resolve('output.jsonl')
      writeJsonlFromMap(outputPath, map)

      const lines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(5)

      // First 3 should be nodes (non x- prefix)
      const first3Ids = lines.slice(0, 3).map(l => JSON.parse(l).id)
      expect(first3Ids.every((id: string) => !id.startsWith('x-'))).toBe(true)

      // Last 2 should be edges (x- prefix)
      const last2Ids = lines.slice(3).map(l => JSON.parse(l).id)
      expect(last2Ids.every((id: string) => id.startsWith('x-'))).toBe(true)
    })
  })

  describe('Phase 3: Conditional redirects', () => {
    it('evaluates role and branch conditions', () => {
      // Role match
      expect(evaluateConditions({ role: 'worker' }, { role: 'worker' })).toBe(true)
      expect(evaluateConditions({ role: 'worker' }, { role: 'manager' })).toBe(false)

      // Branch glob
      expect(evaluateConditions(
        { branch: 'feature-*' },
        { role: 'worker', branch: 'feature-auth' }
      )).toBe(true)
      expect(evaluateConditions(
        { branch: 'feature-*' },
        { role: 'worker', branch: 'main' }
      )).toBe(false)

      // Combined
      expect(evaluateConditions(
        { role: 'worker', branch: 'feature-*' },
        { role: 'worker', branch: 'feature-x' }
      )).toBe(true)
      expect(evaluateConditions(
        { role: 'worker', branch: 'feature-*' },
        { role: 'manager', branch: 'feature-x' }
      )).toBe(false)
    })

    it('finds conditional redirect rules respecting context', () => {
      const rules: ConditionalRedirectRule[] = [
        {
          operations: ['write'],
          pattern: 's-*',
          target: 'opentasks://specs/',
          priority: 50,
          fallback: 'error',
          when: { role: 'worker' },
        },
        {
          operations: ['read', 'write'],
          pattern: '*',
          target: 'opentasks://default/',
          priority: 200,
          fallback: 'local',
        },
      ]

      // Worker writing spec → matches first rule
      const rule1 = findConditionalRedirectRule('write', 's-abc', rules, { role: 'worker' })
      expect(rule1?.target).toBe('opentasks://specs/')

      // Manager writing spec → skips first rule (role mismatch), matches fallback
      const rule2 = findConditionalRedirectRule('write', 's-abc', rules, { role: 'manager' })
      expect(rule2?.target).toBe('opentasks://default/')
    })
  })

  describe('Phase 2: File lock serialization', () => {
    it('prevents concurrent writes via file lock', async () => {
      const lockPath = tempDir.resolve('test.lock')
      const dataPath = tempDir.resolve('counter.txt')
      fs.writeFileSync(dataPath, '0', 'utf-8')

      // Run multiple concurrent locked writes
      const iterations = 10
      const promises = Array.from({ length: iterations }, async (_, i) => {
        await withFileLock(lockPath, async () => {
          const current = parseInt(fs.readFileSync(dataPath, 'utf-8'), 10)
          // Small delay to simulate work and increase conflict window
          await new Promise(resolve => setTimeout(resolve, 5))
          fs.writeFileSync(dataPath, String(current + 1), 'utf-8')
        })
      })

      await Promise.all(promises)

      const final = parseInt(fs.readFileSync(dataPath, 'utf-8'), 10)
      expect(final).toBe(iterations)
    })

    it('lock acquire and release lifecycle', async () => {
      const lockPath = tempDir.resolve('lifecycle.lock')
      const lock = new FileLock({ lockPath })

      // Should acquire successfully (returns void on success, throws on failure)
      await lock.acquire()
      expect(lock.isLocked).toBe(true)
      expect(fs.existsSync(lockPath)).toBe(true)

      // Release
      lock.release()
      expect(lock.isLocked).toBe(false)
      expect(fs.existsSync(lockPath)).toBe(false)
    })
  })

  describe('End-to-end: multi-location setup', () => {
    it('simulates manager + worker connection flow', async () => {
      // 1. Create manager location
      const managerOpentasks = await tempDir.mkdir('manager/.opentasks')
      const managerHash = generateLocationHashFallback(managerOpentasks)
      await tempDir.writeFile('manager/.opentasks/config.json', JSON.stringify({
        version: '1.0',
        location: { hash: managerHash, uuid: 'uuid-mgr', name: 'manager' },
        role: 'manager',
        connections: [],
        redirects: [],
      }))

      // 2. Create worker location
      const workerOpentasks = await tempDir.mkdir('worker/.opentasks')
      const workerHash = generateLocationHashFallback(workerOpentasks)
      await tempDir.writeFile('worker/.opentasks/config.json', JSON.stringify({
        version: '1.0',
        location: { hash: workerHash, uuid: 'uuid-wkr', name: 'worker' },
        role: 'worker',
        connections: [],
        redirects: [],
      }))

      // 3. Create connection from manager → worker
      const mgrToWkr = createConnection(workerOpentasks, 'child', managerOpentasks)
      expect(mgrToWkr.hash).toBe(workerHash)

      // 4. Create connection from worker → manager
      const wkrToMgr = createConnection(managerOpentasks, 'parent', workerOpentasks)
      expect(wkrToMgr.hash).toBe(managerHash)

      // 5. Health check both directions
      const statuses = checkAllConnectionHealth([mgrToWkr], managerOpentasks)
      expect(statuses[0].health).toBe('reachable')

      // 6. Worker config with redirect rules
      const workerRedirects: RedirectRule[] = [{
        operations: ['read', 'write'],
        pattern: '*',
        target: `opentasks://${managerHash}/`,
        priority: 100,
        fallback: 'error',
      }]

      // 7. URI resolution from worker context
      const workerLocation = { hash: workerHash, uuid: 'uuid-wkr', name: 'worker' }
      const workerConnections: Connection[] = [wkrToMgr]

      // Resolve redirect: worker writes get redirected to manager
      const redirectResult = resolveOperationRedirect(
        'write', 'i-task1', workerRedirects, workerConnections, workerLocation, workerOpentasks
      )
      expect(redirectResult.redirected).toBe(true)
      expect(redirectResult.resolved?.hash).toBe(managerHash)

      // 8. Build cross-location URI from manager context
      const crossUri = buildOpentasksUri(workerHash, 'i-worker-issue')
      const managerLocation = { hash: managerHash, uuid: 'uuid-mgr', name: 'manager' }
      const managerConnections: Connection[] = [mgrToWkr]

      const resolved = resolveOpentasksUri(crossUri, managerConnections, managerLocation, managerOpentasks)
      expect(resolved.hash).toBe(workerHash)
      expect(resolved.nodeId).toBe('i-worker-issue')
      expect(resolved.isLocal).toBe(false)

      // 9. Register both in worktree registry
      const gitCommonDir = await tempDir.mkdir('.git')
      await tempDir.mkdir('.git/opentasks')

      registerWorktree(gitCommonDir, {
        path: tempDir.resolve('manager'),
        opentasksPath: managerOpentasks,
        hash: managerHash,
        branch: 'main',
        role: 'manager',
      })

      registerWorktree(gitCommonDir, {
        path: tempDir.resolve('worker'),
        opentasksPath: workerOpentasks,
        hash: workerHash,
        branch: 'feature-x',
        role: 'worker',
        redirectTarget: managerHash,
      })

      const worktrees = listWorktrees(gitCommonDir)
      expect(worktrees).toHaveLength(2)
      expect(worktrees.every(w => w.status === 'active')).toBe(true)

      // 10. Test merge on shared graph.jsonl
      const basePath = tempDir.resolve('graph-base.jsonl')
      const mgrPath = tempDir.resolve('graph-mgr.jsonl')
      const wkrPath = tempDir.resolve('graph-wkr.jsonl')

      const baseGraph = [
        { id: 'i-shared', title: 'Shared Issue', status: 'open', updated_at: '2025-01-01T00:00:00Z' },
      ]
      const mgrGraph = [
        { id: 'i-shared', title: 'Shared Issue', status: 'closed', updated_at: '2025-01-01T02:00:00Z' },
        { id: 'i-mgr-new', title: 'Manager Added', status: 'open', updated_at: '2025-01-01T01:00:00Z' },
      ]
      const wkrGraph = [
        { id: 'i-shared', title: 'Updated by Worker', status: 'open', updated_at: '2025-01-01T01:00:00Z' },
        { id: 'i-wkr-new', title: 'Worker Added', status: 'open', updated_at: '2025-01-01T01:00:00Z' },
      ]

      fs.writeFileSync(basePath, baseGraph.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(mgrPath, mgrGraph.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(wkrPath, wkrGraph.map(e => JSON.stringify(e)).join('\n') + '\n')

      const mergeResult = mergeJsonl(basePath, mgrPath, wkrPath)
      expect(mergeResult).toBe(0)

      const merged = parseJsonlToMap(mgrPath)
      // i-shared: manager changed status to closed, worker changed title
      expect(merged.get('i-shared')?.status).toBe('closed')
      expect(merged.get('i-shared')?.title).toBe('Updated by Worker')
      // Both additions present
      expect(merged.has('i-mgr-new')).toBe(true)
      expect(merged.has('i-wkr-new')).toBe(true)
    })
  })
})
