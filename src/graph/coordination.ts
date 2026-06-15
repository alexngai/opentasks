/**
 * Coordination Types and ClaimManager for OpenTasks
 *
 * Provides agent context, work claiming, and execution tracking.
 */

import type { Storage } from '../storage/interface.js';
import type { StoredNode } from '../schema/storage.js';

// ============================================================================
// Agent Context Types
// ============================================================================

/**
 * Context for operations - tracks who is performing the operation
 */
export interface OperationContext {
  /** Unique identifier for the agent */
  agentId: string;

  /** Human-readable agent name (optional) */
  agentName?: string;

  /** Session identifier for grouping related operations */
  sessionId?: string;

  /** ISO timestamp when operation was initiated */
  timestamp?: string;
}

/**
 * Standard metadata conventions for nodes
 */
export interface StandardNodeMetadata {
  /** Execution context when node was created/modified */
  execution?: ExecutionMetadata;

  /** Work tracking information */
  tracking?: TrackingMetadata;

  /** External system integration info */
  external?: ExternalSyncMetadata;

  /** Custom fields (namespaced by convention) */
  custom?: Record<string, unknown>;
}

/**
 * Execution metadata - tracks agent activity
 */
export interface ExecutionMetadata {
  /** When work started on this node */
  startedAt?: string;

  /** When work completed */
  completedAt?: string;

  /** Duration in milliseconds */
  durationMs?: number;

  /** Which agent performed the work */
  agentId?: string;

  /** Agent's session when work was done */
  sessionId?: string;
}

/**
 * Work tracking metadata
 */
export interface TrackingMetadata {
  /** Estimated time in minutes */
  estimatedMinutes?: number;

  /** Actual time spent in minutes */
  actualMinutes?: number;

  /** Complexity assessment */
  complexity?: 'trivial' | 'simple' | 'moderate' | 'complex' | 'unknown';

  /** Number of attempts */
  attempts?: number;

  /** Tags for categorization */
  labels?: string[];
}

/**
 * External sync metadata
 */
export interface ExternalSyncMetadata {
  /** URI of the source system */
  syncedFrom?: string;

  /** Last sync timestamp */
  syncedAt?: string;

  /** Version/revision from external system */
  externalVersion?: string;

  /** Hash of external content for change detection */
  externalHash?: string;

  /** Whether local has uncommitted changes */
  localModified?: boolean;
}

// ============================================================================
// Claim Types
// ============================================================================

/**
 * Information about a claim on a node
 */
export interface ClaimInfo {
  /** Node that is claimed */
  nodeId: string;

  /** Agent holding the claim */
  agentId: string;

  /** When the claim was acquired */
  claimedAt: string;

  /** When the claim expires (soft lock) */
  lockUntil: string;

  /** Fence token for this claim — monotonic per node; guards stale release/renew */
  fence?: number;

  /** Whether the claim is still valid */
  isValid: boolean;

  /** Whether the claim has expired */
  isExpired: boolean;

  /** Remaining time in milliseconds */
  remainingMs: number;
}

/**
 * Options for claiming a node
 */
export interface ClaimOptions {
  /** Duration in milliseconds (default: 30 minutes) */
  durationMs?: number;

  /** Force claim even if already claimed by another agent */
  force?: boolean;

  /** Reason for claiming (stored in metadata) */
  reason?: string;
}

/**
 * Result of a claim operation
 */
export interface ClaimResult {
  /** Whether the claim was successful */
  success: boolean;

  /** Claim info if successful */
  claim?: ClaimInfo;

  /** Error message if failed */
  error?: string;

  /** Existing claim info if blocked by another agent */
  existingClaim?: ClaimInfo;
}

// ============================================================================
// ClaimManager Interface
// ============================================================================

/**
 * Manages work claims for coordinating multiple agents
 */
export interface ClaimManager {
  /**
   * Claim a node for exclusive work
   *
   * @param nodeId - Node to claim
   * @param agentId - Agent requesting the claim
   * @param options - Claim options
   * @returns Claim result
   */
  claim(nodeId: string, agentId: string, options?: ClaimOptions): Promise<ClaimResult>;

