/**
 * Provider-Aware Graph Store
 *
 * Extends GraphStore with provider resolution and materialization capabilities.
 * This wrapper adds the ability to resolve external URIs and materialize
 * external nodes while keeping the base GraphStore implementation intact.
 */

import type { Node, ExternalNode } from '../schema/index.js';
import type {
  Provider,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ProviderRegistry,
  MaterializationConfig,
  ProviderOperationContext,
} from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import type { MaterializationManager } from '../providers/materialization.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createNativeProvider } from '../providers/native.js';
import { createMaterializationManager } from '../providers/materialization.js';
import {
  isWatchable,
  type ProviderChangeEvent,
  type ProviderNodeChangeEvent,
} from '../providers/traits/Watchable.js';
import {
  isTaskManageable,
  type TaskAction,
  type ReadyTaskOptions,
} from '../providers/traits/TaskManageable.js';
import type { GraphStore } from './store.js';
import type { CreateNodeInput, UpdateNodeInput, DeleteOptions } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for resolving a node
 */
export interface ResolveOptions {
  /** Force fresh fetch (ignore cache) */
  refresh?: boolean;

  /** Explicitly request materialization */
  materialize?: boolean;

  /** Include raw provider data in response */
  includeRawData?: boolean;
}

/**
 * Options for provider-routed create
 */
export interface ProviderCreateOptions {
  /** Target provider scheme (overrides defaultProvider) */
  scheme?: string;

  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext;
}

/**
 * Options for provider-routed get
 */
export interface ProviderGetOptions {
  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext;
}

/**
 * Options for provider-routed update
 */
export interface ProviderUpdateOptions {
  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext;
}

/**
 * Options for task transition operations
 */
export interface TaskTransitionOptions {
  /** Operational context forwarded to the provider */
  context?: ProviderOperationContext;
}

/**
 * Options for listing tasks across providers (federated query)
 */
export interface FederatedListTasksOptions {
  /** Filter by status(es) */
  status?: string | string[];

  /** Filter by tags (AND semantics) */
  tags?: string[];

  /** Filter by assignee */
  assignee?: string;

  /** Text search in title and content */
  search?: string;

  /** Maximum results */
  limit?: number;

  /** Pagination offset */
  offset?: number;

  /** Only query these providers (by name). If omitted, queries all. */
  providers?: string[];

  /** Operational context forwarded to providers */
  context?: ProviderOperationContext;
}

/**
 * Options for querying ready tasks across providers
 */
export interface FederatedReadyTaskOptions extends ReadyTaskOptions {
  /** Only query these providers (by name). If omitted, queries all task-capable providers. */
  providers?: string[];

  /** Operational context forwarded to providers */
  context?: ProviderOperationContext;
}

/**
 * Result from a task transition
 */
export interface TaskTransitionResult {
  /** The updated node (materialized if external) */
  node: Node;
  /** The provider that handled the transition */
  provider: string;
  /** The action that was applied */
  action: TaskAction;
}

/**
 * Result from a provider-routed create
 */
export interface ProviderCreateResult {
  /** The created/materialized node */
  node: Node;
  /** The provider URI (if created via external provider) */
  uri?: string;
  /** Which provider handled the create */
  provider: string;
}

/**
 * Configuration for provider-aware store
 */
export interface ProviderStoreConfig {
  /** Pre-configured provider registry (optional) */
  registry?: ProviderRegistry;

  /** Materialization configuration */
  materialization?: Partial<MaterializationConfig>;

  /** Whether to auto-register native provider (default: true) */
  autoRegisterNative?: boolean;

  /** Default provider for CRUD operations ('native' = local GraphStore) */
  defaultProvider?: string;
}

/**
 * Callback for provider change events received by the store.
 * Allows external consumers to react to provider-driven changes.
 */
export type ProviderChangeHandler = (providerName: string, event: ProviderChangeEvent) => void;

/**
 * Provider-aware graph store interface
 */
export interface ProviderAwareStore extends GraphStore {
  /** Provider registry */
  readonly providers: ProviderRegistry;

  /** Materialization manager */
  readonly materialization: MaterializationManager;

