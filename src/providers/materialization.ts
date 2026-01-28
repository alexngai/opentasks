/**
 * Materialization Manager
 *
 * Handles materialization strategies for external nodes.
 * Controls when and how external provider data is cached in the local graph.
 */

import type { GraphStore } from '../graph/index.js'
import type { ExternalNode } from '../schema/index.js'
import type {
  Provider,
  ProviderNode,
  ProviderRegistry,
  MaterializationStrategy,
  MaterializationConfig,
} from './types.js'
import { DEFAULT_MATERIALIZATION_CONFIG } from './types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context for materialization decisions
 */
export interface MaterializationContext {
  /** How the node is being accessed */
  accessType: 'resolve' | 'edge-create' | 'query'

  /** Explicit request to materialize */
  explicit?: boolean
}

/**
 * Manager for materializing external nodes
 */
export interface MaterializationManager {
  /** Get materialization config */
  readonly config: MaterializationConfig

  /** Check if a node should be materialized */
  shouldMaterialize(uri: string, context: MaterializationContext): boolean

  /** Get the materialization strategy for a URI */
  getStrategyFor(uri: string): MaterializationStrategy

  /** Materialize an external node */
  materialize(
    uri: string,
    providerNode: ProviderNode,
    store: GraphStore
  ): Promise<ExternalNode>

  /** Check if a materialized node is stale */
  isStale(node: ExternalNode): boolean

  /** Refresh a stale node */
  refresh(
    node: ExternalNode,
    provider: Provider,
    store: GraphStore
  ): Promise<ExternalNode | null>

  /** Start background sync */
  startBackgroundSync(store: GraphStore, registry: ProviderRegistry): void

  /** Stop background sync */
  stopBackgroundSync(): void

