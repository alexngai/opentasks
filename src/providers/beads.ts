/**
 * Beads Provider
 *
 * Provider that integrates with Beads via CLI.
 * Handles beads:// and bd:// URI schemes.
 */

import { exec as execCallback } from 'child_process';
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
  ProviderError,
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
 * Configuration for Beads provider
 */
export interface BeadsConfig {
  /** Path to bd executable (default: 'bd') */
  executable?: string;

  /** Working directory for bd commands */
  cwd?: string;

  /** Timeout for CLI commands in ms (default: 30000) */
  timeout?: number;

  /**
   * Extra global flags passed to every bd command invocation.
   * Useful for environments that need `--no-db` (JSONL-only mode)
   * when the filesystem doesn't support SQLite WAL.
   *
   * @example ['--no-db'] or ['--no-daemon', '--sandbox']
   */
  extraArgs?: string[];

  /**
   * Path to Beads data directory to watch for changes.
   * When set, enables the Watchable trait. The provider will
   * use chokidar to monitor this directory for file changes
   * and emit ProviderChangeEvents by diffing against cached state.
   *
   * Typically points to a `.beads/` directory.
   * If not set, watching is not available for this provider.
   */
  watchPath?: string;

  /** Debounce delay for file watching in ms (default: 200) */
  watchDebounceMs?: number;
}

/**
 * Raw Beads issue structure from CLI JSON output
 */
interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number | string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;

  // --- Legacy relationship fields (older bd versions) ---
  /** IDs of issues this issue blocks */
  blocks?: string[];
  /** IDs of issues that block this issue */
  blockedBy?: string[];

  // --- bd v0.49+ relationship fields ---
  /**
   * Dependencies. Format varies by command:
   * - `bd list --json`: compact refs `[{issue_id, depends_on_id, type}]`
   * - `bd show --json`: full issue objects `[{id, title, ...}]` (issues this depends on)
   */
  dependencies?: Array<{
    issue_id?: string;
    depends_on_id?: string;
    type?: string;
    id?: string;
    dependency_type?: string;
    [k: string]: unknown;
  }>;
  /** Issues that depend on this issue (bd show --json) — full issue objects */
  dependents?: Array<{ id: string; dependency_type?: string; [k: string]: unknown }>;
  /** Number of dependencies (bd v0.49+ list output) */
  dependency_count?: number;
  /** Number of dependents (bd v0.49+ list output) */
  dependent_count?: number;

  /** Parent issue ID */
  parent?: string;
  /** Child issue IDs */
  children?: string[];
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for beads:// or bd:// URIs
 * Format: beads://[workspace/]id or bd://[workspace/]id
 */
const BEADS_URI_PATTERN = /^(beads|bd):\/\/(?:([^/]+)\/)?(.+)$/i;

/**
 * Pattern for Beads issue IDs
 */
const BEADS_ID_PATTERN = /^bd-[a-z0-9]+$/i;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map Beads priority to normalized 0-4 scale
 */