  /**
   * Resolve any node by ID or URI
   * - Local IDs (s-, i-, f-, e-, x-) → getNode()
   * - External URIs → provider.get() + optional materialize
   */
  resolveNode(idOrUri: string, options?: ResolveOptions): Promise<Node | ProviderNode | null>;

  /**
   * Materialize a provider node into the local graph
   */
  materializeNode(uri: string): Promise<Node>;

  /**
   * Refresh a materialized external node
   */
  refreshNode(id: string): Promise<Node | null>;

  /**
   * Start background sync for external nodes
   */
  startBackgroundSync(): void;

  /**
   * Stop background sync
   */
  stopBackgroundSync(): void;

  /**
   * Check if background sync is running
   */
  isBackgroundSyncRunning(): boolean;

  /**
   * Start watching all watchable providers for changes.
   *
   * For each provider that implements the Watchable trait, subscribes
   * to change events and auto-refreshes materialized nodes.
   * Non-watchable providers are skipped (use startBackgroundSync for those).
   */
  startProviderWatching(): void;

  /**
   * Stop watching all providers for changes.
   */
  stopProviderWatching(): void;

  /**
   * Register an external handler for provider change events.
   * Called after the store has processed each event internally.
   *
   * @returns Unsubscribe function
   */
  onProviderChange(handler: ProviderChangeHandler): () => void;

  // ===========================================================================
  // Provider-Routed CRUD (Unified Interface)
  // ===========================================================================

  /**
   * Create a node via provider dispatch.
   * Routes to defaultProvider or explicit scheme. Always materializes.
   */
  providerCreate(
    input: CreateNodeInput,
    options?: ProviderCreateOptions,
  ): Promise<ProviderCreateResult>;

  /**
   * Get a node by local ID or provider URI.
   * For external nodes, refreshes if stale.
   */
  providerGet(idOrUri: string, options?: ProviderGetOptions): Promise<Node | null>;

  /**
   * Update a node by local ID or provider URI.
   * For external/materialized nodes, routes update to the owning provider
   * and refreshes the local materialized copy.
   */
  providerUpdate(
    idOrUri: string,
    updates: UpdateNodeInput,
    options?: ProviderUpdateOptions,
  ): Promise<Node>;

  /**
   * Delete a node by local ID or provider URI.
   * For external/materialized nodes, deletes in the provider
   * and removes the local materialized copy.
   */
  providerDelete(
    idOrUri: string,
    options?: DeleteOptions & { context?: ProviderOperationContext },
  ): Promise<void>;

  /** The configured default provider name */
  readonly defaultProvider: string;

  // ===========================================================================
  // Task Lifecycle (TaskManageable Trait — Federated)
  // ===========================================================================

  /**
   * Transition a task's status using a semantic action.
   * Resolves the owning provider, checks that it supports TaskManageable,
   * and delegates the transition.
   */
  taskTransition(
    idOrUri: string,
    action: TaskAction,
    options?: TaskTransitionOptions,
  ): Promise<TaskTransitionResult>;

  /**
   * List tasks across all providers (federated query).
   * Queries the native graph store for type:'task' nodes AND each
   * registered provider's list() method, merging and deduplicating results.
   */
  providerListTasks(options?: FederatedListTasksOptions): Promise<Node[]>;

  /**
   * Get tasks that are ready to work on, aggregated across all
   * task-capable providers (Option B: federated aggregation).
   */
  taskReady(options?: FederatedReadyTaskOptions): Promise<Node[]>;

  /**
   * Assign a task to an owner.
   * Resolves the owning provider, checks TaskManageable + supportsAssignment.
   */
  taskAssign(idOrUri: string, assignee: string, options?: TaskTransitionOptions): Promise<Node>;

