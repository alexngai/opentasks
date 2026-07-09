/**
 * Reconcilable Trait
 *
 * Optional trait for providers that support batch reconciliation.
 * Enables efficient change detection via content hashes instead of
 * individual get() calls per node.
 *
 * Targeted at remote providers (Jira, Linear) where N individual get()
 * calls are expensive. Local filesystem providers are unlikely to need this.
 */

import type { Provider, ProviderOperationContext } from '../types.js';

/**
 * A lightweight node summary with content hash for fast diffing.
 */
export interface ReconcilableNodeSummary {
  /** Node ID in provider's format */
  id: string;

  /** Canonical URI */
  uri: string;

  /** Content hash for fast change detection */
  contentHash: string;

  /** When this data was last updated in the provider (ISO 8601) */
  updatedAt?: string;
}

/**
 * Options for listing reconcilable nodes.
 */
export interface ListReconcilableOptions {
  /** Only return summaries for these IDs (provider-local format) */
  ids?: string[];

  /** Optional operation context */
  context?: ProviderOperationContext;
}

/**
 * Trait for providers that support batch reconciliation.
 *
 * Providers implement this to allow the reconciliation engine to:
 * 1. Fetch all node summaries with content hashes in a single call
 * 2. Compare hashes locally to identify changed nodes
 * 3. Only fetch full node data for nodes that actually changed
 *
 * This reduces network round-trips from N (one per node) to 1 + M
 * (one batch summary + M individual gets for changed nodes).
 */
export interface Reconcilable {
  /**
   * List node summaries with content hashes for reconciliation.
   * Returns lightweight summaries that can be compared against
   * cached hashes to detect changes.
   */
  listForReconciliation(options?: ListReconcilableOptions): Promise<ReconcilableNodeSummary[]>;
}

/**
 * Type guard to check if a provider implements Reconcilable
 */
export function isReconcilable(
  provider: Provider,
): provider is Provider & Reconcilable {
  const p = provider as unknown as Reconcilable;
  return typeof p.listForReconciliation === 'function';
}
