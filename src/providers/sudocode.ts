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

import { exec as execCallback } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ProviderOperationContext,
  ParsedUri,
  UriOptions,
  SearchOptions,
} from './types.js';
import { ProviderError as ProviderErrorClass } from './types.js';
import type {
  RelationshipQueryable,
  ProviderEdge,
  QueryEdgesOptions,
} from './traits/RelationshipQueryable.js';
import { filterEdgesByType, filterEdgesByDirection } from './traits/RelationshipQueryable.js';
import type { EdgeTypeSupport } from '../graph/EdgeTypeRegistry.js';
import type {
  Watchable,
  WatchGranularity,
  WatchChangeCallback,
  ProviderNodeChangeEvent,
  ProviderEdgeChangeEvent,
} from './traits/Watchable.js';
import type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
  ReadyTaskOptions,
} from './traits/TaskManageable.js';

const execAsync = promisify(execCallback);

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Sudocode provider
 */
export interface SudocodeConfig {
  /** Path to sudocode executable (default: 'sudocode') */
  executable?: string;

  /** Working directory for sudocode commands */
  cwd?: string;

  /** Timeout for CLI commands in ms (default: 30000) */
  timeout?: number;

  /**
   * Extra global flags passed to every sudocode command invocation.
   * Useful for environments that need specific flags.
   *
   * @example ['--no-daemon'] or ['--verbose']
   */
  extraArgs?: string[];

  /**
   * Path to Sudocode data directory to watch for changes.
   * When set, enables the Watchable trait. The provider will
   * use chokidar to monitor this directory for file changes
   * and emit ProviderChangeEvents by diffing against cached state.
   *
   * Typically points to a `.sudocode/` directory.
   * If not set, watching is not available for this provider.
   */
  watchPath?: string;

  /** Debounce delay for file watching in ms (default: 200) */
  watchDebounceMs?: number;
}

/**
 * Raw Sudocode spec structure from CLI JSON output
 */
interface SudocodeSpec {
  id: string;
  uuid?: string;
  title: string;
  content?: string;
  priority?: number;
  tags?: string[];
  archived?: boolean | number;
  created_at?: string;
  updated_at?: string;
  parent_id?: string;
  relationships?: SudocodeRelationships;
  [key: string]: unknown;
}

/**
 * Raw Sudocode issue structure from CLI JSON output
 */
interface SudocodeIssue {
  id: string;
  uuid?: string;
  title: string;
  content?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  tags?: string[];
  archived?: boolean | number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  parent_id?: string;
  relationships?: SudocodeRelationships;
  [key: string]: unknown;
}

/**
 * Raw Sudocode relationship.
 *
 * Two formats exist depending on the source:
 * - `show --json`: uses `from_id`/`to_id`/`relationship_type` in nested `{ outgoing, incoming }`
 * - JSONL files:   uses `from`/`to`/`type` in a flat array
 *
 * Both field sets are optional here so a single type handles either format.
 */
interface SudocodeRelationship {
  // show --json fields
  from_id?: string;
  from_uuid?: string;
  from_type?: string;
  to_id?: string;
  to_uuid?: string;
  to_type?: string;
  relationship_type?: string;
  // JSONL fields
  from?: string;
  to?: string;
  type?: string;
  // common
  created_at?: string;
  metadata?: string;
  [key: string]: unknown;
}

/**
 * Relationships may appear in two shapes:
 * - Nested `{ outgoing, incoming }` from `show --json`
 * - Flat `SudocodeRelationship[]` from JSONL files
 */
type SudocodeRelationships =
  | { outgoing?: SudocodeRelationship[]; incoming?: SudocodeRelationship[] }
  | SudocodeRelationship[];

/** Union type for spec or issue */
type SudocodeEntity = SudocodeSpec | SudocodeIssue;

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for sudocode:// or sc:// URIs
 * Format: sudocode://[workspace/]id or sc://[workspace/]id
 */
const SUDOCODE_URI_PATTERN = /^(sudocode|sc):\/\/(?:([^/]+)\/)?(.+)$/i;

/**
 * Pattern for Sudocode spec IDs (e.g., s-14sh, SPEC-001)
 */
const SPEC_ID_PATTERN = /^(?:s-[a-z0-9]+|SPEC-\d+)$/i;

