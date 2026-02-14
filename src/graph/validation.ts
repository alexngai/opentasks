/**
 * Validation Service for Graph Operations
 *
 * Business rule validation beyond basic schema validation.
 * Includes cycle detection for blocks edges.
 */

import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type {
  CreateNodeInput,
  UpdateNodeInput,
  CreateEdgeInput,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  CycleResult,
} from './types.js'

// ============================================================================
// Constants
// ============================================================================

const MAX_TITLE_LENGTH = 500
const MAX_CONTENT_LENGTH = 100_000
const MIN_PRIORITY = 0
const MAX_PRIORITY = 4

const VALID_NODE_TYPES = ['spec', 'issue', 'feedback', 'external'] as const
const VALID_ISSUE_STATUSES = ['open', 'in_progress', 'blocked', 'closed'] as const
const VALID_FEEDBACK_TYPES = ['comment', 'suggestion', 'request'] as const
const VALID_EDGE_TYPES = [
  // Core
  'blocks', 'implements', 'references', 'related',
  // Extended
  'parent-of', 'child-of', 'duplicates', 'supersedes', 'depends-on', 'discovered-from',
] as const

// ============================================================================
// Validation Service Interface
// ============================================================================

/**
 * Validation service for graph operations
 */
export interface ValidationService {
  /** Validate node creation input */
  validateCreateNode(input: CreateNodeInput): ValidationResult

  /** Validate node update input */
  validateUpdateNode(
    existing: StoredNode,
    updates: UpdateNodeInput
  ): ValidationResult

  /** Validate edge creation */
  validateCreateEdge(
    input: CreateEdgeInput,
    getNode: (id: string) => Promise<StoredNode | null>
  ): Promise<ValidationResult>

