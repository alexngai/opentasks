/**
 * Thorough unit tests for resolveLocationTarget
 *
 * Covers all input formats (bare hash, ".", opentasks:// URIs),
 * edge cases, error handling, and interaction with resolveOpentasksUri.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveLocationTarget,
  resolveOpentasksUri,
  parseOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
  isOpentasksUri,
  type ResolvedLocationTarget,
  type ResolvedLocation,
} from '../uri.js'
import type { Connection } from '../connections.js'
import type { LocationIdentity } from '../location.js'

// Shared test fixtures
const currentLocation: LocationIdentity = {
  hash: 'abcd1234',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  name: 'my-project',
}
const currentPath = '/home/user/project/.opentasks'

const connections: Connection[] = [
  {
    hash: 'k7m2x9p4',
    path: '/home/user/other-repo/.opentasks',
    role: 'peer',
    name: 'other-repo',
  },
  {
    hash: 'm3p8q2w5',
    path: '/home/user/shared/.opentasks',
    role: 'parent',
    name: 'shared',
  },
  {
    hash: 'n4r9s3t6',
    path: '/home/user/child-repo/.opentasks',
    role: 'child',
    name: 'child-repo',
  },
]

describe('resolveLocationTarget', () => {
  // ── Bare hash inputs ──

  describe('bare hash resolution', () => {
    it('resolves a bare hash to a connected peer location', () => {
      const result = resolveLocationTarget('k7m2x9p4', connections, currentLocation, currentPath)
      expect(result.hash).toBe('k7m2x9p4')
      expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks')
      expect(result.isLocal).toBe(false)
    })

    it('resolves a bare hash to a connected parent location', () => {
      const result = resolveLocationTarget('m3p8q2w5', connections, currentLocation, currentPath)
      expect(result.hash).toBe('m3p8q2w5')
      expect(result.opentasksPath).toBe('/home/user/shared/.opentasks')
      expect(result.isLocal).toBe(false)
    })

    it('resolves a bare hash to a connected child location', () => {
      const result = resolveLocationTarget('n4r9s3t6', connections, currentLocation, currentPath)
      expect(result.hash).toBe('n4r9s3t6')
      expect(result.opentasksPath).toBe('/home/user/child-repo/.opentasks')
      expect(result.isLocal).toBe(false)
    })

    it('resolves current location hash as local', () => {
      const result = resolveLocationTarget('abcd1234', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.opentasksPath).toBe(currentPath)
      expect(result.isLocal).toBe(true)
    })

    it('throws for unknown bare hash', () => {
      expect(() =>
        resolveLocationTarget('zzzz9999', connections, currentLocation, currentPath)
      ).toThrow('Unknown location hash: zzzz9999')
    })

    it('throws for unknown hash with empty connections', () => {
      expect(() =>
        resolveLocationTarget('k7m2x9p4', [], currentLocation, currentPath)
      ).toThrow('Unknown location hash: k7m2x9p4')
    })
  })

  // ── Current-location shorthand "." ──

  describe('"." shorthand', () => {
    it('resolves "." to current location', () => {
      const result = resolveLocationTarget('.', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.opentasksPath).toBe(currentPath)
      expect(result.isLocal).toBe(true)
    })

    it('resolves "." with empty connections list', () => {
      const result = resolveLocationTarget('.', [], currentLocation, currentPath)
      expect(result.isLocal).toBe(true)
      expect(result.hash).toBe(currentLocation.hash)
    })
  })

  // ── Current-location URI: opentasks://./ ──

  describe('current-location URI', () => {
    it('resolves "opentasks://./" as local', () => {
      const result = resolveLocationTarget('opentasks://./', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.opentasksPath).toBe(currentPath)
      expect(result.isLocal).toBe(true)
    })

    it('resolves "opentasks://./node-id" as local (strips node ID)', () => {
      const result = resolveLocationTarget('opentasks://./i-x7k9', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.isLocal).toBe(true)
      // resolveLocationTarget does NOT include nodeId
      expect('nodeId' in result).toBe(false)
    })
  })

  // ── Hash-based URI: opentasks://hash/ ──

  describe('hash-based URI', () => {
    it('resolves hash URI with trailing slash', () => {
      const result = resolveLocationTarget('opentasks://k7m2x9p4/', connections, currentLocation, currentPath)
      expect(result.hash).toBe('k7m2x9p4')
      expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks')
      expect(result.isLocal).toBe(false)
    })

    it('resolves hash URI with node ID (location only)', () => {
      const result = resolveLocationTarget('opentasks://k7m2x9p4/i-node1', connections, currentLocation, currentPath)
      expect(result.hash).toBe('k7m2x9p4')
      expect(result.isLocal).toBe(false)
      // Location target does not include nodeId
      expect('nodeId' in result).toBe(false)
    })

    it('resolves hash URI matching current location as local', () => {
      const result = resolveLocationTarget('opentasks://abcd1234/', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.isLocal).toBe(true)
    })

    it('resolves hash URI matching current location with node ID as local', () => {
      const result = resolveLocationTarget('opentasks://abcd1234/i-test', connections, currentLocation, currentPath)
      expect(result.hash).toBe('abcd1234')
      expect(result.isLocal).toBe(true)
    })

    it('throws for hash URI with unknown hash', () => {
      expect(() =>
        resolveLocationTarget('opentasks://unknown1/', connections, currentLocation, currentPath)
      ).toThrow('Unknown location hash: unknown1')
    })

    it('resolves parent connection via hash URI', () => {
      const result = resolveLocationTarget('opentasks://m3p8q2w5/', connections, currentLocation, currentPath)
      expect(result.hash).toBe('m3p8q2w5')
      expect(result.opentasksPath).toBe('/home/user/shared/.opentasks')
      expect(result.isLocal).toBe(false)
    })
  })

  // ── Absolute path URI: opentasks:///abs/path ──

  describe('absolute path URI', () => {
    it('resolves absolute path matching current location as local', () => {
      const result = resolveLocationTarget(
        `opentasks://${currentPath}/i-test`,
        connections,
        currentLocation,
        currentPath
      )
      expect(result.isLocal).toBe(true)
      expect(result.hash).toBe('abcd1234')
    })

    it('resolves absolute path matching a connection', () => {
      const result = resolveLocationTarget(
        'opentasks:///home/user/other-repo/.opentasks/i-test',
        connections,
        currentLocation,
        currentPath
      )
      expect(result.hash).toBe('k7m2x9p4')
      expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks')
      expect(result.isLocal).toBe(false)
    })

    it('resolves absolute path URI with trailing slash', () => {
      const result = resolveLocationTarget(
        'opentasks:///home/user/other-repo/.opentasks/',
        connections,
        currentLocation,
        currentPath
      )
      expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks')
    })

    it('resolves unknown absolute path with empty hash', () => {
      const result = resolveLocationTarget(
        'opentasks:///unknown/path/.opentasks/i-test',
        connections,
        currentLocation,
        currentPath
      )
      expect(result.hash).toBe('')
      expect(result.isLocal).toBe(false)
    })
  })

  // ── Return type guarantees ──

  describe('return type structure', () => {
    it('always returns opentasksPath, hash, and isLocal', () => {
      const result = resolveLocationTarget('.', connections, currentLocation, currentPath)
      expect(result).toHaveProperty('opentasksPath')
      expect(result).toHaveProperty('hash')
      expect(result).toHaveProperty('isLocal')
      expect(typeof result.opentasksPath).toBe('string')
      expect(typeof result.hash).toBe('string')
      expect(typeof result.isLocal).toBe('boolean')
    })

    it('never includes nodeId', () => {
      const result1 = resolveLocationTarget('.', connections, currentLocation, currentPath)
      const result2 = resolveLocationTarget('opentasks://k7m2x9p4/i-node', connections, currentLocation, currentPath)
      const result3 = resolveLocationTarget('k7m2x9p4', connections, currentLocation, currentPath)

      expect('nodeId' in result1).toBe(false)
      expect('nodeId' in result2).toBe(false)
      expect('nodeId' in result3).toBe(false)
    })
  })

  // ── Multiple connections with same characteristics ──

  describe('connection matching', () => {
    it('uses first matching connection when multiple exist', () => {
      const dupeConnections: Connection[] = [
        { hash: 'dupehash', path: '/first/.opentasks', role: 'peer', name: 'first' },
        { hash: 'dupehash', path: '/second/.opentasks', role: 'child', name: 'second' },
      ]
      const result = resolveLocationTarget('dupehash', dupeConnections, currentLocation, currentPath)
      expect(result.opentasksPath).toBe('/first/.opentasks')
    })

    it('prefers current location hash over connection with same hash', () => {
      const sameHashConnections: Connection[] = [
        { hash: 'abcd1234', path: '/other/.opentasks', role: 'peer', name: 'other' },
      ]
      const result = resolveLocationTarget('abcd1234', sameHashConnections, currentLocation, currentPath)
      expect(result.isLocal).toBe(true)
      expect(result.opentasksPath).toBe(currentPath)
    })
  })
})

// ── resolveOpentasksUri delegation tests ──

describe('resolveOpentasksUri delegates to resolveLocationTarget', () => {
  it('returns ResolvedLocation with nodeId for hash-based URI', () => {
    const result = resolveOpentasksUri(
      'opentasks://k7m2x9p4/i-x7k9',
      connections,
      currentLocation,
      currentPath
    )
    expect(result.hash).toBe('k7m2x9p4')
    expect(result.nodeId).toBe('i-x7k9')
    expect(result.isLocal).toBe(false)
    expect(result.opentasksPath).toBe('/home/user/other-repo/.opentasks')
  })

  it('returns ResolvedLocation with nodeId for local URI', () => {
    const result = resolveOpentasksUri(
      'opentasks://./i-local1',
      connections,
      currentLocation,
      currentPath
    )
    expect(result.hash).toBe('abcd1234')
    expect(result.nodeId).toBe('i-local1')
    expect(result.isLocal).toBe(true)
  })

  it('returns ResolvedLocation with nodeId for absolute path URI', () => {
    const result = resolveOpentasksUri(
      `opentasks://${currentPath}/s-spec1`,
      connections,
      currentLocation,
      currentPath
    )
    expect(result.nodeId).toBe('s-spec1')
    expect(result.isLocal).toBe(true)
  })

  it('throws for non-opentasks URI', () => {
    expect(() =>
      resolveOpentasksUri('https://example.com', connections, currentLocation, currentPath)
    ).toThrow('Invalid opentasks URI')
  })

  it('throws for bare string (not a URI)', () => {
    expect(() =>
      resolveOpentasksUri('k7m2x9p4', connections, currentLocation, currentPath)
    ).toThrow('Invalid opentasks URI')
  })

  it('propagates unknown hash error from resolveLocationTarget', () => {
    expect(() =>
      resolveOpentasksUri('opentasks://unknown1/i-x', connections, currentLocation, currentPath)
    ).toThrow('Unknown location hash: unknown1')
  })
})

// ── parseOpentasksUri edge cases ──

describe('parseOpentasksUri edge cases', () => {
  it('handles deeply nested absolute paths', () => {
    const result = parseOpentasksUri('opentasks:///a/b/c/d/e/.opentasks/i-deep')
    expect(result?.absolutePath).toBe('/a/b/c/d/e/.opentasks')
    expect(result?.nodeId).toBe('i-deep')
  })

  it('handles node IDs with multiple hyphens', () => {
    const result = parseOpentasksUri('opentasks://hash1234/i-my-complex-id-123')
    expect(result?.locationHash).toBe('hash1234')
    expect(result?.nodeId).toBe('i-my-complex-id-123')
  })

  it('handles node IDs with dots', () => {
    const result = parseOpentasksUri('opentasks://hash1234/i-v1.2.3')
    expect(result?.nodeId).toBe('i-v1.2.3')
  })

  it('returns null for opentasks:// with only scheme', () => {
    expect(parseOpentasksUri('opentasks://')).toBeNull()
  })

  it('returns null for opentasks:// with hash but no node ID', () => {
    expect(parseOpentasksUri('opentasks://hash1234')).toBeNull()
  })

  it('returns null for opentasks:// with hash and trailing slash only', () => {
    expect(parseOpentasksUri('opentasks://hash1234/')).toBeNull()
  })

  it('returns null for opentasks://. without trailing slash', () => {
    // "." alone doesn't start with "./" so it falls through to hash-based
    // which requires a slash after hash, so this is actually: hash=".", nodeId=""
    const result = parseOpentasksUri('opentasks://.')
    expect(result).toBeNull()
  })

  it('handles edge IDs (x- prefix)', () => {
    const result = parseOpentasksUri('opentasks://hash1234/x-edge1')
    expect(result?.nodeId).toBe('x-edge1')
  })

  it('handles spec IDs (s- prefix)', () => {
    const result = parseOpentasksUri('opentasks://hash1234/s-spec1')
    expect(result?.nodeId).toBe('s-spec1')
  })
})

// ── Build URI roundtrip tests ──

describe('URI build and parse roundtrip', () => {
  it('buildOpentasksUri produces parseable URI', () => {
    const uri = buildOpentasksUri('k7m2x9p4', 'i-task1')
    const parsed = parseOpentasksUri(uri)
    expect(parsed?.locationHash).toBe('k7m2x9p4')
    expect(parsed?.nodeId).toBe('i-task1')
  })

  it('buildLocalUri produces parseable URI', () => {
    const uri = buildLocalUri('s-spec1')
    const parsed = parseOpentasksUri(uri)
    expect(parsed?.relativePath).toBe('./')
    expect(parsed?.nodeId).toBe('s-spec1')
  })

  it('buildOpentasksUri + resolveOpentasksUri roundtrip', () => {
    const uri = buildOpentasksUri('k7m2x9p4', 'i-roundtrip')
    const resolved = resolveOpentasksUri(uri, connections, currentLocation, currentPath)
    expect(resolved.hash).toBe('k7m2x9p4')
    expect(resolved.nodeId).toBe('i-roundtrip')
    expect(resolved.isLocal).toBe(false)
  })

  it('buildLocalUri + resolveOpentasksUri roundtrip', () => {
    const uri = buildLocalUri('i-local-rt')
    const resolved = resolveOpentasksUri(uri, connections, currentLocation, currentPath)
    expect(resolved.hash).toBe(currentLocation.hash)
    expect(resolved.nodeId).toBe('i-local-rt')
    expect(resolved.isLocal).toBe(true)
  })

  it('isOpentasksUri correctly identifies built URIs', () => {
    expect(isOpentasksUri(buildOpentasksUri('hash', 'id'))).toBe(true)
    expect(isOpentasksUri(buildLocalUri('id'))).toBe(true)
    expect(isOpentasksUri('not-a-uri')).toBe(false)
    expect(isOpentasksUri('beads://./bd-123')).toBe(false)
  })
})
