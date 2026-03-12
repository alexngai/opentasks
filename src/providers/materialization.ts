/**
 * Materialization Manager
 *
 * Handles materialization strategies for external nodes.
 * Controls when and how external provider data is cached in the local graph.
 */

import type { GraphStore } from '../graph/index.js';
import type { Node, ExternalNode } from '../schema/index.js';
import type {
  Provider,
  ProviderNode,
  ProviderRegistry,
  ProviderOperationContext,
  MaterializationStrategy,
  MaterializationConfig,
} from './types.js';
import { DEFAULT_MATERIALIZATION_CONFIG } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for the materialize() call
 */
export interface MaterializeOptions {
  /**
   * Whether the provider is local (always reachable, compatible status semantics).
   * When true, materializes as native node type (task/context) with metadata.provider_uri.
   * When false/undefined, materializes as type:'external' (current behavior).
   */
  local?: boolean;
}

/**
 * Context for materialization decisions
 */
export interface MaterializationContext {
  /** How the node is being accessed */
  accessType: 'resolve' | 'edge-create' | 'query';

  /** Explicit request to materialize */
  explicit?: boolean;
}

/**
 * Manager for materializing external nodes
 */
export interface MaterializationManager {
  /** Get materialization config */
  readonly config: MaterializationConfig;

  /** Check if a node should be materialized */
  shouldMaterialize(uri: string, context: MaterializationContext): boolean;

  /** Get the materialization strategy for a URI */
  getStrategyFor(uri: string): MaterializationStrategy;

  /** Materialize a provider node into the local graph */
  materialize(
    uri: string,
    providerNode: ProviderNode,
    store: GraphStore,
    options?: MaterializeOptions,
  ): Promise<Node>;

  /** Check if a materialized node is stale (only applies to remote/external nodes) */
  isStale(node: ExternalNode): boolean;

  /** Refresh a stale node */
  refresh(
    node: ExternalNode,
    provider: Provider,
    store: GraphStore,
    context?: ProviderOperationContext,
  ): Promise<Node | null>;

  /** Start background sync */
  startBackgroundSync(store: GraphStore, registry: ProviderRegistry): void;

  /** Stop background sync */
  stopBackgroundSync(): void;