  /** Check for cycles in blocks graph */
  detectCycle(
    fromId: string,
    toId: string,
    getBlocksEdges: (nodeId: string) => Promise<StoredEdge[]>
  ): Promise<CycleResult>
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a validation result
 */
function result(
  errors: ValidationError[] = [],
  warnings: ValidationWarning[] = []
): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Create an error
 */
function error(code: string, message: string, field?: string): ValidationError {
  return { code, message, field }
}

/**
 * Create a warning
 */
function warning(
  code: string,
  message: string,
  field?: string
): ValidationWarning {
  return { code, message, field }
}

// ============================================================================
// Node Validation
// ============================================================================

/**
 * Validate common node fields
 */
function validateCommonFields(
  input: CreateNodeInput | UpdateNodeInput,
  errors: ValidationError[],
  warnings: ValidationWarning[],
  isCreate: boolean
): void {
  // Title validation
  if (isCreate && !('title' in input && input.title)) {
    errors.push(error('REQUIRED', 'Title is required', 'title'))
  } else if ('title' in input && input.title !== undefined) {
    if (typeof input.title !== 'string') {
      errors.push(error('INVALID_TYPE', 'Title must be a string', 'title'))
    } else if (input.title.length === 0) {
      errors.push(error('REQUIRED', 'Title cannot be empty', 'title'))
    } else if (input.title.length > MAX_TITLE_LENGTH) {
      errors.push(
        error(
          'MAX_LENGTH',
          `Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`,
          'title'
        )
      )
    }
  }

  // Content validation
  if ('content' in input && input.content !== undefined) {
    if (typeof input.content !== 'string') {
      errors.push(error('INVALID_TYPE', 'Content must be a string', 'content'))
    } else if (input.content.length > MAX_CONTENT_LENGTH) {
      errors.push(
        error(
          'MAX_LENGTH',
          `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
          'content'
        )
      )
    }
  }

  // Priority validation
  if ('priority' in input && input.priority !== undefined) {
    if (typeof input.priority !== 'number') {
      errors.push(
        error('INVALID_TYPE', 'Priority must be a number', 'priority')
      )
    } else if (
      !Number.isInteger(input.priority) ||
      input.priority < MIN_PRIORITY ||
      input.priority > MAX_PRIORITY
    ) {
      errors.push(
        error(
          'INVALID_RANGE',
          `Priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}`,
          'priority'
        )
      )
    }
  }
}

/**
 * Validate spec-specific fields
 */
function validateSpecFields(
  input: CreateNodeInput,
  errors: ValidationError[],
  _warnings: ValidationWarning[]
): void {
  // Specs have no required fields beyond common fields
  // Status is optional for specs
  if (input.status !== undefined) {
    const validStatuses = ['draft', 'active', 'archived']
    if (!validStatuses.includes(input.status) && typeof input.status !== 'string') {
      errors.push(
        error('INVALID_TYPE', 'Status must be a string', 'status')
      )
    }
  }
}

/**
 * Validate issue-specific fields
 */
function validateIssueFields(
  input: CreateNodeInput,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // Status is required for issues
  if (!input.status) {
    errors.push(error('REQUIRED', 'Status is required for issues', 'status'))
  } else if (typeof input.status !== 'string') {
    errors.push(error('INVALID_TYPE', 'Status must be a string', 'status'))
  } else if (
    !VALID_ISSUE_STATUSES.includes(input.status as (typeof VALID_ISSUE_STATUSES)[number])
  ) {
    // Warn for non-standard statuses but allow them
    warnings.push(
      warning(
        'NON_STANDARD_STATUS',
        `Status '${input.status}' is not a standard status. Standard values: ${VALID_ISSUE_STATUSES.join(', ')}`,
        'status'
      )
    )
  }
}

/**
 * Validate feedback-specific fields
 */
function validateFeedbackFields(
  input: CreateNodeInput,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // target_id is required
  if (!input.target_id) {
    errors.push(
      error('REQUIRED', 'Target ID is required for feedback', 'target_id')
    )
  } else if (typeof input.target_id !== 'string') {
    errors.push(
      error('INVALID_TYPE', 'Target ID must be a string', 'target_id')
    )
  }

  // feedback_type is required
  if (!input.feedback_type) {
    errors.push(
      error(
        'REQUIRED',
        'Feedback type is required for feedback',
        'feedback_type'
      )
    )
  } else if (
    !VALID_FEEDBACK_TYPES.includes(
      input.feedback_type as (typeof VALID_FEEDBACK_TYPES)[number]
    )
  ) {
    warnings.push(
      warning(
        'NON_STANDARD_FEEDBACK_TYPE',
        `Feedback type '${input.feedback_type}' is not standard. Standard values: ${VALID_FEEDBACK_TYPES.join(', ')}`,
        'feedback_type'
      )
    )
  }
}

/**
 * Validate external node-specific fields
 */
function validateExternalFields(
  input: CreateNodeInput,
  errors: ValidationError[],
  _warnings: ValidationWarning[]
): void {
  // uri is required
  if (!input.uri) {
    errors.push(
      error('REQUIRED', 'URI is required for external nodes', 'uri')
    )
  } else if (typeof input.uri !== 'string') {
    errors.push(error('INVALID_TYPE', 'URI must be a string', 'uri'))
  }

  // source is required
  if (!input.source) {
    errors.push(
      error('REQUIRED', 'Source is required for external nodes', 'source')
    )
  } else if (typeof input.source !== 'string') {
    errors.push(error('INVALID_TYPE', 'Source must be a string', 'source'))
  }
}

// ============================================================================
// Edge Validation
// ============================================================================

/**
 * Validate edge creation
 */
async function validateEdge(
  input: CreateEdgeInput,
  getNode: (id: string) => Promise<StoredNode | null>
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  // from_id required
  if (!input.from_id) {
    errors.push(error('REQUIRED', 'From ID is required', 'from_id'))
  }

  // to_id required
  if (!input.to_id) {
    errors.push(error('REQUIRED', 'To ID is required', 'to_id'))
  }

  // type required
  if (!input.type) {
    errors.push(error('REQUIRED', 'Edge type is required', 'type'))
  } else if (!VALID_EDGE_TYPES.includes(input.type as (typeof VALID_EDGE_TYPES)[number])) {
    errors.push(
      error(
        'INVALID_EDGE_TYPE',
        `Invalid edge type: '${input.type}'. Valid types: ${VALID_EDGE_TYPES.join(', ')}`,
        'type'
      )
    )
  }

  // No self-reference
  if (input.from_id && input.to_id && input.from_id === input.to_id) {
    errors.push(
      error('SELF_REFERENCE', 'Cannot create edge from node to itself')
    )
  }

  // If we have errors so far, return early
  if (errors.length > 0) {
    return result(errors, warnings)
  }

  // Verify nodes exist (for local IDs)
  const isLocalId = (id: string) =>
    id.match(/^[sifex]-[a-z0-9]+$/) && !id.includes('://')

  if (isLocalId(input.from_id)) {
    const fromNode = await getNode(input.from_id)
    if (!fromNode) {
      errors.push(
        error('NOT_FOUND', `Source node not found: ${input.from_id}`, 'from_id')
      )
    }
  }

  if (isLocalId(input.to_id)) {
    const toNode = await getNode(input.to_id)
    if (!toNode) {
      errors.push(
        error('NOT_FOUND', `Target node not found: ${input.to_id}`, 'to_id')
      )
    }
  }

  // Type-specific warnings
  if (input.type === 'implements') {
    // Warn if from is not an issue
    if (isLocalId(input.from_id)) {
      const fromNode = await getNode(input.from_id)
      if (fromNode && fromNode.type !== 'issue') {
        warnings.push(
          warning(
            'IMPLEMENTS_FROM_NON_ISSUE',
            `'implements' edge typically has an issue as source, but found ${fromNode.type}`,
            'from_id'
          )
        )
      }
    }

    // Warn if to is not a spec
    if (isLocalId(input.to_id)) {
      const toNode = await getNode(input.to_id)
      if (toNode && toNode.type !== 'spec') {
        warnings.push(
          warning(
            'IMPLEMENTS_TO_NON_SPEC',
            `'implements' edge typically has a spec as target, but found ${toNode.type}`,
            'to_id'
          )
        )
      }
    }
  }

  return result(errors, warnings)
}

// ============================================================================
// Cycle Detection
// ============================================================================

/**
 * Detect if adding a blocks edge would create a cycle
 *
 * Uses DFS to check if toId can reach fromId via existing blocks edges.
 * If so, adding fromId→toId would create a cycle.
 *
 * @param fromId - Source node (would block toId)
 * @param toId - Target node (would be blocked by fromId)
 * @param getBlocksEdges - Function to get outgoing blocks edges for a node
 */
async function detectCycleImpl(
  fromId: string,
  toId: string,
  getBlocksEdges: (nodeId: string) => Promise<StoredEdge[]>
): Promise<CycleResult> {
  const visited = new Set<string>()
  const path: string[] = []

  async function dfs(current: string): Promise<boolean> {
    // If we've reached the fromId, we would have a cycle
    if (current === fromId) {
      return true
    }

    // Already visited this node
    if (visited.has(current)) {
      return false
    }

    visited.add(current)
    path.push(current)

    // Get outgoing blocks edges from current node
    const edges = await getBlocksEdges(current)

    for (const edge of edges) {
      if (await dfs(edge.to_id)) {
        return true
      }
    }

    path.pop()
    return false
  }

  const hasCycle = await dfs(toId)

  return {
    hasCycle,
    cycle: hasCycle ? [fromId, ...path.reverse()] : undefined,
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a validation service
 */
export function createValidationService(): ValidationService {
  return {
    validateCreateNode(input: CreateNodeInput): ValidationResult {
      const errors: ValidationError[] = []
      const warnings: ValidationWarning[] = []

      // Validate type
      if (!input.type) {
        errors.push(error('REQUIRED', 'Type is required', 'type'))
        return result(errors, warnings)
      }

      if (!VALID_NODE_TYPES.includes(input.type)) {
        errors.push(
          error(
            'INVALID_TYPE',
            `Invalid node type: ${input.type}. Valid types: ${VALID_NODE_TYPES.join(', ')}`,
            'type'
          )
        )
        return result(errors, warnings)
      }

      // Validate common fields
      validateCommonFields(input, errors, warnings, true)

      // Type-specific validation
      switch (input.type) {
        case 'spec':
          validateSpecFields(input, errors, warnings)
          break
        case 'issue':
          validateIssueFields(input, errors, warnings)
          break
        case 'feedback':
          validateFeedbackFields(input, errors, warnings)
          break
        case 'external':
          validateExternalFields(input, errors, warnings)
          break
      }

      return result(errors, warnings)
    },

    validateUpdateNode(
      existing: StoredNode,
      updates: UpdateNodeInput
    ): ValidationResult {
      const errors: ValidationError[] = []
      const warnings: ValidationWarning[] = []

      // Validate common fields
      validateCommonFields(updates, errors, warnings, false)

      // Type-specific validation for status changes
      if (existing.type === 'issue' && 'status' in updates) {
        if (updates.status !== undefined && typeof updates.status !== 'string') {
          errors.push(error('INVALID_TYPE', 'Status must be a string', 'status'))
        } else if (
          updates.status &&
          !VALID_ISSUE_STATUSES.includes(
            updates.status as (typeof VALID_ISSUE_STATUSES)[number]
          )
        ) {
          warnings.push(
            warning(
              'NON_STANDARD_STATUS',
              `Status '${updates.status}' is not a standard status`,
              'status'
            )
          )
        }
      }

      return result(errors, warnings)
    },

    async validateCreateEdge(
      input: CreateEdgeInput,
      getNode: (id: string) => Promise<StoredNode | null>
    ): Promise<ValidationResult> {
      return validateEdge(input, getNode)
    },

    async detectCycle(
      fromId: string,
      toId: string,
      getBlocksEdges: (nodeId: string) => Promise<StoredEdge[]>
    ): Promise<CycleResult> {
      return detectCycleImpl(fromId, toId, getBlocksEdges)
    },
  }
}
