/**
 * Native Provider
 *
 * Provider that wraps existing GraphStore node operations.
 * Handles native:// and opentasks:// URI schemes.
 */

import * as fs from 'node:fs'
import type { GraphStore, NodeFilter as GraphNodeFilter } from '../graph/index.js'
import type { Node, EdgeType } from '../schema/index.js'
import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderNodeType,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ProviderOperationContext,
  ParsedUri,
  UriOptions,
  SearchOptions,
} from './types.js'
import type {
  RelationshipQueryable,
  ProviderEdge,
  QueryEdgesOptions,
} from './traits/RelationshipQueryable.js'
import {
  filterEdgesByType,
  filterEdgesByDirection,
} from './traits/RelationshipQueryable.js'
import type { EdgeTypeSupport } from '../graph/EdgeTypeRegistry.js'
import type {
  Watchable,
  WatchGranularity,
  WatchChangeCallback,
} from './traits/Watchable.js'
import type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
  ReadyTaskOptions,
} from './traits/TaskManageable.js'
import { ProviderError as ProviderErrorClass } from './types.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (s-, i-, f-, e-, x-)
 */
const LOCAL_ID_PATTERN = /^[sifex]-[a-z0-9]+$/

/**
 * Pattern for native:// or opentasks:// URIs
 */
const NATIVE_URI_PATTERN = /^(native|opentasks):\/\/(.+)$/i

// ============================================================================
// Type Conversion
// ============================================================================

/**
 * Map OpenTasks node types to provider node types
 */
function mapNodeType(nodeType: string): ProviderNodeType {
  switch (nodeType) {
    case 'spec':
      return 'spec'
    case 'issue':
      return 'issue'
    case 'feedback':
      return 'feedback'
    case 'external':
      return 'external'
    default:
      return 'external'
  }
}

/**
 * Map provider node types to OpenTasks node types
 */
function mapProviderType(providerType: string): 'spec' | 'issue' | 'feedback' | 'external' {
  switch (providerType) {
    case 'spec':
      return 'spec'
    case 'issue':
    case 'task':
      return 'issue'
    case 'feedback':
      return 'feedback'
    default:
      return 'external'
  }
}

/**
 * Convert a Node to ProviderNode
 */
