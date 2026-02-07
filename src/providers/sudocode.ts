/**
 * Sudocode Provider
 *
 * Provider that integrates with sudocode via CLI.
 * Handles sudocode:// and sc:// URI schemes.
 *
 * Sudocode is a git-native agent orchestration system that stores
 * specs, issues, and relationships in .sudocode/ (JSONL + SQLite).
 * This provider bridges sudocode data into the OpenTasks graph.
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderNodeType,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ParsedUri,
  UriOptions,
  SearchOptions,
} from './types.js'
import { ProviderError as ProviderErrorClass } from './types.js'
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
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from './traits/Watchable.js'

const execAsync = promisify(execCallback)

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Sudocode provider
 */
export interface SudocodeConfig {
  /** Path to sudocode executable (default: 'sudocode') */
  executable?: string

  /** Working directory for sudocode commands */
  cwd?: string

  /** Timeout for CLI commands in ms (default: 30000) */
  timeout?: number

  /**
   * Path to Sudocode data directory to watch for changes.
   * When set, enables the Watchable trait. The provider will
   * use chokidar to monitor this directory for file changes
   * and emit ProviderChangeEvents by diffing against cached state.
   *
   * Typically points to a `.sudocode/` directory.
   * If not set, watching is not available for this provider.
   */
  watchPath?: string

  /** Debounce delay for file watching in ms (default: 200) */
  watchDebounceMs?: number
}

/**
 * Raw Sudocode spec structure from CLI JSON output
 */
interface SudocodeSpec {
  id: string
  uuid?: string
  title: string
  content?: string
  priority?: number
  tags?: string[]
  archived?: boolean | number
  created_at?: string
  updated_at?: string
  parent_id?: string
  relationships?: SudocodeRelationship[]
  [key: string]: unknown
}

/**
 * Raw Sudocode issue structure from CLI JSON output
 */
interface SudocodeIssue {
  id: string
  uuid?: string
  title: string
  content?: string
  status?: string
  priority?: number
  assignee?: string
  tags?: string[]
  archived?: boolean | number
  created_at?: string
  updated_at?: string
  closed_at?: string
  parent_id?: string
  relationships?: SudocodeRelationship[]
  [key: string]: unknown
}

/**
 * Raw Sudocode relationship from JSONL
 */
interface SudocodeRelationship {
  from_id?: string
  from_uuid?: string
  from_type?: string
  to_id?: string
  to_uuid?: string
  to_type?: string
  relationship_type?: string
  created_at?: string
  metadata?: string
  [key: string]: unknown
}

/** Union type for spec or issue */
type SudocodeEntity = SudocodeSpec | SudocodeIssue

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for sudocode:// or sc:// URIs
 * Format: sudocode://[workspace/]id or sc://[workspace/]id
 */
const SUDOCODE_URI_PATTERN = /^(sudocode|sc):\/\/(?:([^/]+)\/)?(.+)$/i

/**
 * Pattern for Sudocode spec IDs (e.g., s-14sh, SPEC-001)
 */
const SPEC_ID_PATTERN = /^(?:s-[a-z0-9]+|SPEC-\d+)$/i

/**
 * Pattern for Sudocode issue IDs (e.g., i-x7k9, ISSUE-001)
 */
const ISSUE_ID_PATTERN = /^(?:i-[a-z0-9]+|ISSUE-\d+)$/i

/**
 * Pattern for any Sudocode entity ID
 */
const ENTITY_ID_PATTERN = /^(?:[si]-[a-z0-9]+|(?:SPEC|ISSUE)-\d+)$/i

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine entity type from ID prefix
 */
function entityTypeFromId(id: string): 'spec' | 'issue' {
  if (id.startsWith('s-') || id.toUpperCase().startsWith('SPEC-')) {
    return 'spec'
  }
  return 'issue'
}

/**
 * Map Sudocode node type to ProviderNodeType
 */
function mapNodeType(entityType: 'spec' | 'issue'): ProviderNodeType {
  return entityType
}

