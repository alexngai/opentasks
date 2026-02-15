/**
 * OpenTasks Client Module
 *
 * Client library for interacting with the OpenTasks daemon.
 *
 * @packageDocumentation
 */

// Client
export type { ClientOptions } from './client.js';
export { OpenTasksClient, ClientError, createClient } from './client.js';

// Re-export tool types for convenience
export type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  NodeSummary,
  EdgeSummary,
  FeedbackSummary,
  BlockerQueryParams,
  FeedbackQueryParams,
  CreateFeedbackParams,
  FeedbackAnchor,
  FeedbackType,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
} from '../tools/types.js';