  /**
   * Get valid next actions for a task in its current state.
   * Falls back to the provider's full `taskCapabilities.actions` if the
   * provider doesn't implement `validActions`.
   */
  taskValidActions(idOrUri: string): Promise<TaskAction[]>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (s-, i-, f-, e-, x-)
 */
const LOCAL_ID_PATTERN = /^[ctfex]-[a-z0-9]+$/;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a string is a local node ID
 */
function isLocalId(idOrUri: string): boolean {
  return LOCAL_ID_PATTERN.test(idOrUri);
}

/**
 * Check if a node is backed by an external provider (either type:'external'
 * or a local-provider node with metadata.provider_uri).
 */
function isProviderBacked(node: Node): boolean {
  return node.type === 'external' || typeof node.metadata?.provider_uri === 'string';
}

/**
 * Get the provider URI for a node. For type:'external' nodes, returns the
 * top-level uri field. For local-provider nodes, returns metadata.provider_uri.
 * Returns null if the node has no provider binding.
 */
function getProviderUri(node: Node): string | null {
  if (node.type === 'external') return (node as ExternalNode).uri;
  return (node.metadata?.provider_uri as string) ?? null;
}

/**
 * Convert CreateNodeInput to ProviderCreateInput.
 * Passes through tags and parent_id via metadata so providers can use them.
 */
function toProviderCreateInput(input: CreateNodeInput): ProviderCreateInput {
  // Merge tags and parent_id into metadata for providers that support them
  const metadata: Record<string, unknown> = { ...input.metadata };
  if (input.tags && input.tags.length > 0) {
    metadata.tags = input.tags;
  }
  if (input.parent_id) {
    metadata.parent_id = input.parent_id;
  }

  return {
    type: input.type === 'task' ? 'issue' : input.type === 'context' ? 'spec' : 'issue',
    title: input.title,
    content: input.content,
    status: input.status,
    priority: input.priority,
    metadata: Object.keys(metadata).length > 0 ? metadata : input.metadata,
  };
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
  };
}

/**
 * Find a materialized node by provider URI.
 * Searches both type:'external' nodes (by uri field) and local-provider nodes
 * (by metadata.provider_uri).
 */