function nodeToProviderNode(node: Node): ProviderNode {
  return {
    id: node.id,
    uri: `native://${node.id}`,
    type: mapNodeType(node.type),
    title: node.title,
    content: node.content,
    status: 'status' in node ? (node.status as string) : undefined,
    priority: node.priority,
    rawData: {
      uuid: node.uuid,
      created_at: node.created_at,
      updated_at: node.updated_at,
      tags: node.tags,
      parent_id: node.parent_id,
      archived: node.archived,
      metadata: node.metadata,
      // Type-specific fields
      ...('assignee' in node ? { assignee: node.assignee } : {}),
      ...('target_id' in node ? { target_id: node.target_id } : {}),
      ...('feedback_type' in node ? { feedback_type: node.feedback_type } : {}),
      ...('uri' in node ? { external_uri: node.uri } : {}),
      ...('source' in node ? { source: node.source } : {}),
    },
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Convert ProviderFilter to GraphStore NodeFilter
 */
function convertFilter(filter?: ProviderFilter): GraphNodeFilter | undefined {
  if (!filter) return undefined

  return {
    type: filter.type as GraphNodeFilter['type'],
    status: filter.status,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  }
}

// ============================================================================
// Native Provider Configuration
// ============================================================================

/**
 * Configuration for the native provider
 */
export interface NativeProviderConfig {
  /**
   * Path to the JSONL file to watch for external changes.
   * When set, enables the Watchable trait. The provider will
   * use fs.watch to detect modifications and diff node hashes.
   *
   * Typically set to the `graph.jsonl` path inside `.opentasks/`.
   */
  watchPath?: string

  /** Debounce delay for file watching in ms (default: 150) */
  watchDebounceMs?: number
}

// ============================================================================
// Native Provider Implementation
// ============================================================================

/**
 * Create a native provider wrapping a GraphStore with relationship querying support
 * and optional file-watching via the Watchable trait.
 */
export function createNativeProvider(
  store: GraphStore,
  config?: NativeProviderConfig
): Provider & RelationshipQueryable & Partial<Watchable> & TaskManageable {
  const watchPath = config?.watchPath
  const watchDebounceMs = config?.watchDebounceMs ?? 150

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: true,
    watch: !!watchPath,
    mount: true,
    feedback: true,
  }

  // =========================================================================
  // Watch State
  // =========================================================================

  /** Cached content hashes: node id → hash of title+content+status+priority */
  const cachedHashes = new Map<string, string>()

  /** fs.watch instance */
  let fsWatcher: fs.FSWatcher | null = null

  /** Current watch callback */
  let watchCallback: WatchChangeCallback | null = null

  /** Debounce timer */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** Simple hash for diffing */
  function quickHash(input: string): string {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  function nodeHash(node: Node): string {
    const substantive = {
      type: node.type,
      title: node.title,
      content: node.content,
      status: 'status' in node ? node.status : undefined,
      priority: node.priority,
      tags: node.tags ? [...node.tags].sort() : undefined,
    }
    return quickHash(JSON.stringify(substantive))
  }

  /**
   * Diff current GraphStore state against cached hashes and emit events.
   */
  async function diffAndEmit(): Promise<void> {
    if (!watchCallback) return

    try {
      const nodes = await store.query.nodes({})
      const currentIds = new Set<string>()

      for (const node of nodes) {
        currentIds.add(node.id)
        const hash = nodeHash(node)
        const prevHash = cachedHashes.get(node.id)
        const providerNode = nodeToProviderNode(node)

        if (!prevHash) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'created',
              nodeId: node.id,
              uri: `native://${node.id}`,
              node: providerNode,
              timestamp: new Date().toISOString(),
            },
          })
        } else if (prevHash !== hash) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'updated',
              nodeId: node.id,
              uri: `native://${node.id}`,
              node: providerNode,
              timestamp: new Date().toISOString(),
            },
          })
        }

        cachedHashes.set(node.id, hash)
      }

      // Detect deletes
      for (const [id] of cachedHashes) {
        if (!currentIds.has(id)) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'deleted',
              nodeId: id,
              uri: `native://${id}`,
              timestamp: new Date().toISOString(),
            },
          })
          cachedHashes.delete(id)
        }
      }
    } catch {
      // Resilient — continue watching
    }
  }

  function onFileChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void diffAndEmit()
    }, watchDebounceMs)
  }

  async function seedCache(): Promise<void> {
    try {
      const nodes = await store.query.nodes({})
      cachedHashes.clear()
      for (const node of nodes) {
        cachedHashes.set(node.id, nodeHash(node))
      }
    } catch {
      // If we can't seed, first diff emits everything as 'created'
    }
  }

  return {
    name: 'native',
    schemes: ['native', 'opentasks'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for native:// or opentasks:// URI
      const uriMatch = uri.match(NATIVE_URI_PATTERN)
      if (uriMatch) {
        const scheme = uriMatch[1].toLowerCase()
        const id = uriMatch[2]
        return {
          scheme,
          id,
          isRelative: false,
        }
      }

      // Check for local ID (s-abc1, i-xyz2, etc.)
      if (LOCAL_ID_PATTERN.test(uri)) {
        return {
          scheme: 'native',
          id: uri,
          isRelative: true,
        }
      }

      return null
    },

    buildUri(id: string, options?: UriOptions): string {
      if (options?.relative) {
        return id
      }
      return `native://${id}`
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string, _context?: ProviderOperationContext): Promise<ProviderNode | null> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      const node = await store.getNode(nodeId)
      if (!node) return null

      return nodeToProviderNode(node)
    },

    async list(filter?: ProviderFilter, _context?: ProviderOperationContext): Promise<ProviderNode[]> {
      const graphFilter = convertFilter(filter) ?? {}
      const nodes = await store.query.nodes(graphFilter)
      return nodes.map(nodeToProviderNode)
    },

    async create(input: ProviderCreateInput, _context?: ProviderOperationContext): Promise<ProviderNode> {
      const nodeType = mapProviderType(input.type)

      const node = await store.createNode({
        type: nodeType,
        title: input.title,
        content: input.content,
        status: input.status,
        priority: input.priority,
        metadata: input.metadata,
      })

      return nodeToProviderNode(node)
    },

    async update(id: string, updates: ProviderUpdateInput, _context?: ProviderOperationContext): Promise<ProviderNode> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      const node = await store.updateNode(nodeId, {
        title: updates.title,
        content: updates.content,
        status: updates.status,
        priority: updates.priority,
        metadata: updates.metadata,
      })

      return nodeToProviderNode(node)
    },

    async delete(id: string, _context?: ProviderOperationContext): Promise<void> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      await store.deleteNode(nodeId)
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      const filter: GraphNodeFilter = {
        search: query,
        limit: options?.limit,
        type: options?.type as GraphNodeFilter['type'],
      }

      const nodes = await store.query.nodes(filter)
      return nodes.map(nodeToProviderNode)
    },

    // =========================================================================
    // RelationshipQueryable Implementation
    // =========================================================================

    async queryEdges(nodeId: string, options?: QueryEdgesOptions): Promise<ProviderEdge[]> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(nodeId)
      const localId = parsed?.id ?? nodeId

      // Check if node exists
      const node = await store.getNode(localId)
      if (!node) {
        return []
      }

      // Determine which edges to fetch based on direction
      const direction = options?.direction ?? 'both'
      const edgeType = options?.edgeType as EdgeType | undefined

      let edges: ProviderEdge[] = []

      if (direction === 'out' || direction === 'both') {
        const outEdges = await store.query.edgesFrom(localId, edgeType)
        for (const edge of outEdges) {
          edges.push({
            from: edge.from_id,
            to: edge.to_id,
            type: edge.type,
            metadata: edge.metadata,
          })
        }
      }

      if (direction === 'in' || direction === 'both') {
        const inEdges = await store.query.edgesTo(localId, edgeType)
        for (const edge of inEdges) {
          edges.push({
            from: edge.from_id,
            to: edge.to_id,
            type: edge.type,
            metadata: edge.metadata,
          })
        }
      }

      // Deduplicate edges (in case of 'both' direction)
      if (direction === 'both') {
        const seen = new Set<string>()
        edges = edges.filter((e) => {
          const key = `${e.from}:${e.to}:${e.type}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }

      // Apply additional filters if specified (when direction was used to fetch)
      if (options?.edgeType && !edgeType) {
        edges = filterEdgesByType(edges, options.edgeType)
      }
      if (options?.direction && options.direction !== 'both') {
        edges = filterEdgesByDirection(edges, localId, options.direction)
      }

      // Apply limit
      if (options?.limit && edges.length > options.limit) {
        edges = edges.slice(0, options.limit)
      }

      return edges
    },

    supportedEdgeTypes(): EdgeTypeSupport[] {
      // NativeProvider supports all built-in edge types with full capabilities
      return [
        { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
        { type: 'blocked-by', canQuery: true, canCreate: true, canDelete: true },
        { type: 'implements', canQuery: true, canCreate: true, canDelete: true },
        { type: 'parent-of', canQuery: true, canCreate: true, canDelete: true },
        { type: 'child-of', canQuery: true, canCreate: true, canDelete: true },
        { type: 'discovered-from', canQuery: true, canCreate: true, canDelete: true },
        { type: 'related', canQuery: true, canCreate: true, canDelete: true },
        { type: 'references', canQuery: true, canCreate: true, canDelete: true },
        { type: 'depends-on', canQuery: true, canCreate: true, canDelete: true },
        { type: 'dependency-of', canQuery: true, canCreate: true, canDelete: true },
        { type: 'duplicates', canQuery: true, canCreate: true, canDelete: true },
        { type: 'supersedes', canQuery: true, canCreate: true, canDelete: true },
      ]
    },

    // =========================================================================
    // Watchable Implementation (only functional when watchPath is configured)
    // =========================================================================

    watchGranularity: {
      // Native provider diffs node hashes — knows which nodes changed
      // but doesn't track individual fields or edge changes separately.
      reportsChangedFields: false,
      reportsPreviousValues: false,
      reportsEdgeChanges: false,
      mechanism: 'file-watch' as const,
    } satisfies WatchGranularity,

    startWatching(callback: WatchChangeCallback): void {
      if (!watchPath) return

      watchCallback = callback

      if (fsWatcher) return // Already watching

      void seedCache().then(() => {
        if (!watchCallback) return

        try {
          fsWatcher = fs.watch(watchPath, (eventType: string) => {
            if (eventType === 'change') {
              onFileChange()
            }
          })

          fsWatcher.on('error', () => {
            // Resilient — continue
          })
        } catch {
          // File might not exist yet
        }
      })
    },

    stopWatching(): void {
      watchCallback = null

      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      if (fsWatcher) {
        fsWatcher.close()
        fsWatcher = null
      }
    },

    get isWatching(): boolean {
      return fsWatcher !== null && watchCallback !== null
    },

    // =========================================================================
    // TaskManageable Implementation
    // =========================================================================

    taskCapabilities: {
      actions: ['start', 'complete', 'block', 'reopen', 'close'],
      supportsAssignment: true,
      supportsReadyQuery: true,
      statusModel: ['open', 'in_progress', 'blocked', 'closed'],
    } satisfies TaskCapabilities,

    async transitionTask(
      id: string,
      action: TaskAction,
      _context?: ProviderOperationContext
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      const node = await store.getNode(nodeId)
      if (!node) {
        throw new ProviderErrorClass('NOT_FOUND', `Node not found: ${nodeId}`, 'native')
      }
      if (node.type !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot transition ${node.type} node ${nodeId} — only issues support task lifecycle`,
          'native'
        )
      }

      const statusMap: Record<TaskAction, string> = {
        start: 'in_progress',
        complete: 'closed',
        block: 'blocked',
        reopen: 'open',
        close: 'closed',
      }

      const targetStatus = statusMap[action]
      if (!targetStatus) {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Unsupported task action: ${action}`,
          'native'
        )
      }

      const updates: Record<string, unknown> = { status: targetStatus }

      const updated = await store.updateNode(nodeId, updates)
      return nodeToProviderNode(updated)
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      _context?: ProviderOperationContext
    ): Promise<ProviderNode[]> {
      // Delegate to the existing query engine's ready() method
      const readyIssues = await store.query.ready({
        tags: options?.tags,
        priority: options?.priority,
        assignee: options?.assignee,
        limit: options?.limit,
      })

      return readyIssues.map(nodeToProviderNode)
    },

    async assignTask(
      id: string,
      assignee: string,
      _context?: ProviderOperationContext
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      const node = await store.getNode(nodeId)
      if (!node) {
        throw new ProviderErrorClass('NOT_FOUND', `Node not found: ${nodeId}`, 'native')
      }
      if (node.type !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot assign ${node.type} node ${nodeId} — only issues support assignment`,
          'native'
        )
      }

      const updated = await store.updateNode(nodeId, { assignee })
      return nodeToProviderNode(updated)
    },

    async validActions(
      id: string,
      _context?: ProviderOperationContext
    ): Promise<TaskAction[]> {
      const parsed = this.parseUri(id)
      const nodeId = parsed?.id ?? id

      const node = await store.getNode(nodeId)
      if (!node) {
        throw new ProviderErrorClass('NOT_FOUND', `Node not found: ${nodeId}`, 'native')
      }
      if (node.type !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot query actions for ${node.type} node ${nodeId} — only issues support task lifecycle`,
          'native'
        )
      }

      const status = 'status' in node ? (node.status as string) : undefined
      switch (status) {
        case 'open':
          return ['start', 'block', 'close']
        case 'in_progress':
          return ['complete', 'block', 'close']
        case 'blocked':
          return ['reopen', 'close']
        case 'closed':
          return ['reopen']
        default:
          return ['start', 'complete', 'block', 'reopen', 'close']
      }
    },
  }
}
