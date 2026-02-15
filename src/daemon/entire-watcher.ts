/**
 * Entire Session Watcher
 *
 * Watches .git/entire-sessions/ for session state changes and emits
 * structured events. Used by the auto-linker to correlate sessions
 * with OpenTasks tasks.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';

// ============================================================================
// Types
// ============================================================================

/**
 * Entire session state from a session file
 */
export interface EntireSessionState {
  id: string;
  agent: string;
  phase: 'ACTIVE' | 'IDLE' | 'ENDED';
  baseCommit?: string;
  branch?: string;
  startedAt?: string;
  endedAt?: string;
  checkpoints: string[];
  lastPromptAt?: string;
}

/**
 * Event emitted when a session changes
 */
export interface EntireSessionEvent {
  type: 'started' | 'updated' | 'checkpoint' | 'ended' | 'deleted';
  sessionId: string;
  session: EntireSessionState;
  previousPhase?: string;
  checkpointId?: string;
  timestamp: string;
}

export type SessionEventHandler = (event: EntireSessionEvent) => void;

/**
 * Configuration for the Entire watcher
 */
export interface EntireWatcherConfig {
  /** Path to .opentasks/ directory (used to resolve .git) */
  locationPath: string;

  /** Override the git directory path (for testing) */
  gitDir?: string;

  /** Debounce delay in milliseconds (default: 200) */
  debounceMs?: number;

  /** Use polling instead of native fs events (useful for containers/tests) */
  usePolling?: boolean;
}

/**
 * Entire session watcher interface
 */
export interface EntireWatcher {
  /** Start watching for session changes */
  start(): Promise<void>;

  /** Stop watching */
  stop(): Promise<void>;

  /** Register event handler */
  onSessionEvent(handler: SessionEventHandler): void;

  /** Check if watching */
  readonly isWatching: boolean;

  /** Get the resolved sessions directory path */
  readonly sessionsDir: string;
}

// ============================================================================
// Git Directory Resolution
// ============================================================================

/**
 * Resolve the git directory from a location path.
 * Handles worktrees by checking for .git file that references the real git dir.
 */
function resolveGitDir(locationPath: string): string | null {
  // Walk up from the opentasks location to find .git
  let dir = path.dirname(locationPath); // Go from .opentasks/ to project root
  const root = path.parse(dir).root;

  while (dir !== root) {
    const gitPath = path.join(dir, '.git');

    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return gitPath;
      }
      // Worktree: .git is a file containing "gitdir: <path>"
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const resolved = path.resolve(dir, match[1]);
          return resolved;
        }
      }
    } catch {
      // .git doesn't exist at this level, keep looking
    }

    dir = path.dirname(dir);
  }

  return null;
}

// ============================================================================
// Session File Parsing
// ============================================================================

/**
 * Parse a session state file
 */
function parseSessionFile(filePath: string): EntireSessionState | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    const id = path.basename(filePath, '.json');

    return {
      id,
      agent: String(data.agent ?? data.agentType ?? 'unknown'),
      phase: normalizePhase(String(data.phase ?? data.state ?? 'ACTIVE')),
      baseCommit: data.baseCommit as string | undefined,
      branch: data.branch as string | undefined,
      startedAt: data.startedAt as string | undefined,
      endedAt: data.endedAt as string | undefined,
      checkpoints: Array.isArray(data.checkpoints) ? data.checkpoints.map(String) : [],
      lastPromptAt: data.lastPromptAt as string | undefined,
    };
  } catch {
    return null;
  }
}

