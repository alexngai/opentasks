/**
 * Entire Provider
 *
 * Read-only provider that resolves entire:// URIs to Entire session
 * and checkpoint data. Uses the sessionlog package for direct
 * filesystem/git access — no external binary required.
 *
 * URI formats:
 *   entire://session/<session-id>
 *   entire://checkpoint/<checkpoint-id>
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ParsedUri,
  UriOptions,
  SearchOptions,
} from './types.js';
import { ProviderError } from './types.js';

// Re-export types from sessionlog (canonical source of truth)
// Aliased to preserve existing Entire* naming in the opentasks API
export type {
  SessionlogSession as EntireSession,
  SessionlogCheckpoint as EntireCheckpoint,
  SessionlogTokenUsage as EntireTokenUsage,
  SessionlogSkillUsage as EntireSkillUsage,
  SessionlogStore as EntireStore,
} from 'sessionlog';

import type { SessionlogSession, SessionlogCheckpoint, SessionlogStore } from 'sessionlog';
import { createNativeSessionlogStore } from 'sessionlog';

// Local aliases matching the opentasks naming convention
type EntireSession = SessionlogSession;
type EntireCheckpoint = SessionlogCheckpoint;
type EntireStore = SessionlogStore;

/**
 * Configuration for Entire provider
 */
export interface EntireConfig {
  /** Optional path to Entire CLI executable (e.g. 'entire' or '/usr/local/bin/entire').
   *  When set, the Go CLI is preferred if available, with fallback to the built-in TS store.
   *  When omitted, the built-in TS store is used directly. */
  executable?: string;

  /** Command timeout (ms) */
  timeout?: number;

  /** Working directory */
  cwd?: string;

  /** Session directory name under .git/ (default: 'sessionlog-sessions') */
  sessionDirName?: string;

  /** Git branch for committed checkpoints (default: 'sessionlog/checkpoints/v1') */
  checkpointsBranch?: string;