function mapPriority(priority: number | string | undefined): number | undefined {
  if (priority === undefined) return undefined;

  if (typeof priority === 'number') {
    // Assume already 0-4 scale
    return Math.max(0, Math.min(4, priority));
  }

  // Map string priorities
  switch (priority.toLowerCase()) {
    case 'critical':
    case 'highest':
      return 0;
    case 'high':
      return 1;
    case 'medium':
    case 'normal':
      return 2;
    case 'low':
      return 3;
    case 'lowest':
      return 4;
    default:
      return 2;
  }
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
 * Convert Beads issue to ProviderNode
 */
function beadsIssueToProviderNode(issue: BeadsIssue, workspace: string = '.'): ProviderNode {
  return {
    id: issue.id,
    uri: `beads://${workspace}/${issue.id}`,
    type: 'issue',
    title: issue.title,
    content: issue.description,
    status: issue.status,
    priority: mapPriority(issue.priority),
    rawData: issue,
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Beads Provider Implementation
// ============================================================================

/**
 * Create a Beads provider with relationship querying and optional watching support
 */
export function createBeadsProvider(
  config: BeadsConfig = {},
): Provider & RelationshipQueryable & Partial<Watchable> & TaskManageable {
  const executable = config.executable ?? 'bd';
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

  /** Cached content hashes for change diffing: beads issue id → hash of serialized data */
  const cachedHashes = new Map<string, string>();

  /** Cached edge signatures for edge change detection: "from:to:type" → true */
  const cachedEdgeKeys = new Set<string>();

  /** chokidar watcher instance */
  let fileWatcher: FSWatcher | null = null;

  /** Current watch callback */
  let watchCallback: WatchChangeCallback | null = null;

  /** Debounce timer for coalescing rapid file changes */
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Simple hash for diffing (not cryptographic — just for detecting changes).
   * Uses the same approach as sync.ts calculateContentHash.
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
   * Build a stable hash key for a Beads issue (substantive fields only)
   */
  function issueHashKey(issue: BeadsIssue): string {
    const substantive = {
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      tags: issue.tags ? [...issue.tags].sort() : undefined,
      blocks: issue.blocks ? [...issue.blocks].sort() : undefined,
      blockedBy: issue.blockedBy ? [...issue.blockedBy].sort() : undefined,
      // Structured format (bd v0.49+)
      dependency_count: issue.dependency_count,
      dependent_count: issue.dependent_count,
      parent: issue.parent,
      children: issue.children ? [...issue.children].sort() : undefined,
    };
    return quickHash(JSON.stringify(substantive));
  }

  /**
   * Compute the set of edge keys from an issue's relationship fields
   */
  function issueEdgeKeys(issue: BeadsIssue): Set<string> {
    const keys = new Set<string>();

    // Legacy format: blocks/blockedBy string arrays
    if (issue.blocks) {
      for (const id of issue.blocks) keys.add(`${issue.id}:${id}:blocks`);
    }
    if (issue.blockedBy) {
      for (const id of issue.blockedBy) keys.add(`${id}:${issue.id}:blocks`);
    }

    // Structured format (bd v0.49+): dependencies array with {issue_id, depends_on_id, type}
    if (issue.dependencies) {
      for (const dep of issue.dependencies) {
        // dep.depends_on_id blocks dep.issue_id
        keys.add(`${dep.depends_on_id}:${dep.issue_id}:blocks`);
      }
    }

    if (issue.parent) {
      keys.add(`${issue.parent}:${issue.id}:parent-child`);
    }
    if (issue.children) {
      for (const id of issue.children) keys.add(`${issue.id}:${id}:parent-child`);
    }
    return keys;
  }

  /**
   * Diff current Beads state against cached hashes and emit change events.
   * Called when file watcher detects a change.
   */
  async function diffAndEmit(): Promise<void> {
    if (!watchCallback) return;

    try {
      const output = await execBd(['list', '--json']);
      const issues = parseJson<BeadsIssue[]>(output);

      const currentIds = new Set<string>();
      const currentEdgeKeys = new Set<string>();

      for (const issue of issues) {
        // Beads uses "tombstone" status for soft-deleted issues — treat as deleted
        const isTombstone = issue.status === 'tombstone';

        if (isTombstone) {
          // Only emit 'deleted' if we previously knew about this issue
          if (cachedHashes.has(issue.id)) {
            watchCallback({
              kind: 'node',
              event: {
                type: 'deleted',
                nodeId: issue.id,
                uri: `beads://./${issue.id}`,
                timestamp: new Date().toISOString(),
              },
            });
            cachedHashes.delete(issue.id);
          }
          continue;
        }

        currentIds.add(issue.id);
        const hash = issueHashKey(issue);
        const prevHash = cachedHashes.get(issue.id);
        const providerNode = beadsIssueToProviderNode(issue);

        if (!prevHash) {
          // New issue
          watchCallback({
            kind: 'node',
            event: {
              type: 'created',
              nodeId: issue.id,
              uri: providerNode.uri,
              node: providerNode,
              timestamp: new Date().toISOString(),
            },
          });
        } else if (prevHash !== hash) {
          // Changed issue — compute changed fields if possible
          const event: ProviderNodeChangeEvent = {
            type: 'updated',
            nodeId: issue.id,
            uri: providerNode.uri,
            node: providerNode,
            timestamp: new Date().toISOString(),
          };

          // We can report changed fields by comparing against cached data
          // but we only store hashes, not full data. For field-level we'd
          // need to cache full issue objects. For now, we report the node
          // change without field detail — consumers can diff themselves.
          watchCallback({ kind: 'node', event });
        }

        cachedHashes.set(issue.id, hash);

        // Collect current edges
        for (const key of issueEdgeKeys(issue)) {
          currentEdgeKeys.add(key);
        }
      }

      // Detect deleted issues
      for (const [id] of cachedHashes) {
        if (!currentIds.has(id)) {
          watchCallback({
            kind: 'node',
            event: {
              type: 'deleted',
              nodeId: id,
              uri: `beads://./${id}`,
              timestamp: new Date().toISOString(),
            },
          });
          cachedHashes.delete(id);
        }
      }

      // Detect edge changes
      // New edges
      for (const key of currentEdgeKeys) {
        if (!cachedEdgeKeys.has(key)) {
          const [from, to, type] = key.split(':');
          const event: ProviderEdgeChangeEvent = {
            type: 'created',
            edge: { from, to, type },
            sourceUri: `beads://./${from}`,
            targetUri: `beads://./${to}`,
            timestamp: new Date().toISOString(),
          };
          watchCallback({ kind: 'edge', event });
        }
      }
      // Deleted edges
      for (const key of cachedEdgeKeys) {
        if (!currentEdgeKeys.has(key)) {
          const [from, to, type] = key.split(':');
          const event: ProviderEdgeChangeEvent = {
            type: 'deleted',
            edge: { from, to, type },
            sourceUri: `beads://./${from}`,
            targetUri: `beads://./${to}`,
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
   * Seed the cached hashes from current Beads state (so the first
   * diff only emits genuine changes, not the entire existing dataset)
   */
  async function seedCache(): Promise<void> {
    try {
      const output = await execBd(['list', '--json']);
      const issues = parseJson<BeadsIssue[]>(output);

      cachedHashes.clear();
      cachedEdgeKeys.clear();

      for (const issue of issues) {
        // Skip tombstoned (deleted) issues when seeding cache
        if (issue.status === 'tombstone') continue;

        cachedHashes.set(issue.id, issueHashKey(issue));
        for (const key of issueEdgeKeys(issue)) {
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
    // If arg contains spaces, quotes, or special shell chars, wrap in single quotes
    // and escape any existing single quotes
    if (/['\s"\\$`!]/.test(arg)) {
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }
    return arg;
  }

  /**
   * Execute a bd CLI command
   * @param args - Command arguments
   * @param context - Optional operational context for per-call overrides (cwd, timeout)
   */
  async function execBd(args: string[], context?: ProviderOperationContext): Promise<string> {
    const command = [executable, ...extraArgs, ...args.map(shellEscape)].join(' ');

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
          `Beads CLI not found: ${executable}`,
          'beads',
        );
      }

      if (err.killed) {
        throw new ProviderErrorClass('TIMEOUT', `Command timed out: ${command}`, 'beads');
      }

      // Extract error details from stdout if available (bd returns JSON errors)
      let errorMessage = err.message ?? 'Unknown error';
      if (err.stdout) {
        try {
          const parsed = JSON.parse(err.stdout);
          if (parsed.error) {
            errorMessage = parsed.error;
          }
        } catch {
          // Not JSON, use stdout as-is if it has content
          if (err.stdout.trim()) {
            errorMessage = err.stdout.trim();
          }
        }
      }

      throw new ProviderErrorClass(
        'OPERATION_FAILED',
        `Beads CLI error: ${errorMessage}`,
        'beads',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Parse JSON output from bd CLI
   */
  function parseJson<T>(output: string): T {
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new ProviderErrorClass(
        'PROVIDER_ERROR',
        'Failed to parse Beads CLI output as JSON',
        'beads',
      );
    }
  }

  return {
    name: 'beads',
    schemes: ['beads', 'bd'],
    capabilities,
    local: true,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      // Check for beads:// or bd:// URI
      const match = uri.match(BEADS_URI_PATTERN);
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

      // Check for bare Beads ID
      if (BEADS_ID_PATTERN.test(uri)) {
        return {
          scheme: 'beads',
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
      return `beads://${workspace}/${id}`;
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null;
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string, context?: ProviderOperationContext): Promise<ProviderNode | null> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const issueId = parsed?.id ?? id;
      const workspace = parsed?.workspace ?? '.';

      try {
        const output = await execBd(['show', issueId, '--json'], context);
        // bd show returns an array, take the first element
        const issues = parseJson<BeadsIssue[]>(output);
        if (!issues || issues.length === 0) {
          return null;
        }
        // Treat tombstoned (soft-deleted) issues as not found
        if (issues[0].status === 'tombstone') {
          return null;
        }
        return beadsIssueToProviderNode(issues[0], workspace);
      } catch (error) {
        // Return null for not found, re-throw other errors
        if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
          const message = error.message.toLowerCase();
          if (
            message.includes('not found') ||
            message.includes('does not exist') ||
            message.includes('no issue found matching')
          ) {
            return null;
          }
        }
        throw error;
      }
    },

    async list(
      filter?: ProviderFilter,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const args = ['list', '--json'];

      // Add filters if supported by bd CLI
      if (filter?.status) {
        args.push('--status', filter.status);
      }
      if (filter?.limit) {
        args.push('--limit', String(filter.limit));
      }

      const output = await execBd(args, context);
      const issues = parseJson<BeadsIssue[]>(output);

      return issues
        .filter((issue) => issue.status !== 'tombstone')
        .map((issue) => beadsIssueToProviderNode(issue));
    },

    async create(
      input: ProviderCreateInput,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const args = ['create', input.title];

      if (input.content) {
        args.push('--description', input.content);
      }
      if (input.status) {
        args.push('--status', input.status);
      }
      if (input.priority !== undefined) {
        args.push('--priority', String(input.priority));
      }

      args.push('--json');

      const output = await execBd(args, context);
      const issue = parseJson<BeadsIssue>(output);

      return beadsIssueToProviderNode(issue);
    },

    async update(
      id: string,
      updates: ProviderUpdateInput,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const issueId = parsed?.id ?? id;

      const args = ['update', issueId];

      if (updates.title) {
        args.push('--title', updates.title);
      }
      if (updates.content) {
        args.push('--description', updates.content);
      }
      if (updates.status) {
        args.push('--status', updates.status);
      }
      if (updates.priority !== undefined) {
        args.push('--priority', String(updates.priority));
      }

      args.push('--json');

      const output = await execBd(args, context);
      // bd update returns an array, take the first element
      const issues = parseJson<BeadsIssue[]>(output);
      if (!issues || issues.length === 0) {
        throw new ProviderErrorClass('OPERATION_FAILED', 'Update returned no results', 'beads');
      }

      return beadsIssueToProviderNode(issues[0]);
    },

    async delete(id: string, context?: ProviderOperationContext): Promise<void> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(id);
      const issueId = parsed?.id ?? id;

      await execBd(['delete', issueId, '--force'], context);
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      const args = ['search', query, '--json'];

      if (options?.limit) {
        args.push('--limit', String(options.limit));
      }

      const output = await execBd(args);
      const issues = parseJson<BeadsIssue[]>(output);

      return issues
        .filter((issue) => issue.status !== 'tombstone')
        .map((issue) => beadsIssueToProviderNode(issue));
    },

    // =========================================================================
    // RelationshipQueryable Implementation
    // =========================================================================

    async queryEdges(nodeId: string, options?: QueryEdgesOptions): Promise<ProviderEdge[]> {
      // Parse URI if full URI is passed
      const parsed = this.parseUri(nodeId);
      const issueId = parsed?.id ?? nodeId;

      try {
        const output = await execBd(['show', issueId, '--json']);
        const issues = parseJson<BeadsIssue[]>(output);
        if (!issues || issues.length === 0) {
          return [];
        }

        const issue = issues[0];
        // Tombstoned issues have no meaningful edges
        if (issue.status === 'tombstone') {
          return [];
        }
        let edges: ProviderEdge[] = [];

        // --- Legacy format: blocks/blockedBy string arrays ---
        if (issue.blocks && Array.isArray(issue.blocks)) {
          for (const blockedId of issue.blocks) {
            edges.push({ from: issueId, to: blockedId, type: 'blocks' });
          }
        }
        if (issue.blockedBy && Array.isArray(issue.blockedBy)) {
          for (const blockerId of issue.blockedBy) {
            edges.push({ from: blockerId, to: issueId, type: 'blocks' });
          }
        }

        // --- bd v0.49+ format from `bd show --json` ---
        // `dependencies` = issues THIS issue depends on (they block this)
        // Each element is a full issue object with an `id` field
        if (issue.dependencies && Array.isArray(issue.dependencies)) {
          for (const dep of issue.dependencies) {
            if (dep.id) {
              // Full object format from `bd show` — dep.id is the blocker
              edges.push({ from: dep.id, to: issueId, type: 'blocks' });
            } else if (dep.depends_on_id && dep.issue_id) {
              // Compact format from `bd list` — depends_on_id blocks issue_id
              edges.push({ from: dep.depends_on_id, to: dep.issue_id, type: 'blocks' });
            }
          }
        }

        // `dependents` = issues that depend on THIS issue (this blocks them)
        if (issue.dependents && Array.isArray(issue.dependents)) {
          for (const dep of issue.dependents) {
            if (dep.id) {
              edges.push({ from: issueId, to: dep.id, type: 'blocks' });
            }
          }
        }

        // --- Parent/children ---
        if (issue.parent) {
          edges.push({ from: issue.parent, to: issueId, type: 'parent-child' });
        }
        if (issue.children && Array.isArray(issue.children)) {
          for (const childId of issue.children) {
            edges.push({ from: issueId, to: childId, type: 'parent-child' });
          }
        }

        // Deduplicate edges (multiple formats may report the same relationship)
        const seen = new Set<string>();
        edges = edges.filter((edge) => {
          const key = `${edge.from}:${edge.to}:${edge.type}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Apply filters if specified
        if (options?.edgeType) {
          edges = filterEdgesByType(edges, options.edgeType);
        }
        if (options?.direction) {
          edges = filterEdgesByDirection(edges, issueId, options.direction);
        }
        if (options?.limit && edges.length > options.limit) {
          edges = edges.slice(0, options.limit);
        }

        return edges;
      } catch (error) {
        // Return empty for not found, re-throw other errors
        if (error instanceof ProviderErrorClass && error.code === 'OPERATION_FAILED') {
          const message = error.message.toLowerCase();
          if (
            message.includes('not found') ||
            message.includes('does not exist') ||
            message.includes('no issue found matching')
          ) {
            return [];
          }
        }
        throw error;
      }
    },

    supportedEdgeTypes(): EdgeTypeSupport[] {
      return [
        { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
        { type: 'parent-child', canQuery: true, canCreate: true, canDelete: true },
      ];
    },

    // =========================================================================
    // Watchable Implementation (only functional when watchPath is configured)
    // =========================================================================

    watchGranularity: {
      // Beads diffs at the node level. We can detect which nodes changed
      // but don't track individual field changes (would require caching
      // full issue objects rather than just hashes).
      reportsChangedFields: false,
      reportsPreviousValues: false,

      // Beads embeds relationships in the node (blocks/blockedBy/parent/children).
      // We extract and diff these separately, so we can emit edge events.
      reportsEdgeChanges: true,

      mechanism: 'file-watch' as const,
    } satisfies WatchGranularity,

    startWatching(callback: WatchChangeCallback): void {
      if (!watchPath) {
        return; // Watching not configured — silently no-op
      }

      // Replace callback if already watching
      watchCallback = callback;

      if (fileWatcher) {
        return; // Already watching, just updated callback
      }

      // Seed cache before starting watcher so we only emit real changes
      void seedCache().then(() => {
        if (!watchCallback) return; // Stopped before seed completed

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
          'beads',
        );
      }

      const parsed = this.parseUri(id);
      const issueId = parsed?.id ?? id;

      // Validate transition is allowed from current state
      const current = await this.get(issueId, context);
      if (current) {
        const currentStatus = current.status ?? 'open';
        const allowed = validActionsForStatus(currentStatus);
        if (!allowed.includes(action)) {
          throw new ProviderErrorClass(
            'NOT_SUPPORTED',
            `Cannot ${action} an issue in '${currentStatus}' state. Valid actions: ${allowed.join(', ')}`,
            'beads',
          );
        }
      }

      const output = await execBd(['update', issueId, '--status', targetStatus, '--json'], context);
      const issues = parseJson<BeadsIssue[]>(output);
      if (!issues || issues.length === 0) {
        throw new ProviderErrorClass('OPERATION_FAILED', 'Transition returned no results', 'beads');
      }

      return beadsIssueToProviderNode(issues[0]);
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const output = await execBd(['list', '--json'], context);
      const issues = parseJson<BeadsIssue[]>(output);

      const readyIssues: ProviderNode[] = [];

      for (const issue of issues) {
        // Skip tombstoned and non-open issues
        if (issue.status === 'tombstone' || issue.status !== 'open') continue;

        // Apply tag filter
        if (options?.tags) {
          const issueTags = issue.tags ?? [];
          if (!options.tags.every((t) => issueTags.includes(t))) continue;
        }

        // Apply priority filter
        if (options?.priority !== undefined) {
          const normalized = mapPriority(issue.priority);
          if (normalized === undefined || normalized > options.priority) continue;
        }

        // Apply assignee filter
        if (options?.assignee) {
          if ((issue as Record<string, unknown>).assignee !== options.assignee) continue;
        }

        // Check for active blockers
        let hasActiveBlocker = false;

        // Legacy format: blockedBy
        if (issue.blockedBy && issue.blockedBy.length > 0) {
          // Need to check if blockers are still active
          for (const blockerId of issue.blockedBy) {
            try {
              const blockerOutput = await execBd(['show', blockerId, '--json'], context);
              const blockerIssues = parseJson<BeadsIssue[]>(blockerOutput);
              if (
                blockerIssues?.[0] &&
                blockerIssues[0].status !== 'closed' &&
                blockerIssues[0].status !== 'tombstone'
              ) {
                hasActiveBlocker = true;
                break;
              }
            } catch {
              // If we can't resolve the blocker, assume it's active
              hasActiveBlocker = true;
              break;
            }
          }
        }

        // Structured format (bd v0.49+): dependencies
        if (!hasActiveBlocker && issue.dependencies && issue.dependencies.length > 0) {
          for (const dep of issue.dependencies) {
            const depId = dep.id ?? dep.depends_on_id;
            if (!depId) continue;
            try {
              const depOutput = await execBd(['show', depId, '--json'], context);
              const depIssues = parseJson<BeadsIssue[]>(depOutput);
              if (
                depIssues?.[0] &&
                depIssues[0].status !== 'closed' &&
                depIssues[0].status !== 'tombstone'
              ) {
                hasActiveBlocker = true;
                break;
              }
            } catch {
              hasActiveBlocker = true;
              break;
            }
          }
        }

        if (!hasActiveBlocker) {
          readyIssues.push(beadsIssueToProviderNode(issue));
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
      const issueId = parsed?.id ?? id;

      const output = await execBd(['update', issueId, '--assignee', assignee, '--json'], context);
      const issues = parseJson<BeadsIssue[]>(output);
      if (!issues || issues.length === 0) {
        throw new ProviderErrorClass('OPERATION_FAILED', 'Assign returned no results', 'beads');
      }

      return beadsIssueToProviderNode(issues[0]);
    },

    async validActions(id: string, context?: ProviderOperationContext): Promise<TaskAction[]> {
      const node = await this.get(id, context);
      if (!node) {
        throw new ProviderErrorClass('NOT_FOUND', `Issue not found: ${id}`, 'beads');
      }

      return validActionsForStatus(node.status ?? 'open');
    },
  };
}
