import { describe, it, expect } from 'vitest'
import {
  generateLocationHash,
  generateLocationHashFallback,
  generateLocationIdentity,
  isValidLocationHash,
} from '../location.js'

describe('generateLocationHash', () => {
  it('produces an 8-char base36 string', () => {
    const hash = generateLocationHash('git@github.com:user/repo.git', '.')
    expect(hash).toMatch(/^[a-z0-9]{8}$/)
  })

  it('is deterministic for the same inputs', () => {
    const hash1 = generateLocationHash('git@github.com:user/repo.git', 'packages/app')
    const hash2 = generateLocationHash('git@github.com:user/repo.git', 'packages/app')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different remote URLs', () => {
    const hash1 = generateLocationHash('git@github.com:user/repo-a.git', '.')
    const hash2 = generateLocationHash('git@github.com:user/repo-b.git', '.')
    expect(hash1).not.toBe(hash2)
  })

  it('produces different hashes for different paths', () => {
    const hash1 = generateLocationHash('git@github.com:user/repo.git', 'packages/a')
    const hash2 = generateLocationHash('git@github.com:user/repo.git', 'packages/b')
    expect(hash1).not.toBe(hash2)
  })

  it('normalizes "." to empty string', () => {
    const hash1 = generateLocationHash('git@github.com:user/repo.git', '.')
    const hash2 = generateLocationHash('git@github.com:user/repo.git', '')
    // Both should use empty relative path
    expect(hash1).toBe(hash2)
  })
})

describe('generateLocationHashFallback', () => {
  it('produces an 8-char base36 string', () => {
    const hash = generateLocationHashFallback('/home/user/project/.opentasks')
    expect(hash).toMatch(/^[a-z0-9]{8}$/)
  })

  it('is deterministic for the same path', () => {
    const hash1 = generateLocationHashFallback('/home/user/project/.opentasks')
    const hash2 = generateLocationHashFallback('/home/user/project/.opentasks')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for different paths', () => {
    const hash1 = generateLocationHashFallback('/home/user/project-a/.opentasks')
    const hash2 = generateLocationHashFallback('/home/user/project-b/.opentasks')
    expect(hash1).not.toBe(hash2)
  })
})

describe('generateLocationIdentity', () => {
  it('generates identity with hash, uuid, and name', () => {
    const identity = generateLocationIdentity('/tmp/test-project/.opentasks', 'test-project')
    expect(identity.hash).toMatch(/^[a-z0-9]{8}$/)
    expect(identity.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(identity.name).toBe('test-project')
  })

  it('generates unique UUIDs on each call', () => {
    const id1 = generateLocationIdentity('/tmp/test-project/.opentasks')
    const id2 = generateLocationIdentity('/tmp/test-project/.opentasks')
    expect(id1.uuid).not.toBe(id2.uuid)
  })

  it('uses directory basename as default name', () => {
    const identity = generateLocationIdentity('/tmp/my-cool-project/.opentasks')
    expect(identity.name).toBe('my-cool-project')
  })
})

describe('isValidLocationHash', () => {
  it('validates correct hashes', () => {
    expect(isValidLocationHash('k7m2x9p4')).toBe(true)
    expect(isValidLocationHash('abcdef12')).toBe(true)
    expect(isValidLocationHash('00000000')).toBe(true)
  })

  it('rejects invalid hashes', () => {
    expect(isValidLocationHash('')).toBe(false)
    expect(isValidLocationHash('short')).toBe(false)
    expect(isValidLocationHash('toolongaa')).toBe(false)
    expect(isValidLocationHash('ABCDEFGH')).toBe(false)
    expect(isValidLocationHash('k7m2-9p4')).toBe(false)
  })
})
