import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  EdgeTypeRegistry,
  createEdgeTypeRegistry,
  getEdgeTypeRegistry,
  resetEdgeTypeRegistry,
  BUILTIN_EDGE_TYPES,
  type EdgeTypeDefinition,
} from '../EdgeTypeRegistry.js'

describe('EdgeTypeRegistry', () => {
  let registry: EdgeTypeRegistry

  beforeEach(() => {
    registry = createEdgeTypeRegistry()
  })

  describe('built-in types', () => {
    it('has all built-in types registered', () => {
      for (const type of BUILTIN_EDGE_TYPES) {
        expect(registry.has(type.name)).toBe(true)
      }
    })

    it('includes blocks type with affectsReady=true', () => {
      const result = registry.lookup('blocks')
      expect(result).not.toBeNull()
      expect(result!.definition.affectsReady).toBe(true)
    })

    it('includes implements type with affectsReady=false', () => {
      const result = registry.lookup('implements')
      expect(result).not.toBeNull()
      expect(result!.definition.affectsReady).toBe(false)
    })

    it('has correct provider assignments', () => {
      const blocks = registry.lookup('blocks')
      expect(blocks!.definition.providers).toContain('native')
      expect(blocks!.definition.providers).toContain('beads')

      const implements_ = registry.lookup('implements')
      expect(implements_!.definition.providers).toContain('native')
      expect(implements_!.definition.providers).not.toContain('beads')
    })
  })

  describe('lookup()', () => {
    it('returns null for unknown type', () => {
      const result = registry.lookup('unknown-type')
      expect(result).toBeNull()
    })

    it('returns definition for known type', () => {
      const result = registry.lookup('blocks')
      expect(result).not.toBeNull()
      expect(result!.definition.name).toBe('blocks')
      expect(result!.definition.description).toBe(
        'Source must complete before target can start'
      )
    })

    it('identifies canonical type correctly', () => {
      const blocks = registry.lookup('blocks')
      expect(blocks!.isCanonical).toBe(true)
      expect(blocks!.canonicalType).toBe('blocks')

      const blockedBy = registry.lookup('blocked-by')
      expect(blockedBy!.isCanonical).toBe(false)
      expect(blockedBy!.canonicalType).toBe('blocks')
    })

    it('handles types without inverse', () => {
      const result = registry.lookup('implements')
      expect(result!.isCanonical).toBe(true)
      expect(result!.canonicalType).toBe('implements')
    })
  })

  describe('getInverse()', () => {
    it('returns inverse for blocks', () => {
      expect(registry.getInverse('blocks')).toBe('blocked-by')
    })

    it('returns inverse for blocked-by', () => {
      expect(registry.getInverse('blocked-by')).toBe('blocks')
    })

    it('returns inverse for parent-of', () => {
      expect(registry.getInverse('parent-of')).toBe('child-of')
    })

    it('returns null for types without inverse', () => {
      expect(registry.getInverse('implements')).toBeNull()
      expect(registry.getInverse('references')).toBeNull()
    })

    it('returns null for unknown types', () => {
      expect(registry.getInverse('unknown')).toBeNull()
    })
  })

  describe('affectsReady()', () => {
    it('returns true for blocks', () => {
      expect(registry.affectsReady('blocks')).toBe(true)
    })

    it('returns true for blocked-by', () => {
      expect(registry.affectsReady('blocked-by')).toBe(true)
    })

    it('returns false for implements', () => {
      expect(registry.affectsReady('implements')).toBe(false)
    })

    it('returns false for related', () => {
      expect(registry.affectsReady('related')).toBe(false)
    })

    it('returns false for unknown types', () => {
      expect(registry.affectsReady('unknown')).toBe(false)
    })
  })

  describe('getReadyAffectingTypes()', () => {
    it('returns only types that affect ready', () => {
      const types = registry.getReadyAffectingTypes()
      expect(types).toContain('blocks')
      expect(types).toContain('blocked-by')
      expect(types).not.toContain('implements')
      expect(types).not.toContain('related')
    })
  })

  describe('getTypesForProvider()', () => {
    it('returns types for native provider', () => {
      const types = registry.getTypesForProvider('native')
      const names = types.map((t) => t.name)
      expect(names).toContain('blocks')
      expect(names).toContain('implements')
      expect(names).toContain('references')
    })

    it('returns types for beads provider', () => {
      const types = registry.getTypesForProvider('beads')
      const names = types.map((t) => t.name)
      expect(names).toContain('blocks')
      expect(names).toContain('related')
      expect(names).not.toContain('implements') // Native only
    })

    it('returns empty for unknown provider', () => {
      const types = registry.getTypesForProvider('unknown-provider')
      expect(types).toHaveLength(0)
    })
  })

  describe('register()', () => {
    it('allows registering new types', () => {
      const customType: EdgeTypeDefinition = {
        name: 'custom-blocks',
        description: 'Custom blocking relationship',
        affectsReady: true,
        direction: 'directed',
        providers: ['custom-provider'],
      }

      registry.register(customType)
      expect(registry.has('custom-blocks')).toBe(true)

      const result = registry.lookup('custom-blocks')
      expect(result!.definition.description).toBe('Custom blocking relationship')
    })

    it('allows re-registering same definition (idempotent)', () => {
      const type = BUILTIN_EDGE_TYPES[0]
      expect(() => registry.register(type)).not.toThrow()
    })

    it('throws when re-registering with different definition', () => {
      const conflicting: EdgeTypeDefinition = {
        name: 'blocks',
        description: 'Different description',
        affectsReady: false, // Different!
        direction: 'directed',
        providers: ['native'],
      }

      expect(() => registry.register(conflicting)).toThrow(
        "Edge type 'blocks' already registered with different definition"
      )
    })

    it('tracks inverse relationships for custom types', () => {
      const typeA: EdgeTypeDefinition = {
        name: 'triggers',
        description: 'Triggers execution of',
        inverseOf: 'triggered-by',
        affectsReady: false,
        direction: 'directed',
        providers: ['native'],
      }
      const typeB: EdgeTypeDefinition = {
        name: 'triggered-by',
        description: 'Is triggered by',
        inverseOf: 'triggers',
        affectsReady: false,
        direction: 'directed',
        providers: ['native'],
      }

      registry.register(typeA)
      registry.register(typeB)

      expect(registry.getInverse('triggers')).toBe('triggered-by')
      expect(registry.getInverse('triggered-by')).toBe('triggers')
    })
  })

  describe('getAll()', () => {
    it('returns all registered types', () => {
      const all = registry.getAll()
      expect(all.length).toBeGreaterThanOrEqual(BUILTIN_EDGE_TYPES.length)

      for (const type of BUILTIN_EDGE_TYPES) {
        expect(all.find((t) => t.name === type.name)).toBeDefined()
      }
    })
  })

  describe('has()', () => {
    it('returns true for registered types', () => {
      expect(registry.has('blocks')).toBe(true)
      expect(registry.has('implements')).toBe(true)
    })

    it('returns false for unregistered types', () => {
      expect(registry.has('non-existent')).toBe(false)
    })
  })
})

describe('Global Registry', () => {
  afterEach(() => {
    resetEdgeTypeRegistry()
  })

  it('returns singleton instance', () => {
    const reg1 = getEdgeTypeRegistry()
    const reg2 = getEdgeTypeRegistry()
    expect(reg1).toBe(reg2)
  })

  it('resets properly', () => {
    const reg1 = getEdgeTypeRegistry()
    resetEdgeTypeRegistry()
    const reg2 = getEdgeTypeRegistry()
    expect(reg1).not.toBe(reg2)
  })

  it('has built-in types', () => {
    const reg = getEdgeTypeRegistry()
    expect(reg.has('blocks')).toBe(true)
  })
})