  /** Check if background sync is running */
  isBackgroundSyncRunning(): boolean
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract source/provider name from URI
 */
function extractSource(uri: string): string {
  const match = uri.match(/^([a-z][a-z0-9+.-]*):/i)
  return match ? match[1].toLowerCase() : 'unknown'
}

/**
 * Find existing external node by URI
 */
async function findByUri(
  uri: string,
  store: GraphStore
): Promise<ExternalNode | null> {
  const nodes = await store.query.nodes({
    type: 'external',
    search: uri,
  })

  // Find exact URI match
  for (const node of nodes) {
    if (node.type === 'external' && (node as ExternalNode).uri === uri) {
      return node as ExternalNode
    }
  }

  return null
}

// ============================================================================
// Materialization Manager Implementation
// ============================================================================

/**
 * Create a materialization manager
 */
export function createMaterializationManager(
  partialConfig?: Partial<MaterializationConfig>
): MaterializationManager {
  const config: MaterializationConfig = {
    ...DEFAULT_MATERIALIZATION_CONFIG,
    ...partialConfig,
  }

  let syncInterval: ReturnType<typeof setInterval> | null = null
  let isSyncing = false

  return {
    config,

    /**
     * Get the materialization strategy for a URI
     */
    getStrategyFor(uri: string): MaterializationStrategy {
      // Check for provider-specific override
      if (config.providers) {
        const source = extractSource(uri)
        if (config.providers[source]) {
          return config.providers[source]
        }
      }

      return config.default
    },

    /**
     * Check if a node should be materialized based on strategy and context
     */
    shouldMaterialize(uri: string, context: MaterializationContext): boolean {
      const strategy = this.getStrategyFor(uri)

      switch (strategy) {
        case 'on-demand':
          // Only materialize when explicitly requested
          return context.explicit === true

        case 'lazy':
          // Materialize on resolve access or explicit request
          return context.accessType === 'resolve' || context.explicit === true

        case 'eager':
          // Always materialize
          return true

        case 'none':
          // Never materialize
          return false

        default:
          return false
      }
    },

    /**
     * Materialize an external node from provider data
     */
    async materialize(
      uri: string,
      providerNode: ProviderNode,
      store: GraphStore
    ): Promise<ExternalNode> {
      const source = extractSource(uri)
      const now = new Date().toISOString()

      // Check if already exists
      const existing = await findByUri(uri, store)

      if (existing) {
        // Update existing node
        const updated = await store.updateNode(existing.id, {
          title: providerNode.title,
          content: providerNode.content,
          metadata: {
            ...existing.metadata,
            external_status: providerNode.status,
            external_data: providerNode.rawData,
            cached_at: now,
            stale: false,
            materialized: true,
          },
        })

        return updated as ExternalNode
      }

      // Create new ExternalNode
      const node = await store.createNode({
        type: 'external',
        uri,
        source,
        title: providerNode.title,
        content: providerNode.content,
        metadata: {
          external_status: providerNode.status,
          external_data: providerNode.rawData,
          cached_at: now,
          materialized: true,
        },
      })

      return node as ExternalNode
    },

    /**
     * Check if a materialized node is stale
     */
    isStale(node: ExternalNode): boolean {
      // Check explicit stale flag
      if (node.stale) {
        return true
      }

      // Check cached_at against staleAfter
      if (node.cached_at && config.staleAfter) {
        const cachedTime = new Date(node.cached_at).getTime()
        const now = Date.now()
        return now - cachedTime > config.staleAfter
      }

      // If no cached_at, consider it stale
      return node.cached_at === undefined
    },

    /**
     * Refresh a stale node from provider
     */
    async refresh(
      node: ExternalNode,
      provider: Provider,
      store: GraphStore
    ): Promise<ExternalNode | null> {
      try {
        // Fetch fresh data from provider
        const providerNode = await provider.get(node.uri)

        if (!providerNode) {
          // Node no longer exists in provider, mark as stale
          await store.updateNode(node.id, {
            metadata: {
              ...node.metadata,
              stale: true,
              last_refresh_error: 'Node not found in provider',
              last_refresh_at: new Date().toISOString(),
            },
          })
          return null
        }

        // Update with fresh data
        return this.materialize(node.uri, providerNode, store)
      } catch (error) {
        // Mark as stale on error
        await store.updateNode(node.id, {
          metadata: {
            ...node.metadata,
            stale: true,
            last_refresh_error: error instanceof Error ? error.message : String(error),
            last_refresh_at: new Date().toISOString(),
          },
        })
        return null
      }
    },

    /**
     * Start background sync process
     */
    startBackgroundSync(store: GraphStore, registry: ProviderRegistry): void {
      // Don't start if disabled or already running
      if (!config.backgroundSyncInterval || config.backgroundSyncInterval <= 0) {
        return
      }

      if (syncInterval) {
        return
      }

      syncInterval = setInterval(async () => {
        // Prevent overlapping sync operations
        if (isSyncing) {
          return
        }

        isSyncing = true

        try {
          // Find all external nodes that are materialized
          const externalNodes = await store.query.nodes({
            type: 'external',
          })

          // Filter to stale nodes
          const staleNodes = externalNodes.filter((node) => {
            const extNode = node as ExternalNode
            return extNode.materialized && this.isStale(extNode)
          })

          // Refresh each stale node
          for (const node of staleNodes) {
            const extNode = node as ExternalNode
            const provider = registry.resolveProvider(extNode.uri)

            if (provider) {
              await this.refresh(extNode, provider, store)
            }
          }
        } catch {
          // Log error but continue - background sync should be resilient
        } finally {
          isSyncing = false
        }
      }, config.backgroundSyncInterval)
    },

    /**
     * Stop background sync process
     */
    stopBackgroundSync(): void {
      if (syncInterval) {
        clearInterval(syncInterval)
        syncInterval = null
      }
    },

    /**
     * Check if background sync is running
     */
    isBackgroundSyncRunning(): boolean {
      return syncInterval !== null
    },
  }
}
