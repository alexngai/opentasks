/**
 * Integration Tests: Redirect + Location Resolution Flow
 *
 * Tests the full flow from redirect rule matching through
 * resolveLocationTarget to final RedirectResult, using real
 * filesystem state and config files.
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
  generateLocationHashFallback,
} from '../../../src/core/location.js'
import {
  resolveLocationTarget,
  resolveOpentasksUri,
  buildOpentasksUri,
} from '../../../src/core/uri.js'
import {
  createConnection,
  checkConnectionHealth,
  checkAllConnectionHealth,
  type Connection,
} from '../../../src/core/connections.js'
import {
  matchPattern,
  findRedirectRule,
  resolveRedirect,
  resolveOperationRedirect,
  type RedirectRule,
} from '../../../src/core/redirects.js'
import {
  evaluateConditions,
  findConditionalRedirectRule,
  type ConditionalRedirectRule,
} from '../../../src/core/conditional-redirects.js'
import {
  registerWorktree,
  findWorktree,
  listWorktrees,
  readWorktreeRegistry,
  type WorktreeEntry,
} from '../../../src/core/worktree.js'
import {
  mergeJsonl,
  parseJsonlToMap,
  installMergeDriver,
} from '../../../src/core/merge-driver.js'

describe.skipIf(!SLOW_TESTS)('Redirect + Location Resolution Integration', () => {
  let tempDir: TempDirContext

  beforeEach(async () => {
    tempDir = await withTempDir('redirect-loc-')
  })

  afterEach(async () => {
    await tempDir.cleanup()
  })

  /**
   * Helper: create a simulated .opentasks location with config.json
   */
  async function createLocation(
    name: string,
    role: string = 'manager'
  ): Promise<{ dir: string; hash: string; config: Record<string, unknown> }> {
    const dir = await tempDir.mkdir(`${name}/.opentasks`)
    const hash = generateLocationHashFallback(dir)
    const config = {
      version: '1.0',
      location: { hash, uuid: `uuid-${name}`, name },
      role,
      connections: [] as Connection[],
      redirects: [] as RedirectRule[],
    }
    await tempDir.writeFile(`${name}/.opentasks/config.json`, JSON.stringify(config, null, 2))
    return { dir, hash, config }
  }

  describe('resolveLocationTarget with real filesystem connections', () => {
    it('resolves via createConnection → resolveLocationTarget', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      // Create connection from manager to worker via filesystem
      const conn = createConnection(worker.dir, 'child', manager.dir)
      expect(conn.hash).toBe(worker.hash)

      // Resolve worker hash from manager context
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }
      const result = resolveLocationTarget(
        worker.hash,
        [conn],
        managerLoc,
        manager.dir
      )
      expect(result.hash).toBe(worker.hash)
      expect(result.isLocal).toBe(false)
    })

    it('health check validates hash matches config.json', async () => {
      const loc = await createLocation('target')
      const conn: Connection = {
        hash: loc.hash,
        path: loc.dir,
        role: 'peer',
        name: 'target',
      }

      const status = checkConnectionHealth(conn)
      expect(status.health).toBe('reachable')

      // Modify config.json to have different hash
      const config = JSON.parse(fs.readFileSync(path.join(loc.dir, 'config.json'), 'utf-8'))
      config.location.hash = 'tampered'
      fs.writeFileSync(path.join(loc.dir, 'config.json'), JSON.stringify(config))

      const badStatus = checkConnectionHealth(conn)
      expect(badStatus.health).toBe('hash-mismatch')
    })

    it('checkAllConnectionHealth reports mixed results', async () => {
      const loc1 = await createLocation('reachable')
      const connections: Connection[] = [
        { hash: loc1.hash, path: loc1.dir, role: 'peer', name: 'reachable' },
        { hash: 'ghost123', path: '/nonexistent/.opentasks', role: 'peer', name: 'ghost' },
      ]

      const statuses = checkAllConnectionHealth(connections)
      expect(statuses).toHaveLength(2)
      expect(statuses[0].health).toBe('reachable')
      expect(statuses[1].health).toBe('unreachable')
    })
  })

  describe('redirect rules with resolveLocationTarget', () => {
    it('full redirect flow: findRedirectRule → resolveRedirect → result', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }
      const connections: Connection[] = [
        { hash: worker.hash, path: worker.dir, role: 'child', name: 'worker' },
      ]

      const rules: RedirectRule[] = [
        {
          operations: ['read', 'write'],
          pattern: 's-*',
          target: `opentasks://${worker.hash}/`,
          priority: 50,
          fallback: 'error',
        },
        {
          operations: ['read'],
          pattern: '*',
          target: `opentasks://${worker.hash}/`,
          priority: 100,
          fallback: 'local',
        },
      ]

      // Step 1: find matching rule
      const rule = findRedirectRule('write', 's-spec1', rules)
      expect(rule).not.toBeNull()
      expect(rule!.priority).toBe(50)

      // Step 2: resolve redirect target
      const target = resolveRedirect(rule!, connections, managerLoc, manager.dir)
      expect(target).not.toBeNull()
      expect(target!.hash).toBe(worker.hash)
      expect(target!.isLocal).toBe(false)

      // Step 3: full resolveOperationRedirect
      const result = resolveOperationRedirect(
        'write', 's-spec1', rules, connections, managerLoc, manager.dir
      )
      expect(result.redirected).toBe(true)
      expect(result.targetLocation?.hash).toBe(worker.hash)
    })

    it('fallback=local when target location is unreachable', async () => {
      const manager = await createLocation('manager')
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }

      const rules: RedirectRule[] = [
        {
          operations: ['read'],
          pattern: '*',
          target: 'opentasks://ghosthash/',
          priority: 100,
          fallback: 'local',
        },
      ]

      const result = resolveOperationRedirect(
        'read', 'i-test', rules, [], managerLoc, manager.dir
      )
      // Target can't be resolved → fallback=local → not redirected
      expect(result.redirected).toBe(false)
    })

    it('fallback=error when target location is unreachable', async () => {
      const manager = await createLocation('manager')
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }

      const rules: RedirectRule[] = [
        {
          operations: ['write'],
          pattern: '*',
          target: 'opentasks://ghosthash/',
          priority: 100,
          fallback: 'error',
        },
      ]

      expect(() =>
        resolveOperationRedirect(
          'write', 'i-test', rules, [], managerLoc, manager.dir
        )
      ).toThrow('Redirect target unreachable')
    })

    it('redirect target points to current location (self-redirect)', async () => {
      const manager = await createLocation('manager')
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }

      const rules: RedirectRule[] = [
        {
          operations: ['read', 'write'],
          pattern: '*',
          target: `opentasks://${manager.hash}/`,
          priority: 100,
          fallback: 'error',
        },
      ]

      const result = resolveOperationRedirect(
        'read', 'i-test', rules, [], managerLoc, manager.dir
      )
      expect(result.redirected).toBe(true)
      expect(result.targetLocation?.isLocal).toBe(true)
    })

    it('redirect using "." shorthand target', async () => {
      const manager = await createLocation('manager')
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }

      const rules: RedirectRule[] = [
        {
          operations: ['read'],
          pattern: '*',
          target: '.',
          priority: 100,
          fallback: 'error',
        },
      ]

      const result = resolveOperationRedirect(
        'read', 'i-test', rules, [], managerLoc, manager.dir
      )
      expect(result.redirected).toBe(true)
      expect(result.targetLocation?.isLocal).toBe(true)
      expect(result.targetLocation?.hash).toBe(manager.hash)
    })

    it('no matching rules returns non-redirected', async () => {
      const manager = await createLocation('manager')
      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }

      const result = resolveOperationRedirect(
        'write', 'i-test', [], [], managerLoc, manager.dir
      )
      expect(result.redirected).toBe(false)
      expect(result.targetLocation).toBeUndefined()
      expect(result.rule).toBeUndefined()
    })
  })

  describe('conditional redirects with real locations', () => {
    it('worker role + branch condition routes correctly', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      const connections: Connection[] = [
        { hash: manager.hash, path: manager.dir, role: 'parent', name: 'manager' },
      ]

      const rules: ConditionalRedirectRule[] = [
        {
          operations: ['write'],
          pattern: 's-*',
          target: `opentasks://${manager.hash}/`,
          priority: 50,
          fallback: 'error',
          when: { role: 'worker', branch: 'feature-*' },
        },
        {
          operations: ['read', 'write'],
          pattern: '*',
          target: `opentasks://${manager.hash}/`,
          priority: 100,
          fallback: 'local',
        },
      ]

      // Worker on feature branch → conditional rule matches
      const workerCtx = { role: 'worker', branch: 'feature-auth' }
      const rule1 = findConditionalRedirectRule('write', 's-spec1', rules, workerCtx)
      expect(rule1?.priority).toBe(50)

      // Manager on feature branch → conditional rule skipped (wrong role)
      const mgrCtx = { role: 'manager', branch: 'feature-auth' }
      const rule2 = findConditionalRedirectRule('write', 's-spec1', rules, mgrCtx)
      expect(rule2?.priority).toBe(100) // falls through to wildcard

      // Worker on main branch → conditional rule skipped (wrong branch)
      const mainCtx = { role: 'worker', branch: 'main' }
      const rule3 = findConditionalRedirectRule('write', 's-spec1', rules, mainCtx)
      expect(rule3?.priority).toBe(100) // falls through to wildcard
    })

    it('evaluateConditions handles edge cases', () => {
      // No conditions → always true
      expect(evaluateConditions(undefined, { role: 'worker' })).toBe(true)
      expect(evaluateConditions({}, { role: 'worker' })).toBe(true)

      // Branch condition without branch in context → false
      expect(evaluateConditions({ branch: 'feature-*' }, { role: 'worker' })).toBe(false)

      // Branch suffix matching
      expect(evaluateConditions({ branch: '*-release' }, { role: 'worker', branch: 'v2-release' })).toBe(true)
      expect(evaluateConditions({ branch: '*-release' }, { role: 'worker', branch: 'v2-beta' })).toBe(false)
    })
  })

  describe('pattern matching edge cases', () => {
    it('exact ID match', () => {
      expect(matchPattern('i-specific', 'i-specific')).toBe(true)
      expect(matchPattern('i-specific', 'i-other')).toBe(false)
    })

    it('multiple prefix patterns', () => {
      const rules: RedirectRule[] = [
        { operations: ['read', 'write'], pattern: 's-*', target: 'opentasks://specs/', priority: 10, fallback: 'error' },
        { operations: ['read', 'write'], pattern: 'i-*', target: 'opentasks://issues/', priority: 20, fallback: 'error' },
        { operations: ['read', 'write'], pattern: 'x-*', target: 'opentasks://edges/', priority: 30, fallback: 'error' },
      ]

      expect(findRedirectRule('read', 's-abc', rules)?.target).toBe('opentasks://specs/')
      expect(findRedirectRule('read', 'i-abc', rules)?.target).toBe('opentasks://issues/')
      expect(findRedirectRule('read', 'x-abc', rules)?.target).toBe('opentasks://edges/')
    })

    it('priority ordering: lower number wins', () => {
      const rules: RedirectRule[] = [
        { operations: ['read'], pattern: '*', target: 'opentasks://low/', priority: 200, fallback: 'local' },
        { operations: ['read'], pattern: 'i-*', target: 'opentasks://high/', priority: 10, fallback: 'error' },
        { operations: ['read'], pattern: 'i-*', target: 'opentasks://mid/', priority: 50, fallback: 'local' },
      ]

      const rule = findRedirectRule('read', 'i-test', rules)
      expect(rule?.priority).toBe(10)
      expect(rule?.target).toBe('opentasks://high/')
    })

    it('operation filtering: write-only rule not matched for read', () => {
      const rules: RedirectRule[] = [
        { operations: ['write'], pattern: '*', target: 'opentasks://write-only/', priority: 10, fallback: 'error' },
      ]

      expect(findRedirectRule('read', 'i-test', rules)).toBeNull()
      expect(findRedirectRule('write', 'i-test', rules)?.target).toBe('opentasks://write-only/')
    })
  })

  describe('multi-location redirect chain', () => {
    it('worker redirects to manager, manager operates locally', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      const managerLoc = { hash: manager.hash, uuid: 'uuid-mgr', name: 'manager' }
      const workerLoc = { hash: worker.hash, uuid: 'uuid-wkr', name: 'worker' }

      // Worker → manager connection
      const wkrToMgr: Connection = { hash: manager.hash, path: manager.dir, role: 'parent', name: 'manager' }
      // Manager → worker connection
      const mgrToWkr: Connection = { hash: worker.hash, path: worker.dir, role: 'child', name: 'worker' }

      // Worker redirect rules: all writes go to manager
      const workerRules: RedirectRule[] = [
        {
          operations: ['read', 'write'],
          pattern: '*',
          target: `opentasks://${manager.hash}/`,
          priority: 100,
          fallback: 'error',
        },
      ]

      // Manager has no redirect rules (operates locally)
      const managerRules: RedirectRule[] = []

      // Worker context: write i-task1 → redirected to manager
      const workerResult = resolveOperationRedirect(
        'write', 'i-task1', workerRules, [wkrToMgr], workerLoc, worker.dir
      )
      expect(workerResult.redirected).toBe(true)
      expect(workerResult.targetLocation?.hash).toBe(manager.hash)

      // Manager context: write i-task1 → no redirect
      const managerResult = resolveOperationRedirect(
        'write', 'i-task1', managerRules, [mgrToWkr], managerLoc, manager.dir
      )
      expect(managerResult.redirected).toBe(false)
    })
  })

  describe('resolveLocationTarget + resolveOpentasksUri consistency', () => {
    it('resolveOpentasksUri returns superset of resolveLocationTarget', async () => {
      const loc1 = await createLocation('loc1')
      const loc2 = await createLocation('loc2')

      const loc1Identity = { hash: loc1.hash, uuid: 'uuid-1', name: 'loc1' }
      const connections: Connection[] = [
        { hash: loc2.hash, path: loc2.dir, role: 'peer', name: 'loc2' },
      ]

      const uri = buildOpentasksUri(loc2.hash, 'i-task1')

      const locationTarget = resolveLocationTarget(uri, connections, loc1Identity, loc1.dir)
      const fullResolved = resolveOpentasksUri(uri, connections, loc1Identity, loc1.dir)

      // Full resolved should have same location fields
      expect(fullResolved.hash).toBe(locationTarget.hash)
      expect(fullResolved.opentasksPath).toBe(locationTarget.opentasksPath)
      expect(fullResolved.isLocal).toBe(locationTarget.isLocal)

      // Plus nodeId
      expect(fullResolved.nodeId).toBe('i-task1')
      expect('nodeId' in locationTarget).toBe(false)
    })
  })

  describe('worktree registry + redirect integration', () => {
    it('registered worktrees can be resolved via redirect targets', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      const gitCommonDir = await tempDir.mkdir('.git')
      await tempDir.mkdir('.git/opentasks')

      // Register both worktrees
      registerWorktree(gitCommonDir, {
        path: tempDir.resolve('manager'),
        opentasksPath: manager.dir,
        hash: manager.hash,
        branch: 'main',
        role: 'manager',
      })

      registerWorktree(gitCommonDir, {
        path: tempDir.resolve('worker'),
        opentasksPath: worker.dir,
        hash: worker.hash,
        branch: 'feature-x',
        role: 'worker',
        redirectTarget: manager.hash,
      })

      // Verify worktree entry has redirect target
      const workerEntry = findWorktree(gitCommonDir, worker.hash)
      expect(workerEntry?.redirectTarget).toBe(manager.hash)

      // Use redirect target to resolve location
      const workerLoc = { hash: worker.hash, uuid: 'uuid-wkr', name: 'worker' }
      const wkrToMgr: Connection = { hash: manager.hash, path: manager.dir, role: 'parent', name: 'manager' }

      const redirectTarget = resolveLocationTarget(
        workerEntry!.redirectTarget!,
        [wkrToMgr],
        workerLoc,
        worker.dir
      )
      expect(redirectTarget.hash).toBe(manager.hash)
      expect(redirectTarget.isLocal).toBe(false)
    })
  })

  describe('merge driver integration with locations', () => {
    it('merge driver resolves correctly for multi-location graph files', async () => {
      const manager = await createLocation('manager')
      const worker = await createLocation('worker', 'worker')

      // Simulate shared graph content from manager and worker
      const basePath = tempDir.resolve('merge-base.jsonl')
      const mgrPath = tempDir.resolve('merge-mgr.jsonl')
      const wkrPath = tempDir.resolve('merge-wkr.jsonl')

      // Base: shared issue
      const baseEntries = [
        { id: 'i-shared', title: 'Shared', status: 'open', updated_at: '2025-01-01T00:00:00Z' },
      ]

      // Manager: closes the issue, adds a new spec
      const mgrEntries = [
        { id: 'i-shared', title: 'Shared', status: 'closed', updated_at: '2025-01-01T02:00:00Z' },
        { id: 's-spec1', title: 'New Spec', status: 'draft', updated_at: '2025-01-01T01:00:00Z' },
      ]

      // Worker: updates title, adds a new issue
      const wkrEntries = [
        { id: 'i-shared', title: 'Shared (updated)', status: 'open', updated_at: '2025-01-01T01:00:00Z' },
        { id: 'i-worker-new', title: 'Worker Issue', status: 'open', updated_at: '2025-01-01T01:00:00Z' },
      ]

      fs.writeFileSync(basePath, baseEntries.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(mgrPath, mgrEntries.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(wkrPath, wkrEntries.map(e => JSON.stringify(e)).join('\n') + '\n')

      const exitCode = mergeJsonl(basePath, mgrPath, wkrPath)
      expect(exitCode).toBe(0)

      const merged = parseJsonlToMap(mgrPath)

      // i-shared: mgr closed (status), wkr updated title → both changes preserved
      expect(merged.get('i-shared')?.status).toBe('closed')
      expect(merged.get('i-shared')?.title).toBe('Shared (updated)')

      // Both additions present
      expect(merged.has('s-spec1')).toBe(true)
      expect(merged.has('i-worker-new')).toBe(true)

      // Total: 3 entries
      expect(merged.size).toBe(3)
    })

    it('merge with edges preserves ordering', async () => {
      const basePath = tempDir.resolve('edge-base.jsonl')
      const oursPath = tempDir.resolve('edge-ours.jsonl')
      const theirsPath = tempDir.resolve('edge-theirs.jsonl')

      const base = [
        { id: 'i-1', title: 'Issue', updated_at: '2025-01-01T00:00:00Z' },
      ]
      const ours = [
        { id: 'i-1', title: 'Issue', updated_at: '2025-01-01T00:00:00Z' },
        { id: 'x-edge1', from_id: 'i-1', to_id: 'i-2', type: 'blocks', updated_at: '2025-01-01T01:00:00Z' },
      ]
      const theirs = [
        { id: 'i-1', title: 'Issue', updated_at: '2025-01-01T00:00:00Z' },
        { id: 'i-2', title: 'Issue 2', updated_at: '2025-01-01T01:00:00Z' },
      ]

      fs.writeFileSync(basePath, base.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(oursPath, ours.map(e => JSON.stringify(e)).join('\n') + '\n')
      fs.writeFileSync(theirsPath, theirs.map(e => JSON.stringify(e)).join('\n') + '\n')

      mergeJsonl(basePath, oursPath, theirsPath)

      // Verify output file has nodes before edges
      const content = fs.readFileSync(oursPath, 'utf-8').trim().split('\n')
      const ids = content.map(line => JSON.parse(line).id)

      // Nodes should come before edges
      const edgeIndex = ids.findIndex((id: string) => id.startsWith('x-'))
      const lastNodeIndex = ids.findLastIndex((id: string) => !id.startsWith('x-'))
      expect(lastNodeIndex).toBeLessThan(edgeIndex)
    })
  })
})
