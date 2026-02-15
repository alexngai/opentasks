/**
 * Entire Auto-Linker
 *
 * Correlation engine that automatically creates edges between OpenTasks
 * tasks and Entire sessions/checkpoints. Matches sessions to tasks via
 * claims, in-progress status, and branch association.
 */

import type { GraphStore } from '../graph/store.js';
import type { DaemonFlushManager } from './flush.js';
import type { EntireSessionEvent, EntireSessionState } from './entire-watcher.js';
import type { MaterializationArchiver } from '../materialization/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Correlation confidence level
 */
export type CorrelationConfidence = 'high' | 'medium' | 'low';

/**
 * How a task was matched to a session
 */
export type CorrelationStrategy = 'claimed-task' | 'in-progress-branch' | 'in-progress-any';

/**
 * A task matched to an Entire session
 */
export interface MatchedTask {
  nodeId: string;
  uri?: string;
  matchReason: CorrelationStrategy;
  confidence: CorrelationConfidence;
}

/**
 * Result of correlating a session with tasks
 */
export interface CorrelationResult {
  sessionId: string;
  matchedTasks: MatchedTask[];
  edgesCreated: string[];
  nodesCreated: string[];
  strategy: CorrelationStrategy | 'none';
  timestamp: string;
}

/**
 * Configuration for the auto-linker
 */
export interface EntireAutoLinkerConfig {
  /** Graph store for creating nodes and edges */
  store: GraphStore;

  /** Flush manager for scheduling persistence */
  flushManager: DaemonFlushManager;

  /** Minimum confidence for auto-linking (default: 'medium') */
  minConfidence?: CorrelationConfidence;

  /** Optional archiver for durable session snapshots */
  archiver?: MaterializationArchiver;
}

/**
 * Auto-linker interface
 */
export interface EntireAutoLinker {
  /** Handle a session event from the watcher */
  handleSessionEvent(event: EntireSessionEvent): Promise<void>;

  /** Manually trigger correlation for a session */
  correlate(sessionId: string, session: EntireSessionState): Promise<CorrelationResult>;

  /** Get correlation history */
  getCorrelations(): Map<string, CorrelationResult>;
}

// ============================================================================
// Confidence Ordering
// ============================================================================

