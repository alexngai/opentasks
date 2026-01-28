import { describe, it, expect } from 'vitest'
import {
  isSpec,
  isIssue,
  isFeedback,
  isExternal,
  validateStoredNode,
  parseNode,
  tryParseNode,
  ValidationError,
} from '../validation.js'
import type { StoredNode } from '../storage.js'
import type { Node, Spec, Issue, Feedback, ExternalNode } from '../nodes.js'

// Test fixtures
const baseFields = {
  id: 's-a2b3',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  title: 'Test Node',
  created_at: '2025-01-26T10:00:00Z',
  updated_at: '2025-01-26T10:00:00Z',
}

const validSpec: StoredNode = {
  ...baseFields,
  type: 'spec',
  content: '## Overview\n\nThis is a spec.',
}

const validIssue: StoredNode = {
  ...baseFields,
  id: 'i-x7k9',
  type: 'issue',
  status: 'open',
}

const validFeedback: StoredNode = {
  ...baseFields,
  id: 'f-m4n5',
  type: 'feedback',
  target_id: 's-a2b3',
  feedback_type: 'suggestion',
}

const validExternal: StoredNode = {
  ...baseFields,
  id: 'e-p6q7',
  type: 'external',
  uri: 'jira://PROJ-123',
  source: 'jira',
  materialized: false,
}

describe('Type Guards', () => {
  it('isSpec returns true for spec nodes', () => {
    const node = parseNode(validSpec)
    expect(isSpec(node)).toBe(true)
    expect(isIssue(node)).toBe(false)
    expect(isFeedback(node)).toBe(false)
    expect(isExternal(node)).toBe(false)
  })

  it('isIssue returns true for issue nodes', () => {
    const node = parseNode(validIssue)
    expect(isIssue(node)).toBe(true)
    expect(isSpec(node)).toBe(false)
  })

  it('isFeedback returns true for feedback nodes', () => {
    const node = parseNode(validFeedback)
    expect(isFeedback(node)).toBe(true)
    expect(isSpec(node)).toBe(false)
  })

  it('isExternal returns true for external nodes', () => {
    const node = parseNode(validExternal)
    expect(isExternal(node)).toBe(true)
    expect(isSpec(node)).toBe(false)
  })
})

describe('validateStoredNode', () => {
  it('validates a valid spec', () => {
    const result = validateStoredNode(validSpec)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid issue', () => {
    const result = validateStoredNode(validIssue)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid feedback', () => {
    const result = validateStoredNode(validFeedback)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid external node', () => {
    const result = validateStoredNode(validExternal)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects node missing required core fields', () => {
    const invalid: StoredNode = {
      id: 's-a2b3',
      uuid: '',
      type: 'spec',
      title: '',
      created_at: '',
      updated_at: '2025-01-26T10:00:00Z',
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => e.field === 'uuid')).toBe(true)
    expect(result.errors.some((e) => e.field === 'title')).toBe(true)
  })

  it('rejects issue missing status', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'issue',
      // missing status
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'status')).toBe(true)
  })

  it('rejects feedback missing target_id', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'feedback',
      feedback_type: 'comment',
      // missing target_id
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'target_id')).toBe(true)
  })

  it('rejects feedback missing feedback_type', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'feedback',
      target_id: 's-a2b3',
      // missing feedback_type
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'feedback_type')).toBe(true)
  })

  it('rejects external missing uri', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'external',
      source: 'jira',
      materialized: false,
      // missing uri
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'uri')).toBe(true)
  })

  it('rejects external missing source', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'external',
      uri: 'jira://PROJ-123',
      materialized: false,
      // missing source
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'source')).toBe(true)
  })

  it('rejects external missing materialized', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'external',
      uri: 'jira://PROJ-123',
      source: 'jira',
      // missing materialized
    }
    const result = validateStoredNode(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'materialized')).toBe(true)
  })
})

describe('parseNode', () => {
  it('parses a valid spec', () => {
    const node = parseNode(validSpec)
    expect(node.type).toBe('spec')
    expect(isSpec(node)).toBe(true)
  })

  it('parses a valid issue', () => {
    const node = parseNode(validIssue)
    expect(node.type).toBe('issue')
    expect(isIssue(node)).toBe(true)
    if (isIssue(node)) {
      expect(node.status).toBe('open')
    }
  })

  it('throws ValidationError for invalid node', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'issue',
      // missing status
    }
    expect(() => parseNode(invalid)).toThrow(ValidationError)
  })

  it('preserves unknown fields', () => {
    const withExtra: StoredNode = {
      ...validSpec,
      customField: 'custom value',
      anotherField: 123,
    }
    const node = parseNode(withExtra)
    expect((node as any).customField).toBe('custom value')
    expect((node as any).anotherField).toBe(123)
  })
})

describe('tryParseNode', () => {
  it('returns node for valid input', () => {
    const node = tryParseNode(validSpec)
    expect(node).not.toBeNull()
    expect(node?.type).toBe('spec')
  })

  it('returns null for invalid input', () => {
    const invalid: StoredNode = {
      ...baseFields,
      type: 'issue',
      // missing status
    }
    const node = tryParseNode(invalid)
    expect(node).toBeNull()
  })
})

describe('Node type narrowing', () => {
  it('allows type-safe access after guard', () => {
    const node = parseNode(validIssue)

    if (isIssue(node)) {
      // TypeScript should allow access to issue-specific fields
      expect(node.status).toBe('open')
      // assignee is optional on issues
      expect(node.assignee).toBeUndefined()
    }
  })

  it('allows type-safe access to feedback fields', () => {
    const node = parseNode(validFeedback)

    if (isFeedback(node)) {
      expect(node.target_id).toBe('s-a2b3')
      expect(node.feedback_type).toBe('suggestion')
    }
  })

  it('allows type-safe access to external fields', () => {
    const node = parseNode(validExternal)

    if (isExternal(node)) {
      expect(node.uri).toBe('jira://PROJ-123')
      expect(node.source).toBe('jira')
      expect(node.materialized).toBe(false)
    }
  })
})
