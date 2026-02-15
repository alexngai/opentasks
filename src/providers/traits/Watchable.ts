/**
 * Watchable Trait
 *
 * Optional trait for providers that can detect and emit change events
 * from their underlying data source. Each provider is responsible for
 * its own watching mechanism (file watching, polling, webhooks, etc.).
 *
 * The granularity of change events is provider-dependent. Providers
 * declare their capabilities via `watchGranularity`, and consumers
 * can adapt their behavior accordingly.
 */

import type { Provider, ProviderNode } from '../types.js';
import type { ProviderEdge } from './RelationshipQueryable.js';

// ============================================================================
// Watch Granularity
// ============================================================================

/**
 * Detection mechanism used by the provider
 *
 * Informational — helps consumers understand latency characteristics.
 */
export type WatchMechanism = 'file-watch' | 'polling' | 'webhook' | 'stream';

/**
 * Declares what level of detail a provider's change events carry.
 *
 * Providers set these flags so consumers know what to expect
 * without inspecting every event at runtime.
 */
export interface WatchGranularity {
  /**
   * Provider can report which fields changed on a node update.
   * When true, `ProviderNodeChangeEvent.changedFields` may be populated.
   */
  reportsChangedFields: boolean;

  /**
   * Provider can report the previous values of changed fields.
   * When true, `ProviderNodeChangeEvent.previousValues` may be populated.
   * Implies `reportsChangedFields`.
   */
  reportsPreviousValues: boolean;

  /**
   * Provider can emit edge change events separately from node events.
   * When true, `ProviderEdgeChangeEvent` events may be emitted.
   */
  reportsEdgeChanges: boolean;

  /** How the provider detects changes (informational) */
  mechanism: WatchMechanism;
}

// ============================================================================
// Change Event Types
// ============================================================================

/**
 * Event emitted when a node changes in the provider's data source.
 *
 * All fields beyond `type`, `nodeId`, `uri`, and `timestamp` are
 * optional and depend on the provider's declared granularity.
 */
export interface ProviderNodeChangeEvent {
  /** What happened */
  type: 'created' | 'updated' | 'deleted';

  /** Node ID in the provider's local format */
  nodeId: string;

  /** Canonical URI for the node */
  uri: string;

  /** Full node data (absent for deletes, may be absent if provider can't supply cheaply) */
  node?: ProviderNode;

  /**
   * Which fields changed (only for 'updated' events).
   * Present when `watchGranularity.reportsChangedFields` is true.
   * Uses ProviderNode field names: 'title', 'content', 'status', 'priority', etc.
   */
  changedFields?: string[];

  /**
   * Previous values of changed fields (only for 'updated' events).
   * Present when `watchGranularity.reportsPreviousValues` is true.
   * Keys match `changedFields`.
   */
  previousValues?: Record<string, unknown>;

  /** Provider-side timestamp of when the change occurred (ISO 8601) */
  timestamp: string;
}

/**
 * Event emitted when an edge changes in the provider's data source.
 *
 * Only emitted when `watchGranularity.reportsEdgeChanges` is true.
 * For providers where edges are embedded in nodes (e.g., Beads
 * blocks/blockedBy arrays), edge changes arrive as part of
 * node update events instead.
 */
export interface ProviderEdgeChangeEvent {
  /** What happened */
  type: 'created' | 'deleted';

  /** The edge that changed */
  edge: ProviderEdge;

  /** URI of the source node */
  sourceUri: string;

  /** URI of the target node */
  targetUri: string;

  /** Provider-side timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * Discriminated union of all provider change events.
 *
 * Consumers switch on `kind` to handle node vs. edge events:
 *
 * ```typescript
 * provider.startWatching((event) => {
 *   switch (event.kind) {
 *     case 'node':
 *       handleNodeChange(event.event)
 *       break
 *     case 'edge':
 *       handleEdgeChange(event.event)
 *       break
 *   }
 * })
 * ```
 */
export type ProviderChangeEvent =
  | { kind: 'node'; event: ProviderNodeChangeEvent }
  | { kind: 'edge'; event: ProviderEdgeChangeEvent };

/**
 * Callback for receiving provider change events
 */
export type WatchChangeCallback = (event: ProviderChangeEvent) => void;

// ============================================================================
// Watchable Trait
// ============================================================================

/**
 * Watchable Trait
 *
 * Providers implement this trait to emit change events from their
 * underlying data source. The detection mechanism is entirely
 * provider-specific:
 *
 * - **Beads**: file-watch on Beads JSONL files, diff against cached hashes
 * - **Native**: delegates to the daemon FileWatcher on graph.jsonl
 * - **Jira/Linear**: webhook receiver or long-poll
 * - **Claude Tasks**: not applicable (ephemeral, caller is only writer)
 *
 * Lifecycle:
 * 1. Check `isWatchable(provider)` before calling watch methods
 * 2. Call `startWatching(callback)` to begin receiving events
 * 3. Call `stopWatching()` to clean up resources
 *
 * @example
 * ```typescript
 * const provider = registry.resolveProvider(uri)
 * if (provider && isWatchable(provider)) {
 *   console.log('Mechanism:', provider.watchGranularity.mechanism)
 *   console.log('Reports fields:', provider.watchGranularity.reportsChangedFields)
 *
 *   provider.startWatching((event) => {
 *     if (event.kind === 'node' && event.event.type === 'updated') {
 *       console.log(`Node ${event.event.nodeId} changed`)
 *       if (event.event.changedFields) {
 *         console.log('Changed fields:', event.event.changedFields)
 *       }
 *     }
 *   })
 *
 *   // Later...
 *   provider.stopWatching()
 * }
 * ```
 */
export interface Watchable {
  /**
   * Declares the granularity of change events this provider emits.
   *
   * Consumers use this to adapt behavior — e.g., skip full re-fetch
   * when changedFields is available, or listen for edge events only
   * when the provider reports them.
   */
  readonly watchGranularity: WatchGranularity;

  /**
   * Start watching for changes and emitting events via the callback.
   *
   * Providers should:
   * - Set up their detection mechanism (file watcher, interval, etc.)
   * - Emit events through the callback as changes are detected
   * - Handle their own debouncing and deduplication
   * - Be resilient to transient errors (log and continue)
   *
   * Calling `startWatching` when already watching replaces the callback.
   *
   * @param callback - Function called for each change event
   */
  startWatching(callback: WatchChangeCallback): void;

  /**
   * Stop watching and release all associated resources.
   *
   * After calling `stopWatching`:
   * - No more events will be emitted
   * - File watchers / intervals / connections are cleaned up
   * - `isWatching` returns false
   *
   * Safe to call multiple times or when not watching.
   */
  stopWatching(): void;

  /** Whether the provider is currently watching for changes */
  readonly isWatching: boolean;
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Check if a provider implements the Watchable trait
 *
 * @param provider - The provider to check
 * @returns True if the provider can watch for changes
 *
 * @example
 * ```typescript
 * for (const provider of registry.list()) {
 *   if (isWatchable(provider)) {
 *     provider.startWatching(handleChange)
 *   }
 * }
 * ```
 */
export function isWatchable(provider: Provider): provider is Provider & Watchable {
  const p = provider as unknown as Watchable;
  return (
    typeof p.startWatching === 'function' &&
    typeof p.stopWatching === 'function' &&
    p.watchGranularity !== undefined &&
    typeof p.watchGranularity === 'object'
  );
}