/**
 * Map Sudocode priority to normalized 0-4 scale
 */
function mapPriority(priority: number | undefined): number | undefined {
  if (priority === undefined) return undefined
  return Math.max(0, Math.min(4, priority))
}

/**
 * Map Sudocode relationship types to OpenTasks edge types
 */
function mapRelationshipType(relType: string): string {
  switch (relType.toLowerCase()) {
    case 'blocks':
      return 'blocks'
    case 'related':
      return 'related'
    case 'discovered-from':
      return 'discovered-from'
    case 'implements':
      return 'implements'
    case 'references':
      return 'references'
    case 'depends-on':
      return 'depends-on'
    default:
      return relType
  }
}

/**
 * Check if an entity is archived (handles both boolean and number)
 */
function isArchived(entity: SudocodeEntity): boolean {
  return entity.archived === true || entity.archived === 1
}

/**
 * Convert Sudocode spec to ProviderNode
 */
function specToProviderNode(spec: SudocodeSpec, workspace: string = '.'): ProviderNode {
  return {
    id: spec.id,
    uri: `sudocode://${workspace}/${spec.id}`,
    type: 'spec',
    title: spec.title,
    content: spec.content,
    status: isArchived(spec) ? 'archived' : 'active',
    priority: mapPriority(spec.priority),
    rawData: spec as unknown as Record<string, unknown>,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Convert Sudocode issue to ProviderNode
 */
function issueToProviderNode(issue: SudocodeIssue, workspace: string = '.'): ProviderNode {
  return {
    id: issue.id,
    uri: `sudocode://${workspace}/${issue.id}`,
    type: 'issue',
    title: issue.title,
    content: issue.content,
    status: issue.status,
    priority: mapPriority(issue.priority),
    rawData: issue as unknown as Record<string, unknown>,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Convert any Sudocode entity to ProviderNode
 */
function entityToProviderNode(entity: SudocodeEntity, workspace: string = '.'): ProviderNode {
  const entityType = entityTypeFromId(entity.id)
  if (entityType === 'spec') {
    return specToProviderNode(entity as SudocodeSpec, workspace)
  }
  return issueToProviderNode(entity as SudocodeIssue, workspace)
}

// ============================================================================
// Sudocode Provider Implementation
// ============================================================================

/**
 * Create a Sudocode provider with relationship querying and optional watching support
 */
export function createSudocodeProvider(
  config: SudocodeConfig = {}
): Provider & RelationshipQueryable & Partial<Watchable> {
  const executable = config.executable ?? 'sudocode'
  const cwd = config.cwd
  const timeout = config.timeout ?? 30000
  const watchPath = config.watchPath
  const watchDebounceMs = config.watchDebounceMs ?? 200

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: true,
    watch: !!watchPath,
  }

  // =========================================================================
  // Watch State (only active when watchPath is configured)
  // =========================================================================

  /** Cached content hashes for change diffing: entity id → hash of serialized data */
  const cachedHashes = new Map<string, string>()

  /** Cached edge signatures for edge change detection: "from:to:type" → true */
  const cachedEdgeKeys = new Set<string>()

  /** chokidar watcher instance */
  let fileWatcher: FSWatcher | null = null

  /** Current watch callback */
  let watchCallback: WatchChangeCallback | null = null

  /** Debounce timer for coalescing rapid file changes */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Simple hash for diffing (not cryptographic — just for detecting changes).
   */
  function quickHash(input: string): string {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  /**
   * Build a stable hash key for a Sudocode entity (substantive fields only)
   */
  function entityHashKey(entity: SudocodeEntity): string {
    const substantive = {
      title: entity.title,
      content: entity.content,
      status: 'status' in entity ? entity.status : undefined,
      priority: entity.priority,
      tags: entity.tags ? [...entity.tags].sort() : undefined,
      archived: entity.archived,
      parent_id: entity.parent_id,
    }
    return quickHash(JSON.stringify(substantive))
  }

  /**
   * Compute the set of edge keys from an entity's relationship fields
   */
  function entityEdgeKeys(entity: SudocodeEntity): Set<string> {
    const keys = new Set<string>()

    if (entity.relationships && Array.isArray(entity.relationships)) {
      for (const rel of entity.relationships) {
        if (rel.from_id && rel.to_id && rel.relationship_type) {
          const edgeType = mapRelationshipType(rel.relationship_type)
          keys.add(`${rel.from_id}:${rel.to_id}:${edgeType}`)
        }
      }
    }

    if (entity.parent_id) {
      keys.add(`${entity.parent_id}:${entity.id}:parent-of`)
    }

    return keys
  }

  /**
   * Diff current Sudocode state against cached hashes and emit change events.
   */
  async function diffAndEmit(): Promise<void> {
    if (!watchCallback) return

    try {
      // Fetch all entities
      const issues = await fetchEntities('issue')
      const specs = await fetchEntities('spec')
      const allEntities = [...issues, ...specs]

      const currentIds = new Set<string>()
      const currentEdgeKeys = new Set<string>()

      for (const entity of allEntities) {
        if (isArchived(entity)) {
          if (cachedHashes.has(entity.id)) {
            watchCallback({
              kind: 'node',
              event: {
                type: 'deleted',
                nodeId: entity.id,
                uri: `sudocode://./${entity.id}`,
                timestamp: new Date().toISOString(),
              },
            })
            cachedHashes.delete(entity.id)
          }
          continue
        }

        currentIds.add(entity.id)
        const hash = entityHashKey(entity)
        const prevHash = cachedHashes.get(entity.id)
        const providerNode = entityToProviderNode(entity)

        if (!prevHash) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'created',
              nodeId: entity.id,
              uri: providerNode.uri,
              node: providerNode,
              timestamp: new Date().toISOString(),
            },
          })
        } else if (prevHash !== hash) {
          const event: ProviderNodeChangeEvent = {
            type: 'updated',
            nodeId: entity.id,
            uri: providerNode.uri,
            node: providerNode,
            timestamp: new Date().toISOString(),
          }
          watchCallback({ kind: 'node', event })
        }

        cachedHashes.set(entity.id, hash)

        for (const key of entityEdgeKeys(entity)) {
          currentEdgeKeys.add(key)
        }
      }

      // Detect deleted entities
      for (const [id] of cachedHashes) {
        if (!currentIds.has(id)) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'deleted',
              nodeId: id,
              uri: `sudocode://./${id}`,
              timestamp: new Date().toISOString(),
            },
          })
          cachedHashes.delete(id)
        }
      }

      // Detect edge changes — new edges
      for (const key of currentEdgeKeys) {
        if (!cachedEdgeKeys.has(key)) {
          const [from, to, type] = key.split(':')
          const event: ProviderEdgeChangeEvent = {
            type: 'created',
            edge: { from, to, type },
            sourceUri: `sudocode://./${from}`,
            targetUri: `sudocode://./${to}`,
            timestamp: new Date().toISOString(),
          }
          watchCallback({ kind: 'edge', event })
        }
      }
      // Deleted edges
      for (const key of cachedEdgeKeys) {
        if (!currentEdgeKeys.has(key)) {
          const [from, to, type] = key.split(':')
          const event: ProviderEdgeChangeEvent = {
            type: 'deleted',
            edge: { from, to, type },
            sourceUri: `sudocode://./${from}`,
            targetUri: `sudocode://./${to}`,
            timestamp: new Date().toISOString(),
          }
          watchCallback({ kind: 'edge', event })
        }
      }

      // Update cached edge state
      cachedEdgeKeys.clear()
      for (const key of currentEdgeKeys) {
        cachedEdgeKeys.add(key)
      }
    } catch {
      // Resilient — log internally but don't crash the watcher
    }
  }

  /**
   * Handle a raw file change event with debouncing
   */
  function onFileChange(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void diffAndEmit()
    }, watchDebounceMs)
  }

  /**
   * Seed the cached hashes from current Sudocode state
   */
  async function seedCache(): Promise<void> {
    try {
      const issues = await fetchEntities('issue')
      const specs = await fetchEntities('spec')
      const allEntities = [...issues, ...specs]

      cachedHashes.clear()
      cachedEdgeKeys.clear()

      for (const entity of allEntities) {
        if (isArchived(entity)) continue

        cachedHashes.set(entity.id, entityHashKey(entity))
        for (const key of entityEdgeKeys(entity)) {
          cachedEdgeKeys.add(key)
        }
      }
    } catch {
      // If we can't seed, first diff will treat everything as 'created'
    }
  }

  /**
   * Shell-escape a single argument
   */
  function shellEscape(arg: string): string {
    if (/['\s"\\$`!]/.test(arg)) {
      return `'${arg.replace(/'/g, "'\\''")}'`
    }
    return arg
  }

  /**
   * Execute a sudocode CLI command
   */
  async function execSudocode(args: string[]): Promise<string> {
    const command = [executable, ...args.map(shellEscape)].join(' ')

    try {
      const { stdout } = await execAsync(command, {
        cwd,
        timeout,
        env: { ...process.env },
      })
      return stdout.trim()
    } catch (error) {
      const err = error as {
        code?: string | number
        message?: string
        killed?: boolean
        stdout?: string
        stderr?: string
      }

      if (err.code === 'ENOENT') {
        throw new ProviderErrorClass(
          'PROVIDER_ERROR',
          `Sudocode CLI not found: ${executable}`,
          'sudocode'
        )
      }

      if (err.killed) {
        throw new ProviderErrorClass('TIMEOUT', `Command timed out: ${command}`, 'sudocode')
      }

      let errorMessage = err.message ?? 'Unknown error'
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout)
          if (parsed.error) {
            errorMessage = parsed.error
          }
        } catch {
          if (err.stdout.trim()) {
            errorMessage = err.stdout.trim()
          }
        }
      }

      throw new ProviderErrorClass(
        'OPERATION_FAILED',
        `Sudocode CLI error: ${errorMessage}`,
        'sudocode',
        error instanceof Error ? error : undefined
      )
    }
  }

  /**
   * Parse JSON output from sudocode CLI
   */
  function parseJson<T>(output: string): T {
    try {
      return JSON.parse(output) as T
    } catch {
      throw new ProviderErrorClass(
        'PROVIDER_ERROR',
        'Failed to parse Sudocode CLI output as JSON',
        'sudocode'
      )
    }
  }

  /**
   * Fetch entities of a given type from sudocode CLI
   */
  async function fetchEntities(type: 'spec' | 'issue'): Promise<SudocodeEntity[]> {
    const subcommand = type === 'spec' ? 'spec' : 'issue'
    const output = await execSudocode([subcommand, 'list', '--json'])
    return parseJson<SudocodeEntity[]>(output)
  }

  return {
    name: 'sudocode',
    schemes: ['sudocode', 'sc'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for sudocode:// or sc:// URI
      const match = uri.match(SUDOCODE_URI_PATTERN)
      if (match) {
        const scheme = match[1].toLowerCase()
        const workspace = match[2] || '.'
        const id = match[3]
        return {
          scheme,
          workspace,
          id,
          isRelative: workspace === '.',
        }
      }

      // Check for bare Sudocode entity ID
      if (ENTITY_ID_PATTERN.test(uri)) {
        return {
          scheme: 'sudocode',
          workspace: '.',
          id: uri,
          isRelative: true,
        }
      }

      return null
    },

    buildUri(id: string, options?: UriOptions): string {
      const workspace = options?.workspace ?? '.'
      if (options?.relative) {
        return id
      }
      return `sudocode://${workspace}/${id}`
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string): Promise<ProviderNode | null> {
      const parsed = this.parseUri(id)
      const entityId = parsed?.id ?? id
      const workspace = parsed?.workspace ?? '.'
      const entityType = entityTypeFromId(entityId)
      const subcommand = entityType === 'spec' ? 'spec' : 'issue'

      try {
        const output = await execSudocode([subcommand, 'show', entityId, '--json'])
        const entity = parseJson<SudocodeEntity>(output)
        if (!entity) {
          return null
        }
        return entityToProviderNode(entity, workspace)
      } catch (error) {
        if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
          const message = error.message.toLowerCase()
          if (
            message.includes('not found') ||
            message.includes('does not exist') ||
            message.includes('no issue found') ||
            message.includes('no spec found')
          ) {
            return null
          }
        }
        throw error
      }
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      const results: ProviderNode[] = []
      const entityTypes: Array<'spec' | 'issue'> =
        filter?.type === 'spec' ? ['spec'] :
          filter?.type === 'issue' ? ['issue'] :
            ['issue', 'spec']

      for (const entityType of entityTypes) {
        const subcommand = entityType === 'spec' ? 'spec' : 'issue'
        const args = [subcommand, 'list', '--json']

        if (filter?.status) {
          args.push('--status', filter.status)
        }

        try {
          const output = await execSudocode(args)
          const entities = parseJson<SudocodeEntity[]>(output)

          for (const entity of entities) {
            if (!isArchived(entity)) {
              results.push(entityToProviderNode(entity))
            }
          }
        } catch {
          // If one type fails (e.g., no specs), continue with the other
        }
      }

      // Apply limit after combining
      if (filter?.limit && results.length > filter.limit) {
        return results.slice(0, filter.limit)
      }

      return results
    },

    async create(input: ProviderCreateInput): Promise<ProviderNode> {
      const entityType = input.type === 'spec' ? 'spec' : 'issue'
      const subcommand = entityType === 'spec' ? 'spec' : 'issue'
      const args = [subcommand, 'create', '--title', input.title]

      if (input.content) {
        args.push('--content', input.content)
      }
      if (input.status && entityType === 'issue') {
        args.push('--status', input.status)
      }
      if (input.priority !== undefined) {
        args.push('--priority', String(input.priority))
      }

      args.push('--json')

      const output = await execSudocode(args)
      const entity = parseJson<SudocodeEntity>(output)

      return entityToProviderNode(entity)
    },

    async update(id: string, updates: ProviderUpdateInput): Promise<ProviderNode> {
      const parsed = this.parseUri(id)
      const entityId = parsed?.id ?? id
      const entityType = entityTypeFromId(entityId)
      const subcommand = entityType === 'spec' ? 'spec' : 'issue'

      const args = [subcommand, 'update', entityId]

      if (updates.title) {
        args.push('--title', updates.title)
      }
      if (updates.content) {
        args.push('--content', updates.content)
      }
      if (updates.status && entityType === 'issue') {
        args.push('--status', updates.status)
      }
      if (updates.priority !== undefined) {
        args.push('--priority', String(updates.priority))
      }

      args.push('--json')

      const output = await execSudocode(args)
      const entity = parseJson<SudocodeEntity>(output)

      return entityToProviderNode(entity)
    },

    async delete(id: string): Promise<void> {
      const parsed = this.parseUri(id)
      const entityId = parsed?.id ?? id
      const entityType = entityTypeFromId(entityId)
      const subcommand = entityType === 'spec' ? 'spec' : 'issue'

      await execSudocode([subcommand, 'delete', entityId, '--force'])
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      const results: ProviderNode[] = []
      const entityTypes: Array<'spec' | 'issue'> =
        options?.type === 'spec' ? ['spec'] :
          options?.type === 'issue' ? ['issue'] :
            ['issue', 'spec']

      for (const entityType of entityTypes) {
        const subcommand = entityType === 'spec' ? 'spec' : 'issue'
        const args = [subcommand, 'list', '--json', '--search', query]

        try {
          const output = await execSudocode(args)
          const entities = parseJson<SudocodeEntity[]>(output)

          for (const entity of entities) {
            if (!isArchived(entity)) {
              results.push(entityToProviderNode(entity))
            }
          }
        } catch {
          // If search fails for one type, continue with the other
        }
      }

      if (options?.limit && results.length > options.limit) {
        return results.slice(0, options.limit)
      }

      return results
    },

    // =========================================================================
    // RelationshipQueryable Implementation
    // =========================================================================

    async queryEdges(nodeId: string, options?: QueryEdgesOptions): Promise<ProviderEdge[]> {
      const parsed = this.parseUri(nodeId)
      const entityId = parsed?.id ?? nodeId
      const entityType = entityTypeFromId(entityId)
      const subcommand = entityType === 'spec' ? 'spec' : 'issue'

      try {
        const output = await execSudocode([subcommand, 'show', entityId, '--json'])
        const entity = parseJson<SudocodeEntity>(output)
        if (!entity) {
          return []
        }

        let edges: ProviderEdge[] = []

        // Extract relationships from the entity
        if (entity.relationships && Array.isArray(entity.relationships)) {
          for (const rel of entity.relationships) {
            if (rel.from_id && rel.to_id && rel.relationship_type) {
              edges.push({
                from: rel.from_id,
                to: rel.to_id,
                type: mapRelationshipType(rel.relationship_type),
              })
            }
          }
        }

        // Parent-child relationship
        if (entity.parent_id) {
          edges.push({ from: entity.parent_id, to: entityId, type: 'parent-of' })
        }

        // Deduplicate edges
        const seen = new Set<string>()
        edges = edges.filter((edge) => {
          const key = `${edge.from}:${edge.to}:${edge.type}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })

        // Apply filters
        if (options?.edgeType) {
          edges = filterEdgesByType(edges, options.edgeType)
        }
        if (options?.direction) {
          edges = filterEdgesByDirection(edges, entityId, options.direction)
        }
        if (options?.limit && edges.length > options.limit) {
          edges = edges.slice(0, options.limit)
        }

        return edges
      } catch (error) {
        if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
          const message = error.message.toLowerCase()
          if (
            message.includes('not found') ||
            message.includes('does not exist') ||
            message.includes('no issue found') ||
            message.includes('no spec found')
          ) {
            return []
          }
        }
        throw error
      }
    },

    supportedEdgeTypes(): EdgeTypeSupport[] {
      return [
        { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
        { type: 'related', canQuery: true, canCreate: true, canDelete: true },
        { type: 'discovered-from', canQuery: true, canCreate: true, canDelete: true },
        { type: 'implements', canQuery: true, canCreate: true, canDelete: true },
        { type: 'references', canQuery: true, canCreate: true, canDelete: true },
        { type: 'depends-on', canQuery: true, canCreate: true, canDelete: true },
        { type: 'parent-of', canQuery: true, canCreate: false, canDelete: false },
      ]
    },

    // =========================================================================
    // Watchable Implementation (only functional when watchPath is configured)
    // =========================================================================

    watchGranularity: {
      reportsChangedFields: false,
      reportsPreviousValues: false,
      reportsEdgeChanges: true,
      mechanism: 'file-watch' as const,
    } satisfies WatchGranularity,

    startWatching(callback: WatchChangeCallback): void {
      if (!watchPath) {
        return
      }

      watchCallback = callback

      if (fileWatcher) {
        return // Already watching, just updated callback
      }

      void seedCache().then(() => {
        if (!watchCallback) return

        fileWatcher = chokidar.watch(watchPath, {
          ignoreInitial: true,
          persistent: true,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 20,
          },
        })

        fileWatcher.on('add', onFileChange)
        fileWatcher.on('change', onFileChange)
        fileWatcher.on('unlink', onFileChange)

        fileWatcher.on('error', () => {
          // Resilient — continue watching despite transient errors
        })
      })
    },

    stopWatching(): void {
      watchCallback = null

      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      if (fileWatcher) {
        void fileWatcher.close()
        fileWatcher = null
      }
    },

    get isWatching(): boolean {
      return fileWatcher !== null && watchCallback !== null
    },
  }
}
