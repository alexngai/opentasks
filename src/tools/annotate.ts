/**
 * Annotate Tool
 *
 * Complete feedback lifecycle management.
 */

import type { Anchor } from '../schema/index.js'
import type { GraphStore } from '../graph/store.js'
import type { AnnotateParams, AnnotateResult, FeedbackAnchor, OperationContext } from './types.js'

// ============================================================================
// Constants
// ============================================================================

const TITLE_MAX_LENGTH = 50

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncate string to max length with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.substring(0, maxLength - 3) + '...'
}

/**
 * Build an Anchor from FeedbackAnchor params
 */
function buildAnchor(anchor?: FeedbackAnchor): Anchor | undefined {
  if (!anchor) return undefined

  if (anchor.line !== undefined) {
    return {
      line: anchor.line,
      anchor_status: 'valid',
    }
  }

  if (anchor.text !== undefined) {
    return {
      text: anchor.text,
      anchor_status: 'valid',
    }
  }

  return undefined
}

/**
 * Count how many operations are specified
 */
function countOperations(params: AnnotateParams): number {
  let count = 0
  if (params.create !== undefined) count++
  if (params.resolve !== undefined) count++
  if (params.dismiss !== undefined) count++
  if (params.reopen !== undefined) count++
  return count
}

// ============================================================================
// Annotate Tool Implementation
// ============================================================================

/**
 * Manage feedback lifecycle
 *
 * @param store - Graph store for data operations
 * @param params - Annotate parameters
 * @param context - Optional operation context for tracking agent activity
 * @returns Annotate result with success status
 */
export async function annotate(
  store: GraphStore,
  params: AnnotateParams,
  context?: OperationContext
): Promise<AnnotateResult> {
  // Validate targetId is provided
  if (!params.targetId) {
    return { success: false, error: 'Missing required parameter: targetId' }
  }

  // Validate exactly one operation
  const operationCount = countOperations(params)

  if (operationCount === 0) {
    return {
      success: false,
      error: 'No operation specified. Provide one of: create, resolve, dismiss, reopen',
    }
  }

  if (operationCount > 1) {
    return {
      success: false,
      error: 'Multiple operations specified. Provide exactly one of: create, resolve, dismiss, reopen',
    }
  }

  try {
    // Dispatch to appropriate operation handler
    if (params.create !== undefined) {
      return await createFeedback(store, params.targetId, params.create, params.fromId, context)
    }

    if (params.resolve !== undefined) {
      return await resolveFeedback(store, params.resolve, context)
    }

    if (params.dismiss !== undefined) {
      return await dismissFeedback(store, params.dismiss, context)
    }

    if (params.reopen !== undefined) {
      return await reopenFeedback(store, params.reopen, context)
    }

    // Should never reach here
    return { success: false, error: 'Unknown operation' }
  } catch (error) {
    if (error instanceof Error) {
      return { success: false, error: error.message }
    }
    return { success: false, error: 'Unknown error occurred' }
  }
}

// ============================================================================
// Operation Handlers
// ============================================================================

/**
 * Create new feedback on a target node
 */
async function createFeedback(
  store: GraphStore,
  targetId: string,
  params: NonNullable<AnnotateParams['create']>,
  fromId?: string,
  context?: OperationContext
): Promise<AnnotateResult> {
  // Validate target exists
  const targetNode = await store.getNode(targetId)
  if (!targetNode) {
    return { success: false, error: `Target node not found: ${targetId}` }
  }

  // Validate content is provided
  if (!params.content) {
    return { success: false, error: 'Missing required parameter: content' }
  }

  // Build anchor
  const anchor = buildAnchor(params.anchor)

  // Build metadata with context if provided
  const metadata = context
    ? {
        _context: {
          agentId: context.agentId,
          agentName: context.agentName,
          sessionId: context.sessionId,
          timestamp: context.timestamp ?? new Date().toISOString(),
        },
      }
    : undefined

  // Create feedback node (underlying storage uses snake_case)
  const feedbackNode = await store.createNode({
    type: 'feedback',
    title: truncate(params.content.replace(/\n/g, ' '), TITLE_MAX_LENGTH),
    content: params.content,
    target_id: targetId,
    target_anchor: anchor,
    feedback_type: params.type || 'comment',
    metadata,
  })

  // If fromId provided, create edge linking issue to feedback
  if (fromId) {
    const edgeMetadata = context
      ? {
          _context: {
            agentId: context.agentId,
            agentName: context.agentName,
            sessionId: context.sessionId,
            timestamp: context.timestamp ?? new Date().toISOString(),
          },
        }
      : undefined

    await store.createEdge({
      from_id: fromId,
      to_id: feedbackNode.id,
      type: 'discovered-from',
      metadata: edgeMetadata,
    })
  }

  return { success: true, feedbackId: feedbackNode.id }
}

/**
 * Mark feedback as resolved
 */
async function resolveFeedback(
  store: GraphStore,
  feedbackId: string,
  _context?: OperationContext // Unused but kept for API consistency
): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedbackId)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedbackId}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedbackId}` }
  }

  // Update to resolved
  await store.updateNode(feedbackId, { resolved: true })

  return { success: true, feedbackId }
}

/**
 * Mark feedback as dismissed
 */
async function dismissFeedback(
  store: GraphStore,
  feedbackId: string,
  _context?: OperationContext // Unused but kept for API consistency
): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedbackId)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedbackId}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedbackId}` }
  }

  // Update to dismissed
  await store.updateNode(feedbackId, { dismissed: true })

  return { success: true, feedbackId }
}

/**
 * Reopen resolved or dismissed feedback
 */
async function reopenFeedback(
  store: GraphStore,
  feedbackId: string,
  _context?: OperationContext // Unused but kept for API consistency
): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedbackId)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedbackId}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedbackId}` }
  }

  // Update to reopen (clear resolved and dismissed)
  await store.updateNode(feedbackId, { resolved: false, dismissed: false })

  return { success: true, feedbackId }
}