  /** Check if background sync is running */
  isBackgroundSyncRunning(): boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract source/provider name from URI
 */
function extractSource(uri: string): string {
  const match = uri.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

/**
 * Find existing external node by URI
 */
async function findByUri(uri: string, store: GraphStore): Promise<ExternalNode | null> {
  const nodes = await store.query.nodes({
    type: 'external',
    search: uri,
  });

  // Find exact URI match
  for (const node of nodes) {
    if (node.type === 'external' && (node as ExternalNode).uri === uri) {
      return node as ExternalNode;
    }
  }

  return null;
}

/**
 * Find existing node by provider_uri in metadata (for local-provider nodes)
 */
async function findByProviderUri(uri: string, store: GraphStore): Promise<Node | null> {
  // Search across task and context nodes for a metadata.provider_uri match
  const nodes = await store.query.nodes({ search: uri });
  for (const node of nodes) {
    if (node.metadata?.provider_uri === uri) {
      return node;
    }
  }
  return null;
}

/**
 * Map provider node type to local graph node type
 */
function mapProviderTypeToNodeType(providerType: string): 'task' | 'context' {
  switch (providerType) {
    case 'spec':
      return 'context';
    case 'issue':
    case 'task':
    case 'feedback':
    default:
      return 'task';
  }
}

// ============================================================================
// Materialization Manager Implementation
// ============================================================================

/**
 * Create a materialization manager
 */
export function createMaterializationManager(
  partialConfig?: Partial<MaterializationConfig>,
): MaterializationManager {
  const config: MaterializationConfig = {
    ...DEFAULT_MATERIALIZATION_CONFIG,
    ...partialConfig,
  };

  let syncInterval: ReturnType<typeof setInterval> | null = null;
  let isSyncing = false;

  return {
    config,

    /**
     * Get the materialization strategy for a URI
     */
    getStrategyFor(uri: string): MaterializationStrategy {
      // Check for provider-specific override
      if (config.providers) {
        const source = extractSource(uri);
        if (config.providers[source]) {
          return config.providers[source];
        }
      }

      return config.default;
    },

    /**
     * Check if a node should be materialized based on strategy and context
     */
    shouldMaterialize(uri: string, context: MaterializationContext): boolean {
      const strategy = this.getStrategyFor(uri);

      switch (strategy) {
        case 'on-demand':
          // Only materialize when explicitly requested
          return context.explicit === true;

        case 'lazy':
          // Materialize on resolve access or explicit request
          return context.accessType === 'resolve' || context.explicit === true;

        case 'eager':
          // Always materialize
          return true;

        case 'none':
          // Never materialize
          return false;

        default:
          return false;
      }
    },

    /**
     * Materialize a provider node into the local graph.
     *
     * When options.local is true, creates a native node (task/context) with
     * metadata.provider_uri and metadata.provider_source as back-references.
     * When false/undefined, creates a type:'external' node (remote behavior).
     */
    async materialize(
      uri: string,
      providerNode: ProviderNode,
      store: GraphStore,
      options?: MaterializeOptions,
    ): Promise<Node> {
      const source = extractSource(uri);
      const now = new Date().toISOString();

      // ── Local provider path ──────────────────────────────────────────
      if (options?.local) {
        const nodeType = mapProviderTypeToNodeType(providerNode.type);

        // Check for existing node by provider_uri
        const existing = await findByProviderUri(uri, store);

        if (existing) {
          const updated = await store.updateNode(existing.id, {
            title: providerNode.title,
            content: providerNode.content,
            status: providerNode.status,
            priority: providerNode.priority,
            metadata: {
              ...existing.metadata,
              provider_uri: uri,
              provider_source: source,
            },
          });
          return updated;
        }

        // Create new native node with provider back-reference
        const node = await store.createNode({
          type: nodeType,
          title: providerNode.title,
          content: providerNode.content,
          status: providerNode.status ?? 'open',
          priority: providerNode.priority,
          metadata: {
            provider_uri: uri,
            provider_source: source,
          },
        });
        return node;
      }

      // ── Remote provider path (existing behavior) ─────────────────────
      // Check if already exists
      const existing = await findByUri(uri, store);

      if (existing) {
        // Update existing node — sync top-level ExternalNode fields + metadata
        const updated = await store.updateNode(existing.id, {
          title: providerNode.title,
          content: providerNode.content,
          external_status: providerNode.status,
          external_data: providerNode.rawData,
          cached_at: now,
          stale: false,
          materialized: true,
          metadata: {
            ...existing.metadata,
            external_status: providerNode.status,
            external_data: providerNode.rawData,
            cached_at: now,
            stale: false,
            materialized: true,
          },
        });

        return updated as ExternalNode;
      }

      // Create new ExternalNode — set top-level fields per schema + metadata
      const node = await store.createNode({
        type: 'external',
        uri,
        source,
        title: providerNode.title,
        content: providerNode.content,
        materialized: true,
        external_status: providerNode.status,
        external_data: providerNode.rawData,
        cached_at: now,
        metadata: {
          external_status: providerNode.status,
          external_data: providerNode.rawData,
          cached_at: now,
        },
      });

      return node as ExternalNode;
    },

    /**
     * Check if a materialized node is stale
     */
    isStale(node: ExternalNode): boolean {
      // Check explicit stale flag
      if (node.stale) {
        return true;
      }

      // Check cached_at against staleAfter
      if (node.cached_at && config.staleAfter) {
        const cachedTime = new Date(node.cached_at).getTime();
        const now = Date.now();
        return now - cachedTime > config.staleAfter;
      }

      // If no cached_at, consider it stale
      return node.cached_at === undefined;
    },

    /**
     * Refresh a stale node from provider
     */
    async refresh(
      node: ExternalNode,
      provider: Provider,
      store: GraphStore,
      context?: ProviderOperationContext,
    ): Promise<Node | null> {
      try {
        // Fetch fresh data from provider
        const providerNode = await provider.get(node.uri, context);

        if (!providerNode) {
          // Node no longer exists in provider, mark as stale
          await store.updateNode(node.id, {
            metadata: {
              ...node.metadata,
              stale: true,
              last_refresh_error: 'Node not found in provider',
              last_refresh_at: new Date().toISOString(),
            },
          });
          return null;
        }

        // Update with fresh data
        return this.materialize(node.uri, providerNode, store);
      } catch (error) {
        // Mark as stale on error
        await store.updateNode(node.id, {
          metadata: {
            ...node.metadata,
            stale: true,
            last_refresh_error: error instanceof Error ? error.message : String(error),
            last_refresh_at: new Date().toISOString(),
          },
        });
        return null;
      }
    },

    /**
     * Start background sync process
     */
    startBackgroundSync(store: GraphStore, registry: ProviderRegistry): void {
      // Don't start if disabled or already running
      if (!config.backgroundSyncInterval || config.backgroundSyncInterval <= 0) {
        return;
      }

      if (syncInterval) {
        return;
      }

      syncInterval = setInterval(async () => {
        // Prevent overlapping sync operations
        if (isSyncing) {
          return;
        }

        isSyncing = true;

        try {
          // Find all external nodes that are materialized
          const externalNodes = await store.query.nodes({
            type: 'external',
          });

          // Filter to stale nodes
          const staleNodes = externalNodes.filter((node) => {
            const extNode = node as ExternalNode;
            return extNode.materialized && this.isStale(extNode);
          });

          // Refresh each stale node
          for (const node of staleNodes) {
            const extNode = node as ExternalNode;
            const provider = registry.resolveProvider(extNode.uri);

            if (provider) {
              await this.refresh(extNode, provider, store);
            }
          }
        } catch {
          // Log error but continue - background sync should be resilient
        } finally {
          isSyncing = false;
        }
      }, config.backgroundSyncInterval);
    },

    /**
     * Stop background sync process
     */
    stopBackgroundSync(): void {
      if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
      }
    },

    /**
     * Check if background sync is running
     */
    isBackgroundSyncRunning(): boolean {
      return syncInterval !== null;
    },
  };
}
