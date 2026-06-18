/**
 * Type guards and validation for OpenTasks nodes
 */

import type { Context, Task, Feedback, ExternalNode, Attempt, Node } from './nodes.js';
import type { StoredNode } from './storage.js';

/**
 * Validation error with details
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
    code: string;
  }>;
}

// === Type Guards ===

/**
 * Check if node is a Context
 */
export function isContext(node: Node): node is Context {
  return node.type === 'context';
}

/**
 * Check if node is a Task
 */
export function isTask(node: Node): node is Task {
  return node.type === 'task';
}

/**
 * Check if node is Feedback
 */
export function isFeedback(node: Node): node is Feedback {
  return node.type === 'feedback';
}

/**
 * Check if node is an ExternalNode
 */
export function isExternal(node: Node): node is ExternalNode {
  return node.type === 'external';
}

/**
 * Check if node is an Attempt
 */
export function isAttempt(node: Node): node is Attempt {
  return node.type === 'attempt';
}

// === Validation ===

/**
 * Validate stored node structure
 * Returns validation result with all errors
 */
export function validateStoredNode(stored: StoredNode): ValidationResult {
  const errors: ValidationResult['errors'] = [];

  // Core validation (all types)
  if (!stored.id) {
    errors.push({ field: 'id', message: 'Required', code: 'REQUIRED' });
  }
  if (!stored.uuid) {
    errors.push({ field: 'uuid', message: 'Required', code: 'REQUIRED' });
  }
  if (!stored.type) {
    errors.push({ field: 'type', message: 'Required', code: 'REQUIRED' });
  }
  if (!stored.title) {
    errors.push({ field: 'title', message: 'Required', code: 'REQUIRED' });
  }
  if (!stored.created_at) {
    errors.push({ field: 'created_at', message: 'Required', code: 'REQUIRED' });
  }
  if (!stored.updated_at) {
    errors.push({ field: 'updated_at', message: 'Required', code: 'REQUIRED' });
  }

  // Type-specific validation
  switch (stored.type) {
    case 'task':
      if (!stored.status) {
        errors.push({
          field: 'status',
          message: 'Required for tasks',
          code: 'REQUIRED',
        });
      }
      break;

    case 'feedback':
      if (!stored.target_id) {
        errors.push({
          field: 'target_id',
          message: 'Required for feedback',
          code: 'REQUIRED',
        });
      }
      if (!stored.feedback_type) {
        errors.push({
          field: 'feedback_type',
          message: 'Required for feedback',
          code: 'REQUIRED',
        });
      }
      break;

    case 'attempt':
      if (!stored.target_id) {
        errors.push({
          field: 'target_id',
          message: 'Required for attempts',
          code: 'REQUIRED',
        });
      }
      break;

    case 'external':
      if (!stored.uri) {
        errors.push({
          field: 'uri',
          message: 'Required for external nodes',
          code: 'REQUIRED',
        });
      }
      if (!stored.source) {
        errors.push({
          field: 'source',
          message: 'Required for external nodes',
          code: 'REQUIRED',
        });
      }
      if (stored.materialized === undefined) {
        errors.push({
          field: 'materialized',
          message: 'Required for external nodes',
          code: 'REQUIRED',
        });
      }
      break;

    case 'context':
      // No additional required fields
      break;

    default:
      // Unknown type — allow but could warn
      break;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert StoredNode to typed Node
 * Throws ValidationError if node is invalid
 */
export function parseNode(stored: StoredNode): Node {
  const result = validateStoredNode(stored);

  if (!result.valid) {
    const firstError = result.errors[0];
    throw new ValidationError(
      `Invalid node: ${firstError.message} (${firstError.field})`,
      firstError.field,
      firstError.code,
    );
  }

  // Return as the appropriate type
  // The stored node already has all fields, we just cast based on type
  switch (stored.type) {
    case 'context':
      return stored as unknown as Context;
    case 'task':
      return stored as unknown as Task;
    case 'feedback':
      return stored as unknown as Feedback;
    case 'attempt':
      return stored as unknown as Attempt;
    case 'external':
      return stored as unknown as ExternalNode;
    default:
      // For unknown types, treat as Context (most permissive)
      return { ...stored, type: 'context' } as Context;
  }
}

/**
 * Safely try to parse a node, returning null if invalid
 */
export function tryParseNode(stored: StoredNode): Node | null {
  try {
    return parseNode(stored);
  } catch {
    return null;
  }
}

/**
 * Check if a stored node has a known type
 */
export function hasKnownType(
  stored: StoredNode,
): stored is StoredNode & { type: 'context' | 'task' | 'feedback' | 'external' | 'attempt' } {
  return ['context', 'task', 'feedback', 'external', 'attempt'].includes(stored.type);
}
