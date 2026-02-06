/**
 * Beads Provider bd v0.49 Compatibility E2E Tests
 *
 * Validates that the Beads provider correctly handles bd v0.49 output
 * formats including structured dependencies, tombstone soft-deletes,
 * and queryEdges with real CLI data.
 *
 * Requires: bd CLI available in PATH (set AGENT_TESTS=1)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import {
  AGENT_TESTS,
  AGENT_SKIP_MESSAGE,
  isBdAvailable,
  createBeadsWorkspace,
  createBeadsTask,
  deleteBeadsTask,
  linkBeadsTasks,
  getBdExecutable,
  type BeadsWorkspaceContext,
} from '../../helpers/index.js'
import { createBeadsProvider } from '../../../../src/providers/beads.js'
import { isRelationshipQueryable } from '../../../../src/providers/traits/RelationshipQueryable.js'

describe.skipIf(!AGENT_TESTS)('Beads Provider v0.49 Compatibility', () => {
  let beadsAvailable: boolean
  let workspace: BeadsWorkspaceContext | null = null
  let provider: ReturnType<typeof createBeadsProvider>

  beforeAll(async () => {
    beadsAvailable = await isBdAvailable()
    if (beadsAvailable) {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-beads-compat-'))
      workspace = await createBeadsWorkspace(workspaceDir, 'bd')
      provider = createBeadsProvider({
        executable: getBdExecutable(),
        cwd: workspace.path,
        extraArgs: ['--no-db'],
      })
    }
  })

  afterAll(async () => {
    if (workspace) {
      await workspace.cleanup()
    }
  })

  describe('queryEdges with v0.49 dependencies', () => {
    it('should return blocking edges from the blocker side', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const blocker = await createBeadsTask(workspace!.path, 'Blocker Issue')
      const blocked = await createBeadsTask(workspace!.path, 'Blocked Issue')
      await linkBeadsTasks(workspace!.path, blocker.id, blocked.id)

      if (!isRelationshipQueryable(provider)) {
        throw new Error('Provider should be RelationshipQueryable')
      }

      // Query edges from the blocker's perspective
      const edges = await provider.queryEdges(blocker.id)

      expect(edges.length).toBeGreaterThanOrEqual(1)
      const blockEdge = edges.find(
        (e) => e.from === blocker.id && e.to === blocked.id && e.type === 'blocks'
      )
      expect(blockEdge).toBeDefined()

      // Clean up
      await deleteBeadsTask(workspace!.path, blocked.id)
      await deleteBeadsTask(workspace!.path, blocker.id)
    })

    it('should return blocking edges from the blocked side', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const blocker = await createBeadsTask(workspace!.path, 'Blocker Side')
      const blocked = await createBeadsTask(workspace!.path, 'Blocked Side')
      await linkBeadsTasks(workspace!.path, blocker.id, blocked.id)

      if (!isRelationshipQueryable(provider)) {
        throw new Error('Provider should be RelationshipQueryable')
      }

      // Query edges from the blocked issue's perspective
      const edges = await provider.queryEdges(blocked.id)

      expect(edges.length).toBeGreaterThanOrEqual(1)
      const blockEdge = edges.find(
        (e) => e.from === blocker.id && e.to === blocked.id && e.type === 'blocks'
      )
      expect(blockEdge).toBeDefined()

      // Clean up
      await deleteBeadsTask(workspace!.path, blocked.id)
      await deleteBeadsTask(workspace!.path, blocker.id)
    })

    it('should support edge type filtering', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const a = await createBeadsTask(workspace!.path, 'Filter A')
      const b = await createBeadsTask(workspace!.path, 'Filter B')
      await linkBeadsTasks(workspace!.path, a.id, b.id)

      if (!isRelationshipQueryable(provider)) {
        throw new Error('Provider should be RelationshipQueryable')
      }

      // Should find blocks edges
      const blockEdges = await provider.queryEdges(a.id, { edgeType: 'blocks' })
      expect(blockEdges.length).toBeGreaterThanOrEqual(1)

      // Should not find parent-child edges (none exist)
      const parentEdges = await provider.queryEdges(a.id, { edgeType: 'parent-child' })
      expect(parentEdges).toHaveLength(0)

      // Clean up
      await deleteBeadsTask(workspace!.path, b.id)
      await deleteBeadsTask(workspace!.path, a.id)
    })

    it('should not duplicate edges when both formats report the same relationship', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const a = await createBeadsTask(workspace!.path, 'Dedup A')
      const b = await createBeadsTask(workspace!.path, 'Dedup B')
      await linkBeadsTasks(workspace!.path, a.id, b.id)

      if (!isRelationshipQueryable(provider)) {
        throw new Error('Provider should be RelationshipQueryable')
      }

      const edges = await provider.queryEdges(a.id)
      // Count how many times the same a→b blocks edge appears
      const blockEdges = edges.filter(
        (e) => e.from === a.id && e.to === b.id && e.type === 'blocks'
      )
      expect(blockEdges).toHaveLength(1)

      // Clean up
      await deleteBeadsTask(workspace!.path, b.id)
      await deleteBeadsTask(workspace!.path, a.id)
    })
  })

  describe('Tombstone filtering', () => {
    it('should return null for deleted issues via get()', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const task = await createBeadsTask(workspace!.path, 'Will Be Deleted')

      // Verify it exists first
      const before = await provider.get(task.id)
      expect(before).not.toBeNull()
      expect(before!.title).toBe('Will Be Deleted')

      // Delete it
      await deleteBeadsTask(workspace!.path, task.id)

      // Should return null (tombstone filtered)
      const after = await provider.get(task.id)
      expect(after).toBeNull()
    })

    it('should exclude deleted issues from list()', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      const alive = await createBeadsTask(workspace!.path, 'Alive Issue')
      const doomed = await createBeadsTask(workspace!.path, 'Doomed Issue')

      // Delete one
      await deleteBeadsTask(workspace!.path, doomed.id)

      // List should not include the deleted issue
      const nodes = await provider.list()
      const ids = nodes.map((n) => n.id)
      expect(ids).toContain(alive.id)
      expect(ids).not.toContain(doomed.id)

      // None should have tombstone status
      for (const node of nodes) {
        expect(node.status).not.toBe('tombstone')
      }

      // Clean up
      await deleteBeadsTask(workspace!.path, alive.id)
    })

    it('should return empty edges for deleted issues via queryEdges()', async ({ skip }) => {
      if (!beadsAvailable) {
        skip()
        return
      }

      if (!isRelationshipQueryable(provider)) {
        throw new Error('Provider should be RelationshipQueryable')
      }

      const a = await createBeadsTask(workspace!.path, 'Tombstone Edge A')
      const b = await createBeadsTask(workspace!.path, 'Tombstone Edge B')
      await linkBeadsTasks(workspace!.path, a.id, b.id)

      // Verify edges exist before deletion
      const edgesBefore = await provider.queryEdges(a.id)
      expect(edgesBefore.length).toBeGreaterThanOrEqual(1)

      // Delete the blocker
      await deleteBeadsTask(workspace!.path, a.id)

      // queryEdges on deleted issue should return empty
      const edgesAfter = await provider.queryEdges(a.id)
      expect(edgesAfter).toHaveLength(0)

      // Clean up
      await deleteBeadsTask(workspace!.path, b.id)
    })
  })
})

// If tests are skipped, show appropriate message
if (!AGENT_TESTS) {
  describe('Beads Provider v0.49 Compatibility (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
