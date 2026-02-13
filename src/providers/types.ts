/**
 * Provider Types
 *
 * Type definitions for the provider system that enables OpenTasks
 * to connect with external task/issue systems.
 */

// ============================================================================
// Provider Capabilities
// ============================================================================

/**
 * Capabilities supported by a provider
 */
export interface ProviderCapabilities {
  /** Can read/fetch nodes */
  read: boolean

  /** Can create/update/delete nodes */
  write: boolean

  /** Can search nodes by query */
  search: boolean

  /** Can watch for changes */
  watch: boolean

  /** Can be used as a CRUD backend through OpenTasks' unified interface */
  mount: boolean

  /** Supports feedback/annotation natively (else falls back to local graph) */
  feedback: boolean
}

// ============================================================================
// URI Types
// ============================================================================

/**
 * Parsed URI structure
 */
export interface ParsedUri {
  /** URI scheme (e.g., 'beads', 'claude', 'native') */
  scheme: string

  /** Workspace identifier (e.g., '.', 'current', absolute path) */
  workspace?: string

  /** Node ID within the provider */
  id: string

  /** Whether the URI uses relative workspace reference */
  isRelative: boolean
}

/**
 * Options for building URIs
 */
export interface UriOptions {
  /** Workspace to include in URI */
  workspace?: string

  /** Use relative workspace (.) */
  relative?: boolean
}

// ============================================================================
// Provider Node Types
// ============================================================================

/**
 * Node type in provider context
 */
export type ProviderNodeType = 'spec' | 'issue' | 'task' | 'feedback' | 'external'

/**
 * Normalized node representation from a provider
 */
export interface ProviderNode {
  /** ID in provider's format */
  id: string

  /** Canonical URI */
  uri: string

  /** Node type equivalent */
  type: ProviderNodeType

  /** Display title */
  title: string

  /** Content/description */
  content?: string

  /** Provider-specific status */
  status?: string

  /** Priority (normalized 0-4) */
  priority?: number

  /** Raw data from provider */
  rawData?: Record<string, unknown>

  /** When this data was fetched (ISO 8601) */
  fetchedAt: string
}

// ============================================================================
// Operation Context
// ============================================================================

/**
 * Operational context passed to provider methods.
 *
 * Carries per-call operational overrides (cwd, timeout) and a freeform
 * extensions bag for provider-specific parameters. Providers read what
 * they need and ignore the rest.
 *
 * Designed as the forward-compatible seed for a full CallContext if
 * we later want namespaced extensions (extensions keyed by provider name).
 */
export interface ProviderOperationContext {
  /** Override the provider's default working directory */
  cwd?: string

  /** Override the provider's default timeout (ms) */
  timeout?: number

  /** Provider-specific extension parameters */
  extensions?: Record<string, unknown>
}

// ============================================================================
// CRUD Input Types
// ============================================================================

/**
 * Input for creating a new node via provider
 */
export interface ProviderCreateInput {
  /** Node type to create */
  type: 'spec' | 'issue'

  /** Node title */
  title: string

  /** Node content/description */
  content?: string

  /** Initial status */
  status?: string

  /** Priority (0-4) */
  priority?: number

  /** Additional metadata */
  metadata?: Record<string, unknown>

  /** Provider-specific data extensions (ignored by providers that don't understand them) */
  extensions?: Record<string, unknown>
}

/**
 * Input for updating a node via provider
 */
export interface ProviderUpdateInput {
  /** Updated title */
  title?: string

  /** Updated content */
  content?: string

  /** Updated status */
  status?: string

  /** Updated priority */
  priority?: number

  /** Additional metadata to merge */
  metadata?: Record<string, unknown>

  /** Provider-specific data extensions (ignored by providers that don't understand them) */
  extensions?: Record<string, unknown>
}

/**
 * Filter for listing nodes from provider
 */
export interface ProviderFilter {
  /** Filter by node type */
  type?: string

  /** Filter by status */
  status?: string

  /** Search query */
  search?: string

  /** Maximum results */
  limit?: number

  /** Pagination offset */
  offset?: number
}

// ============================================================================
// Watch Types
// ============================================================================

/**
 * Event emitted when a provider node changes
 */
export interface WatchEvent {
  /** Type of change */
  type: 'created' | 'updated' | 'deleted'

  /** ID of the affected node */
  nodeId: string

  /** Node data (not present for deletions) */
  node?: ProviderNode
}

/**
 * Callback for watch events
 */