/**
 * Pattern for Sudocode issue IDs (e.g., i-x7k9, ISSUE-001)
 */
const ISSUE_ID_PATTERN = /^(?:i-[a-z0-9]+|ISSUE-\d+)$/i;

/**
 * Pattern for any Sudocode entity ID
 */
const ENTITY_ID_PATTERN = /^(?:[si]-[a-z0-9]+|(?:SPEC|ISSUE)-\d+)$/i;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine entity type from ID prefix
 */
function entityTypeFromId(id: string): 'spec' | 'issue' {
  if (id.startsWith('s-') || id.toUpperCase().startsWith('SPEC-')) {
    return 'spec';
  }
  return 'issue';
}

/**
 * Valid task actions for each status state
 */
function validActionsForStatus(status: string): TaskAction[] {
  switch (status) {
    case 'open':
      return ['start', 'block', 'close'];
    case 'in_progress':
      return ['complete', 'block', 'close'];
    case 'blocked':
      return ['reopen', 'close'];
    case 'closed':
      return ['reopen'];
    default:
      return ['start', 'complete', 'block', 'reopen', 'close'];
  }
}

/**
 * Map Sudocode priority to normalized 0-4 scale
 */
function mapPriority(priority: number | undefined): number | undefined {
  if (priority === undefined) return undefined;
  return Math.max(0, Math.min(4, priority));
}

/**
 * Map Sudocode relationship types to OpenTasks edge types
 */
function mapRelationshipType(relType: string): string {
  switch (relType.toLowerCase()) {
    case 'blocks':
      return 'blocks';
    case 'related':
      return 'related';
    case 'discovered-from':
      return 'discovered-from';
    case 'implements':
      return 'implements';
    case 'references':
      return 'references';
    case 'depends-on':
      return 'depends-on';
    default:
      return relType;
  }
}

/**
 * Normalize relationships from either format into a flat array
 * with consistent `from_id`, `to_id`, `relationship_type` fields.
 */
function normalizeRelationships(rels: SudocodeRelationships | undefined): SudocodeRelationship[] {
  if (!rels) return [];

  let flat: SudocodeRelationship[];
  if (Array.isArray(rels)) {
    // JSONL format: flat array with from/to/type
    flat = rels;
  } else {
    // show --json format: { outgoing, incoming } with from_id/to_id/relationship_type
    flat = [...(rels.outgoing ?? []), ...(rels.incoming ?? [])];
  }

  // Normalize field names so consumers can always use from_id/to_id/relationship_type
  return flat.map((rel) => ({
    ...rel,
    from_id: rel.from_id ?? rel.from,
    to_id: rel.to_id ?? rel.to,
    relationship_type: rel.relationship_type ?? rel.type,
  }));
}

/**
 * Check if an entity is archived (handles both boolean and number)
 */
function isArchived(entity: SudocodeEntity): boolean {
  return entity.archived === true || entity.archived === 1;
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
  };
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
  };
}

/**
 * Convert any Sudocode entity to ProviderNode
 */
function entityToProviderNode(entity: SudocodeEntity, workspace: string = '.'): ProviderNode {
  const entityType = entityTypeFromId(entity.id);
  if (entityType === 'spec') {
    return specToProviderNode(entity as SudocodeSpec, workspace);
  }
  return issueToProviderNode(entity as SudocodeIssue, workspace);
}

// ============================================================================
// Sudocode Provider Implementation
// ============================================================================

/**
 * Create a Sudocode provider with relationship querying and optional watching support
 */
