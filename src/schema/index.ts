/**
 * OpenTasks Schema - Type definitions and validation
 *
 * @packageDocumentation
 */

// Base types
export type { Anchor, BaseNode } from './base.js';

// Node types
export type { Context, Task, Feedback, ExternalNode, Node, NodeType } from './nodes.js';

// Edge types
export type { Edge, EdgeType, CoreEdgeType, ExtendedEdgeType } from './edges.js';

// Storage types
export type {
  StoredNode,
  StoredEdge,
  PersistedGraph,
  GraphMetadata,
  GraphChanges,
} from './storage.js';

// Validation
export {
  ValidationError,
  type ValidationResult,
  isContext,
  isTask,
  isFeedback,
  isExternal,
  validateStoredNode,
  parseNode,
  tryParseNode,
  hasKnownType,
} from './validation.js';