export type WatchCallback = (event: WatchEvent) => void

/**
 * Function to unsubscribe from watch
 */
export type Unsubscribe = () => void

// ============================================================================
// Search Types
// ============================================================================

/**
 * Options for searching nodes
 */
export interface SearchOptions {
  /** Maximum results */
  limit?: number

  /** Filter by node type */
  type?: string
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Core provider interface
 *
 * Providers enable OpenTasks to connect with external task/issue systems.
 * Each provider handles a specific URI scheme and implements CRUD operations.
 */
export interface Provider {
  /** Provider identifier */
  readonly name: string

  /** URI schemes this provider handles (e.g., ['beads', 'bd']) */
  readonly schemes: string[]

  /** What operations this provider supports */
  readonly capabilities: ProviderCapabilities

  // ===========================================================================
  // URI Operations
  // ===========================================================================

  /**
   * Parse a URI string into its components
   * @returns Parsed URI or null if not valid for this provider
   */
  parseUri(uri: string): ParsedUri | null

  /**
   * Build a canonical URI for a node ID
   */
  buildUri(id: string, options?: UriOptions): string

  /**
   * Check if a URI is valid for this provider
   */
  isValidUri(uri: string): boolean

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Get a node by ID
   * @param context - Optional operational context (cwd override, timeout, extensions)
   * @returns Node data or null if not found
   */
  get(id: string, context?: ProviderOperationContext): Promise<ProviderNode | null>

  /**
   * List nodes with optional filtering
   * @param context - Optional operational context (cwd override, timeout, extensions)
   */
  list(filter?: ProviderFilter, context?: ProviderOperationContext): Promise<ProviderNode[]>

  /**
   * Create a new node
   * @param context - Optional operational context (cwd override, timeout, extensions)
   */
  create(input: ProviderCreateInput, context?: ProviderOperationContext): Promise<ProviderNode>

  /**
   * Update an existing node
   * @param context - Optional operational context (cwd override, timeout, extensions)
   */
  update(id: string, updates: ProviderUpdateInput, context?: ProviderOperationContext): Promise<ProviderNode>

  /**
   * Delete a node
   * @param context - Optional operational context (cwd override, timeout, extensions)
   */
  delete(id: string, context?: ProviderOperationContext): Promise<void>

  // ===========================================================================
  // Optional Operations
  // ===========================================================================

  /**
   * Search nodes by query string
   * Only available if capabilities.search is true
   */
  search?(query: string, options?: SearchOptions): Promise<ProviderNode[]>

  /**
   * Watch for changes to nodes
   * Only available if capabilities.watch is true
   */
  watch?(callback: WatchCallback): Unsubscribe
}

// ============================================================================
// Materialization Types
// ============================================================================

/**
 * Strategy for materializing external nodes
 */
export type MaterializationStrategy =
  | 'on-demand' // Only when explicitly requested
  | 'lazy' // On first access
  | 'eager' // When edge is created
  | 'none' // Never materialize, always fetch

/**
 * Configuration for node materialization
 */
export interface MaterializationConfig {
  /** Default strategy for all providers */
  default: MaterializationStrategy

  /** Per-provider strategy overrides */
  providers?: Record<string, MaterializationStrategy>

  /** Background sync interval in ms (0 to disable) */
  backgroundSyncInterval?: number

  /** Time in ms before cached data is considered stale */
  staleAfter?: number
}

/**
 * Default materialization configuration
 */
export const DEFAULT_MATERIALIZATION_CONFIG: MaterializationConfig = {
  default: 'on-demand',
  backgroundSyncInterval: 0,
  staleAfter: 5 * 60 * 1000, // 5 minutes
}

// ============================================================================
// Provider Registry Types
// ============================================================================

/**
 * Registry for managing providers
 */
export interface ProviderRegistry {
  /** Register a provider */
  register(provider: Provider): void

  /** Unregister a provider by name */
  unregister(name: string): void

  /** Get a provider by name */
  get(name: string): Provider | undefined

  /** Find provider that can handle a URI or ID */
  resolveProvider(idOrUri: string): Provider | null

  /** List all registered providers */
  list(): Provider[]

  /** Check if a URI/ID can be resolved */
  canResolve(idOrUri: string): boolean
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes for provider operations
 */
export type ProviderErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_URI'
  | 'OPERATION_FAILED'
  | 'NOT_SUPPORTED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'

/**
 * Error thrown by provider operations
 */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly provider?: string,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