  /** Prefix for shadow branches (default: 'sessionlog/') */
  shadowBranchPrefix?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for entire:// URIs
 * Format: entire://(session|checkpoint)/<id>
 */
const ENTIRE_URI_PATTERN = /^entire:\/\/(session|checkpoint)\/(.+)$/i;

// ============================================================================
// CLI Exec Store (shells out to Go binary)
// ============================================================================

/**
 * Create an Entire store that shells out to the Go CLI binary.
 * Used when the user explicitly configures an executable path.
 *
 * TODO: Add E2E tests for this store (requires `entire` binary or stub tests).
 *   See entire-sessionlog-e2e.test.ts for context.
 */
export function createEntireExecStore(config: {
  executable: string;
  timeout?: number;
  cwd?: string;
}): EntireStore {
  const { executable, timeout = 30000, cwd = process.cwd() } = config;

  async function execEntire(args: string): Promise<string> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const result = await execAsync(`${executable} ${args}`, {
        cwd,
        timeout,
        env: { ...process.env, NO_COLOR: '1' },
      });
      return result.stdout.trim();
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Entire CLI failed: ${error.message}`,
          'entire',
          error,
        );
      }
      throw error;
    }
  }

  function parseSessionJson(json: string): EntireSession[] {
    try {
      const data = JSON.parse(json);
      const sessions = Array.isArray(data) ? data : [data];
      return sessions.map((s: Record<string, unknown>) => ({
        id: String(s.id ?? s.sessionId ?? ''),
        agent: String(s.agent ?? s.agentType ?? 'unknown'),
        phase: String(s.phase ?? s.state ?? 'ACTIVE').toUpperCase() as EntireSession['phase'],
        baseCommit: s.baseCommit as string | undefined,
        branch: s.branch as string | undefined,
        startedAt: s.startedAt as string | undefined,
        endedAt: s.endedAt as string | undefined,
        checkpoints: s.checkpoints as string[] | undefined,
        tokenUsage: s.tokenUsage as EntireSession['tokenUsage'],
        filesTouched: s.filesTouched as string[] | undefined,
        summary: s.summary as string | undefined,
      }));
    } catch {
      return [];
    }
  }

  function parseCheckpointJson(json: string): EntireCheckpoint[] {
    try {
      const data = JSON.parse(json);
      const checkpoints = Array.isArray(data) ? data : [data];
      return checkpoints.map((c: Record<string, unknown>) => ({
        id: String(c.id ?? c.checkpointId ?? ''),
        sessionId: c.sessionId as string | undefined,
        commitHash: c.commitHash as string | undefined,
        commitMessage: c.commitMessage as string | undefined,
        promptCount: c.promptCount as number | undefined,
        filesModified: c.filesModified as string[] | undefined,
        filesNew: c.filesNew as string[] | undefined,
        filesDeleted: c.filesDeleted as string[] | undefined,
        tokenUsage: c.tokenUsage as EntireCheckpoint['tokenUsage'],
        context: c.context as string | undefined,
      }));
    } catch {
      return [];
    }
  }

  return {
    async getSession(id: string): Promise<EntireSession | null> {
      try {
        const output = await execEntire(`status --json`);
        const sessions = parseSessionJson(output);
        return sessions.find((s) => s.id === id) ?? null;
      } catch {
        return null;
      }
    },

    async listSessions(): Promise<EntireSession[]> {
      try {
        const output = await execEntire(`status --json`);
        return parseSessionJson(output);
      } catch {
        return [];
      }
    },

    async getCheckpoint(id: string): Promise<EntireCheckpoint | null> {
      try {
        const output = await execEntire(`rewind --list`);
        const checkpoints = parseCheckpointJson(output);
        return checkpoints.find((c) => c.id === id) ?? null;
      } catch {
        return null;
      }
    },

    async listCheckpoints(): Promise<EntireCheckpoint[]> {
      try {
        const output = await execEntire(`rewind --list`);
        return parseCheckpointJson(output);
      } catch {
        return [];
      }
    },

    async search(query: string): Promise<Array<EntireSession | EntireCheckpoint>> {
      const results: Array<EntireSession | EntireCheckpoint> = [];
      const lowerQuery = query.toLowerCase();

      try {
        const sessions = await this.listSessions();
        for (const session of sessions) {
          if (
            session.summary?.toLowerCase().includes(lowerQuery) ||
            session.id.toLowerCase().includes(lowerQuery) ||
            session.filesTouched?.some((f) => f.toLowerCase().includes(lowerQuery))
          ) {
            results.push(session);
          }
        }
      } catch {
        // Continue with checkpoints
      }

      try {
        const checkpoints = await this.listCheckpoints();
        for (const cp of checkpoints) {
          if (
            cp.commitMessage?.toLowerCase().includes(lowerQuery) ||
            cp.id.toLowerCase().includes(lowerQuery) ||
            cp.context?.toLowerCase().includes(lowerQuery) ||
            cp.filesModified?.some((f) => f.toLowerCase().includes(lowerQuery)) ||
            cp.filesNew?.some((f) => f.toLowerCase().includes(lowerQuery))
          ) {
            results.push(cp);
          }
        }
      } catch {
        // Return what we have
      }

      return results;
    },
  };
}

// ============================================================================
// Store Factory (with CLI → native fallback)
// ============================================================================

/**
 * Check if a CLI executable is available on the system.
 */
async function isExecutableAvailable(executable: string): Promise<boolean> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`${executable} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an Entire store with optional CLI fallback.
 *
 * - If `config.executable` is set and the binary is found, uses the Go CLI.
 * - Otherwise, uses the built-in TS store (sessionlog package).
 */
export async function createEntireCliStoreAsync(config: EntireConfig = {}): Promise<EntireStore> {
  const cwd = config.cwd ?? process.cwd();

  if (config.executable) {
    const available = await isExecutableAvailable(config.executable);
    if (available) {
      return createEntireExecStore({
        executable: config.executable,
        timeout: config.timeout,
        cwd,
      });
    }
  }

  return createNativeSessionlogStore(cwd);
}

/**
 * Create an Entire store (sync — always uses built-in TS store).
 * For the CLI-preferred path, use createEntireCliStoreAsync instead.
 */
export function createEntireCliStore(config: EntireConfig = {}): EntireStore {
  const cwd = config.cwd ?? process.cwd();
  return createNativeSessionlogStore(cwd);
}

/**
 * Create a native Entire store that reads directly from the filesystem
 * and git branches, without requiring the Entire CLI binary.
 *
 * This is the recommended store for production use.
 */
export async function createEntireNativeStore(config: EntireConfig = {}): Promise<EntireStore> {
  const { createNativeEntireStore } = await import('../entire/store/native-store.js');
  return createNativeEntireStore(config.cwd, {
    sessionDirName: config.sessionDirName,
    checkpointsBranch: config.checkpointsBranch,
    shadowBranchPrefix: config.shadowBranchPrefix,
  });
}

/**
 * Create an in-memory Entire store for testing
 */
export function createInMemoryEntireStore(): EntireStore & {
  addSession(session: EntireSession): void;
  addCheckpoint(checkpoint: EntireCheckpoint): void;
} {
  const sessions = new Map<string, EntireSession>();
  const checkpoints = new Map<string, EntireCheckpoint>();

  return {
    addSession(session: EntireSession): void {
      sessions.set(session.id, session);
    },

    addCheckpoint(checkpoint: EntireCheckpoint): void {
      checkpoints.set(checkpoint.id, checkpoint);
    },

    async getSession(id: string): Promise<EntireSession | null> {
      return sessions.get(id) ?? null;
    },

    async listSessions(): Promise<EntireSession[]> {
      return Array.from(sessions.values());
    },

    async getCheckpoint(id: string): Promise<EntireCheckpoint | null> {
      return checkpoints.get(id) ?? null;
    },

    async listCheckpoints(): Promise<EntireCheckpoint[]> {
      return Array.from(checkpoints.values());
    },

    async search(query: string): Promise<Array<EntireSession | EntireCheckpoint>> {
      const results: Array<EntireSession | EntireCheckpoint> = [];
      const lowerQuery = query.toLowerCase();

      for (const session of sessions.values()) {
        if (
          session.summary?.toLowerCase().includes(lowerQuery) ||
          session.id.toLowerCase().includes(lowerQuery) ||
          session.filesTouched?.some((f) => f.toLowerCase().includes(lowerQuery))
        ) {
          results.push(session);
        }
      }

      for (const cp of checkpoints.values()) {
        if (
          cp.commitMessage?.toLowerCase().includes(lowerQuery) ||
          cp.id.toLowerCase().includes(lowerQuery) ||
          cp.context?.toLowerCase().includes(lowerQuery) ||
          cp.filesModified?.some((f) => f.toLowerCase().includes(lowerQuery)) ||
          cp.filesNew?.some((f) => f.toLowerCase().includes(lowerQuery))
        ) {
          results.push(cp);
        }
      }

      return results;
    },
  };
}

// ============================================================================
// Node Conversion
// ============================================================================

/**
 * Convert an Entire session to a ProviderNode
 */
function sessionToProviderNode(session: EntireSession): ProviderNode {
  return {
    id: session.id,
    uri: `entire://session/${session.id}`,
    type: 'external',
    title: `Session: ${session.summary || session.id}`,
    content: session.summary,
    status: session.phase === 'ENDED' ? 'closed' : 'open',
    rawData: {
      entityType: 'session',
      agent: session.agent,
      baseCommit: session.baseCommit,
      branch: session.branch,
      phase: session.phase,
      tokenUsage: session.tokenUsage,
      filesTouched: session.filesTouched,
      checkpoints: session.checkpoints,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      skillsUsed: session.skillsUsed,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Convert an Entire checkpoint to a ProviderNode
 */
function checkpointToProviderNode(checkpoint: EntireCheckpoint): ProviderNode {
  return {
    id: checkpoint.id,
    uri: `entire://checkpoint/${checkpoint.id}`,
    type: 'external',
    title: `Checkpoint: ${checkpoint.commitMessage || checkpoint.id}`,
    content: checkpoint.context,
    status: 'closed', // Checkpoints are immutable
    rawData: {
      entityType: 'checkpoint',
      sessionId: checkpoint.sessionId,
      commitHash: checkpoint.commitHash,
      commitMessage: checkpoint.commitMessage,
      promptCount: checkpoint.promptCount,
      filesModified: checkpoint.filesModified,
      filesNew: checkpoint.filesNew,
      filesDeleted: checkpoint.filesDeleted,
      tokenUsage: checkpoint.tokenUsage,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Check if an item is a session (has 'phase' field)
 */
function isSession(item: EntireSession | EntireCheckpoint): item is EntireSession {
  return 'phase' in item;
}

// ============================================================================
// Entire Provider Implementation
// ============================================================================

/**
 * Create an Entire provider.
 *
 * When a pre-built store is provided, it is used directly.
 * Otherwise, falls back to the sync native store (createEntireCliStore).
 * For CLI-preferred creation, build the store via createEntireCliStoreAsync
 * and pass it as the `store` parameter.
 */
export function createEntireProvider(config: EntireConfig = {}, store?: EntireStore): Provider {
  const entireStore = store ?? createEntireCliStore(config);

  const capabilities: ProviderCapabilities = {
    read: true,
    write: false,
    search: true,
    watch: false,
    mount: false,
    feedback: false,
  };

  return {
    name: 'entire',
    schemes: ['entire'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      const match = uri.match(ENTIRE_URI_PATTERN);
      if (match) {
        const entityType = match[1].toLowerCase(); // 'session' or 'checkpoint'
        const id = match[2];
        return {
          scheme: 'entire',
          workspace: entityType,
          id,
          isRelative: false,
        };
      }
      return null;
    },

    buildUri(id: string, options?: UriOptions): string {
      const entityType = options?.workspace ?? 'session';
      if (options?.relative) {
        return id;
      }
      return `entire://${entityType}/${id}`;
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null;
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string): Promise<ProviderNode | null> {
      const parsed = this.parseUri(id);
      const entityType = parsed?.workspace ?? 'session';
      const entityId = parsed?.id ?? id;

      try {
        if (entityType === 'checkpoint') {
          const checkpoint = await entireStore.getCheckpoint(entityId);
          if (!checkpoint) return null;
          return checkpointToProviderNode(checkpoint);
        } else {
          const session = await entireStore.getSession(entityId);
          if (!session) return null;
          return sessionToProviderNode(session);
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to get entire entity: ${error instanceof Error ? error.message : String(error)}`,
          'entire',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      try {
        const results: ProviderNode[] = [];

        // List sessions
        const sessions = await entireStore.listSessions();
        for (const session of sessions) {
          const node = sessionToProviderNode(session);
          if (filter?.status && node.status !== filter.status) continue;
          results.push(node);
        }

        // List checkpoints
        const checkpoints = await entireStore.listCheckpoints();
        for (const cp of checkpoints) {
          const node = checkpointToProviderNode(cp);
          if (filter?.status && node.status !== filter.status) continue;
          results.push(node);
        }

        // Apply limit
        if (filter?.limit) {
          return results.slice(0, filter.limit);
        }

        return results;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to list entire entities: ${error instanceof Error ? error.message : String(error)}`,
          'entire',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async create(_input: ProviderCreateInput): Promise<ProviderNode> {
      throw new ProviderError(
        'NOT_SUPPORTED',
        'Entire provider is read-only. Sessions and checkpoints are managed by the Entire CLI.',
        'entire',
      );
    },

    async update(_id: string, _updates: ProviderUpdateInput): Promise<ProviderNode> {
      throw new ProviderError(
        'NOT_SUPPORTED',
        'Entire provider is read-only. Sessions and checkpoints are managed by the Entire CLI.',
        'entire',
      );
    },

    async delete(_id: string): Promise<void> {
      throw new ProviderError(
        'NOT_SUPPORTED',
        'Entire provider is read-only. Sessions and checkpoints are managed by the Entire CLI.',
        'entire',
      );
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(query: string, options?: SearchOptions): Promise<ProviderNode[]> {
      try {
        const results = await entireStore.search(query);
        let nodes = results.map((item) =>
          isSession(item) ? sessionToProviderNode(item) : checkpointToProviderNode(item),
        );

        if (options?.limit) {
          nodes = nodes.slice(0, options.limit);
        }

        return nodes;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to search entire: ${error instanceof Error ? error.message : String(error)}`,
          'entire',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
}