function normalizePhase(phase: string): EntireSessionState['phase'] {
  const upper = phase.toUpperCase();
  if (upper === 'ACTIVE' || upper === 'IDLE' || upper === 'ENDED') {
    return upper as EntireSessionState['phase'];
  }
  return 'ACTIVE';
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an Entire session watcher
 */
export function createEntireWatcher(config: EntireWatcherConfig): EntireWatcher {
  const { locationPath, debounceMs = 200, usePolling = false } = config;

  // Resolve git dir
  const gitDir = config.gitDir ?? resolveGitDir(locationPath);
  const sessionsDir = gitDir ? path.join(gitDir, 'entire-sessions') : '';

  let watcher: FSWatcher | null = null;
  let watching = false;
  const handlers: SessionEventHandler[] = [];

  // Cache of known session states for diff detection
  const sessionCache = new Map<string, EntireSessionState>();

  // Debounce map
  const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();

  function emitEvent(event: EntireSessionEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }

  function determineEventType(
    previous: EntireSessionState | undefined,
    current: EntireSessionState,
  ): EntireSessionEvent | null {
    const timestamp = new Date().toISOString();

    if (!previous) {
      // New session
      return {
        type: current.phase === 'ENDED' ? 'ended' : 'started',
        sessionId: current.id,
        session: current,
        timestamp,
      };
    }

    // Phase change to ENDED
    if (previous.phase !== 'ENDED' && current.phase === 'ENDED') {
      return {
        type: 'ended',
        sessionId: current.id,
        session: current,
        previousPhase: previous.phase,
        timestamp,
      };
    }

    // New checkpoints
    if (current.checkpoints.length > previous.checkpoints.length) {
      const newCheckpointId = current.checkpoints[current.checkpoints.length - 1];
      return {
        type: 'checkpoint',
        sessionId: current.id,
        session: current,
        checkpointId: newCheckpointId,
        previousPhase: previous.phase,
        timestamp,
      };
    }

    // Phase change (ACTIVE → IDLE, etc.)
    if (previous.phase !== current.phase) {
      return {
        type: 'updated',
        sessionId: current.id,
        session: current,
        previousPhase: previous.phase,
        timestamp,
      };
    }

    // No meaningful change
    return null;
  }

  function handleFileChange(filePath: string): void {
    if (!filePath.endsWith('.json')) return;

    // Cancel existing debounce
    const existing = pendingChanges.get(filePath);
    if (existing) clearTimeout(existing);

    pendingChanges.set(
      filePath,
      setTimeout(() => {
        pendingChanges.delete(filePath);

        const current = parseSessionFile(filePath);
        if (!current) return;

        const previous = sessionCache.get(current.id);
        const event = determineEventType(previous, current);

        // Update cache
        sessionCache.set(current.id, current);

        if (event) {
          emitEvent(event);
        }
      }, debounceMs),
    );
  }

  function handleFileDelete(filePath: string): void {
    if (!filePath.endsWith('.json')) return;

    const sessionId = path.basename(filePath, '.json');
    const previous = sessionCache.get(sessionId);

    if (previous) {
      sessionCache.delete(sessionId);

      emitEvent({
        type: 'deleted',
        sessionId,
        session: previous,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return {
    get isWatching(): boolean {
      return watching;
    },

    get sessionsDir(): string {
      return sessionsDir;
    },

    async start(): Promise<void> {
      if (watching || !sessionsDir) return;

      // Process existing session files on startup
      try {
        if (fs.existsSync(sessionsDir)) {
          const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(sessionsDir, file);
            const session = parseSessionFile(filePath);
            if (session) {
              sessionCache.set(session.id, session);
            }
          }
        }
      } catch {
        // Ignore errors reading existing files
      }

      return new Promise<void>((resolve) => {
        watcher = chokidar.watch(path.join(sessionsDir, '*.json'), {
          ignoreInitial: true,
          persistent: true,
          ignorePermissionErrors: true,
          usePolling,
          interval: usePolling ? 100 : undefined,
          awaitWriteFinish: {
            stabilityThreshold: usePolling ? 100 : 200,
            pollInterval: 50,
          },
        });

        watcher.on('add', handleFileChange);
        watcher.on('change', handleFileChange);
        watcher.on('unlink', handleFileDelete);

        watcher.on('ready', () => {
          watching = true;
          resolve();
        });

        watcher.on('error', () => {
          // Log but don't crash — directory may not exist yet
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      // Clear pending changes
      for (const timeout of pendingChanges.values()) {
        clearTimeout(timeout);
      }
      pendingChanges.clear();

      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      watching = false;
    },

    onSessionEvent(handler: SessionEventHandler): void {
      handlers.push(handler);
    },
  };
}
