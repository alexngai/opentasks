/**
 * Tests for Beads Provider
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createBeadsProvider } from '../beads.js'
import type { Provider } from '../types.js'
import { ProviderError } from '../types.js'
import type { RelationshipQueryable } from '../traits/RelationshipQueryable.js'
import { isRelationshipQueryable } from '../traits/RelationshipQueryable.js'

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'

describe('BeadsProvider', () => {
  let provider: Provider & RelationshipQueryable
  let mockExec: Mock

  // Helper to set up mock exec response
  function mockExecResponse(stdout: string, stderr: string = '') {
    mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
      // Handle both callback styles
      const cb = callback || options
      if (typeof cb === 'function') {
        cb(null, { stdout, stderr })
      }
      return { stdout, stderr }
    })
  }

  function mockExecError(error: Error & { code?: string; killed?: boolean }) {
    mockExec.mockImplementation((cmd: string, options: any, callback?: any) => {
      const cb = callback || options
      if (typeof cb === 'function') {
        cb(error, { stdout: '', stderr: error.message })
      }
    })
  }

  beforeEach(() => {
    mockExec = exec as unknown as Mock
    mockExec.mockReset()
    provider = createBeadsProvider()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('beads')
    })

    it('should have correct schemes', () => {
      expect(provider.schemes).toEqual(['beads', 'bd'])
    })

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: true,
        search: true,
        watch: false,
      })
    })
  })

  describe('parseUri', () => {
    it('should parse beads:// URIs with workspace', () => {
      const result = provider.parseUri('beads://workspace/bd-123')
      expect(result).toEqual({
        scheme: 'beads',
        workspace: 'workspace',
        id: 'bd-123',
        isRelative: false,
      })
    })

    it('should parse beads:// URIs with relative workspace', () => {
      const result = provider.parseUri('beads://./bd-456')
      expect(result).toEqual({
        scheme: 'beads',
        workspace: '.',
        id: 'bd-456',
        isRelative: true,
      })
    })

    it('should parse bd:// shorthand URIs', () => {
      const result = provider.parseUri('bd://bd-789')
      expect(result).toEqual({
        scheme: 'bd',
        workspace: '.',
        id: 'bd-789',
        isRelative: true,
      })
    })

    it('should parse bd:// URIs with workspace', () => {
      const result = provider.parseUri('bd://myworkspace/bd-abc')
      expect(result).toEqual({
        scheme: 'bd',
        workspace: 'myworkspace',
        id: 'bd-abc',
        isRelative: false,
      })
    })

    it('should parse bare Beads IDs', () => {
      const result = provider.parseUri('bd-xyz')
      expect(result).toEqual({
        scheme: 'beads',
        workspace: '.',
        id: 'bd-xyz',
        isRelative: true,
      })
    })

    it('should be case-insensitive for schemes', () => {
      expect(provider.parseUri('BEADS://./bd-123')).toMatchObject({
        scheme: 'beads',
        id: 'bd-123',
      })
      expect(provider.parseUri('BD://./bd-456')).toMatchObject({
        scheme: 'bd',
        id: 'bd-456',
      })
    })

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('native://s-abc1')).toBeNull()
      expect(provider.parseUri('jira://PROJ-123')).toBeNull()
    })

    it('should return null for invalid IDs', () => {
      expect(provider.parseUri('invalid')).toBeNull()
      expect(provider.parseUri('s-abc1')).toBeNull()
    })
  })

  describe('buildUri', () => {
    it('should build full URIs with default workspace', () => {
      expect(provider.buildUri('bd-123')).toBe('beads://./bd-123')
    })

    it('should build full URIs with custom workspace', () => {
      expect(provider.buildUri('bd-123', { workspace: 'myworkspace' })).toBe(
        'beads://myworkspace/bd-123'
      )
    })

    it('should build relative URIs when requested', () => {
      expect(provider.buildUri('bd-123', { relative: true })).toBe('bd-123')
    })
  })

  describe('isValidUri', () => {
    it('should return true for valid URIs', () => {
      expect(provider.isValidUri('beads://./bd-123')).toBe(true)
      expect(provider.isValidUri('bd://bd-456')).toBe(true)
      expect(provider.isValidUri('bd-xyz')).toBe(true)
    })

    it('should return false for invalid URIs', () => {
      expect(provider.isValidUri('native://s-abc1')).toBe(false)
      expect(provider.isValidUri('invalid')).toBe(false)
    })
  })

  describe('get', () => {
    const mockIssue = {
      id: 'bd-123',
      title: 'Test Issue',
      description: 'Test description',
      status: 'open',
      priority: 2,
    }

    it('should get an issue by ID', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([mockIssue]))

      const result = await provider.get('bd-123')

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd show bd-123 --json')

      expect(result).toMatchObject({
        id: 'bd-123',
        type: 'issue',
        title: 'Test Issue',
        content: 'Test description',
        status: 'open',
        priority: 2,
      })
    })

    it('should get an issue by full URI', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([mockIssue]))

      const result = await provider.get('beads://./bd-123')

      expect(result).not.toBeNull()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd show bd-123 --json')
    })

    it('should return null for non-existent issue', async () => {
      const error = new Error('Issue not found') as Error & { code?: string }
      mockExecError(error)

      const result = await provider.get('bd-notfound')

      expect(result).toBeNull()
    })

    it('should include rawData', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([mockIssue]))

      const result = await provider.get('bd-123')

      expect(result?.rawData).toEqual(mockIssue)
    })
  })

  describe('list', () => {
    const mockIssues = [
      { id: 'bd-1', title: 'Issue 1', status: 'open' },
      { id: 'bd-2', title: 'Issue 2', status: 'done' },
    ]

    it('should list all issues', async () => {
      mockExecResponse(JSON.stringify(mockIssues))

      const result = await provider.list()

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd list --json')

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('bd-1')
      expect(result[1].id).toBe('bd-2')
    })

    it('should list issues with status filter', async () => {
      mockExecResponse(JSON.stringify([mockIssues[0]]))

      await provider.list({ status: 'open' })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--status open')
    })

    it('should list issues with limit', async () => {
      mockExecResponse(JSON.stringify([mockIssues[0]]))

      await provider.list({ limit: 10 })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--limit 10')
    })
  })

  describe('create', () => {
    const mockCreatedIssue = {
      id: 'bd-new',
      title: 'New Issue',
      description: 'New description',
      status: 'open',
    }

    it('should create an issue', async () => {
      mockExecResponse(JSON.stringify(mockCreatedIssue))

      const result = await provider.create({
        type: 'issue',
        title: 'New Issue',
        content: 'New description',
      })

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd create')
      expect(callArgs).toContain('New Issue')
      expect(callArgs).toContain('--description')

      expect(result.id).toBe('bd-new')
      expect(result.title).toBe('New Issue')
    })

    it('should create an issue with status', async () => {
      mockExecResponse(JSON.stringify(mockCreatedIssue))

      await provider.create({
        type: 'issue',
        title: 'New Issue',
        status: 'in_progress',
      })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--status in_progress')
    })

    it('should create an issue with priority', async () => {
      mockExecResponse(JSON.stringify(mockCreatedIssue))

      await provider.create({
        type: 'issue',
        title: 'New Issue',
        priority: 1,
      })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--priority 1')
    })
  })

  describe('update', () => {
    const mockUpdatedIssue = {
      id: 'bd-123',
      title: 'Updated Title',
      status: 'done',
    }

    it('should update an issue', async () => {
      // bd update returns an array
      mockExecResponse(JSON.stringify([mockUpdatedIssue]))

      const result = await provider.update('bd-123', { title: 'Updated Title' })

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd update bd-123')
      expect(callArgs).toContain('--title')

      expect(result.title).toBe('Updated Title')
    })

    it('should update status', async () => {
      // bd update returns an array
      mockExecResponse(JSON.stringify([mockUpdatedIssue]))

      await provider.update('bd-123', { status: 'done' })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--status done')
    })

    it('should update by full URI', async () => {
      // bd update returns an array
      mockExecResponse(JSON.stringify([mockUpdatedIssue]))

      await provider.update('beads://./bd-123', { title: 'Updated' })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd update bd-123')
    })
  })

  describe('delete', () => {
    it('should delete an issue', async () => {
      mockExecResponse('')

      await provider.delete('bd-123')

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd delete bd-123')
      expect(callArgs).toContain('--force')
    })

    it('should delete by full URI', async () => {
      mockExecResponse('')

      await provider.delete('beads://./bd-123')

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd delete bd-123')
    })
  })

  describe('search', () => {
    const mockSearchResults = [
      { id: 'bd-1', title: 'Search result 1' },
      { id: 'bd-2', title: 'Search result 2' },
    ]

    it('should search issues', async () => {
      mockExecResponse(JSON.stringify(mockSearchResults))

      const result = await provider.search!('test query')

      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('bd search')
      expect(callArgs).toContain('test query')
      expect(callArgs).toContain('--json')

      expect(result).toHaveLength(2)
    })

    it('should search with limit', async () => {
      mockExecResponse(JSON.stringify([mockSearchResults[0]]))

      await provider.search!('query', { limit: 5 })

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('--limit 5')
    })
  })

  describe('error handling', () => {
    it('should throw ProviderError for missing executable', async () => {
      const error = new Error('spawn ENOENT') as Error & { code?: string }
      error.code = 'ENOENT'
      mockExecError(error)

      await expect(provider.get('bd-123')).rejects.toThrow(ProviderError)
      await expect(provider.get('bd-123')).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      })
    })

    it('should throw ProviderError for timeout', async () => {
      const error = new Error('Command timeout') as Error & { killed?: boolean }
      error.killed = true
      mockExecError(error)

      await expect(provider.get('bd-123')).rejects.toThrow(ProviderError)
      await expect(provider.get('bd-123')).rejects.toMatchObject({
        code: 'TIMEOUT',
      })
    })

    it('should throw ProviderError for invalid JSON', async () => {
      mockExecResponse('not valid json')

      await expect(provider.get('bd-123')).rejects.toThrow(ProviderError)
      await expect(provider.get('bd-123')).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      })
    })
  })

  describe('priority mapping', () => {
    it('should map numeric priorities', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([{ id: 'bd-1', title: 'Test', priority: 0 }]))
      const result = await provider.get('bd-1')
      expect(result?.priority).toBe(0)
    })

    it('should map string priorities', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([{ id: 'bd-1', title: 'Test', priority: 'high' }]))
      const result = await provider.get('bd-1')
      expect(result?.priority).toBe(1)

      mockExecResponse(JSON.stringify([{ id: 'bd-2', title: 'Test', priority: 'critical' }]))
      const result2 = await provider.get('bd-2')
      expect(result2?.priority).toBe(0)

      mockExecResponse(JSON.stringify([{ id: 'bd-3', title: 'Test', priority: 'low' }]))
      const result3 = await provider.get('bd-3')
      expect(result3?.priority).toBe(3)
    })

    it('should handle missing priority', async () => {
      // bd show returns an array
      mockExecResponse(JSON.stringify([{ id: 'bd-1', title: 'Test' }]))
      const result = await provider.get('bd-1')
      expect(result?.priority).toBeUndefined()
    })
  })

  describe('configuration', () => {
    it('should use custom executable', async () => {
      const customProvider = createBeadsProvider({ executable: '/custom/bd' })
      // bd show returns an array
      mockExecResponse(JSON.stringify([{ id: 'bd-1', title: 'Test' }]))

      await customProvider.get('bd-1')

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('/custom/bd')
    })
  })

  describe('RelationshipQueryable', () => {
    describe('isRelationshipQueryable', () => {
      it('should return true for BeadsProvider', () => {
        expect(isRelationshipQueryable(provider)).toBe(true)
      })
    })

    describe('supportedEdgeTypes', () => {
      it('should return supported edge types', () => {
        const edgeTypes = provider.supportedEdgeTypes()

        expect(edgeTypes).toHaveLength(2)
        expect(edgeTypes).toContainEqual({
          type: 'blocks',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
        expect(edgeTypes).toContainEqual({
          type: 'parent-child',
          canQuery: true,
          canCreate: true,
          canDelete: true,
        })
      })
    })

    describe('queryEdges', () => {
      it('should return empty array for issue with no relationships', async () => {
        mockExecResponse(JSON.stringify([{ id: 'bd-123', title: 'Test Issue' }]))

        const edges = await provider.queryEdges('bd-123')

        expect(edges).toEqual([])
      })

      it('should parse blocks relationships', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456', 'bd-789'],
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123')

        expect(edges).toHaveLength(2)
        expect(edges).toContainEqual({
          from: 'bd-123',
          to: 'bd-456',
          type: 'blocks',
        })
        expect(edges).toContainEqual({
          from: 'bd-123',
          to: 'bd-789',
          type: 'blocks',
        })
      })

      it('should parse blockedBy relationships', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blockedBy: ['bd-001', 'bd-002'],
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123')

        expect(edges).toHaveLength(2)
        expect(edges).toContainEqual({
          from: 'bd-001',
          to: 'bd-123',
          type: 'blocks',
        })
        expect(edges).toContainEqual({
          from: 'bd-002',
          to: 'bd-123',
          type: 'blocks',
        })
      })

      it('should parse parent relationship', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-child',
              title: 'Child Issue',
              parent: 'bd-parent',
            },
          ])
        )

        const edges = await provider.queryEdges('bd-child')

        expect(edges).toHaveLength(1)
        expect(edges[0]).toEqual({
          from: 'bd-parent',
          to: 'bd-child',
          type: 'parent-child',
        })
      })

      it('should parse children relationships', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-parent',
              title: 'Parent Issue',
              children: ['bd-child1', 'bd-child2'],
            },
          ])
        )

        const edges = await provider.queryEdges('bd-parent')

        expect(edges).toHaveLength(2)
        expect(edges).toContainEqual({
          from: 'bd-parent',
          to: 'bd-child1',
          type: 'parent-child',
        })
        expect(edges).toContainEqual({
          from: 'bd-parent',
          to: 'bd-child2',
          type: 'parent-child',
        })
      })

      it('should combine all relationship types', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456'],
              blockedBy: ['bd-789'],
              parent: 'bd-parent',
              children: ['bd-child'],
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123')

        expect(edges).toHaveLength(4)
      })

      it('should filter by edge type', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456'],
              parent: 'bd-parent',
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123', { edgeType: 'blocks' })

        expect(edges).toHaveLength(1)
        expect(edges[0].type).toBe('blocks')
      })

      it('should filter by direction (out)', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456'], // outgoing
              blockedBy: ['bd-789'], // incoming
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123', { direction: 'out' })

        expect(edges).toHaveLength(1)
        expect(edges[0].from).toBe('bd-123')
        expect(edges[0].to).toBe('bd-456')
      })

      it('should filter by direction (in)', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456'], // outgoing
              blockedBy: ['bd-789'], // incoming
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123', { direction: 'in' })

        expect(edges).toHaveLength(1)
        expect(edges[0].from).toBe('bd-789')
        expect(edges[0].to).toBe('bd-123')
      })

      it('should apply limit', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-1', 'bd-2', 'bd-3', 'bd-4', 'bd-5'],
            },
          ])
        )

        const edges = await provider.queryEdges('bd-123', { limit: 2 })

        expect(edges).toHaveLength(2)
      })

      it('should query by full URI', async () => {
        mockExecResponse(
          JSON.stringify([
            {
              id: 'bd-123',
              title: 'Test Issue',
              blocks: ['bd-456'],
            },
          ])
        )

        const edges = await provider.queryEdges('beads://./bd-123')

        expect(mockExec).toHaveBeenCalled()
        const callArgs = mockExec.mock.calls[0][0]
        expect(callArgs).toContain('bd show bd-123 --json')

        expect(edges).toHaveLength(1)
      })

      it('should return empty array for non-existent issue', async () => {
        const error = new Error('Issue not found') as Error & { code?: string }
        mockExecError(error)

        const edges = await provider.queryEdges('bd-notfound')

        expect(edges).toEqual([])
      })
    })
  })
})
