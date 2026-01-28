import { describe, it, expect } from 'vitest'
import { createValidationService } from '../validation.js'
import type { CreateNodeInput, CreateEdgeInput } from '../types.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'

describe('ValidationService', () => {
  const service = createValidationService()

  // =========================================================================
  // Node Creation Validation
  // =========================================================================

  describe('validateCreateNode', () => {
    describe('common fields', () => {
      it('requires type', () => {
        const input = { title: 'Test' } as CreateNodeInput
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'type' })
        )
      })

      it('rejects invalid type', () => {
        const input = { type: 'invalid', title: 'Test' } as unknown as CreateNodeInput
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'INVALID_TYPE', field: 'type' })
        )
      })

      it('requires title', () => {
        const input = { type: 'spec' } as CreateNodeInput
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'title' })
        )
      })

      it('rejects empty title', () => {
        const input: CreateNodeInput = { type: 'spec', title: '' }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'title' })
        )
      })

      it('rejects title exceeding max length', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'a'.repeat(501),
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'MAX_LENGTH', field: 'title' })
        )
      })

      it('rejects content exceeding max length', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test',
          content: 'a'.repeat(100_001),
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'MAX_LENGTH', field: 'content' })
        )
      })

      it('rejects invalid priority (out of range)', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test',
          priority: 5,
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'INVALID_RANGE', field: 'priority' })
        )
      })

      it('rejects negative priority', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test',
          priority: -1,
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'INVALID_RANGE', field: 'priority' })
        )
      })

      it('accepts valid priority', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test',
          priority: 2,
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
      })
    })

    describe('spec validation', () => {
      it('accepts valid spec', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test Spec',
          content: 'Some content',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
      })

      it('accepts spec with optional status', () => {
        const input: CreateNodeInput = {
          type: 'spec',
          title: 'Test Spec',
          status: 'draft',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
      })
    })

    describe('issue validation', () => {
      it('requires status for issues', () => {
        const input: CreateNodeInput = {
          type: 'issue',
          title: 'Test Issue',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'status' })
        )
      })

      it('accepts valid issue', () => {
        const input: CreateNodeInput = {
          type: 'issue',
          title: 'Test Issue',
          status: 'open',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
      })

      it('warns for non-standard status', () => {
        const input: CreateNodeInput = {
          type: 'issue',
          title: 'Test Issue',
          status: 'custom_status',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true) // Warnings don't fail validation
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NON_STANDARD_STATUS',
            field: 'status',
          })
        )
      })
    })

    describe('feedback validation', () => {
      it('requires target_id for feedback', () => {
        const input: CreateNodeInput = {
          type: 'feedback',
          title: 'Test Feedback',
          feedback_type: 'comment',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'target_id' })
        )
      })

      it('requires feedback_type for feedback', () => {
        const input: CreateNodeInput = {
          type: 'feedback',
          title: 'Test Feedback',
          target_id: 's-abc123',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'feedback_type' })
        )
      })

      it('accepts valid feedback', () => {
        const input: CreateNodeInput = {
          type: 'feedback',
          title: 'Test Feedback',
          target_id: 's-abc123',
          feedback_type: 'comment',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
      })
    })

    describe('external validation', () => {
      it('requires uri for external', () => {
        const input: CreateNodeInput = {
          type: 'external',
          title: 'External Node',
          source: 'jira',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'uri' })
        )
      })

      it('requires source for external', () => {
        const input: CreateNodeInput = {
          type: 'external',
          title: 'External Node',
          uri: 'jira://PROJ-123',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(false)
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'REQUIRED', field: 'source' })
        )
      })

      it('accepts valid external node', () => {
        const input: CreateNodeInput = {
          type: 'external',
          title: 'External Node',
          uri: 'jira://PROJ-123',
          source: 'jira',
        }
        const result = service.validateCreateNode(input)

        expect(result.valid).toBe(true)
      })
    })
  })

  // =========================================================================
  // Node Update Validation
  // =========================================================================

  describe('validateUpdateNode', () => {
    const existingIssue: StoredNode = {
      id: 'i-test',
      uuid: 'test-uuid',
      type: 'issue',
      title: 'Existing Issue',
      status: 'open',
      created_at: '2025-01-26T10:00:00Z',
      updated_at: '2025-01-26T10:00:00Z',
    }

    it('accepts valid update', () => {
      const result = service.validateUpdateNode(existingIssue, {
        title: 'Updated Title',
      })

      expect(result.valid).toBe(true)
    })

    it('rejects title exceeding max length', () => {
      const result = service.validateUpdateNode(existingIssue, {
        title: 'a'.repeat(501),
      })

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'MAX_LENGTH', field: 'title' })
      )
    })

    it('warns for non-standard status on issues', () => {
      const result = service.validateUpdateNode(existingIssue, {
        status: 'custom',
      })

      expect(result.valid).toBe(true)
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'NON_STANDARD_STATUS' })
      )
    })
  })

  // =========================================================================
  // Edge Validation
  // =========================================================================

  describe('validateCreateEdge', () => {
    const mockGetNode = async (id: string): Promise<StoredNode | null> => {
      const nodes: Record<string, StoredNode> = {
        's-spec1': {
          id: 's-spec1',
          uuid: 'spec-uuid',
          type: 'spec',
          title: 'Test Spec',
          created_at: '2025-01-26T10:00:00Z',
          updated_at: '2025-01-26T10:00:00Z',
        },
        'i-issue1': {
          id: 'i-issue1',
          uuid: 'issue-uuid',
          type: 'issue',
          title: 'Test Issue',
          status: 'open',
          created_at: '2025-01-26T10:00:00Z',
          updated_at: '2025-01-26T10:00:00Z',
        },
      }
      return nodes[id] || null
    }

    it('requires from_id', async () => {
      const input = { to_id: 's-spec1', type: 'blocks' } as CreateEdgeInput
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'REQUIRED', field: 'from_id' })
      )
    })

    it('requires to_id', async () => {
      const input = { from_id: 'i-issue1', type: 'blocks' } as CreateEdgeInput
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'REQUIRED', field: 'to_id' })
      )
    })

    it('requires type', async () => {
      const input = { from_id: 'i-issue1', to_id: 's-spec1' } as CreateEdgeInput
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'REQUIRED', field: 'type' })
      )
    })

    it('rejects self-reference', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 'i-issue1',
        type: 'blocks',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'SELF_REFERENCE' })
      )
    })

    it('errors when source node not found', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-nonexistent',
        to_id: 's-spec1',
        type: 'implements',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'NOT_FOUND', field: 'from_id' })
      )
    })

    it('errors when target node not found', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 's-nonexistent',
        type: 'implements',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'NOT_FOUND', field: 'to_id' })
      )
    })

    it('accepts valid edge', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 's-spec1',
        type: 'implements',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(true)
    })

    it('warns when implements edge has non-issue source', async () => {
      const input: CreateEdgeInput = {
        from_id: 's-spec1',
        to_id: 'i-issue1',
        type: 'implements',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(true) // Warning, not error
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'IMPLEMENTS_FROM_NON_ISSUE' })
      )
    })

    it('warns when implements edge has non-spec target', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 'i-issue1',
        type: 'implements',
      }
      // Note: This will hit self-reference first, so use different nodes
      const getNodeWithTwoIssues = async (
        id: string
      ): Promise<StoredNode | null> => {
        const nodes: Record<string, StoredNode> = {
          'i-issue1': {
            id: 'i-issue1',
            uuid: 'issue-uuid-1',
            type: 'issue',
            title: 'Test Issue 1',
            status: 'open',
            created_at: '2025-01-26T10:00:00Z',
            updated_at: '2025-01-26T10:00:00Z',
          },
          'i-issue2': {
            id: 'i-issue2',
            uuid: 'issue-uuid-2',
            type: 'issue',
            title: 'Test Issue 2',
            status: 'open',
            created_at: '2025-01-26T10:00:00Z',
            updated_at: '2025-01-26T10:00:00Z',
          },
        }
        return nodes[id] || null
      }

      const input2: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 'i-issue2',
        type: 'implements',
      }
      const result = await service.validateCreateEdge(
        input2,
        getNodeWithTwoIssues
      )

      expect(result.valid).toBe(true)
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'IMPLEMENTS_TO_NON_SPEC' })
      )
    })

    it('allows external URIs without node lookup', async () => {
      const input: CreateEdgeInput = {
        from_id: 'i-issue1',
        to_id: 'jira://PROJ-123',
        type: 'references',
      }
      const result = await service.validateCreateEdge(input, mockGetNode)

      expect(result.valid).toBe(true)
    })
  })

  // =========================================================================
  // Cycle Detection
  // =========================================================================

  describe('detectCycle', () => {
    it('detects simple cycle (A→B, adding B→A)', async () => {
      // A blocks B already exists
      const getBlocksEdges = async (nodeId: string): Promise<StoredEdge[]> => {
        if (nodeId === 'i-b') {
          return [] // B doesn't block anything yet
        }
        if (nodeId === 'i-a') {
          return [
            {
              id: 'x-1',
              uuid: 'edge-uuid-1',
              from_id: 'i-a',
              to_id: 'i-b',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ]
        }
        return []
      }

      // Adding B→A would create cycle
      const result = await service.detectCycle('i-b', 'i-a', getBlocksEdges)

      expect(result.hasCycle).toBe(true)
      expect(result.cycle).toEqual(['i-b', 'i-a'])
    })

    it('detects transitive cycle (A→B→C, adding C→A)', async () => {
      // A→B, B→C exists
      const getBlocksEdges = async (nodeId: string): Promise<StoredEdge[]> => {
        const edges: Record<string, StoredEdge[]> = {
          'i-a': [
            {
              id: 'x-1',
              uuid: 'edge-1',
              from_id: 'i-a',
              to_id: 'i-b',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ],
          'i-b': [
            {
              id: 'x-2',
              uuid: 'edge-2',
              from_id: 'i-b',
              to_id: 'i-c',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ],
          'i-c': [],
        }
        return edges[nodeId] || []
      }

      // Adding C→A would create cycle
      const result = await service.detectCycle('i-c', 'i-a', getBlocksEdges)

      expect(result.hasCycle).toBe(true)
      expect(result.cycle).toContain('i-a')
      expect(result.cycle).toContain('i-b')
      expect(result.cycle).toContain('i-c')
    })

    it('returns no cycle for valid edge', async () => {
      // A→B exists
      const getBlocksEdges = async (nodeId: string): Promise<StoredEdge[]> => {
        if (nodeId === 'i-a') {
          return [
            {
              id: 'x-1',
              uuid: 'edge-uuid-1',
              from_id: 'i-a',
              to_id: 'i-b',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ]
        }
        return []
      }

      // Adding A→C is fine (no cycle)
      const result = await service.detectCycle('i-a', 'i-c', getBlocksEdges)

      expect(result.hasCycle).toBe(false)
      expect(result.cycle).toBeUndefined()
    })

    it('handles no existing edges', async () => {
      const getBlocksEdges = async (): Promise<StoredEdge[]> => []

      const result = await service.detectCycle('i-a', 'i-b', getBlocksEdges)

      expect(result.hasCycle).toBe(false)
    })

    it('handles complex graph without cycle', async () => {
      // Diamond: A→B, A→C, B→D, C→D
      const getBlocksEdges = async (nodeId: string): Promise<StoredEdge[]> => {
        const edges: Record<string, StoredEdge[]> = {
          'i-a': [
            {
              id: 'x-1',
              uuid: 'e1',
              from_id: 'i-a',
              to_id: 'i-b',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
            {
              id: 'x-2',
              uuid: 'e2',
              from_id: 'i-a',
              to_id: 'i-c',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ],
          'i-b': [
            {
              id: 'x-3',
              uuid: 'e3',
              from_id: 'i-b',
              to_id: 'i-d',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ],
          'i-c': [
            {
              id: 'x-4',
              uuid: 'e4',
              from_id: 'i-c',
              to_id: 'i-d',
              type: 'blocks',
              created_at: '2025-01-26T10:00:00Z',
            },
          ],
          'i-d': [],
        }
        return edges[nodeId] || []
      }

      // Adding D→E is fine
      const result = await service.detectCycle('i-d', 'i-e', getBlocksEdges)

      expect(result.hasCycle).toBe(false)
    })
  })
})
