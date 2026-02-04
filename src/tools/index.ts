/**
 * OpenTasks Tools Module
 *
 * The 3-tool agent interface for graph operations.
 *
 * @packageDocumentation
 */

// Types
export type {
  // Link tool
  LinkParams,
  LinkResult,
  // Query tool
  QueryParams,
  QueryResult,
  NodeSummary,
  EdgeSummary,
  FeedbackSummary,
  BlockerQueryParams,
  FeedbackQueryParams,
  // Annotate tool
  AnnotateParams,
  AnnotateResult,
  CreateFeedbackParams,
  FeedbackAnchor,
  FeedbackType,
  // Re-exports
  EdgeType,
  NodeType,
  Node,
  Edge,
  NodeFilter,
  EdgeFilter,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
  // Errors
  ToolErrorCode,
} from './types.js'

export { ToolError } from './types.js'

// Tools
export { link } from './link.js'
export { query } from './query.js'
export { annotate } from './annotate.js'