  /**
   * Release a claim on a node
   *
   * @param nodeId - Node to release
   * @param agentId - Agent releasing (must match claim holder)
   * @returns Whether release was successful
   */
  release(nodeId: string, agentId: string, fence?: number): Promise<boolean>;

  /**
   * Renew/extend a claim
   *
   * @param nodeId - Node with existing claim
   * @param agentId - Agent holding the claim
   * @param durationMs - New duration from now
   * @returns Updated claim result
   */
  renew(nodeId: string, agentId: string, durationMs?: number, fence?: number): Promise<ClaimResult>;

  /**
   * Get claim information for a node
   *
   * @param nodeId - Node to check
   * @returns Claim info or null if not claimed
   */
  getClaim(nodeId: string): Promise<ClaimInfo | null>;

  /**
   * Check if a node is claimed by a specific agent
   *
   * @param nodeId - Node to check
   * @param agentId - Agent to check for
   * @returns Whether the agent holds the claim
   */
  isClaimedBy(nodeId: string, agentId: string): Promise<boolean>;

  /**
   * Get all claims held by an agent
   *
   * @param agentId - Agent to query
   * @returns Array of claim info
   */
  getClaimsFor(agentId: string): Promise<ClaimInfo[]>;

  /**
   * Get all expired claims (for cleanup)
   *
   * @returns Array of expired claim info
   */
  getExpiredClaims(): Promise<ClaimInfo[]>;

  /**
   * Clean up expired claims
   *
   * @returns Number of claims cleaned up
   */
  cleanupExpired(): Promise<number>;
}

// ============================================================================
// ClaimManager Implementation
// ============================================================================

/** Default claim duration: 30 minutes */
const DEFAULT_CLAIM_DURATION_MS = 30 * 60 * 1000;

/**
 * Create claim info from a stored node
 */
function nodeToClaimInfo(node: StoredNode): ClaimInfo | null {
  if (!node.claimed_by || !node.claimed_at || !node.lock_until) {
    return null;
  }

  const now = Date.now();
  const lockUntil = new Date(node.lock_until).getTime();
  const isExpired = now > lockUntil;
  const remainingMs = Math.max(0, lockUntil - now);

  return {
    nodeId: node.id,
    agentId: node.claimed_by,
    claimedAt: node.claimed_at,
    lockUntil: node.lock_until,
    fence: node.claim_fence,
    isValid: !isExpired,
    isExpired,
    remainingMs,
  };
}

/** Remaining lease time in ms (0 if no/elapsed lease) */
function computeRemainingMs(lockUntil?: string): number {
  if (!lockUntil) return 0;
  return Math.max(0, new Date(lockUntil).getTime() - Date.now());
}

/** Build ClaimInfo for a claim the caller now holds */
function toHeldClaim(
  nodeId: string,
  agentId: string,
  claimedAt: string | undefined,
  lockUntil: string | undefined,
  fence: number | undefined,
): ClaimInfo {
  return {
    nodeId,
    agentId,
    claimedAt: claimedAt ?? new Date().toISOString(),
    lockUntil: lockUntil ?? '',
    fence,
    isValid: true,
    isExpired: false,
    remainingMs: computeRemainingMs(lockUntil),
  };
}

/** Build ClaimInfo describing the existing holder that blocked an operation */
function toExistingClaim(
  nodeId: string,
  agentId: string,
  claimedAt: string | undefined,
  lockUntil: string | undefined,
): ClaimInfo {
  const remainingMs = computeRemainingMs(lockUntil);
  return {
    nodeId,
    agentId,
    claimedAt: claimedAt ?? '',
    lockUntil: lockUntil ?? '',
    isValid: remainingMs > 0,
    isExpired: remainingMs <= 0,
    remainingMs,
  };
}

/**
 * Create a ClaimManager backed by storage
 */
