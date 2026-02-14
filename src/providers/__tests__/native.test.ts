/**
 * Tests for Native Provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createNativeProvider } from '../native.js'
import type { Provider, ProviderNode } from '../types.js'
import type { GraphStore } from '../../graph/index.js'
import type { Node, Spec, Issue, Feedback, Edge } from '../../schema/index.js'
import type { RelationshipQueryable } from '../traits/RelationshipQueryable.js'
import { isRelationshipQueryable } from '../traits/RelationshipQueryable.js'

describe('NativeProvider', () => {
  let provider: Provider & RelationshipQueryable
  let mockStore: GraphStore

  // Mock nodes for testing
  const mockSpec: Spec = {
    id: 's-abc1',
    uuid: 'uuid-1',
    type: 'spec',
    title: 'Test Spec',
    content: 'Spec content',
    priority: 1,
    tags: ['test'],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }

  const mockIssue: Issue = {
    id: 'i-xyz2',
    uuid: 'uuid-2',
    type: 'issue',
    title: 'Test Issue',
    content: 'Issue content',
    status: 'open',
    priority: 2,
    assignee: 'user1',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }

  const mockFeedback: Feedback = {
    id: 'f-def3',
    uuid: 'uuid-3',
    type: 'feedback',
    title: 'Test Feedback',
    content: 'Feedback content',
    target_id: 's-abc1',
    feedback_type: 'comment',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }

  // Mock edges for testing
  const mockBlocksEdge: Edge = {
    id: 'e-block1',
    uuid: 'edge-uuid-1',
    from_id: 'i-xyz2',
    to_id: 's-abc1',
    type: 'blocks',
    created_at: '2024-01-01T00:00:00.000Z',
  }

  const mockImplementsEdge: Edge = {
    id: 'e-impl1',
    uuid: 'edge-uuid-2',
    from_id: 'i-xyz2',
    to_id: 's-abc1',
    type: 'implements',
    created_at: '2024-01-01T00:00:00.000Z',
  }

  beforeEach(() => {
    mockStore = {
      getNode: vi.fn(),
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      query: {
        nodes: vi.fn(),
        edges: vi.fn(),
        edgesFrom: vi.fn().mockResolvedValue([]),
        edgesTo: vi.fn().mockResolvedValue([]),
        edgesFor: vi.fn().mockResolvedValue([]),
        blockers: vi.fn(),
        blocking: vi.fn(),
        ready: vi.fn(),
        children: vi.fn(),
        descendants: vi.fn(),
        ancestors: vi.fn(),
        parent: vi.fn(),
        implementers: vi.fn(),
        specs: vi.fn(),
        isBlocking: vi.fn(),
        feedback: vi.fn(),
        unresolvedFeedback: vi.fn(),
      },
      initialize: vi.fn(),
      close: vi.fn(),
      flush: vi.fn(),
      createEdge: vi.fn(),
      getEdge: vi.fn(),
      deleteEdge: vi.fn(),
      restoreNode: vi.fn(),
      addTags: vi.fn(),
      removeTags: vi.fn(),
      setTags: vi.fn(),
      transaction: vi.fn(),
    } as unknown as GraphStore

    provider = createNativeProvider(mockStore)
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('native')
    })

    it('should have correct schemes', () => {
      expect(provider.schemes).toEqual(['native', 'opentasks'])
    })

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: true,
        search: true,
        watch: false,
        mount: true,
        feedback: true,
      })
    })
  })

  describe('parseUri', () => {
    it('should parse native:// URIs', () => {
      const result = provider.parseUri('native://s-abc1')
      expect(result).toEqual({
        scheme: 'native',
        id: 's-abc1',
        isRelative: false,
      })
    })

    it('should parse opentasks:// URIs', () => {
      const result = provider.parseUri('opentasks://i-xyz2')
      expect(result).toEqual({
        scheme: 'opentasks',
        id: 'i-xyz2',
        isRelative: false,
      })
    })

    it('should parse local IDs (s-, i-, f-, e-, x-)', () => {
      expect(provider.parseUri('s-abc1')).toEqual({
        scheme: 'native',
        id: 's-abc1',
        isRelative: true,
      })
      expect(provider.parseUri('i-xyz2')).toEqual({
        scheme: 'native',
        id: 'i-xyz2',
        isRelative: true,
      })
      expect(provider.parseUri('f-def3')).toEqual({
        scheme: 'native',
        id: 'f-def3',
        isRelative: true,
      })
      expect(provider.parseUri('e-ghi4')).toEqual({
        scheme: 'native',
        id: 'e-ghi4',
        isRelative: true,
      })
      expect(provider.parseUri('x-jkl5')).toEqual({
        scheme: 'native',
        id: 'x-jkl5',
        isRelative: true,
      })
    })

    it('should be case-insensitive for schemes', () => {
      expect(provider.parseUri('NATIVE://s-abc1')).toEqual({
        scheme: 'native',
        id: 's-abc1',
        isRelative: false,
      })
      expect(provider.parseUri('Native://i-xyz2')).toEqual({
        scheme: 'native',
        id: 'i-xyz2',
        isRelative: false,
      })
    })

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('beads://bd-123')).toBeNull()
      expect(provider.parseUri('jira://PROJ-123')).toBeNull()
    })

    it('should return null for invalid IDs', () => {
      expect(provider.parseUri('invalid')).toBeNull()
      expect(provider.parseUri('not-a-valid-id')).toBeNull()
    })
  })

  describe('buildUri', () => {
    it('should build full URIs by default', () => {
      expect(provider.buildUri('s-abc1')).toBe('native://s-abc1')
      expect(provider.buildUri('i-xyz2')).toBe('native://i-xyz2')
    })

    it('should build relative URIs when requested', () => {
      expect(provider.buildUri('s-abc1', { relative: true })).toBe('s-abc1')
      expect(provider.buildUri('i-xyz2', { relative: true })).toBe('i-xyz2')
    })
  })

  describe('isValidUri', () => {
    it('should return true for valid URIs', () => {
      expect(provider.isValidUri('native://s-abc1')).toBe(true)
      expect(provider.isValidUri('opentasks://i-xyz2')).toBe(true)
      expect(provider.isValidUri('s-abc1')).toBe(true)
    })

    it('should return false for invalid URIs', () => {
      expect(provider.isValidUri('beads://bd-123')).toBe(false)
      expect(provider.isValidUri('invalid')).toBe(false)
    })
  })

  describe('get', () => {
    it('should get a node by ID', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockSpec)

      const result = await provider.get('s-abc1')

      expect(mockStore.getNode).toHaveBeenCalledWith('s-abc1')
      expect(result).toMatchObject({
        id: 's-abc1',
        type: 'spec',
        title: 'Test Spec',
        content: 'Spec content',
        priority: 1,
      })
    })

    it('should get a node by full URI', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockSpec)

      const result = await provider.get('native://s-abc1')

      expect(mockStore.getNode).toHaveBeenCalledWith('s-abc1')
      expect(result).not.toBeNull()
    })

    it('should return null for non-existent node', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(null)

      const result = await provider.get('s-notfound')

      expect(result).toBeNull()
    })

    it('should include status for issues', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)

      const result = await provider.get('i-xyz2')

      expect(result?.status).toBe('open')
    })
  })

  describe('list', () => {
    it('should list nodes without filter', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockSpec, mockIssue])

      const result = await provider.list()

      expect(mockStore.query.nodes).toHaveBeenCalledWith({})
      expect(result).toHaveLength(2)
    })

    it('should list nodes with type filter', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockSpec])

      const result = await provider.list({ type: 'spec' })

      expect(mockStore.query.nodes).toHaveBeenCalledWith({ type: 'spec' })
      expect(result).toHaveLength(1)
    })

    it('should list nodes with status filter', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockIssue])

      const result = await provider.list({ status: 'open' })

      expect(mockStore.query.nodes).toHaveBeenCalledWith({ status: 'open' })
      expect(result).toHaveLength(1)
    })

    it('should list nodes with limit and offset', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockSpec])

      await provider.list({ limit: 10, offset: 5 })

      expect(mockStore.query.nodes).toHaveBeenCalledWith({
        limit: 10,
        offset: 5,
      })
    })
  })

  describe('create', () => {
    it('should create a spec', async () => {
      vi.mocked(mockStore.createNode).mockResolvedValue(mockSpec)

      const result = await provider.create({
        type: 'spec',
        title: 'New Spec',
        content: 'New spec content',
      })

      expect(mockStore.createNode).toHaveBeenCalledWith({
        type: 'spec',
        title: 'New Spec',
        content: 'New spec content',
        status: undefined,
        priority: undefined,
        metadata: undefined,
      })
      expect(result.type).toBe('spec')
    })

    it('should create an issue', async () => {
      vi.mocked(mockStore.createNode).mockResolvedValue(mockIssue)

      const result = await provider.create({
        type: 'issue',
        title: 'New Issue',
        status: 'open',
        priority: 2,
      })

      expect(mockStore.createNode).toHaveBeenCalledWith({
        type: 'issue',
        title: 'New Issue',
        content: undefined,
        status: 'open',
        priority: 2,
        metadata: undefined,
      })
      expect(result.type).toBe('issue')
      expect(result.status).toBe('open')
    })

    it('should map task type to issue', async () => {
      vi.mocked(mockStore.createNode).mockResolvedValue(mockIssue)

      await provider.create({
        type: 'issue',
        title: 'New Task',
      })

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'issue' })
      )
    })
  })

  describe('update', () => {
    it('should update a node by ID', async () => {
      vi.mocked(mockStore.updateNode).mockResolvedValue({
        ...mockSpec,
        title: 'Updated Title',
      })

      const result = await provider.update('s-abc1', { title: 'Updated Title' })

      expect(mockStore.updateNode).toHaveBeenCalledWith('s-abc1', {
        title: 'Updated Title',
        content: undefined,
        status: undefined,
        priority: undefined,
        metadata: undefined,
      })
      expect(result.title).toBe('Updated Title')
    })

    it('should update a node by full URI', async () => {
      vi.mocked(mockStore.updateNode).mockResolvedValue(mockSpec)

      await provider.update('native://s-abc1', { title: 'Updated' })

      expect(mockStore.updateNode).toHaveBeenCalledWith('s-abc1', expect.any(Object))
    })

    it('should update status', async () => {
      vi.mocked(mockStore.updateNode).mockResolvedValue({
        ...mockIssue,
        status: 'closed',
      })

      const result = await provider.update('i-xyz2', { status: 'closed' })

      expect(mockStore.updateNode).toHaveBeenCalledWith(
        'i-xyz2',
        expect.objectContaining({ status: 'closed' })
      )
      expect(result.status).toBe('closed')
    })
  })

  describe('delete', () => {
    it('should delete a node by ID', async () => {
      vi.mocked(mockStore.deleteNode).mockResolvedValue(undefined)

      await provider.delete('s-abc1')

      expect(mockStore.deleteNode).toHaveBeenCalledWith('s-abc1')
    })

    it('should delete a node by full URI', async () => {
      vi.mocked(mockStore.deleteNode).mockResolvedValue(undefined)

      await provider.delete('native://s-abc1')

      expect(mockStore.deleteNode).toHaveBeenCalledWith('s-abc1')
    })
  })

  describe('search', () => {
    it('should search nodes by query', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockSpec])

      const result = await provider.search!('test')

      expect(mockStore.query.nodes).toHaveBeenCalledWith({
        search: 'test',
        limit: undefined,
        type: undefined,
      })
      expect(result).toHaveLength(1)
    })

    it('should search with limit', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockSpec])

      await provider.search!('test', { limit: 5 })

      expect(mockStore.query.nodes).toHaveBeenCalledWith({
        search: 'test',
        limit: 5,
        type: undefined,
      })
    })

    it('should search with type filter', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([mockIssue])

      await provider.search!('test', { type: 'issue' })

      expect(mockStore.query.nodes).toHaveBeenCalledWith({
        search: 'test',
        limit: undefined,
        type: 'issue',
      })
    })
  })

  describe('node conversion', () => {
    it('should convert spec to ProviderNode correctly', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockSpec)

      const result = await provider.get('s-abc1')

      expect(result).toMatchObject({
        id: 's-abc1',
        uri: 'native://s-abc1',
        type: 'spec',
        title: 'Test Spec',
        content: 'Spec content',
        priority: 1,
      })
      expect(result?.rawData).toMatchObject({
        uuid: 'uuid-1',
        tags: ['test'],
      })
      expect(result?.fetchedAt).toBeDefined()
    })

    it('should convert issue to ProviderNode with status', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)

      const result = await provider.get('i-xyz2')

      expect(result).toMatchObject({
        id: 'i-xyz2',
        uri: 'native://i-xyz2',
        type: 'issue',
        title: 'Test Issue',
        status: 'open',
        priority: 2,
      })
      expect(result?.rawData).toMatchObject({
        assignee: 'user1',
      })
    })

    it('should convert feedback to ProviderNode', async () => {
      vi.mocked(mockStore.getNode).mockResolvedValue(mockFeedback)

      const result = await provider.get('f-def3')

      expect(result).toMatchObject({
        id: 'f-def3',
        uri: 'native://f-def3',
        type: 'feedback',
        title: 'Test Feedback',
      })
      expect(result?.rawData).toMatchObject({
        target_id: 's-abc1',
        feedback_type: 'comment',
      })
    })
  })

  describe('RelationshipQueryable', () => {
    describe('isRelationshipQueryable', () => {
      it('should return true for NativeProvider', () => {
        expect(isRelationshipQueryable(provider)).toBe(true)
      })
    })

    describe('supportedEdgeTypes', () => {
      it('should return all built-in edge types', () => {
        const edgeTypes = provider.supportedEdgeTypes()

        expect(edgeTypes.length).toBe(12)
        expect(edgeTypes).toContainEqual({
          type: 'blocks',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
        expect(edgeTypes).toContainEqual({
          type: 'implements',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
        expect(edgeTypes).toContainEqual({
          type: 'parent-of',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
        expect(edgeTypes).toContainEqual({
          type: 'related',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
      })
    })

    describe('queryEdges', () => {
      it('should return empty array for non-existent node', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(null)

        const edges = await provider.queryEdges('i-notfound')

        expect(edges).toEqual([])
      })

      it('should return outgoing edges', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([mockBlocksEdge, mockImplementsEdge])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([])

        const edges = await provider.queryEdges('i-xyz2', { direction: 'out' })

        expect(mockStore.query.edgesFrom).toHaveBeenCalledWith('i-xyz2', undefined)
        expect(edges).toHaveLength(2)
        expect(edges[0]).toMatchObject({
          from: 'i-xyz2',
          to: 's-abc1',
          type: 'blocks',
        })
        expect(edges[1]).toMatchObject({
          from: 'i-xyz2',
          to: 's-abc1',
          type: 'implements',
        })
      })

      it('should return incoming edges', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(mockSpec)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([mockBlocksEdge])

        const edges = await provider.queryEdges('s-abc1', { direction: 'in' })

        expect(mockStore.query.edgesTo).toHaveBeenCalledWith('s-abc1', undefined)
        expect(edges).toHaveLength(1)
        expect(edges[0]).toMatchObject({
          from: 'i-xyz2',
          to: 's-abc1',
          type: 'blocks',
        })
      })

      it('should return both directions by default', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([mockImplementsEdge])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([mockBlocksEdge])

        const edges = await provider.queryEdges('i-xyz2')

        expect(mockStore.query.edgesFrom).toHaveBeenCalled()
        expect(mockStore.query.edgesTo).toHaveBeenCalled()
        expect(edges).toHaveLength(2)
      })

      it('should filter by edge type', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([mockBlocksEdge])

        const edges = await provider.queryEdges('i-xyz2', {
          direction: 'out',
          edgeType: 'blocks',
        })

        expect(mockStore.query.edgesFrom).toHaveBeenCalledWith('i-xyz2', 'blocks')
        expect(edges).toHaveLength(1)
        expect(edges[0].type).toBe('blocks')
      })

      it('should deduplicate edges with both direction', async () => {
        const sameEdge = mockBlocksEdge
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([sameEdge])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([sameEdge])

        const edges = await provider.queryEdges('i-xyz2', { direction: 'both' })

        // Should deduplicate the same edge appearing in both directions
        expect(edges).toHaveLength(1)
      })

      it('should apply limit', async () => {
        const edges = [
          { ...mockBlocksEdge, id: 'e-1', to_id: 's-1' },
          { ...mockBlocksEdge, id: 'e-2', to_id: 's-2' },
          { ...mockBlocksEdge, id: 'e-3', to_id: 's-3' },
        ]
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue(edges)
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([])

        const result = await provider.queryEdges('i-xyz2', { direction: 'out', limit: 2 })

        expect(result).toHaveLength(2)
      })

      it('should query by full URI', async () => {
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([mockBlocksEdge])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([])

        await provider.queryEdges('native://i-xyz2', { direction: 'out' })

        expect(mockStore.getNode).toHaveBeenCalledWith('i-xyz2')
        expect(mockStore.query.edgesFrom).toHaveBeenCalledWith('i-xyz2', undefined)
      })

      it('should include metadata in returned edges', async () => {
        const edgeWithMetadata = {
          ...mockBlocksEdge,
          metadata: { reason: 'dependency' },
        }
        vi.mocked(mockStore.getNode).mockResolvedValue(mockIssue)
        vi.mocked(mockStore.query.edgesFrom).mockResolvedValue([edgeWithMetadata])
        vi.mocked(mockStore.query.edgesTo).mockResolvedValue([])

        const edges = await provider.queryEdges('i-xyz2', { direction: 'out' })

        expect(edges[0].metadata).toEqual({ reason: 'dependency' })
      })
    })
  })
})
