/**
 * Provider Traits
 *
 * Optional interfaces that providers can implement to extend their capabilities.
 * Traits are used by the federated graph system to understand provider features.
 */

export type {
  RelationshipQueryable,
  ProviderEdge,
  EdgeDirection,
  QueryEdgesOptions,
  EdgeTypeSupport,
} from './RelationshipQueryable.js';

export {
  isRelationshipQueryable,
  filterEdgesByType,
  filterEdgesByDirection,
  getNeighborFromEdge,
} from './RelationshipQueryable.js';

export type {
  Watchable,
  WatchGranularity,
  WatchMechanism,
  WatchChangeCallback,
  ProviderChangeEvent,
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from './Watchable.js';

export { isWatchable } from './Watchable.js';

export type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
  ReadyTaskOptions,
} from './TaskManageable.js';

export { isTaskManageable } from './TaskManageable.js';