export function createSudocodeProvider(
  config: SudocodeConfig = {},
): Provider & RelationshipQueryable & Partial<Watchable> & TaskManageable {
  const executable = config.executable ?? 'sudocode';
  const cwd = config.cwd;
  const timeout = config.timeout ?? 30000;
  const extraArgs = config.extraArgs ?? [];
  const watchPath = config.watchPath;
  const watchDebounceMs = config.watchDebounceMs ?? 200;

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: true,
    watch: !!watchPath,
    mount: true,
    feedback: false,
  };

  // =========================================================================
  // Watch State (only active when watchPath is configured)
  // =========================================================================

  /** Cached content hashes for change diffing: entity id → hash of serialized data */
  const cachedHashes = new Map<string, string>();

  /** Cached edge signatures for edge change detection: "from\0to\0type" → true */
  const cachedEdgeKeys = new Set<string>();

  /** chokidar watcher instance */
  let fileWatcher: FSWatcher | null = null;

  /** Current watch callback */
  let watchCallback: WatchChangeCallback | null = null;

  /** Debounce timer for coalescing rapid file changes */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Simple hash for diffing (not cryptographic — just for detecting changes).
   */
  function quickHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
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
    };
    return quickHash(JSON.stringify(substantive));
  }

  /**
   * Compute the set of edge keys from an entity's relationship fields
   */
  function entityEdgeKeys(entity: SudocodeEntity): Set<string> {
    const keys = new Set<string>();

    for (const rel of normalizeRelationships(entity.relationships)) {
      if (rel.from_id && rel.to_id && rel.relationship_type) {
        const edgeType = mapRelationshipType(rel.relationship_type);
        keys.add(`${rel.from_id}\0${rel.to_id}\0${edgeType}`);
      }
    }

    if (entity.parent_id) {
      keys.add(`${entity.parent_id}\0${entity.id}\0parent-of`);
    }

    return keys;
  }

  /**
   * Diff current Sudocode state against cached hashes and emit change events.
   */
  async function diffAndEmit(): Promise<void> {
    if (!watchCallback) return;

    try {
      // Read entities directly from JSONL files (includes relationships)
      const issues = await readEntitiesFromJsonl('issue');
      const specs = await readEntitiesFromJsonl('spec');
      const allEntities = [...issues, ...specs];

      const currentIds = new Set<string>();
      const currentEdgeKeys = new Set<string>();

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
            });
            cachedHashes.delete(entity.id);
          }
          continue;
        }

        currentIds.add(entity.id);
        const hash = entityHashKey(entity);
        const prevHash = cachedHashes.get(entity.id);
        const providerNode = entityToProviderNode(entity);

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
          });
        } else if (prevHash !== hash) {
          const event: ProviderNodeChangeEvent = {
            type: 'updated',
            nodeId: entity.id,
            uri: providerNode.uri,
            node: providerNode,
            timestamp: new Date().toISOString(),
          };
          watchCallback({ kind: 'node', event });
        }

        cachedHashes.set(entity.id, hash);

        for (const key of entityEdgeKeys(entity)) {
          currentEdgeKeys.add(key);
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
          });
          cachedHashes.delete(id);
        }
      }

      // Detect edge changes — new edges
      for (const key of currentEdgeKeys) {
        if (!cachedEdgeKeys.has(key)) {
          const [from, to, type] = key.split('\0');
          const event: ProviderEdgeChangeEvent = {
            type: 'created',
            edge: { from, to, type },
            sourceUri: `sudocode://./${from}`,
            targetUri: `sudocode://./${to}`,
            timestamp: new Date().toISOString(),
          };
          watchCallback({ kind: 'edge', event });
        }
      }
      // Deleted edges
      for (const key of cachedEdgeKeys) {
        if (!currentEdgeKeys.has(key)) {
          const [from, to, type] = key.split('\0');
          const event: ProviderEdgeChangeEvent = {
            type: 'deleted',
            edge: { from, to, type },
            sourceUri: `sudocode://./${from}`,
            targetUri: `sudocode://./${to}`,
            timestamp: new Date().toISOString(),
          };
          watchCallback({ kind: 'edge', event });
        }
      }

      // Update cached edge state
      cachedEdgeKeys.clear();
      for (const key of currentEdgeKeys) {
        cachedEdgeKeys.add(key);
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
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void diffAndEmit();
    }, watchDebounceMs);
  }

  /**
   * Seed the cached hashes from current Sudocode state
   */
  async function seedCache(): Promise<void> {
    try {
      const issues = await readEntitiesFromJsonl('issue');
      const specs = await readEntitiesFromJsonl('spec');
      const allEntities = [...issues, ...specs];

      cachedHashes.clear();
      cachedEdgeKeys.clear();

      for (const entity of allEntities) {
        if (isArchived(entity)) continue;

        cachedHashes.set(entity.id, entityHashKey(entity));
        for (const key of entityEdgeKeys(entity)) {
          cachedEdgeKeys.add(key);
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
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }
    return arg;
  }

  /**
   * Execute a sudocode CLI command
   */
  async function execSudocode(args: string[], context?: ProviderOperationContext): Promise<string> {
    const command = [executable, ...extraArgs.map(shellEscape), ...args.map(shellEscape)].join(' ');

    try {
      const { stdout } = await execAsync(command, {
        cwd: context?.cwd ?? cwd,
        timeout: context?.timeout ?? timeout,
        env: { ...process.env },
      });
      return stdout.trim();
    } catch (error) {
      const err = error as {
        code?: string | number;
        message?: string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };

      if (err.code === 'ENOENT') {
        throw new ProviderErrorClass(
          'PROVIDER_ERROR',
          `Sudocode CLI not found: ${executable}`,
          'sudocode',
        );
      }

      if (err.killed) {
        throw new ProviderErrorClass('TIMEOUT', `Command timed out: ${command}`, 'sudocode');
      }

      let errorMessage = err.message ?? 'Unknown error';
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout);
          if (parsed.error) {
            errorMessage = parsed.error;
          }
        } catch {
          if (err.stdout.trim()) {
            errorMessage = err.stdout.trim();
          }
        }
      }

      throw new ProviderErrorClass(
        'OPERATION_FAILED',
        `Sudocode CLI error: ${errorMessage}`,
        'sudocode',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Parse JSON output from sudocode CLI
   */
  function parseJson<T>(output: string): T {
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new ProviderErrorClass(
        'PROVIDER_ERROR',
        'Failed to parse Sudocode CLI output as JSON',
        'sudocode',
      );
    }
  }

  /**
   * Fetch entities of a given type from sudocode CLI (list — no relationships)
   */
  async function fetchEntities(type: 'spec' | 'issue'): Promise<SudocodeEntity[]> {
    const subcommand = type === 'spec' ? 'spec' : 'issue';
    const output = await execSudocode(['--json', subcommand, 'list']);
    return parseJson<SudocodeEntity[]>(output);
  }

  /**
   * Resolve the path to the .sudocode data directory.
   * Prefers watchPath, then derives from cwd.
   */
  function sudocodeDataDir(): string | null {
    return watchPath ?? (cwd ? join(cwd, '.sudocode') : null);
  }

  /**
   * Read entities directly from a JSONL file in .sudocode/.
   * The JSONL files contain fully denormalized data with relationships
   * and tags already embedded — no CLI calls needed.
   *
   * Falls back to CLI `list` if the file can't be read.
   */
  async function readEntitiesFromJsonl(type: 'spec' | 'issue'): Promise<SudocodeEntity[]> {
    const jsonlFile = type === 'spec' ? 'specs.jsonl' : 'issues.jsonl';
    const dir = sudocodeDataDir();
    if (!dir) {
      // No path to .sudocode dir — fall back to CLI
      return fetchEntities(type);
    }

    try {
      const content = await readFile(join(dir, jsonlFile), 'utf-8');
      const entities: SudocodeEntity[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entities.push(JSON.parse(trimmed) as SudocodeEntity);
        } catch {
          // Skip malformed lines
        }
      }
      return entities;
    } catch {
      // File doesn't exist or isn't readable — fall back to CLI
      return fetchEntities(type);
    }
  }

  /**
   * Find a single entity by ID from the JSONL files.
   * Falls back to CLI `show` if JSONL is unavailable or entity not found.
   */
  async function findEntityById(
    id: string,
    workspace: string = '.',
  ): Promise<SudocodeEntity | null> {
    const entityType = entityTypeFromId(id);
    const dir = sudocodeDataDir();

    if (dir) {
      try {
        const entities = await readEntitiesFromJsonl(entityType);
        const found = entities.find((e) => e.id === id);
        if (found) return found;
        // Not in JSONL — might be a stale file; fall through to CLI
      } catch {
        // JSONL read failed — fall through to CLI
      }
    }

    // Fall back to CLI show
    const subcommand = entityType === 'spec' ? 'spec' : 'issue';
    try {
      const output = await execSudocode(['--json', subcommand, 'show', id]);
      return parseJson<SudocodeEntity>(output);
    } catch (error) {
      if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
        const message = error.message.toLowerCase();
        if (
          message.includes('not found') ||
          message.includes('does not exist') ||
          message.includes('no issue found') ||
          message.includes('no spec found')
        ) {
          return null;
        }
      }
      throw error;
    }
  }

  return {
    name: 'sudocode',
    schemes: ['sudocode', 'sc'],
    capabilities,
    local: true,
    description: 'Sudocode git-native agent orchestration. Manages specs and issues via CLI. Issues support task lifecycle; specs are context/requirement nodes. Only title, content, and priority are passed through on create. Status is supported on issue update.',
    metadataSchema: {
      fields: {},
      description: 'Metadata is not passed through to Sudocode. Tags and assignee set via top-level fields are also not forwarded on create/update.',
    },

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for sudocode:// or sc:// URI
      const match = uri.match(SUDOCODE_URI_PATTERN);
      if (match) {
        const scheme = match[1].toLowerCase();
        const workspace = match[2] || '.';
        const id = match[3];
        return {
          scheme,
          workspace,
          id,
          isRelative: workspace === '.',
        };
      }

      // Check for bare Sudocode entity ID
      if (ENTITY_ID_PATTERN.test(uri)) {
        return {
          scheme: 'sudocode',
          workspace: '.',
          id: uri,
          isRelative: true,
        };
      }

      return null;
    },

    buildUri(id: string, options?: UriOptions): string {
      const workspace = options?.workspace ?? '.';
      if (options?.relative) {
        return id;
      }
      return `sudocode://${workspace}/${id}`;
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null;
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string, _context?: ProviderOperationContext): Promise<ProviderNode | null> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;
      const workspace = parsed?.workspace ?? '.';

      const entity = await findEntityById(entityId, workspace);
      if (!entity) return null;
      return entityToProviderNode(entity, workspace);
    },

    async list(
      filter?: ProviderFilter,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const results: ProviderNode[] = [];
      const entityTypes: Array<'spec' | 'issue'> =
        filter?.type === 'spec'
          ? ['spec']
          : filter?.type === 'issue'
            ? ['issue']
            : ['issue', 'spec'];

      for (const entityType of entityTypes) {
        try {
          const entities = await readEntitiesFromJsonl(entityType);

          for (const entity of entities) {
            if (isArchived(entity)) continue;

            // Client-side status filter (applies to issues; specs don't have status)
            if (filter?.status && entityType === 'issue') {
              const issue = entity as SudocodeIssue;
              if (issue.status !== filter.status) continue;
            }

            results.push(entityToProviderNode(entity));
          }
        } catch {
          // If one type fails (e.g., no specs), continue with the other
        }
      }

      // Apply limit after combining
      if (filter?.limit && results.length > filter.limit) {
        return results.slice(0, filter.limit);
      }

      return results;
    },

    async create(
      input: ProviderCreateInput,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const entityType = input.type === 'spec' ? 'spec' : 'issue';
      const subcommand = entityType === 'spec' ? 'spec' : 'issue';
      // --json is global (before subcommand), title is positional (after create)
      const args = ['--json', subcommand, 'create', input.title];

      if (input.content) {
        args.push('-d', input.content);
      }
      if (input.priority !== undefined) {
        args.push('-p', String(input.priority));
      }

      const output = await execSudocode(args, context);
      const entity = parseJson<SudocodeEntity>(output);

      return entityToProviderNode(entity);
    },

    async update(
      id: string,
      updates: ProviderUpdateInput,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;
      const entityType = entityTypeFromId(entityId);
      const subcommand = entityType === 'spec' ? 'spec' : 'issue';

      // --json is global (before subcommand)
      const args = ['--json', subcommand, 'update', entityId];

      if (updates.title) {
        args.push('--title', updates.title);
      }
      if (updates.content) {
        args.push('--description', updates.content);
      }
      if (updates.status && entityType === 'issue') {
        args.push('-s', updates.status);
      }
      if (updates.priority !== undefined) {
        args.push('-p', String(updates.priority));
      }

      const output = await execSudocode(args, context);
      const entity = parseJson<SudocodeEntity>(output);

      return entityToProviderNode(entity);
    },

    async delete(id: string, context?: ProviderOperationContext): Promise<void> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;
      const entityType = entityTypeFromId(entityId);
      const subcommand = entityType === 'spec' ? 'spec' : 'issue';

      await execSudocode([subcommand, 'delete', '--hard', entityId], context);
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      const results: ProviderNode[] = [];
      const entityTypes: Array<'spec' | 'issue'> =
        options?.type === 'spec'
          ? ['spec']
          : options?.type === 'issue'
            ? ['issue']
            : ['issue', 'spec'];

      const queryLower = query.toLowerCase();

      for (const entityType of entityTypes) {
        try {
          const entities = await readEntitiesFromJsonl(entityType);

          for (const entity of entities) {
            if (isArchived(entity)) continue;

            // Client-side text search across title and content
            const titleMatch = entity.title?.toLowerCase().includes(queryLower);
            const contentMatch = entity.content?.toLowerCase().includes(queryLower);
            if (!titleMatch && !contentMatch) continue;

            results.push(entityToProviderNode(entity));
          }
        } catch {
          // If search fails for one type, continue with the other
        }
      }

      if (options?.limit && results.length > options.limit) {
        return results.slice(0, options.limit);
      }

      return results;
    },

    // =========================================================================
    // RelationshipQueryable Implementation
    // =========================================================================

    async queryEdges(nodeId: string, options?: QueryEdgesOptions): Promise<ProviderEdge[]> {
      const parsed = this.parseUri(nodeId);
      const entityId = parsed?.id ?? nodeId;

      const entity = await findEntityById(entityId);
      if (!entity) return [];

      let edges: ProviderEdge[] = [];

      // Extract relationships (handles both show and JSONL formats)
      for (const rel of normalizeRelationships(entity.relationships)) {
        if (rel.from_id && rel.to_id && rel.relationship_type) {
          edges.push({
            from: rel.from_id,
            to: rel.to_id,
            type: mapRelationshipType(rel.relationship_type),
          });
        }
      }

      // Parent-child relationship
      if (entity.parent_id) {
        edges.push({ from: entity.parent_id, to: entityId, type: 'parent-of' });
      }

      // Deduplicate edges
      const seen = new Set<string>();
      edges = edges.filter((edge) => {
        const key = `${edge.from}\0${edge.to}\0${edge.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Apply filters
      if (options?.edgeType) {
        edges = filterEdgesByType(edges, options.edgeType);
      }
      if (options?.direction) {
        edges = filterEdgesByDirection(edges, entityId, options.direction);
      }
      if (options?.limit && edges.length > options.limit) {
        edges = edges.slice(0, options.limit);
      }

      return edges;
    },

    supportedEdgeTypes(): EdgeTypeSupport[] {
      return [
        { type: 'blocks', canQuery: true, canCreate: false, canDelete: false },
        { type: 'related', canQuery: true, canCreate: false, canDelete: false },
        { type: 'discovered-from', canQuery: true, canCreate: false, canDelete: false },
        { type: 'implements', canQuery: true, canCreate: false, canDelete: false },
        { type: 'references', canQuery: true, canCreate: false, canDelete: false },
        { type: 'depends-on', canQuery: true, canCreate: false, canDelete: false },
        { type: 'parent-of', canQuery: true, canCreate: false, canDelete: false },
      ];
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
        return;
      }

      watchCallback = callback;

      if (fileWatcher) {
        return; // Already watching, just updated callback
      }

      void seedCache().then(() => {
        if (!watchCallback) return;

        fileWatcher = chokidar.watch(watchPath, {
          ignoreInitial: true,
          persistent: true,
          awaitWriteFinish: {
            stabilityThreshold: 100,
            pollInterval: 20,
          },
        });

        fileWatcher.on('add', onFileChange);
        fileWatcher.on('change', onFileChange);
        fileWatcher.on('unlink', onFileChange);

        fileWatcher.on('error', () => {
          // Resilient — continue watching despite transient errors
        });
      });
    },

    stopWatching(): void {
      watchCallback = null;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      if (fileWatcher) {
        void fileWatcher.close();
        fileWatcher = null;
      }
    },

    get isWatching(): boolean {
      return fileWatcher !== null && watchCallback !== null;
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
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;

      // Only issues support task transitions (not specs)
      if (entityTypeFromId(entityId) !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot transition spec ${entityId} — only issues support task lifecycle`,
          'sudocode',
        );
      }

      const statusMap: Record<TaskAction, string> = {
        start: 'in_progress',
        complete: 'closed',
        block: 'blocked',
        reopen: 'open',
        close: 'closed',
      };

      const targetStatus = statusMap[action];
      if (!targetStatus) {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Unsupported task action: ${action}`,
          'sudocode',
        );
      }

      // Validate transition is allowed from current state
      const current = await findEntityById(entityId);
      if (current) {
        const currentStatus = (current as SudocodeIssue).status ?? 'open';
        const allowed = validActionsForStatus(currentStatus);
        if (!allowed.includes(action)) {
          throw new ProviderErrorClass(
            'NOT_SUPPORTED',
            `Cannot ${action} an issue in '${currentStatus}' state. Valid actions: ${allowed.join(', ')}`,
            'sudocode',
          );
        }
      }

      const output = await execSudocode(
        ['--json', 'issue', 'update', entityId, '-s', targetStatus],
        context,
      );
      const entity = parseJson<SudocodeEntity>(output);

      return entityToProviderNode(entity);
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const issues = await readEntitiesFromJsonl('issue');

      const readyIssues: ProviderNode[] = [];

      for (const entity of issues) {
        const issue = entity as SudocodeIssue;
        if (isArchived(issue)) continue;
        if (issue.status !== 'open') continue;

        // Apply tag filter
        if (options?.tags) {
          const issueTags = issue.tags ?? [];
          if (!options.tags.every((t) => issueTags.includes(t))) continue;
        }

        // Apply priority filter
        if (options?.priority !== undefined) {
          const p = mapPriority(issue.priority);
          if (p === undefined || p > options.priority) continue;
        }

        // Apply assignee filter
        if (options?.assignee && issue.assignee !== options.assignee) continue;

        // Check for active blockers via relationships
        let hasActiveBlocker = false;
        const rels = normalizeRelationships(issue.relationships);

        for (const rel of rels) {
          if (!rel.from_id || !rel.to_id || !rel.relationship_type) continue;

          const relType = rel.relationship_type.toLowerCase();
          const isBlocking =
            (relType === 'blocks' && rel.to_id === issue.id) ||
            (relType === 'depends-on' && rel.from_id === issue.id);

          if (!isBlocking) continue;

          // Resolve the blocker to check its status
          const blockerId = relType === 'blocks' ? rel.from_id : rel.to_id;
          try {
            const blocker = await findEntityById(blockerId);
            if (blocker && !isArchived(blocker)) {
              const blockerStatus = (blocker as SudocodeIssue).status;
              if (blockerStatus && blockerStatus !== 'closed') {
                hasActiveBlocker = true;
                break;
              }
            }
          } catch {
            // If we can't resolve the blocker, assume it's active
            hasActiveBlocker = true;
            break;
          }
        }

        if (!hasActiveBlocker) {
          readyIssues.push(entityToProviderNode(issue));
        }
      }

      // Sort by priority (lower number = higher priority)
      readyIssues.sort((a, b) => {
        const aPriority = a.priority ?? Infinity;
        const bPriority = b.priority ?? Infinity;
        return aPriority - bPriority;
      });

      // Apply limit
      if (options?.limit && readyIssues.length > options.limit) {
        return readyIssues.slice(0, options.limit);
      }

      return readyIssues;
    },

    async assignTask(
      id: string,
      assignee: string,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;

      if (entityTypeFromId(entityId) !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot assign spec ${entityId} — only issues support assignment`,
          'sudocode',
        );
      }

      const output = await execSudocode(
        ['--json', 'issue', 'update', entityId, '--assignee', assignee],
        context,
      );
      const entity = parseJson<SudocodeEntity>(output);

      return entityToProviderNode(entity);
    },

    async validActions(id: string, context?: ProviderOperationContext): Promise<TaskAction[]> {
      const parsed = this.parseUri(id);
      const entityId = parsed?.id ?? id;

      if (entityTypeFromId(entityId) !== 'issue') {
        throw new ProviderErrorClass(
          'NOT_SUPPORTED',
          `Cannot query actions for spec ${entityId} — only issues support task lifecycle`,
          'sudocode',
        );
      }

      const entity = await findEntityById(entityId);
      if (!entity) {
        throw new ProviderErrorClass('NOT_FOUND', `Issue not found: ${entityId}`, 'sudocode');
      }

      const issue = entity as SudocodeIssue;
      return validActionsForStatus(issue.status ?? 'open');
    },
  };
}
