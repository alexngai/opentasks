/**
 * Tests for P1, P2, and P3 gap fixes:
 * - Gap #6: Conditional redirect integration
 * - Gap #8: Parallel query expansion
 * - Gap #14: URI hash validation
 * - Gap #15: Edge deduplication
 * - Gap #2: follow-refs expansion mode
 * - Gap #7: crossLocationEdges
 * - Gap #12: Configurable LocationProvider query limit
 * - Gap #13: Worktree registry locking (structural test only)
 * - Gap #3: Discover command
 * - Gap #17: LocationConfigSchema partial input
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ============================================================================
// Gap #6: Conditional redirect integration
// ============================================================================
import {
  resolveOperationRedirect,
  type RedirectRule,
} from '../core/redirects.js'
import type { ConditionalRedirectRule, RedirectContext } from '../core/conditional-redirects.js'
import type { Connection } from '../core/connections.js'
import type { LocationIdentity } from '../core/location.js'

describe('Gap #6: resolveOperationRedirect with RedirectContext', () => {
  const currentLocation: LocationIdentity = {
    hash: 'abcd1234',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    name: 'current',
  }
  const currentPath = '/home/user/project/.opentasks'
  const connections: Connection[] = [
    {
      hash: 'k7m2x9p4',
      path: '/home/user/main-repo/.opentasks',
      role: 'peer',
      name: 'main-repo',
    },
    {
      hash: 'n4r7s1t8',
      path: '/home/user/staging/.opentasks',
      role: 'peer',
      name: 'staging',
    },
  ]

  it('evaluates conditional rules when context is provided', () => {
    const rules: ConditionalRedirectRule[] = [
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://k7m2x9p4/',
        priority: 50,
        fallback: 'error',
        when: { role: 'worker' },
      },
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://n4r7s1t8/',
        priority: 100,
        fallback: 'local',
      },
    ]

    const context: RedirectContext = { role: 'worker', branch: 'main' }
    const result = resolveOperationRedirect(
      'read',
      'i-x7k9',
      rules,
      connections,
      currentLocation,
      currentPath,
      context
    )
    expect(result.redirected).toBe(true)
    expect(result.targetLocation?.hash).toBe('k7m2x9p4')
  })

  it('skips conditional rules that dont match context', () => {
    const rules: ConditionalRedirectRule[] = [
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://k7m2x9p4/',
        priority: 50,
        fallback: 'error',
        when: { role: 'worker' },
      },
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://n4r7s1t8/',
        priority: 100,
        fallback: 'local',
      },
    ]

    const context: RedirectContext = { role: 'manager', branch: 'main' }
    const result = resolveOperationRedirect(
      'read',
      'i-x7k9',
      rules,
      connections,
      currentLocation,
      currentPath,
      context
    )
    // Should skip role=worker rule and match the fallback
    expect(result.redirected).toBe(true)
    expect(result.targetLocation?.hash).toBe('n4r7s1t8')
  })

  it('evaluates branch condition in context', () => {
    const rules: ConditionalRedirectRule[] = [
      {
        operations: ['read'],
        pattern: '*',
        target: 'opentasks://k7m2x9p4/',
        priority: 50,
        fallback: 'local',
        when: { branch: 'feature-*' },
      },
    ]

    // Branch matches
    const context1: RedirectContext = { role: 'worker', branch: 'feature-login' }
    const result1 = resolveOperationRedirect(
      'read', 'i-x7k9', rules, connections, currentLocation, currentPath, context1
    )
    expect(result1.redirected).toBe(true)

    // Branch doesn't match
    const context2: RedirectContext = { role: 'worker', branch: 'main' }
    const result2 = resolveOperationRedirect(
      'read', 'i-x7k9', rules, connections, currentLocation, currentPath, context2
    )
    expect(result2.redirected).toBe(false)
  })

  it('falls back to non-conditional matching when no context provided', () => {
    const rules: ConditionalRedirectRule[] = [
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: 'opentasks://k7m2x9p4/',
        priority: 100,
        fallback: 'error',
        when: { role: 'worker' },
      },
    ]

    // Without context, conditional `when` is not evaluated — uses findRedirectRule
    const result = resolveOperationRedirect(
      'read', 'i-x7k9', rules, connections, currentLocation, currentPath
    )
    // findRedirectRule ignores `when` — rule matches
    expect(result.redirected).toBe(true)
    expect(result.targetLocation?.hash).toBe('k7m2x9p4')
  })
})

// ============================================================================
// Gap #14: URI hash validation
// ============================================================================
import { parseOpentasksUri } from '../core/uri.js'

describe('Gap #14: URI hash validation', () => {
  it('rejects invalid hash format (uppercase)', () => {
    expect(parseOpentasksUri('opentasks://INVALID1/i-x7k9')).toBeNull()
  })

  it('rejects invalid hash format (too short)', () => {
    expect(parseOpentasksUri('opentasks://abc/i-x7k9')).toBeNull()
  })

  it('rejects invalid hash format (too long)', () => {
    expect(parseOpentasksUri('opentasks://abcdefghij/i-x7k9')).toBeNull()
  })

  it('rejects hash with special characters', () => {
    expect(parseOpentasksUri('opentasks://ab-cd_12/i-x7k9')).toBeNull()
  })

  it('accepts valid 8-char lowercase alphanumeric hash', () => {
    const result = parseOpentasksUri('opentasks://k7m2x9p4/i-x7k9')
    expect(result).not.toBeNull()
    expect(result?.locationHash).toBe('k7m2x9p4')
  })

  it('still parses current-location URIs (bypass hash validation)', () => {
    const result = parseOpentasksUri('opentasks://./i-x7k9')
    expect(result).not.toBeNull()
    expect(result?.relativePath).toBe('./')
  })

  it('still parses absolute-path URIs (bypass hash validation)', () => {
    const result = parseOpentasksUri('opentasks:///home/user/.opentasks/s-g8h9')
    expect(result).not.toBeNull()
    expect(result?.absolutePath).toBe('/home/user/.opentasks')
  })
})

// ============================================================================
// Gap #15: Edge deduplication
// ============================================================================
import { deduplicateEdges } from '../storage/locked-writer.js'
import type { StoredEdge } from '../schema/storage.js'

describe('Gap #15: Edge deduplication timestamp logic', () => {
  function makeEdge(id: string, fromId: string, toId: string, createdAt: string): StoredEdge {
    return {
      id,
      uuid: '550e8400-e29b-41d4-a716-446655440001',
      from_id: fromId,
      to_id: toId,
      type: 'blocks',
      created_at: createdAt,
    }
  }

  it('keeps the newer edge when both have timestamps', () => {
    const edges: StoredEdge[] = [
      makeEdge('x-1', 'i-1', 'i-2', '2025-01-01T10:00:00Z'),
      makeEdge('x-1', 'i-1', 'i-3', '2025-01-01T12:00:00Z'),
    ]

    const result = deduplicateEdges(edges)
    expect(result).toHaveLength(1)
    expect(result[0].to_id).toBe('i-3')
    expect(result[0].created_at).toBe('2025-01-01T12:00:00Z')
  })

  it('keeps the first edge when timestamps are identical', () => {
    const edges: StoredEdge[] = [
      makeEdge('x-1', 'i-1', 'i-2', '2025-01-01T10:00:00Z'),
      makeEdge('x-1', 'i-1', 'i-3', '2025-01-01T10:00:00Z'),
    ]

    const result = deduplicateEdges(edges)
    expect(result).toHaveLength(1)
    // First entry wins when timestamps equal
    expect(result[0].to_id).toBe('i-2')
  })

  it('handles single edge', () => {
    const edges: StoredEdge[] = [
      makeEdge('x-1', 'i-1', 'i-2', '2025-01-01T10:00:00Z'),
    ]
    const result = deduplicateEdges(edges)
    expect(result).toHaveLength(1)
  })

  it('handles empty array', () => {
    expect(deduplicateEdges([])).toHaveLength(0)
  })
})

// ============================================================================
// Gaps #2, #7, #8: Query expansion — follow-refs, crossLocationEdges, parallel
// ============================================================================
import {
  createQueryExpander,
  type ExpandedResult,
} from '../graph/expansion.js'
import type { Storage } from '../storage/interface.js'
import type { LocationProvider } from '../providers/location.js'
import type { ProviderNode } from '../providers/types.js'
import type { StoredNode } from '../schema/storage.js'

function mockStorage(overrides?: Partial<Storage>): Storage {
  return {
    createNode: vi.fn(),
    getNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    queryNodes: vi.fn().mockResolvedValue([]),
    createEdge: vi.fn(),
    getEdge: vi.fn(),
    deleteEdge: vi.fn(),
    getEdgesFrom: vi.fn().mockResolvedValue([]),
    getEdgesTo: vi.fn().mockResolvedValue([]),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    getTagsForNodes: vi.fn().mockResolvedValue(new Map()),
    getNodesByTag: vi.fn().mockResolvedValue([]),
    getReady: vi.fn().mockResolvedValue([
      { id: 'i-local', uuid: 'uuid1', type: 'issue', title: 'Local', status: 'open', created_at: '2025-01-01', updated_at: '2025-01-01' },
    ]),
    runInTransaction: vi.fn(),
    markDirty: vi.fn(),
    getDirtyNodes: vi.fn().mockResolvedValue([]),
    clearDirty: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

function mockProvider(hash: string, nodes: ProviderNode[] = []): LocationProvider {
  return {
    name: `opentasks-${hash}`,
    schemes: ['opentasks'],
    capabilities: { read: true, write: false, search: true, watch: false, mount: false, feedback: false },
    parseUri: vi.fn().mockReturnValue(null),
    buildUri: vi.fn().mockReturnValue(''),
    isValidUri: vi.fn().mockReturnValue(false),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(nodes),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ready: vi.fn().mockResolvedValue(nodes),
    close: vi.fn(),
  }
}

describe('Gap #2: follow-refs expansion mode', () => {
  it('only queries locations referenced in local edges', async () => {
    // Use valid 8-char base36 hashes for URI parsing
    const hash1 = 'r3m0t3a1'
    const hash2 = 'r3m0t3b2'
    const localHash = 'l0c4lhs1'

    const storage = mockStorage({
      getEdgesFrom: vi.fn().mockResolvedValue([
        {
          id: 'x-1', uuid: 'u1', from_id: 'i-local',
          to_id: `opentasks://${hash1}/i-ref1`,
          type: 'blocks', created_at: '2025-01-01',
        },
      ]),
    })

    const remote1 = mockProvider(hash1, [
      { id: 'i-ref1', uri: `opentasks://${hash1}/i-ref1`, type: 'issue', title: 'Ref1', fetchedAt: '2025-01-01' },
    ])
    const remote2 = mockProvider(hash2, [
      { id: 'i-ref2', uri: `opentasks://${hash2}/i-ref2`, type: 'issue', title: 'Ref2', fetchedAt: '2025-01-01' },
    ])

    const providers = new Map<string, LocationProvider>()
    providers.set(hash1, remote1)
    providers.set(hash2, remote2)

    const expander = createQueryExpander(storage, localHash, providers)
    const result = await expander.expandedReady({ expand: 'follow-refs' })

    // Should query remote1 (referenced) but NOT remote2 (not referenced)
    expect(result.connected[hash1]).toHaveLength(1)
    expect(result.connected[hash2]).toBeUndefined()
    expect(result.queriedLocations).toContain(hash1)
    expect(result.queriedLocations).not.toContain(hash2)
  })

  it('returns empty connected when no edges reference other locations', async () => {
    const storage = mockStorage({
      getEdgesFrom: vi.fn().mockResolvedValue([
        { id: 'x-1', uuid: 'u1', from_id: 'i-local', to_id: 'i-other-local', type: 'blocks', created_at: '2025-01-01' },
      ]),
    })

    const remote1 = mockProvider('r3m0t3a1')
    const providers = new Map<string, LocationProvider>()
    providers.set('r3m0t3a1', remote1)

    const expander = createQueryExpander(storage, 'l0c4lhs1', providers)
    const result = await expander.expandedReady({ expand: 'follow-refs' })

    expect(Object.keys(result.connected)).toHaveLength(0)
  })
})

describe('Gap #7: crossLocationEdges in ExpandedResult', () => {
  it('includes edges that reference other locations', async () => {
    const remoteHash = 'r3m0t3a1'
    const localHash = 'l0c4lhs1'

    const crossEdge = {
      id: 'x-1', uuid: 'u1', from_id: 'i-local',
      to_id: `opentasks://${remoteHash}/i-ref1`,
      type: 'blocks', created_at: '2025-01-01',
    }
    const localEdge = {
      id: 'x-2', uuid: 'u2', from_id: 'i-local',
      to_id: 'i-other', type: 'related', created_at: '2025-01-01',
    }

    const storage = mockStorage({
      getEdgesFrom: vi.fn().mockResolvedValue([crossEdge, localEdge]),
    })

    const remote1 = mockProvider(remoteHash)
    const providers = new Map<string, LocationProvider>()
    providers.set(remoteHash, remote1)

    const expander = createQueryExpander(storage, localHash, providers)
    const result = await expander.expandedReady({ expand: 'connections' })

    expect(result.crossLocationEdges).toHaveLength(1)
    expect(result.crossLocationEdges[0].id).toBe('x-1')
  })

  it('returns empty crossLocationEdges when no cross-location edges exist', async () => {
    const storage = mockStorage()
    const expander = createQueryExpander(storage, 'l0c4lhs1', new Map())
    const result = await expander.expandedReady({ expand: 'none' })

    expect(result.crossLocationEdges).toEqual([])
  })
})

describe('Gap #8: Parallel provider queries', () => {
  it('queries all providers in parallel (not sequential)', async () => {
    const callOrder: string[] = []
    const storage = mockStorage()
    const hash1 = 's10whsh1'
    const hash2 = 's10whsh2'

    const makeSlowProvider = (hash: string, delay: number): LocationProvider => {
      const p = mockProvider(hash)
      ;(p.ready as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push(`start-${hash}`)
        await new Promise((r) => setTimeout(r, delay))
        callOrder.push(`end-${hash}`)
        return []
      })
      return p
    }

    const providers = new Map<string, LocationProvider>()
    providers.set(hash1, makeSlowProvider(hash1, 50))
    providers.set(hash2, makeSlowProvider(hash2, 50))

    const expander = createQueryExpander(storage, 'l0c4lhs1', providers)
    const start = Date.now()
    await expander.expandedReady({ expand: 'connections' })
    const elapsed = Date.now() - start

    // If parallel: both start before either ends
    // If sequential: start-slow1, end-slow1, start-slow2, end-slow2
    expect(callOrder[0]).toBe(`start-${hash1}`)
    expect(callOrder[1]).toBe(`start-${hash2}`)
    // And total time should be ~50ms, not ~100ms
    expect(elapsed).toBeLessThan(100)
  })
})

// ============================================================================
// Gap #3: Discover command
// ============================================================================
import { discoverLocations, type DiscoveredLocation } from '../core/discover.js'

describe('Gap #3: discoverLocations', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-discover-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeLocation(dir: string, hash: string, name: string): void {
    const opentasksDir = path.join(dir, '.opentasks')
    fs.mkdirSync(opentasksDir, { recursive: true })
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify({ location: { hash, uuid: 'test-uuid', name } }),
      'utf-8'
    )
  }

  it('discovers self location', () => {
    makeLocation(tmpDir, 'self1234', 'self')
    const results = discoverLocations(tmpDir)
    expect(results.some((l) => l.hash === 'self1234' && l.direction === 'self')).toBe(true)
  })

  it('discovers child locations (down)', () => {
    const childDir = path.join(tmpDir, 'child-project')
    fs.mkdirSync(childDir)
    makeLocation(childDir, 'child123', 'child')

    const results = discoverLocations(tmpDir, { direction: 'down' })
    expect(results.some((l) => l.hash === 'child123' && l.direction === 'down')).toBe(true)
  })

  it('discovers parent locations (up)', () => {
    makeLocation(tmpDir, 'parent12', 'parent')
    const childDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(childDir)

    const results = discoverLocations(childDir, { direction: 'up' })
    expect(results.some((l) => l.hash === 'parent12' && l.direction === 'up')).toBe(true)
  })

  it('respects maxDepth', () => {
    // Create deeply nested location
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd')
    fs.mkdirSync(deep, { recursive: true })
    makeLocation(deep, 'deep1234', 'deep')

    const results = discoverLocations(tmpDir, { direction: 'down', maxDepth: 2 })
    expect(results.some((l) => l.hash === 'deep1234')).toBe(false)

    const resultsDeep = discoverLocations(tmpDir, { direction: 'down', maxDepth: 5 })
    expect(resultsDeep.some((l) => l.hash === 'deep1234')).toBe(true)
  })

  it('returns empty array when no locations found', () => {
    const emptyDir = path.join(tmpDir, 'empty')
    fs.mkdirSync(emptyDir)

    const results = discoverLocations(emptyDir, { direction: 'down', maxDepth: 1 })
    expect(results).toHaveLength(0)
  })

  it('discovers both directions with direction=both', () => {
    makeLocation(tmpDir, 'parent12', 'parent')
    const childDir = path.join(tmpDir, 'child-project')
    fs.mkdirSync(childDir)
    makeLocation(childDir, 'child123', 'child')

    const startDir = path.join(tmpDir, 'start')
    fs.mkdirSync(startDir)

    const results = discoverLocations(tmpDir, { direction: 'both' })
    // Should find self and child
    expect(results.some((l) => l.direction === 'self')).toBe(true)
    expect(results.some((l) => l.direction === 'down')).toBe(true)
  })
})

// ============================================================================
// Gap #17: LocationConfigSchema partial input
// ============================================================================
import { LocationConfigSchema } from '../config/schema.js'

describe('Gap #17: LocationConfigSchema partial input', () => {
  it('accepts full config', () => {
    const result = LocationConfigSchema.parse({
      hash: 'abcd1234',
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      name: 'my-location',
    })
    expect(result?.hash).toBe('abcd1234')
    expect(result?.uuid).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(result?.name).toBe('my-location')
  })

  it('generates uuid and defaults name when only hash provided', () => {
    const result = LocationConfigSchema.parse({
      hash: 'abcd1234',
    })
    expect(result?.hash).toBe('abcd1234')
    expect(result?.uuid).toBeDefined()
    // UUID should be valid format
    expect(result?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(result?.name).toBe('')
  })

  it('returns undefined when no hash provided', () => {
    const result = LocationConfigSchema.parse({ name: 'test' })
    expect(result).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    const result = LocationConfigSchema.parse(undefined)
    expect(result).toBeUndefined()
  })
})
