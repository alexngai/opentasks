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
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderRegistry,
  MaterializationConfig,
  ProviderOperationContext,
} from '../providers/types.js'
import { ProviderError } from '../providers/types.js'
import type { MaterializationManager } from '../providers/materialization.js'
import { createProviderRegistry } from '../providers/registry.js'
import { createNativeProvider } from '../providers/native.js'
import { createMaterializationManager } from '../providers/materialization.js'
import {
  isWatchable,
  type ProviderChangeEvent,
  type ProviderNodeChangeEvent,
} from '../providers/traits/Watchable.js'
import type { GraphStore } from './store.js'
import type { CreateNodeInput, UpdateNodeInput, DeleteOptions } from './types.js'

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
 * Options for provider-routed create
 */
export interface ProviderCreateOptions {
  /** Target provider scheme (overrides defaultProvider) */
  scheme?: string

  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext
}

/**
 * Options for provider-routed get
 */
export interface ProviderGetOptions {
  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext
}

/**
 * Options for provider-routed update
 */
export interface ProviderUpdateOptions {
  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext
}

/**
 * Result from a provider-routed create
 */
export interface ProviderCreateResult {
  /** The created/materialized node */
  node: Node
  /** The provider URI (if created via external provider) */
  uri?: string
  /** Which provider handled the create */
  provider: string
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

  /** Default provider for CRUD operations ('native' = local GraphStore) */
  defaultProvider?: string
}

/**
 * Callback for provider change events received by the store.
 * Allows external consumers to react to provider-driven changes.
 */
export type ProviderChangeHandler = (
  providerName: string,
  event: ProviderChangeEvent
) => void

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

  /**
   * Start watching all watchable providers for changes.
   *
   * For each provider that implements the Watchable trait, subscribes
   * to change events and auto-refreshes materialized nodes.
   * Non-watchable providers are skipped (use startBackgroundSync for those).
   */
  startProviderWatching(): void

  /**
   * Stop watching all providers for changes.
   */
  stopProviderWatching(): void

  /**
   * Register an external handler for provider change events.
   * Called after the store has processed each event internally.
   *
   * @returns Unsubscribe function
   */
  onProviderChange(handler: ProviderChangeHandler): () => void

  // ===========================================================================
  // Provider-Routed CRUD (Unified Interface)
  // ===========================================================================

  /**
   * Create a node via provider dispatch.
   * Routes to defaultProvider or explicit scheme. Always materializes.
   */
  providerCreate(
    input: CreateNodeInput,
    options?: ProviderCreateOptions
  ): Promise<ProviderCreateResult>

  /**
   * Get a node by local ID or provider URI.
   * For external nodes, refreshes if stale.
   */
  providerGet(idOrUri: string, options?: ProviderGetOptions): Promise<Node | null>

  /**
   * Update a node by local ID or provider URI.
   * For external/materialized nodes, routes update to the owning provider
   * and refreshes the local materialized copy.
   */
  providerUpdate(idOrUri: string, updates: UpdateNodeInput, options?: ProviderUpdateOptions): Promise<Node>

  /**
   * Delete a node by local ID or provider URI.
   * For external/materialized nodes, deletes in the provider
   * and removes the local materialized copy.
   */
  providerDelete(idOrUri: string, options?: DeleteOptions & { context?: ProviderOperationContext }): Promise<void>

  /** The configured default provider name */
  readonly defaultProvider: string
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
 * Convert CreateNodeInput to ProviderCreateInput.
 * Passes through tags and parent_id via metadata so providers can use them.
 */
function toProviderCreateInput(input: CreateNodeInput): ProviderCreateInput {
  // Merge tags and parent_id into metadata for providers that support them
  const metadata: Record<string, unknown> = { ...input.metadata }
  if (input.tags && input.tags.length > 0) {
    metadata.tags = input.tags
  }
  if (input.parent_id) {
    metadata.parent_id = input.parent_id
  }

  return {
    type: input.type === 'issue' || input.type === 'spec' ? input.type : 'issue',
    title: input.title,
    content: input.content,
    status: input.status,
    priority: input.priority,
    metadata: Object.keys(metadata).length > 0 ? metadata : input.metadata,
  }
}

/**
 * Convert UpdateNodeInput to ProviderUpdateInput
 */
