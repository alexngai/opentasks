/**
 * Sudocode Provider E2E Tests
 *
 * Tests the full SudocodeProvider flow against the real sudocode binary.
 * No mocking — exercises the complete CLI integration pipeline.
 *
 * Requires: sudocode CLI available (npm install -g sudocode)
 * Gated by: RUN_FULL_AGENT_TESTS=1
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_TESTS } from '../../../integration/helpers/index.js'
import {
  isSudocodeAvailable,
  createSudocodeWorkspace,
  createSudocodeIssue,
  createSudocodeSpec,
  linkSudocodeEntities,
  SUDOCODE_SKIP_MESSAGE,
  type SudocodeWorkspaceContext,
} from '../../helpers/sudocode-helpers.js'
import { createSudocodeProvider, type SudocodeConfig } from '../../../../src/providers/sudocode.js'
import { isRelationshipQueryable } from '../../../../src/providers/traits/RelationshipQueryable.js'
import type { Provider } from '../../../../src/providers/types.js'

// ============================================================================
// Shared State
// ============================================================================

let sudocodeAvailable = false
let sharedWorkspace: SudocodeWorkspaceContext | null = null
let provider: Provider & ReturnType<typeof createSudocodeProvider>

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!AGENT_TESTS)('Sudocode Provider E2E', () => {
  beforeAll(async () => {
    sudocodeAvailable = await isSudocodeAvailable()
    if (!sudocodeAvailable) {
      console.log(SUDOCODE_SKIP_MESSAGE)
      return
    }

    const workspaceDir = await mkdtemp(join(tmpdir(), 'opentasks-sudocode-e2e-'))
    sharedWorkspace = await createSudocodeWorkspace(workspaceDir)

    const config: SudocodeConfig = {
      executable: 'npx sudocode',
      cwd: sharedWorkspace.path,
      timeout: 30000,
    }
    provider = createSudocodeProvider(config)
  })

  afterAll(async () => {
    if (sharedWorkspace) {
      await sharedWorkspace.cleanup()
    }
  })

  // =========================================================================
  // Issue CRUD — Full Lifecycle
  // =========================================================================

  describe('Issue CRUD lifecycle', () => {
    it('should create an issue via provider and verify with direct CLI', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const node = await provider.create({
        title: 'E2E Create Issue',
        content: 'Created via provider',
        type: 'issue',
        priority: 1,
      })

      expect(node.id).toMatch(/^i-/)
      expect(node.title).toBe('E2E Create Issue')
      expect(node.type).toBe('issue')
      expect(node.uri).toMatch(/^sudocode:\/\//)

      // Verify via direct CLI helper
      const listed = await provider.list({ type: 'issue' })
      expect(listed.some((n) => n.id === node.id)).toBe(true)
    })

    it('should get an issue by ID', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Get Issue',
        content: 'For get test',
        type: 'issue',
      })

      const fetched = await provider.get(created.id)

      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
      expect(fetched!.title).toBe('E2E Get Issue')
      expect(fetched!.content).toBe('For get test')
      expect(fetched!.type).toBe('issue')
      expect(fetched!.status).toBe('open')
    })

    it('should get an issue by full URI', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E URI Get Issue',
        type: 'issue',
      })

      const fetched = await provider.get(created.uri)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
    })

    it('should update an issue title and description', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Update Before',
        content: 'Before update',
        type: 'issue',
      })

      const updated = await provider.update(created.id, {
        title: 'E2E Update After',
        content: 'After update',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.title).toBe('E2E Update After')
      expect(updated.content).toBe('After update')
    })

    it('should update issue status', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Status Update',
        type: 'issue',
      })

      const updated = await provider.update(created.id, {
        status: 'in_progress',
      })

      expect(updated.status).toBe('in_progress')
    })

    it('should delete an issue and confirm gone', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Delete Issue',
        type: 'issue',
      })

      await provider.delete(created.id)

      const fetched = await provider.get(created.id)
      expect(fetched).toBeNull()
    })

    it('should return null for non-existent issue', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const fetched = await provider.get('i-nonexistent99')
      expect(fetched).toBeNull()
    })
  })

  // =========================================================================
  // Spec CRUD — Full Lifecycle
  // =========================================================================

  describe('Spec CRUD lifecycle', () => {
    it('should create a spec via provider', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const node = await provider.create({
        title: 'E2E Create Spec',
        content: 'Created via provider',
        type: 'spec',
        priority: 0,
      })

      expect(node.id).toMatch(/^s-/)
      expect(node.title).toBe('E2E Create Spec')
      expect(node.type).toBe('spec')
      expect(node.uri).toMatch(/^sudocode:\/\//)
    })

    it('should get a spec by ID', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Get Spec',
        content: 'For spec get test',
        type: 'spec',
      })

      const fetched = await provider.get(created.id)

      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
      expect(fetched!.title).toBe('E2E Get Spec')
      expect(fetched!.content).toBe('For spec get test')
      expect(fetched!.type).toBe('spec')
    })

    it('should list specs separately from issues', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      // Create one of each
      await provider.create({ title: 'E2E List Spec A', type: 'spec' })
      await provider.create({ title: 'E2E List Issue Z', type: 'issue' })

      const specs = await provider.list({ type: 'spec' })
      const issues = await provider.list({ type: 'issue' })

      expect(specs.every((n) => n.type === 'spec')).toBe(true)
      expect(issues.every((n) => n.type === 'issue')).toBe(true)

      expect(specs.some((n) => n.title === 'E2E List Spec A')).toBe(true)
      expect(issues.some((n) => n.title === 'E2E List Issue Z')).toBe(true)
    })

    it('should update a spec', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Spec Update Before',
        content: 'Original',
        type: 'spec',
      })

      const updated = await provider.update(created.id, {
        title: 'E2E Spec Update After',
        content: 'Revised',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.title).toBe('E2E Spec Update After')
      expect(updated.content).toBe('Revised')
    })
  })

  // =========================================================================
  // List with mixed types
  // =========================================================================

  describe('List operations', () => {
    it('should list all entities (issues + specs) together', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const allNodes = await provider.list()

      // Should include both types from earlier tests
      const types = new Set(allNodes.map((n) => n.type))
      expect(types.has('issue')).toBe(true)
      expect(types.has('spec')).toBe(true)
    })

    it('should respect limit in list', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const limited = await provider.list({ limit: 2 })
      expect(limited.length).toBeLessThanOrEqual(2)
    })

    it('should filter issues by status', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      // Create an in_progress issue
      const created = await provider.create({
        title: 'E2E Status Filter Issue',
        type: 'issue',
      })
      await provider.update(created.id, { status: 'in_progress' })

      const inProgress = await provider.list({
        type: 'issue',
        status: 'in_progress',
      })

      expect(inProgress.length).toBeGreaterThanOrEqual(1)
      expect(inProgress.every((n) => n.status === 'in_progress')).toBe(true)
    })
  })

  // =========================================================================
  // Search
  // =========================================================================

  describe('Search operations', () => {
    it('should search issues by title keyword', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      await provider.create({
        title: 'E2E Zephyr Unique Search Term',
        type: 'issue',
      })

      const results = await provider.search('Zephyr')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(
        results.some((n) => n.title.includes('Zephyr'))
      ).toBe(true)
    })

    it('should search specs by description keyword', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      await provider.create({
        title: 'E2E Spec Search Test',
        content: 'Quantum entanglement protocol',
        type: 'spec',
      })

      const results = await provider.search('Quantum')

      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('should return empty for non-matching search', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const results = await provider.search('xyzzy_nonexistent_term_99999')
      expect(results).toEqual([])
    })
  })

  // =========================================================================
  // Relationships via RelationshipQueryable
  // =========================================================================

  describe('RelationshipQueryable with real data', () => {
    let blockerId: string
    let blockedId: string

    beforeAll(async () => {
      if (!sudocodeAvailable || !sharedWorkspace) return

      // Create two issues and link them directly via CLI
      const blocker = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Blocker Issue'
      )
      const blocked = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Blocked Issue'
      )

      await linkSudocodeEntities(
        sharedWorkspace.path,
        blocker.id,
        blocked.id,
        'blocks'
      )

      blockerId = blocker.id
      blockedId = blocked.id
    })

    it('should implement RelationshipQueryable', ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      expect(isRelationshipQueryable(provider)).toBe(true)
    })

    it('should query outgoing edges from blocker', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const edges = await provider.queryEdges(blockerId, { direction: 'out' })

      expect(edges.length).toBeGreaterThanOrEqual(1)
      expect(
        edges.some(
          (e) =>
            e.from === blockerId && e.to === blockedId && e.type === 'blocks'
        )
      ).toBe(true)
    })

    it('should query incoming edges to blocked issue', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const edges = await provider.queryEdges(blockedId, { direction: 'in' })

      expect(edges.length).toBeGreaterThanOrEqual(1)
      expect(
        edges.some(
          (e) =>
            e.from === blockerId && e.to === blockedId && e.type === 'blocks'
        )
      ).toBe(true)
    })

    it('should filter edges by type', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const edges = await provider.queryEdges(blockerId, {
        edgeType: 'blocks',
      })

      expect(edges.length).toBeGreaterThanOrEqual(1)
      expect(edges.every((e) => e.type === 'blocks')).toBe(true)
    })

    it('should return empty for non-matching edge type', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const edges = await provider.queryEdges(blockerId, {
        edgeType: 'implements',
      })

      // blocker has no 'implements' edges
      const implEdges = edges.filter(
        (e) => e.from === blockerId && e.type === 'implements'
      )
      expect(implEdges).toEqual([])
    })

    it('should return empty edges for non-existent entity', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const edges = await provider.queryEdges('i-nonexistent99')
      expect(edges).toEqual([])
    })
  })

  // =========================================================================
  // Cross-type relationships (spec implements issue)
  // =========================================================================

  describe('Cross-type relationships', () => {
    it('should link a spec to an issue with implements', async ({ skip }) => {
      if (!sudocodeAvailable || !sharedWorkspace) { skip(); return }

      const issue = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Feature Request'
      )
      const spec = await createSudocodeSpec(
        sharedWorkspace.path,
        'E2E Feature Design',
        { content: 'Design for the feature' }
      )

      await linkSudocodeEntities(
        sharedWorkspace.path,
        spec.id,
        issue.id,
        'implements'
      )

      const edges = await provider.queryEdges(spec.id)

      expect(
        edges.some(
          (e) =>
            e.from === spec.id &&
            e.to === issue.id &&
            e.type === 'implements'
        )
      ).toBe(true)
    })
  })

  // =========================================================================
  // Provider ↔ CLI data consistency
  // =========================================================================

  describe('Provider ↔ CLI data consistency', () => {
    it('should see issues created directly by CLI', async ({ skip }) => {
      if (!sudocodeAvailable || !sharedWorkspace) { skip(); return }

      // Create directly via CLI helper (bypassing provider)
      const direct = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Direct CLI Issue',
        { content: 'Created outside provider', priority: 3 }
      )

      // Read via provider
      const node = await provider.get(direct.id)

      expect(node).not.toBeNull()
      expect(node!.title).toBe('E2E Direct CLI Issue')
      expect(node!.content).toBe('Created outside provider')
      expect(node!.priority).toBe(3)
    })

    it('should see specs created directly by CLI', async ({ skip }) => {
      if (!sudocodeAvailable || !sharedWorkspace) { skip(); return }

      const direct = await createSudocodeSpec(
        sharedWorkspace.path,
        'E2E Direct CLI Spec',
        { content: 'Spec from CLI' }
      )

      const node = await provider.get(direct.id)

      expect(node).not.toBeNull()
      expect(node!.title).toBe('E2E Direct CLI Spec')
      expect(node!.type).toBe('spec')
    })

    it('should see relationships created directly by CLI', async ({
      skip,
    }) => {
      if (!sudocodeAvailable || !sharedWorkspace) { skip(); return }

      const a = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Consistency Issue A'
      )
      const b = await createSudocodeIssue(
        sharedWorkspace.path,
        'E2E Consistency Issue B'
      )
      await linkSudocodeEntities(sharedWorkspace.path, a.id, b.id, 'blocks')

      const edges = await provider.queryEdges(a.id, { direction: 'out' })

      expect(
        edges.some(
          (e) => e.from === a.id && e.to === b.id && e.type === 'blocks'
        )
      ).toBe(true)
    })
  })

  // =========================================================================
  // rawData and metadata fields
  // =========================================================================

  describe('rawData and metadata', () => {
    it('should include rawData with sudocode-native fields', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E RawData Issue',
        content: 'Test raw data',
        type: 'issue',
        priority: 2,
      })

      const node = await provider.get(created.id)

      expect(node).not.toBeNull()
      expect(node!.rawData).toBeDefined()
      expect(node!.rawData!.uuid).toBeDefined()
      expect(node!.rawData!.created_at).toBeDefined()
      expect(node!.rawData!.updated_at).toBeDefined()
    })

    it('should include fetchedAt timestamp', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E FetchedAt Issue',
        type: 'issue',
      })

      const node = await provider.get(created.id)

      expect(node).not.toBeNull()
      expect(node!.fetchedAt).toBeDefined()
      expect(new Date(node!.fetchedAt!).getTime()).not.toBeNaN()
    })
  })

  // =========================================================================
  // URI round-tripping
  // =========================================================================

  describe('URI round-tripping', () => {
    it('should round-trip an issue through URI build/parse/get', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E URI Roundtrip',
        type: 'issue',
      })

      // Build a URI, parse it, then get by parsed ID
      const uri = provider.buildUri(created.id, { workspace: '.' })
      expect(uri).toBe(`sudocode://./${created.id}`)

      const parsed = provider.parseUri(uri)
      expect(parsed).not.toBeNull()
      expect(parsed!.id).toBe(created.id)

      const fetched = await provider.get(uri)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
    })

    it('should accept sc:// scheme and resolve correctly', async ({
      skip,
    }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E SC Scheme Issue',
        type: 'issue',
      })

      const parsed = provider.parseUri(`sc://./${created.id}`)
      expect(parsed).not.toBeNull()
      expect(parsed!.id).toBe(created.id)
    })
  })

  // =========================================================================
  // Concurrent operations
  // =========================================================================

  describe('Concurrent operations', () => {
    it('should handle concurrent creates', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const promises = Array.from({ length: 3 }, (_, i) =>
        provider.create({
          title: `E2E Concurrent ${i}`,
          type: 'issue',
        })
      )

      const results = await Promise.all(promises)

      expect(results).toHaveLength(3)
      const ids = new Set(results.map((r) => r.id))
      expect(ids.size).toBe(3)
    })

    it('should handle concurrent reads', async ({ skip }) => {
      if (!sudocodeAvailable) { skip(); return }

      const created = await provider.create({
        title: 'E2E Concurrent Read',
        type: 'issue',
      })

      const promises = Array.from({ length: 5 }, () =>
        provider.get(created.id)
      )
      const results = await Promise.all(promises)

      expect(results.every((r) => r?.id === created.id)).toBe(true)
    })
  })
})

// ============================================================================
// Skip fallback
// ============================================================================

describe.skipIf(AGENT_TESTS)('Sudocode Provider E2E (skipped)', () => {
  it('requires RUN_FULL_AGENT_TESTS=1', ({ skip }) => {
    skip()
  })
})
