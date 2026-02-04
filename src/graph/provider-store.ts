/**
 * Provider-Aware Graph Store
 *
 * Extends GraphStore with provider resolution and materialization capabilities.
 * This wrapper adds the ability to resolve external URIs and materialize
 * external nodes while keeping the base GraphStore implementation intact.
 */

import type { Node, ExternalNode } from '../schema/index.js'
import type {
  Provider,
  ProviderNode,
  ProviderRegistry,
  MaterializationConfig,
} from '../providers/types.js'
import type { MaterializationManager } from '../providers/materialization.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createNativeProvider } from '../providers/native.js'
import { createMaterializationManager } from '../providers/materialization.js'
import type { GraphStore } from './store.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for resolving a node
 */
export interface ResolveOptions {
  /** Force fresh fetch (ignore cache) */
  refresh?: boolean

  /** Explicitly request materialization */
  materialize?: boolean

  /** Include raw provider data in response */
  includeRawData?: boolean
}

/**
 * Configuration for provider-aware store
 */
export interface ProviderStoreConfig {
  /** Pre-configured provider registry (optional) */
  registry?: ProviderRegistry

  /** Materialization configuration */
  materialization?: Partial<MaterializationConfig>

  /** Whether to auto-register native provider (default: true) */
  autoRegisterNative?: boolean
}

/**
 * Provider-aware graph store interface
 */
export interface ProviderAwareStore extends GraphStore {
  /** Provider registry */
  readonly providers: ProviderRegistry

  /** Materialization manager */
  readonly materialization: MaterializationManager

  /**
   * Resolve any node by ID or URI
   * - Local IDs (s-, i-, f-, e-, x-) → getNode()
   * - External URIs → provider.get() + optional materialize
   */
  resolveNode(
    idOrUri: string,
    options?: ResolveOptions
  ): Promise<Node | ProviderNode | null>

  /**
   * Materialize an external node from provider data
   */
  materializeNode(uri: string): Promise<ExternalNode>

  /**
   * Refresh a materialized external node
   */
  refreshNode(id: string): Promise<ExternalNode | null>

  /**
   * Start background sync for external nodes
   */
  startBackgroundSync(): void

  /**
   * Stop background sync
   */
  stopBackgroundSync(): void

  /**
   * Check if background sync is running
   */
  isBackgroundSyncRunning(): boolean
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (s-, i-, f-, e-, x-)
 */
const LOCAL_ID_PATTERN = /^[sifex]-[a-z0-9]+$/

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a string is a local node ID
 */
function isLocalId(idOrUri: string): boolean {
  return LOCAL_ID_PATTERN.test(idOrUri)
}

/**
 * Find external node by URI in the store
 */
async function findExternalNodeByUri(
  uri: string,
  store: GraphStore
): Promise<ExternalNode | null> {
  const nodes = await store.query.nodes({
    type: 'external',
  })

  for (const node of nodes) {
    if (node.type === 'external' && (node as ExternalNode).uri === uri) {
      return node as ExternalNode
    }
  }

  return null
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a provider-aware store by wrapping an existing GraphStore
 */
export function createProviderAwareStore(
  baseStore: GraphStore,
  config: ProviderStoreConfig = {}
): ProviderAwareStore {
  // Set up provider registry
  const registry = config.registry ?? createProviderRegistry()

  // Set up materialization manager
  const materialization = createMaterializationManager(config.materialization)

  // Auto-register native provider if not disabled
  if (config.autoRegisterNative !== false) {
    const nativeProvider = createNativeProvider(baseStore)
    registry.register(nativeProvider)
  }

  // Create the provider-aware store by extending the base store
  const providerStore: ProviderAwareStore = {
    // Spread all base store properties and methods
    ...baseStore,

    // Add provider-specific properties
    providers: registry,
    materialization,

    /**
     * Resolve a node by ID or URI
     */
    async resolveNode(
      idOrUri: string,
      options?: ResolveOptions
    ): Promise<Node | ProviderNode | null> {
      // 1. Check if local ID - use existing getNode
      if (isLocalId(idOrUri)) {
        return baseStore.getNode(idOrUri)
      }

      // 2. Check for cached materialized node (unless refresh requested)
      if (!options?.refresh) {
        const existing = await findExternalNodeByUri(idOrUri, baseStore)
        if (existing && !materialization.isStale(existing)) {
          return existing
        }
      }

      // 3. Find provider for this URI
      const provider = registry.resolveProvider(idOrUri)
      if (!provider) {
        return null
      }

      // 4. Parse URI and fetch from provider
      const parsed = provider.parseUri(idOrUri)
      if (!parsed) {
        return null
      }

      const providerNode = await provider.get(parsed.id)
      if (!providerNode) {
        return null
      }

      // 5. Materialize if requested or per strategy
      const shouldMaterialize = materialization.shouldMaterialize(idOrUri, {
        accessType: 'resolve',
        explicit: options?.materialize,
      })

      if (shouldMaterialize) {
        return materialization.materialize(idOrUri, providerNode, baseStore)
      }

      // Return provider node directly
      return providerNode as unknown as Node
    },

    /**
     * Explicitly materialize an external node
     */
    async materializeNode(uri: string): Promise<ExternalNode> {
      // Find provider for this URI
      const provider = registry.resolveProvider(uri)
      if (!provider) {
        throw new Error(`No provider found for URI: ${uri}`)
      }

      // Parse and fetch
      const parsed = provider.parseUri(uri)
      if (!parsed) {
        throw new Error(`Invalid URI for provider: ${uri}`)
      }

      const providerNode = await provider.get(parsed.id)
      if (!providerNode) {
        throw new Error(`Node not found: ${uri}`)
      }

      // Materialize
      return materialization.materialize(uri, providerNode, baseStore)
    },

    /**
     * Refresh a materialized external node
     */
    async refreshNode(id: string): Promise<ExternalNode | null> {
      // Get the existing node
      const node = await baseStore.getNode(id)
      if (!node || node.type !== 'external') {
        throw new Error(`Node not found or not external: ${id}`)
      }

      const externalNode = node as ExternalNode

      // Find provider
      const provider = registry.resolveProvider(externalNode.uri)
      if (!provider) {
        throw new Error(`No provider found for URI: ${externalNode.uri}`)
      }

      // Refresh using materialization manager
      return materialization.refresh(externalNode, provider, baseStore)
    },

    /**
     * Start background sync
     */
    startBackgroundSync(): void {
      materialization.startBackgroundSync(baseStore, registry)
    },

    /**
     * Stop background sync
     */
    stopBackgroundSync(): void {
      materialization.stopBackgroundSync()
    },

    /**
     * Check if background sync is running
     */
    isBackgroundSyncRunning(): boolean {
      return materialization.isBackgroundSyncRunning()
    },
  }

  return providerStore
}