const CONFIDENCE_ORDER: Record<CorrelationConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function meetsConfidenceThreshold(
  confidence: CorrelationConfidence,
  minimum: CorrelationConfidence,
): boolean {
  return CONFIDENCE_ORDER[confidence] >= CONFIDENCE_ORDER[minimum];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an Entire auto-linker
 */
export function createEntireAutoLinker(config: EntireAutoLinkerConfig): EntireAutoLinker {
  const { store, flushManager, archiver } = config;
  const minConfidence = config.minConfidence ?? 'medium';

  // Track which sessions have been linked to avoid duplicates
  const correlations = new Map<string, CorrelationResult>();

  // Track created external nodes: URI → node ID mapping
  const createdNodes = new Map<string, string>();

  /**
   * Find tasks correlated with a session
   */
  async function findCorrelatedTasks(session: EntireSessionState): Promise<MatchedTask[]> {
    const matched: MatchedTask[] = [];

    // Strategy 1: Claimed tasks (high confidence)
    try {
      const allIssues = await store.query.nodes({
        type: 'task',
        status: 'in_progress',
        archived: false,
      });

      for (const issue of allIssues) {
        const raw = issue as unknown as Record<string, unknown>;
        const claimedBy = raw.claimed_by as string | undefined;
        const lockUntil = raw.lock_until as string | undefined;

        if (claimedBy && (!lockUntil || new Date(lockUntil) > new Date())) {
          matched.push({
            nodeId: issue.id,
            uri: raw.uri as string | undefined,
            matchReason: 'claimed-task',
            confidence: 'high',
          });
        }
      }
    } catch {
      // Continue to next strategy
    }

    if (matched.length > 0) return matched;

    // Strategy 2: In-progress tasks on same branch (medium confidence)
    if (session.branch) {
      try {
        const allIssues = await store.query.nodes({
          type: 'task',
          status: 'in_progress',
          archived: false,
        });

        for (const issue of allIssues) {
          const raw = issue as unknown as Record<string, unknown>;
          if (raw.branch === session.branch) {
            matched.push({
              nodeId: issue.id,
              uri: raw.uri as string | undefined,
              matchReason: 'in-progress-branch',
              confidence: 'medium',
            });
          }
        }
      } catch {
        // Continue to next strategy
      }
    }

    if (matched.length > 0) return matched;

    // Strategy 3: Any in-progress task (low confidence)
    // Only if exactly one in-progress task exists (ambiguity guard)
    try {
      const allInProgress = await store.query.nodes({
        type: 'task',
        status: 'in_progress',
        archived: false,
      });

      if (allInProgress.length === 1) {
        const raw = allInProgress[0] as unknown as Record<string, unknown>;
        matched.push({
          nodeId: allInProgress[0].id,
          uri: raw.uri as string | undefined,
          matchReason: 'in-progress-any',
          confidence: 'low',
        });
      }
    } catch {
      // No matches
    }

    return matched;
  }

  /**
   * Ensure an external node exists for an Entire session.
   * Returns the node's actual graph ID (not the URI).
   */
  async function ensureSessionNode(session: EntireSessionState): Promise<string> {
    const uri = `entire://session/${session.id}`;

    const cachedId = createdNodes.get(uri);
    if (cachedId) return cachedId;

    // Check if node already exists
    const existing = await store.query.nodes({
      type: 'external',
      search: uri,
      limit: 1,
    });

    if (existing.length > 0) {
      const nodeId = (existing[0] as unknown as Record<string, unknown>).id as string;
      createdNodes.set(uri, nodeId);
      return nodeId;
    }

    try {
      const node = await store.createNode({
        type: 'external',
        title: `Session: ${session.id}`,
        uri,
        source: 'entire',
        metadata: {
          entityType: 'session',
          agent: session.agent,
          phase: session.phase,
          baseCommit: session.baseCommit,
          branch: session.branch,
          startedAt: session.startedAt,
        },
      });

      const nodeId = (node as unknown as Record<string, unknown>).id as string;
      createdNodes.set(uri, nodeId);
      flushManager.markDirty(nodeId);
      flushManager.schedule();

      return nodeId;
    } catch {
      // Node may already exist from a concurrent operation — re-query
      const retryExisting = await store.query.nodes({
        type: 'external',
        search: uri,
        limit: 1,
      });
      if (retryExisting.length > 0) {
        const nodeId = (retryExisting[0] as unknown as Record<string, unknown>).id as string;
        createdNodes.set(uri, nodeId);
        return nodeId;
      }
      // Fallback: use URI as ID (should not happen in practice)
      createdNodes.set(uri, uri);
      return uri;
    }
  }

  /**
   * Ensure an external node exists for an Entire checkpoint.
   * Returns the node's actual graph ID (not the URI).
   */
  async function ensureCheckpointNode(
    checkpointId: string,
    session: EntireSessionState,
  ): Promise<string> {
    const uri = `entire://checkpoint/${checkpointId}`;

    const cachedId = createdNodes.get(uri);
    if (cachedId) return cachedId;

    // Check if node already exists
    const existing = await store.query.nodes({
      type: 'external',
      search: uri,
      limit: 1,
    });

    if (existing.length > 0) {
      const nodeId = (existing[0] as unknown as Record<string, unknown>).id as string;
      createdNodes.set(uri, nodeId);
      return nodeId;
    }

    try {
      const node = await store.createNode({
        type: 'external',
        title: `Checkpoint: ${checkpointId}`,
        uri,
        source: 'entire',
        metadata: {
          entityType: 'checkpoint',
          sessionId: session.id,
        },
      });

      const nodeId = (node as unknown as Record<string, unknown>).id as string;
      createdNodes.set(uri, nodeId);
      flushManager.markDirty(nodeId);
      flushManager.schedule();

      return nodeId;
    } catch {
      // Re-query in case of concurrent creation
      const retryExisting = await store.query.nodes({
        type: 'external',
        search: uri,
        limit: 1,
      });
      if (retryExisting.length > 0) {
        const nodeId = (retryExisting[0] as unknown as Record<string, unknown>).id as string;
        createdNodes.set(uri, nodeId);
        return nodeId;
      }
      createdNodes.set(uri, uri);
      return uri;
    }
  }

  /**
   * Create an edge if it doesn't already exist
   */
  async function createEdgeIfNotExists(
    fromId: string,
    toId: string,
    type: string,
    metadata?: Record<string, unknown>,
  ): Promise<string | null> {
    // Check for existing edge
    try {
      const existingEdges = await store.query.edges({
        from_id: fromId,
        to_id: toId,
        type,
      });

      if (existingEdges.length > 0) {
        return existingEdges[0].id;
      }
    } catch {
      // Continue to create
    }

    try {
      const edge = await store.createEdge({
        from_id: fromId,
        to_id: toId,
        type,
        metadata: {
          ...metadata,
          _context: {
            source: 'entire-auto-linker',
            timestamp: new Date().toISOString(),
            ...(metadata?._context as unknown as Record<string, unknown> | undefined),
          },
        },
      });

      flushManager.markDirty(fromId);
      flushManager.markDirty(toId);
      flushManager.schedule();

      return edge.id;
    } catch {
      return null;
    }
  }

  return {
    async handleSessionEvent(event: EntireSessionEvent): Promise<void> {
      const { type, sessionId, session } = event;

      switch (type) {
        case 'started': {
          // Create session node — returns the node's graph ID
          const sessionNodeId = await ensureSessionNode(session);

          // Correlate with tasks
          const tasks = await findCorrelatedTasks(session);
          const edgesCreated: string[] = [];
          const matchedForResult: MatchedTask[] = [];

          for (const task of tasks) {
            if (!meetsConfidenceThreshold(task.confidence, minConfidence)) continue;

            matchedForResult.push(task);
            const edgeId = await createEdgeIfNotExists(task.nodeId, sessionNodeId, 'worked-on', {
              _context: {
                correlation: task.matchReason,
                confidence: task.confidence,
                sessionAgent: session.agent,
              },
            });
            if (edgeId) edgesCreated.push(edgeId);
          }

          correlations.set(sessionId, {
            sessionId,
            matchedTasks: matchedForResult,
            edgesCreated,
            nodesCreated: [sessionNodeId],
            strategy: matchedForResult[0]?.matchReason ?? 'none',
            timestamp: new Date().toISOString(),
          });

          // Archive if configured
          if (archiver) {
            const sessionUri = `entire://session/${session.id}`;
            void archiver.onSessionEvent('started', sessionUri, store).catch(() => {});
          }
          break;
        }

        case 'checkpoint': {
          if (!event.checkpointId) break;

          // Ensure session and checkpoint nodes exist — returns graph IDs
          const sessionNodeId = await ensureSessionNode(session);
          const checkpointNodeId = await ensureCheckpointNode(event.checkpointId, session);

          const edgesCreated: string[] = [];

          // Create contains edge (session → checkpoint)
          const containsId = await createEdgeIfNotExists(
            sessionNodeId,
            checkpointNodeId,
            'contains',
          );
          if (containsId) edgesCreated.push(containsId);

          // Create implemented-by edges (tasks → checkpoint)
          const tasks = await findCorrelatedTasks(session);
          const matchedForResult: MatchedTask[] = [];

          for (const task of tasks) {
            if (!meetsConfidenceThreshold(task.confidence, minConfidence)) continue;

            matchedForResult.push(task);
            const edgeId = await createEdgeIfNotExists(
              task.nodeId,
              checkpointNodeId,
              'implemented-by',
              {
                _context: {
                  correlation: task.matchReason,
                  confidence: task.confidence,
                  checkpointId: event.checkpointId,
                },
              },
            );
            if (edgeId) edgesCreated.push(edgeId);
          }

          // Update existing correlation record
          const existing = correlations.get(sessionId);
          if (existing) {
            existing.edgesCreated.push(...edgesCreated);
            existing.nodesCreated.push(checkpointNodeId);
          }

          // Archive checkpoint if configured
          if (archiver) {
            const sessionUri = `entire://session/${session.id}`;
            void archiver.onSessionEvent('checkpoint', sessionUri, store).catch(() => {});
          }
          break;
        }

        case 'ended': {
          // Update session node status if it exists
          try {
            const nodes = await store.query.nodes({
              type: 'external',
              search: `entire://session/${sessionId}`,
              limit: 1,
            });

            if (nodes.length > 0) {
              await store.updateNode(nodes[0].id, {
                status: 'closed',
                metadata: { phase: 'ENDED', endedAt: session.endedAt },
              });
              flushManager.markDirty(nodes[0].id);
              flushManager.schedule();

              // Archive final session state if configured
              if (archiver) {
                const sessionUri = `entire://session/${sessionId}`;
                void archiver.onSessionEvent('ended', sessionUri, store).catch(() => {});
              }
            }
          } catch {
            // Best-effort update
          }
          break;
        }

        case 'updated': {
          // Update session node metadata if it exists
          try {
            const nodes = await store.query.nodes({
              type: 'external',
              search: `entire://session/${sessionId}`,
              limit: 1,
            });

            if (nodes.length > 0) {
              await store.updateNode(nodes[0].id, {
                metadata: {
                  phase: session.phase,
                  lastPromptAt: session.lastPromptAt,
                },
              });
              flushManager.markDirty(nodes[0].id);
              flushManager.schedule();
            }
          } catch {
            // Best-effort update
          }
          break;
        }

        case 'deleted': {
          // Preserve history — don't delete nodes or edges
          break;
        }
      }
    },

    async correlate(sessionId: string, session: EntireSessionState): Promise<CorrelationResult> {
      // Create session node
      const sessionNodeId = await ensureSessionNode(session);

      // Correlate with tasks
      const tasks = await findCorrelatedTasks(session);
      const edgesCreated: string[] = [];
      const matchedForResult: MatchedTask[] = [];

      for (const task of tasks) {
        if (!meetsConfidenceThreshold(task.confidence, minConfidence)) continue;

        matchedForResult.push(task);
        const edgeId = await createEdgeIfNotExists(task.nodeId, sessionNodeId, 'worked-on', {
          _context: {
            correlation: task.matchReason,
            confidence: task.confidence,
            sessionAgent: session.agent,
          },
        });
        if (edgeId) edgesCreated.push(edgeId);
      }

      const result: CorrelationResult = {
        sessionId,
        matchedTasks: matchedForResult,
        edgesCreated,
        nodesCreated: [sessionNodeId],
        strategy: matchedForResult[0]?.matchReason ?? 'none',
        timestamp: new Date().toISOString(),
      };

      correlations.set(sessionId, result);
      return result;
    },

    getCorrelations(): Map<string, CorrelationResult> {
      return new Map(correlations);
    },
  };
}