async function findExternalNodeByUri(uri: string, store: GraphStore): Promise<Node | null> {
  // First check type:'external' nodes
  const externalNodes = await store.query.nodes({ type: 'external' });
  for (const node of externalNodes) {
    if (node.type === 'external' && (node as ExternalNode).uri === uri) {
      return node;
    }
  }

  // Then check local-provider nodes via metadata.provider_uri
  const allNodes = await store.query.nodes({ search: uri });
  for (const node of allNodes) {
    if (node.metadata?.provider_uri === uri) {
      return node;
    }
  }

  return null;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a provider-aware store by wrapping an existing GraphStore
 */
export function createProviderAwareStore(
  baseStore: GraphStore,
  config: ProviderStoreConfig = {},
): ProviderAwareStore {
  // Set up provider registry
  const registry = config.registry ?? createProviderRegistry();

  // Set up materialization manager
  const materialization = createMaterializationManager(config.materialization);

  // Default provider configuration
  const defaultProviderName = config.defaultProvider ?? 'native';

  // Auto-register native provider if not disabled
  if (config.autoRegisterNative !== false) {
    const nativeProvider = createNativeProvider(baseStore);
    registry.register(nativeProvider);
  }

  // =========================================================================
  // Provider Watch State
  // =========================================================================

  /** External handlers for provider change events */
  const changeHandlers: ProviderChangeHandler[] = [];

  /** Track which providers are currently being watched */
  const watchedProviders = new Set<string>();

  /**
   * Handle an inbound provider change event.
   * Auto-refreshes materialized nodes, then notifies external handlers.
   */
  async function handleProviderChange(
    providerName: string,
    event: ProviderChangeEvent,
  ): Promise<void> {
    if (event.kind === 'node') {
      await handleNodeChange(providerName, event.event);
    }
    // Edge events: no auto-action needed for now — consumers can
    // react via onProviderChange handlers. In the future, the
    // federated graph could invalidate cached edge data here.

    // Notify external handlers
    for (const handler of changeHandlers) {
      try {
        handler(providerName, event);
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
    event: ProviderNodeChangeEvent,
  ): Promise<void> {
    // Check if we have a materialized copy of this node
    const existing = await findExternalNodeByUri(event.uri, baseStore);

    if (!existing) {
      // Node not materialized locally — nothing to refresh.
      // The event is still forwarded to external handlers above.
      return;
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
      });
      return;
    }

    // For 'created' (re-appeared) or 'updated': refresh materialized copy
    const changeProvider = registry.get(_providerName) ?? registry.resolveProvider(event.uri);
    if (event.node) {
      // Provider included the full node data — materialize directly
      await materialization.materialize(event.uri, event.node, baseStore, {
        local: changeProvider?.local,
      });
    } else {
      // No node data in event — fetch fresh from provider
      if (changeProvider) {
        if (existing.type === 'external') {
          await materialization.refresh(existing as ExternalNode, changeProvider, baseStore);
        } else {
          // Local-provider node — fetch and re-materialize
          const parsed = changeProvider.parseUri(event.uri);
          if (parsed) {
            const fresh = await changeProvider.get(parsed.id);
            if (fresh) {
              await materialization.materialize(event.uri, fresh, baseStore, {
                local: changeProvider.local,
              });
            }
          }
        }
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
      options?: ResolveOptions,
    ): Promise<Node | ProviderNode | null> {
      return resolveNodeInternal(idOrUri, options);
    },

    /**
     * Explicitly materialize an external node
     */
    async materializeNode(uri: string): Promise<Node> {
      // Find provider for this URI
      const provider = registry.resolveProvider(uri);
      if (!provider) {
        throw new Error(`No provider found for URI: ${uri}`);
      }

      // Parse and fetch
      const parsed = provider.parseUri(uri);
      if (!parsed) {
        throw new Error(`Invalid URI for provider: ${uri}`);
      }

      const providerNode = await provider.get(parsed.id);
      if (!providerNode) {
        throw new Error(`Node not found: ${uri}`);
      }

      // Materialize
      return materialization.materialize(uri, providerNode, baseStore, {
        local: provider.local,
      });
    },

    /**
     * Refresh a materialized external node
     */
    async refreshNode(id: string): Promise<Node | null> {
      // Get the existing node
      const node = await baseStore.getNode(id);
      if (!node || node.type !== 'external') {
        throw new Error(`Node not found or not external: ${id}`);
      }

      const externalNode = node as ExternalNode;

      // Find provider
      const provider = registry.resolveProvider(externalNode.uri);
      if (!provider) {
        throw new Error(`No provider found for URI: ${externalNode.uri}`);
      }

      // Refresh using materialization manager
      return materialization.refresh(externalNode, provider, baseStore);
    },

    /**
     * Start background sync
     */
    startBackgroundSync(): void {
      materialization.startBackgroundSync(baseStore, registry);
    },

    /**
     * Stop background sync
     */
    stopBackgroundSync(): void {
      materialization.stopBackgroundSync();
    },

    /**
     * Check if background sync is running
     */
    isBackgroundSyncRunning(): boolean {
      return materialization.isBackgroundSyncRunning();
    },

    /**
     * Start watching all watchable providers for changes.
     */
    startProviderWatching(): void {
      for (const provider of registry.list()) {
        if (isWatchable(provider) && !watchedProviders.has(provider.name)) {
          provider.startWatching((event) => {
            void handleProviderChange(provider.name, event);
          });
          watchedProviders.add(provider.name);
        }
      }
    },

    /**
     * Stop watching all providers for changes.
     */
    stopProviderWatching(): void {
      for (const provider of registry.list()) {
        if (isWatchable(provider) && watchedProviders.has(provider.name)) {
          provider.stopWatching();
          watchedProviders.delete(provider.name);
        }
      }
    },

    /**
     * Register an external handler for provider change events.
     */
    onProviderChange(handler: ProviderChangeHandler): () => void {
      changeHandlers.push(handler);
      return () => {
        const idx = changeHandlers.indexOf(handler);
        if (idx >= 0) changeHandlers.splice(idx, 1);
      };
    },

    // =========================================================================
    // Provider-Routed CRUD (Unified Interface)
    // =========================================================================

    defaultProvider: defaultProviderName,

    async providerCreate(
      input: CreateNodeInput,
      options?: ProviderCreateOptions,
    ): Promise<ProviderCreateResult> {
      const targetScheme = options?.scheme ?? defaultProviderName;

      // Native/local path — no provider routing needed
      if (targetScheme === 'native' || targetScheme === 'opentasks') {
        const node = await baseStore.createNode(input);
        return { node, provider: 'native' };
      }

      // Find the target provider by name or scheme
      const provider = registry.get(targetScheme) ?? registry.resolveProvider(`${targetScheme}://`);
      if (!provider) {
        throw new ProviderError('NOT_FOUND', `Unknown provider: ${targetScheme}`, targetScheme);
      }

      if (!provider.capabilities.write) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Provider ${provider.name} is read-only`,
          provider.name,
        );
      }

      if (!provider.capabilities.mount) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Provider ${provider.name} does not support mounting`,
          provider.name,
        );
      }

      // Create via provider, forwarding operational context
      const providerNode = await provider.create(toProviderCreateInput(input), options?.context);

      // Build canonical URI and always materialize on create
      const uri = provider.buildUri(providerNode.id);
      const materializedNode = await materialization.materialize(uri, providerNode, baseStore, {
        local: provider.local,
      });

      return {
        node: materializedNode,
        uri,
        provider: provider.name,
      };
    },

    async providerGet(idOrUri: string, options?: ProviderGetOptions): Promise<Node | null> {
      // 1. Local ID — direct store access
      if (isLocalId(idOrUri)) {
        const node = await baseStore.getNode(idOrUri);

        // If it's a materialized external node, check staleness
        if (node?.type === 'external') {
          const extNode = node as ExternalNode;
          if (materialization.isStale(extNode)) {
            const provider = registry.resolveProvider(extNode.uri);
            if (provider) {
              const refreshed = await materialization.refresh(
                extNode,
                provider,
                baseStore,
                options?.context,
              );
              return refreshed ?? node;
            }
          }
        }

        return node;
      }

      // 2. Provider URI — resolve through provider, always materialize
      const result = await resolveNodeInternal(idOrUri, { materialize: true }, options?.context);
      return result as Node | null;
    },

    async providerUpdate(
      idOrUri: string,
      updates: UpdateNodeInput,
      options?: ProviderUpdateOptions,
    ): Promise<Node> {
      // Resolve the target node and provider
      const { node, provider: owningProvider, isExternal } = await resolveForWrite(idOrUri);

      if (!isExternal || owningProvider?.name === 'native') {
        // Local node — update directly
        return baseStore.updateNode(node.id, updates);
      }

      // Provider-backed node but provider not registered — error rather than silent local-only update
      const nodeProviderUri = getProviderUri(node);
      if (!owningProvider) {
        throw new ProviderError(
          'NOT_FOUND',
          `Provider not registered for node URI: ${nodeProviderUri}. Cannot route update.`,
        );
      }

      if (!owningProvider.capabilities.write) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Provider ${owningProvider.name} is read-only`,
          owningProvider.name,
        );
      }

      // Route update to owning provider
      const parsed = owningProvider.parseUri(nodeProviderUri!);
      if (!parsed) {
        throw new ProviderError(
          'INVALID_URI',
          `Cannot parse URI: ${nodeProviderUri}`,
          owningProvider.name,
        );
      }

      const updatedProviderNode = await owningProvider.update(
        parsed.id,
        toProviderUpdateInput(updates),
        options?.context,
      );

      // Refresh local materialized copy with provider's response
      return materialization.materialize(nodeProviderUri!, updatedProviderNode, baseStore, {
        local: owningProvider.local,
      }) as Promise<Node>;
    },

    async providerDelete(
      idOrUri: string,
      options?: DeleteOptions & { context?: ProviderOperationContext },
    ): Promise<void> {
      // Resolve the target node and provider
      const { node, provider: owningProvider, isExternal } = await resolveForWrite(idOrUri);

      if (!isExternal || owningProvider?.name === 'native') {
        // Local node — delete directly
        await baseStore.deleteNode(node.id, options);
        return;
      }

      // Provider-backed node but provider not registered — error rather than silent local-only delete
      const deleteProviderUri = getProviderUri(node);
      if (!owningProvider) {
        throw new ProviderError(
          'NOT_FOUND',
          `Provider not registered for node URI: ${deleteProviderUri}. Cannot route delete.`,
        );
      }

      if (!owningProvider.capabilities.write) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Provider ${owningProvider.name} is read-only`,
          owningProvider.name,
        );
      }

      // Delete in owning provider
      const parsed = owningProvider.parseUri(deleteProviderUri!);
      if (!parsed) {
        throw new ProviderError(
          'INVALID_URI',
          `Cannot parse URI: ${deleteProviderUri}`,
          owningProvider.name,
        );
      }

      await owningProvider.delete(parsed.id, options?.context);

      // Remove local materialized copy
      await baseStore.deleteNode(node.id, { hard: true });
    },

    // =========================================================================
    // Task Lifecycle (TaskManageable Trait — Federated)
    // =========================================================================

    async taskTransition(
      idOrUri: string,
      action: TaskAction,
      options?: TaskTransitionOptions,
    ): Promise<TaskTransitionResult> {
      const { provider, providerId } = await resolveTaskProvider(idOrUri);

      const updatedNode = await provider.transitionTask(providerId, action, options?.context);

      // Native provider nodes already exist in the graph store — no materialization needed
      if (provider.name === 'native') {
        const node = await baseStore.getNode(updatedNode.id);
        if (!node) {
          throw new ProviderError('NOT_FOUND', `Node not found after transition: ${updatedNode.id}`);
        }
        return { node, provider: provider.name, action };
      }

      // Materialize the result for non-native providers
      const uri = provider.buildUri(updatedNode.id);
      const materialized = await materialization.materialize(uri, updatedNode, baseStore, {
        local: provider.local,
      });

      return {
        node: materialized,
        provider: provider.name,
        action,
      };
    },

    async providerListTasks(options?: FederatedListTasksOptions): Promise<Node[]> {
      const results: Node[] = [];
      const seenUris = new Set<string>();

      // 1. Query native graph store for type:'task' nodes
      const nativeFilter: Record<string, unknown> = { type: 'task' as const };
      if (options?.status) nativeFilter.status = options.status;
      if (options?.tags) nativeFilter.tags = options.tags;
      if (options?.assignee) nativeFilter.assignee = options.assignee;
      if (options?.search) nativeFilter.search = options.search;

      const nativeNodes = await baseStore.query.nodes(nativeFilter);
      const seenIds = new Set<string>();
      for (const node of nativeNodes) {
        results.push(node);
        seenIds.add(node.id);
        // Track provider URIs from local-provider nodes to prevent duplicates
        // when the provider federation loop re-discovers the same tasks
        const pUri = getProviderUri(node);
        if (pUri) {
          seenUris.add(pUri);
        }
      }

      // 2. Query each registered provider's list()
      for (const provider of registry.list()) {
        if (provider.name === 'native') continue; // already covered above
        if (options?.providers && !options.providers.includes(provider.name)) continue;

        try {
          const providerFilter: ProviderFilter = {};
          if (options?.status) {
            providerFilter.status = Array.isArray(options.status) ? options.status[0] : options.status;
          }
          if (options?.search) providerFilter.search = options.search;

          const providerNodes = await provider.list(providerFilter, options?.context);

          for (const pNode of providerNodes) {
            const uri = provider.buildUri(pNode.id);
            if (seenUris.has(uri)) continue;
            seenUris.add(uri);

            // Check if already materialized in graph
            const existing = await findExternalNodeByUri(uri, baseStore);
            if (existing) {
              // Avoid pushing the same graph node twice (already in results from native query)
              if (!seenIds.has(existing.id)) {
                results.push(existing);
                seenIds.add(existing.id);
              }
            } else {
              // Materialize so callers get Node objects with local IDs
              const materialized = await materialization.materialize(uri, pNode, baseStore, {
                local: provider.local,
              });
              results.push(materialized);
              seenIds.add(materialized.id);
            }
          }
        } catch {
          // Provider unavailable — skip gracefully
        }
      }

      // 3. Apply limit after aggregation
      if (options?.limit && results.length > options.limit) {
        const offset = options?.offset ?? 0;
        return results.slice(offset, offset + options.limit);
      }
      if (options?.offset) {
        return results.slice(options.offset);
      }

      return results;
    },

    async taskReady(options?: FederatedReadyTaskOptions): Promise<Node[]> {
      const results: Node[] = [];
      const seenIds = new Set<string>();

      for (const provider of registry.list()) {
        if (!isTaskManageable(provider)) continue;
        if (options?.providers && !options.providers.includes(provider.name)) continue;

        const readyNodes = await provider.readyTasks(
          {
            limit: options?.limit,
            tags: options?.tags,
            priority: options?.priority,
            assignee: options?.assignee,
          },
          options?.context,
        );

        // Native provider nodes already exist in the graph store — retrieve directly
        if (provider.name === 'native') {
          for (const pNode of readyNodes) {
            const node = await baseStore.getNode(pNode.id);
            if (node && !seenIds.has(node.id)) {
              results.push(node);
              seenIds.add(node.id);
            }
          }
          continue;
        }

        // Materialize each ready task from non-native providers so callers get Node objects
        for (const pNode of readyNodes) {
          const uri = provider.buildUri(pNode.id);
          const existing = await findExternalNodeByUri(uri, baseStore);
          if (existing) {
            if (!seenIds.has(existing.id)) {
              results.push(existing);
              seenIds.add(existing.id);
            }
          } else {
            const materialized = await materialization.materialize(uri, pNode, baseStore, {
              local: provider.local,
            });
            if (!seenIds.has(materialized.id)) {
              results.push(materialized);
              seenIds.add(materialized.id);
            }
          }
        }
      }

      // Apply global limit after aggregating across providers
      if (options?.limit && results.length > options.limit) {
        return results.slice(0, options.limit);
      }

      return results;
    },

    async taskAssign(
      idOrUri: string,
      assignee: string,
      options?: TaskTransitionOptions,
    ): Promise<Node> {
      const { provider, providerId } = await resolveTaskProvider(idOrUri);

      if (!provider.taskCapabilities.supportsAssignment || !provider.assignTask) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          `Provider ${provider.name} does not support task assignment`,
          provider.name,
        );
      }

      const updatedNode = await provider.assignTask(providerId, assignee, options?.context);

      // Native provider nodes already exist in the graph store — no materialization needed
      if (provider.name === 'native') {
        const node = await baseStore.getNode(updatedNode.id);
        if (!node) {
          throw new ProviderError('NOT_FOUND', `Node not found after assign: ${updatedNode.id}`);
        }
        return node;
      }

      const uri = provider.buildUri(updatedNode.id);
      return materialization.materialize(uri, updatedNode, baseStore, {
        local: provider.local,
      }) as Promise<Node>;
    },

    async taskValidActions(idOrUri: string): Promise<TaskAction[]> {
      const { provider, providerId } = await resolveTaskProvider(idOrUri);

      if (provider.validActions) {
        return provider.validActions(providerId);
      }

      // Fall back to the provider's declared capabilities
      return provider.taskCapabilities.actions;
    },
  };

  // ===========================================================================
  // Internal Helper: Resolve a task-capable provider for a given ID or URI
  // ===========================================================================

  async function resolveTaskProvider(idOrUri: string): Promise<{
    provider: Provider & import('../providers/traits/TaskManageable.js').TaskManageable;
    providerId: string;
  }> {
    // If it's a local ID, check if it's a provider-backed node
    if (isLocalId(idOrUri)) {
      const node = await baseStore.getNode(idOrUri);
      if (!node) {
        throw new ProviderError('NOT_FOUND', `Node not found: ${idOrUri}`);
      }
      const taskProviderUri = getProviderUri(node);
      if (taskProviderUri) {
        const provider = registry.resolveProvider(taskProviderUri);
        if (!provider) {
          throw new ProviderError('NOT_FOUND', `No provider found for URI: ${taskProviderUri}`);
        }
        if (!isTaskManageable(provider)) {
          throw new ProviderError(
            'NOT_SUPPORTED',
            `Provider ${provider.name} does not support task operations`,
            provider.name,
          );
        }
        const parsed = provider.parseUri(taskProviderUri);
        if (!parsed) {
          throw new ProviderError(
            'INVALID_URI',
            `Cannot parse URI: ${taskProviderUri}`,
            provider.name,
          );
        }
        return { provider, providerId: parsed.id };
      }
      // Local non-provider node — check native provider
      const nativeProvider = registry.get('native');
      if (!nativeProvider || !isTaskManageable(nativeProvider)) {
        throw new ProviderError(
          'NOT_SUPPORTED',
          'Native provider does not support task operations',
        );
      }
      return {
        provider: nativeProvider as Provider &
          import('../providers/traits/TaskManageable.js').TaskManageable,
        providerId: idOrUri,
      };
    }

    // Provider URI
    const provider = registry.resolveProvider(idOrUri);
    if (!provider) {
      throw new ProviderError('NOT_FOUND', `No provider found for: ${idOrUri}`);
    }
    if (!isTaskManageable(provider)) {
      throw new ProviderError(
        'NOT_SUPPORTED',
        `Provider ${provider.name} does not support task operations`,
        provider.name,
      );
    }
    const parsed = provider.parseUri(idOrUri);
    if (!parsed) {
      throw new ProviderError('INVALID_URI', `Cannot parse URI: ${idOrUri}`, provider.name);
    }
    return { provider, providerId: parsed.id };
  }

  // ===========================================================================
  // Internal Helper: Resolve any node by ID or URI (used by resolveNode and providerGet)
  // ===========================================================================

  async function resolveNodeInternal(
    idOrUri: string,
    options?: ResolveOptions,
    context?: ProviderOperationContext,
  ): Promise<Node | ProviderNode | null> {
    // 1. Check if local ID - use existing getNode
    if (isLocalId(idOrUri)) {
      return baseStore.getNode(idOrUri);
    }

    // 2. Check for cached materialized node (unless refresh requested)
    if (!options?.refresh) {
      const existing = await findExternalNodeByUri(idOrUri, baseStore);
      if (existing) {
        // Local-provider nodes (type !== 'external') are never stale
        if (existing.type !== 'external' || !materialization.isStale(existing as ExternalNode)) {
          return existing;
        }
      }
    }

    // 3. Find provider for this URI
    const provider = registry.resolveProvider(idOrUri);
    if (!provider) {
      return null;
    }

    // 4. Parse URI and fetch from provider
    const parsed = provider.parseUri(idOrUri);
    if (!parsed) {
      return null;
    }

    const providerNode = await provider.get(parsed.id, context);
    if (!providerNode) {
      return null;
    }

    // 5. Materialize if requested or per strategy
    const shouldMaterialize = materialization.shouldMaterialize(idOrUri, {
      accessType: 'resolve',
      explicit: options?.materialize,
    });

    if (shouldMaterialize) {
      return materialization.materialize(idOrUri, providerNode, baseStore, {
        local: provider.local,
      });
    }

    // Return provider node directly
    return providerNode as unknown as Node;
  }

  // ===========================================================================
  // Internal Helper: Resolve a node + its owning provider for write operations
  // ===========================================================================

  async function resolveForWrite(idOrUri: string): Promise<{
    node: Node;
    provider: Provider | null;
    isExternal: boolean;
  }> {
    // Case 1: Provider URI (e.g., sudocode://proj/i-456)
    if (!isLocalId(idOrUri)) {
      const provider = registry.resolveProvider(idOrUri);
      if (!provider) {
        throw new ProviderError('NOT_FOUND', `No provider found for: ${idOrUri}`);
      }

      // Check if we have a materialized copy
      const existing = await findExternalNodeByUri(idOrUri, baseStore);
      if (existing) {
        return { node: existing, provider, isExternal: true };
      }

      // No local copy — materialize first so we have a node to return
      const parsed = provider.parseUri(idOrUri);
      if (!parsed) {
        throw new ProviderError('INVALID_URI', `Cannot parse URI: ${idOrUri}`, provider.name);
      }

      const providerNode = await provider.get(parsed.id);
      if (!providerNode) {
        throw new ProviderError('NOT_FOUND', `Node not found: ${idOrUri}`, provider.name);
      }

      const materialized = await materialization.materialize(idOrUri, providerNode, baseStore, {
        local: provider.local,
      });
      return { node: materialized, provider, isExternal: true };
    }

    // Case 2: Local ID (s-abc1, i-def2, x-ghi3)
    const node = await baseStore.getNode(idOrUri);
    if (!node) {
      throw new ProviderError('NOT_FOUND', `Node not found: ${idOrUri}`);
    }

    // Check if it's a provider-backed node (external OR local-provider with metadata.provider_uri)
    const providerUri = getProviderUri(node);
    if (providerUri) {
      const provider = registry.resolveProvider(providerUri);
      return { node, provider, isExternal: true };
    }

    // Pure local node (no provider binding)
    return { node, provider: null, isExternal: false };
  }

  return providerStore;
}
