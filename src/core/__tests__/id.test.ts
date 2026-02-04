import { describe, it, expect } from 'vitest'
import {
  generateId,
  generateIdFromUuid,
  typePrefix,
  adaptiveLength,
  hexToBase36,
  parseIdPrefix,
  inferTypeFromId,
} from '../id.js'

describe('typePrefix', () => {
  it('returns correct prefix for each type', () => {
    expect(typePrefix('spec')).toBe('s')
    expect(typePrefix('issue')).toBe('i')
    expect(typePrefix('feedback')).toBe('f')
    expect(typePrefix('external')).toBe('e')
    expect(typePrefix('edge')).toBe('x')
  })

  it('returns "n" for unknown types', () => {
    expect(typePrefix('unknown')).toBe('n')
    expect(typePrefix('custom')).toBe('n')
  })
})

describe('adaptiveLength', () => {
  it('returns 4 for small counts', () => {
    expect(adaptiveLength(0)).toBe(4)
    expect(adaptiveLength(100)).toBe(4)
    expect(adaptiveLength(979)).toBe(4)
  })

  it('returns 5 for medium counts', () => {
    expect(adaptiveLength(980)).toBe(5)
    expect(adaptiveLength(3000)).toBe(5)
    expect(adaptiveLength(5899)).toBe(5)
  })

  it('returns 6 for larger counts', () => {
    expect(adaptiveLength(5900)).toBe(6)
    expect(adaptiveLength(20000)).toBe(6)
    expect(adaptiveLength(34999)).toBe(6)
  })

  it('returns 7 for even larger counts', () => {
    expect(adaptiveLength(35000)).toBe(7)
    expect(adaptiveLength(100000)).toBe(7)
    expect(adaptiveLength(211999)).toBe(7)
  })

  it('returns 8 for very large counts', () => {
    expect(adaptiveLength(212000)).toBe(8)
    expect(adaptiveLength(1000000)).toBe(8)
  })
})

describe('hexToBase36', () => {
  it('converts hex to base36', () => {
    // 255 in hex is 'ff', in base36 is '73'
    expect(hexToBase36('ff')).toBe('73')
    // 0 should be '0'
    expect(hexToBase36('0')).toBe('0')
    // 0x1000 = 4096 decimal = 3*36^2 + 5*36 + 28 = 35s in base36
    expect(hexToBase36('1000')).toBe('35s')
  })

  it('produces lowercase output', () => {
    const result = hexToBase36('abcdef')
    expect(result).toBe(result.toLowerCase())
  })
})

describe('generateId', () => {
  it('generates id with correct prefix for spec', () => {
    const { id, uuid } = generateId('spec')
    expect(id).toMatch(/^s-[a-z0-9]{4,}$/)
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('generates id with correct prefix for issue', () => {
    const { id } = generateId('issue')
    expect(id).toMatch(/^i-[a-z0-9]{4,}$/)
  })

  it('generates id with correct prefix for feedback', () => {
    const { id } = generateId('feedback')
    expect(id).toMatch(/^f-[a-z0-9]{4,}$/)
  })

  it('generates id with correct prefix for external', () => {
    const { id } = generateId('external')
    expect(id).toMatch(/^e-[a-z0-9]{4,}$/)
  })

  it('generates id with correct prefix for edge', () => {
    const { id } = generateId('edge')
    expect(id).toMatch(/^x-[a-z0-9]{4,}$/)
  })

  it('generates unique UUIDs', () => {
    const uuids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const { uuid } = generateId('issue')
      uuids.add(uuid)
    }
    expect(uuids.size).toBe(100)
  })

  it('respects existingCount for adaptive length', () => {
    const { id: small } = generateId('issue', 0)
    const { id: large } = generateId('issue', 10000)

    // Small count should have shorter hash part
    const smallHash = small.split('-')[1]
    const largeHash = large.split('-')[1]

    expect(smallHash.length).toBe(4)
    expect(largeHash.length).toBe(6)
  })
})

describe('generateIdFromUuid', () => {
  it('generates deterministic id from uuid', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const result1 = generateIdFromUuid('issue', uuid)
    const result2 = generateIdFromUuid('issue', uuid)

    expect(result1.id).toBe(result2.id)
    expect(result1.uuid).toBe(uuid)
  })

  it('same uuid produces same hash part', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const spec = generateIdFromUuid('spec', uuid)
    const issue = generateIdFromUuid('issue', uuid)

    // Same hash, different prefix
    expect(spec.id.slice(2)).toBe(issue.id.slice(2))
    expect(spec.id[0]).toBe('s')
    expect(issue.id[0]).toBe('i')
  })
})

describe('parseIdPrefix', () => {
  it('extracts prefix from valid ids', () => {
    expect(parseIdPrefix('s-a2b3')).toBe('s')
    expect(parseIdPrefix('i-x7k9pm')).toBe('i')
    expect(parseIdPrefix('f-123')).toBe('f')
    expect(parseIdPrefix('e-abc')).toBe('e')
    expect(parseIdPrefix('x-xyz')).toBe('x')
  })

  it('returns null for invalid format', () => {
    expect(parseIdPrefix('invalid')).toBeNull()
    expect(parseIdPrefix('no-prefix-here')).toBeNull()
    expect(parseIdPrefix('')).toBeNull()
    expect(parseIdPrefix('A-uppercase')).toBeNull()
  })
})

describe('inferTypeFromId', () => {
  it('infers correct type from id', () => {
    expect(inferTypeFromId('s-a2b3')).toBe('spec')
    expect(inferTypeFromId('i-x7k9')).toBe('issue')
    expect(inferTypeFromId('f-m4n5')).toBe('feedback')
    expect(inferTypeFromId('e-p6q7')).toBe('external')
    expect(inferTypeFromId('x-r8s9')).toBe('edge')
  })

  it('returns null for unknown prefix', () => {
    expect(inferTypeFromId('z-unknown')).toBeNull()
    expect(inferTypeFromId('invalid')).toBeNull()
  })
})