function toProviderUpdateInput(updates: UpdateNodeInput): ProviderUpdateInput {
  return {
    title: updates.title,
    content: updates.content,
    status: updates.status,
    priority: updates.priority,
    metadata: updates.metadata,
  }
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

  // Default provider configuration
  const defaultProviderName = config.defaultProvider ?? 'native'

  // Auto-register native provider if not disabled
  if (config.autoRegisterNative !== false) {
    const nativeProvider = createNativeProvider(baseStore)
    registry.register(nativeProvider)
  }

  // =========================================================================
  // Provider Watch State
  // =========================================================================

  /** External handlers for provider change events */
  const changeHandlers: ProviderChangeHandler[] = []

  /** Track which providers are currently being watched */
  const watchedProviders = new Set<string>()

  /**
   * Handle an inbound provider change event.
   * Auto-refreshes materialized nodes, then notifies external handlers.
   */
  async function handleProviderChange(
    providerName: string,
    event: ProviderChangeEvent
  ): Promise<void> {
    if (event.kind === 'node') {
      await handleNodeChange(providerName, event.event)
    }
    // Edge events: no auto-action needed for now — consumers can
    // react via onProviderChange handlers. In the future, the
    // federated graph could invalidate cached edge data here.

    // Notify external handlers
    for (const handler of changeHandlers) {
      try {
        handler(providerName, event)
      } catch {
        // Don't let handler errors break the watch loop
      }
    }
  }

  /**
   * Handle a node change from a provider.
   * If the node is already materialized locally, refresh it.
   */
  async function handleNodeChange(
    _providerName: string,
    event: ProviderNodeChangeEvent
  ): Promise<void> {
    // Check if we have a materialized copy of this node
    const existing = await findExternalNodeByUri(event.uri, baseStore)

    if (!existing) {
      // Node not materialized locally — nothing to refresh.
      // The event is still forwarded to external handlers above.
      return
    }

    if (event.type === 'deleted') {
      // Mark the local materialized node as stale
      await baseStore.updateNode(existing.id, {
        metadata: {
          ...existing.metadata,
          stale: true,
          last_refresh_at: new Date().toISOString(),
          last_refresh_error: 'Node deleted in provider',
        },
      })
      return
    }

    // For 'created' (re-appeared) or 'updated': refresh materialized copy
    if (event.node) {
      // Provider included the full node data — materialize directly
      await materialization.materialize(event.uri, event.node, baseStore)
    } else {
      // No node data in event — fetch fresh from provider
      const provider = registry.resolveProvider(event.uri)
      if (provider) {
        await materialization.refresh(existing, provider, baseStore)
      }
    }
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
      return resolveNodeInternal(idOrUri, options)
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

    /**
     * Start watching all watchable providers for changes.
     */
    startProviderWatching(): void {
      for (const provider of registry.list()) {
        if (isWatchable(provider) && !watchedProviders.has(provider.name)) {
          provider.startWatching((event) => {
            void handleProviderChange(provider.name, event)
          })
          watchedProviders.add(provider.name)
        }
      }
    },

    /**
     * Stop watching all providers for changes.
     */
    stopProviderWatching(): void {
      for (const provider of registry.list()) {
        if (isWatchable(provider) && watchedProviders.has(provider.name)) {
          provider.stopWatching()
          watchedProviders.delete(provider.name)
        }
      }
    },

    /**
     * Register an external handler for provider change events.
     */
    onProviderChange(handler: ProviderChangeHandler): () => void {
      changeHandlers.push(handler)
      return () => {
        const idx = changeHandlers.indexOf(handler)
        if (idx >= 0) changeHandlers.splice(idx, 1)
      }
    },

    // =========================================================================
    // Provider-Routed CRUD (Unified Interface)
    // =========================================================================

    defaultProvider: defaultProviderName,

    async providerCreate(
      input: CreateNodeInput,
      options?: ProviderCreateOptions
    ): Promise<ProviderCreateResult> {
      const targetScheme = options?.scheme ?? defaultProviderName

      // Native/local path — no provider routing needed
      if (targetScheme === 'native' || targetScheme === 'opentasks') {
        const node = await baseStore.createNode(input)
        return { node, provider: 'native' }
      }

      // Find the target provider by name or scheme
      const provider = registry.get(targetScheme) ?? registry.resolveProvider(`${targetScheme}://`)
      if (!provider) {
        throw new ProviderError('NOT_FOUND', `Unknown provider: ${targetScheme}`, targetScheme)
      }

      if (!provider.capabilities.write) {
        throw new ProviderError('NOT_SUPPORTED', `Provider ${provider.name} is read-only`, provider.name)
      }

      if (!provider.capabilities.mount) {
        throw new ProviderError('NOT_SUPPORTED', `Provider ${provider.name} does not support mounting`, provider.name)
      }

      // Create via provider, forwarding operational context
      const providerNode = await provider.create(toProviderCreateInput(input), options?.context)

      // Build canonical URI and always materialize on create
      const uri = provider.buildUri(providerNode.id)
      const materializedNode = await materialization.materialize(uri, providerNode, baseStore)

      return {
        node: materializedNode,
        uri,
        provider: provider.name,
      }
    },

    async providerGet(idOrUri: string, options?: ProviderGetOptions): Promise<Node | null> {
      // 1. Local ID — direct store access
      if (isLocalId(idOrUri)) {
        const node = await baseStore.getNode(idOrUri)

        // If it's a materialized external node, check staleness
        if (node?.type === 'external') {
          const extNode = node as ExternalNode
          if (materialization.isStale(extNode)) {
            const provider = registry.resolveProvider(extNode.uri)
            if (provider) {
              const refreshed = await materialization.refresh(extNode, provider, baseStore, options?.context)
              return refreshed ?? node
            }
          }
        }

        return node
      }

      // 2. Provider URI — resolve through provider, always materialize
      const result = await resolveNodeInternal(idOrUri, { materialize: true }, options?.context)
      return result as Node | null
    },

    async providerUpdate(idOrUri: string, updates: UpdateNodeInput, options?: ProviderUpdateOptions): Promise<Node> {
      // Resolve the target node and provider
      const { node, provider: owningProvider, isExternal } = await resolveForWrite(idOrUri)

      if (!isExternal || owningProvider?.name === 'native') {
        // Local node — update directly
        return baseStore.updateNode(node.id, updates)
      }

      // External node but provider not registered — error rather than silent local-only update
      if (!owningProvider) {
        const extNode = node as ExternalNode
        throw new ProviderError(
          'NOT_FOUND',
          `Provider not registered for external node URI: ${extNode.uri}. Cannot route update.`
        )
      }

      if (!owningProvider.capabilities.write) {
        throw new ProviderError('NOT_SUPPORTED', `Provider ${owningProvider.name} is read-only`, owningProvider.name)
      }

      // Route update to external provider
      const extNode = node as ExternalNode
      const parsed = owningProvider.parseUri(extNode.uri)
      if (!parsed) {
        throw new ProviderError('INVALID_URI', `Cannot parse URI: ${extNode.uri}`, owningProvider.name)
      }

      const updatedProviderNode = await owningProvider.update(parsed.id, toProviderUpdateInput(updates), options?.context)

      // Refresh local materialized copy with provider's response
      return materialization.materialize(extNode.uri, updatedProviderNode, baseStore) as Promise<Node>
    },

    async providerDelete(idOrUri: string, options?: DeleteOptions & { context?: ProviderOperationContext }): Promise<void> {
      // Resolve the target node and provider
      const { node, provider: owningProvider, isExternal } = await resolveForWrite(idOrUri)

      if (!isExternal || owningProvider?.name === 'native') {
        // Local node — delete directly
        await baseStore.deleteNode(node.id, options)
        return
      }

      // External node but provider not registered — error rather than silent local-only delete
      if (!owningProvider) {
        const extNode = node as ExternalNode
        throw new ProviderError(
          'NOT_FOUND',
          `Provider not registered for external node URI: ${extNode.uri}. Cannot route delete.`
        )
      }

      if (!owningProvider.capabilities.write) {
        throw new ProviderError('NOT_SUPPORTED', `Provider ${owningProvider.name} is read-only`, owningProvider.name)
      }

      // Delete in external provider
      const extNode = node as ExternalNode
      const parsed = owningProvider.parseUri(extNode.uri)
      if (!parsed) {
        throw new ProviderError('INVALID_URI', `Cannot parse URI: ${extNode.uri}`, owningProvider.name)
      }

      await owningProvider.delete(parsed.id, options?.context)

      // Remove local materialized copy
      await baseStore.deleteNode(node.id, { hard: true })
    },
  }

  // ===========================================================================
  // Internal Helper: Resolve any node by ID or URI (used by resolveNode and providerGet)
  // ===========================================================================

  async function resolveNodeInternal(
    idOrUri: string,
    options?: ResolveOptions,
    context?: ProviderOperationContext
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

    const providerNode = await provider.get(parsed.id, context)
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
  }

  // ===========================================================================
  // Internal Helper: Resolve a node + its owning provider for write operations
  // ===========================================================================

  async function resolveForWrite(idOrUri: string): Promise<{
    node: Node
    provider: Provider | null
    isExternal: boolean
  }> {
    // Case 1: Provider URI (e.g., sudocode://proj/i-456)
    if (!isLocalId(idOrUri)) {
      const provider = registry.resolveProvider(idOrUri)
      if (!provider) {
        throw new ProviderError('NOT_FOUND', `No provider found for: ${idOrUri}`)
      }

      // Check if we have a materialized copy
      const existing = await findExternalNodeByUri(idOrUri, baseStore)
      if (existing) {
        return { node: existing, provider, isExternal: true }
      }

      // No local copy — materialize first so we have a node to return
      const parsed = provider.parseUri(idOrUri)
      if (!parsed) {
        throw new ProviderError('INVALID_URI', `Cannot parse URI: ${idOrUri}`, provider.name)
      }

      const providerNode = await provider.get(parsed.id)
      if (!providerNode) {
        throw new ProviderError('NOT_FOUND', `Node not found: ${idOrUri}`, provider.name)
      }

      const materialized = await materialization.materialize(idOrUri, providerNode, baseStore)
      return { node: materialized, provider, isExternal: true }
    }

    // Case 2: Local ID (s-abc1, i-def2, x-ghi3)
    const node = await baseStore.getNode(idOrUri)
    if (!node) {
      throw new ProviderError('NOT_FOUND', `Node not found: ${idOrUri}`)
    }

    // Check if it's a materialized external node
    if (node.type === 'external') {
      const extNode = node as ExternalNode
      const provider = registry.resolveProvider(extNode.uri)
      return { node, provider, isExternal: true }
    }

    // Pure local node
    return { node, provider: null, isExternal: false }
  }

  return providerStore
}
