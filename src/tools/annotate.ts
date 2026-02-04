/**
 * Annotate Tool
 *
 * Complete feedback lifecycle management.
 */

import type { Anchor } from '../schema/index.js'
import type { GraphStore } from '../graph/store.js'
import type { AnnotateParams, AnnotateResult, FeedbackAnchor } from './types.js'

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
 * @returns Annotate result with success status
 */
export async function annotate(store: GraphStore, params: AnnotateParams): Promise<AnnotateResult> {
  // Validate target_id is provided
  if (!params.target_id) {
    return { success: false, error: 'Missing required parameter: target_id' }
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
      return await createFeedback(store, params.target_id, params.create, params.from_id)
    }

    if (params.resolve !== undefined) {
      return await resolveFeedback(store, params.resolve)
    }

    if (params.dismiss !== undefined) {
      return await dismissFeedback(store, params.dismiss)
    }

    if (params.reopen !== undefined) {
      return await reopenFeedback(store, params.reopen)
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
  target_id: string,
  params: NonNullable<AnnotateParams['create']>,
  from_id?: string
): Promise<AnnotateResult> {
  // Validate target exists
  const targetNode = await store.getNode(target_id)
  if (!targetNode) {
    return { success: false, error: `Target node not found: ${target_id}` }
  }

  // Validate content is provided
  if (!params.content) {
    return { success: false, error: 'Missing required parameter: content' }
  }

  // Build anchor
  const anchor = buildAnchor(params.anchor)

  // Create feedback node
  const feedbackNode = await store.createNode({
    type: 'feedback',
    title: truncate(params.content.replace(/\n/g, ' '), TITLE_MAX_LENGTH),
    content: params.content,
    target_id,
    target_anchor: anchor,
    feedback_type: params.type || 'comment',
  })

  // If from_id provided, create edge linking issue to feedback
  if (from_id) {
    await store.createEdge({
      from_id,
      to_id: feedbackNode.id,
      type: 'discovered-from',
    })
  }

  return { success: true, feedback_id: feedbackNode.id }
}

/**
 * Mark feedback as resolved
 */
async function resolveFeedback(store: GraphStore, feedback_id: string): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedback_id)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedback_id}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedback_id}` }
  }

  // Update to resolved
  await store.updateNode(feedback_id, { resolved: true })

  return { success: true, feedback_id }
}

/**
 * Mark feedback as dismissed
 */
async function dismissFeedback(store: GraphStore, feedback_id: string): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedback_id)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedback_id}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedback_id}` }
  }

  // Update to dismissed
  await store.updateNode(feedback_id, { dismissed: true })

  return { success: true, feedback_id }
}

/**
 * Reopen resolved or dismissed feedback
 */
async function reopenFeedback(store: GraphStore, feedback_id: string): Promise<AnnotateResult> {
  // Validate feedback exists
  const feedbackNode = await store.getNode(feedback_id)
  if (!feedbackNode) {
    return { success: false, error: `Feedback not found: ${feedback_id}` }
  }

  if (feedbackNode.type !== 'feedback') {
    return { success: false, error: `Node is not feedback: ${feedback_id}` }
  }

  // Update to reopen (clear resolved and dismissed)
  await store.updateNode(feedback_id, { resolved: false, dismissed: false })

  return { success: true, feedback_id }
}