export function createClaimManager(storage: Storage): ClaimManager {
  return {
    async claim(nodeId: string, agentId: string, options?: ClaimOptions): Promise<ClaimResult> {
      const durationMs = options?.durationMs ?? DEFAULT_CLAIM_DURATION_MS;
      const force = options?.force ?? false;

      // Existence check for a precise error message. The claim decision itself
      // is made atomically by storage.claimNode (a single conditional UPDATE),
      // so there is no read-modify-write race — a node deleted between here and
      // the claim simply yields ok:false.
      const node = await storage.getNode(nodeId);
      if (!node) {
        return { success: false, error: `Node not found: ${nodeId}` };
      }

      const outcome = await storage.claimNode(nodeId, agentId, { leaseMs: durationMs, force });

      if (!outcome.ok) {
        return {
          success: false,
          error: outcome.claimedBy
            ? `Node is claimed by ${outcome.claimedBy}`
            : `Cannot claim node: ${nodeId}`,
          existingClaim: outcome.claimedBy
            ? toExistingClaim(nodeId, outcome.claimedBy, outcome.claimedAt, outcome.lockUntil)
            : undefined,
        };
      }

      return {
        success: true,
        claim: toHeldClaim(nodeId, agentId, outcome.claimedAt, outcome.lockUntil, outcome.fence),
      };
    },

    async release(nodeId: string, agentId: string, fence?: number): Promise<boolean> {
      return storage.releaseNode(nodeId, agentId, fence != null ? { fence } : undefined);
    },

    async renew(
      nodeId: string,
      agentId: string,
      durationMs?: number,
      fence?: number,
    ): Promise<ClaimResult> {
      const duration = durationMs ?? DEFAULT_CLAIM_DURATION_MS;

      const outcome = await storage.renewNode(nodeId, agentId, { leaseMs: duration, fence });

      if (!outcome.ok) {
        let error: string;
        if (!outcome.claimedBy) {
          error = 'Node is not claimed';
        } else if (outcome.claimedBy === agentId) {
          error = 'Fence token mismatch';
        } else {
          error = `Node is claimed by ${outcome.claimedBy}`;
        }
        return {
          success: false,
          error,
          existingClaim: outcome.claimedBy
            ? toExistingClaim(nodeId, outcome.claimedBy, outcome.claimedAt, outcome.lockUntil)
            : undefined,
        };
      }

      return {
        success: true,
        claim: toHeldClaim(nodeId, agentId, outcome.claimedAt, outcome.lockUntil, outcome.fence),
      };
    },

    async getClaim(nodeId: string): Promise<ClaimInfo | null> {
      const node = await storage.getNode(nodeId);
      if (!node) {
        return null;
      }

      return nodeToClaimInfo(node);
    },

    async isClaimedBy(nodeId: string, agentId: string): Promise<boolean> {
      const claim = await this.getClaim(nodeId);
      return claim !== null && claim.isValid && claim.agentId === agentId;
    },

    async getClaimsFor(agentId: string): Promise<ClaimInfo[]> {
      // Query all nodes claimed by this agent
      const nodes = await storage.queryNodes({});
      const claims: ClaimInfo[] = [];

      for (const node of nodes) {
        if (node.claimed_by === agentId) {
          const claim = nodeToClaimInfo(node);
          if (claim) {
            claims.push(claim);
          }
        }
      }

      return claims;
    },

    async getExpiredClaims(): Promise<ClaimInfo[]> {
      const nodes = await storage.queryNodes({});
      const expired: ClaimInfo[] = [];

      for (const node of nodes) {
        const claim = nodeToClaimInfo(node);
        if (claim && claim.isExpired) {
          expired.push(claim);
        }
      }

      return expired;
    },

    async cleanupExpired(): Promise<number> {
      // Atomic, per-row guarded clear — never clobbers a freshly re-claimed task
      // (the previous read-then-write version could).
      const cleared = await storage.sweepExpiredClaims();
      return cleared.length;
    },
  };
}
