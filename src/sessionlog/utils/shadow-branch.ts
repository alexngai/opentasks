/**
 * Shadow Branch Utilities
 *
 * Standalone utilities for shadow branch name generation, parsing,
 * and classification. Extracted from checkpoint-store.ts for reuse.
 *
 * Ported from Go: checkpoint/temporary.go, strategy/cleanup.go
 */

import * as crypto from 'node:crypto';
import {
  SHADOW_BRANCH_PREFIX,
  SHADOW_BRANCH_HASH_LENGTH,
  CHECKPOINTS_BRANCH,
} from '../types.js';
import { listBranches, deleteBranch } from '../git-operations.js';

/** Worktree ID hash length (6 hex characters) */
const WORKTREE_ID_HASH_LENGTH = 6;

/**
 * Options for overriding default branch naming.
 */
export interface ShadowBranchOptions {
  /** Prefix for shadow branches (default: SHADOW_BRANCH_PREFIX from types) */
  shadowBranchPrefix?: string;
  /** Git branch for committed checkpoints (default: CHECKPOINTS_BRANCH from types) */
  checkpointsBranch?: string;
}

/**
 * Hash a worktree identifier to a short hex string.
 */
export function hashWorktreeID(worktreeID: string): string {
  return crypto
    .createHash('sha256')
    .update(worktreeID)
    .digest('hex')
    .slice(0, WORKTREE_ID_HASH_LENGTH);
}

/**
 * Returns the shadow branch name for a base commit hash and worktree identifier.
 * Format: <prefix><commit[:7]>-<hash(worktreeID)[:6]>
 */
export function shadowBranchNameForCommit(
  baseCommit: string,
  worktreeID?: string,
  options?: ShadowBranchOptions,
): string {
  const prefix = options?.shadowBranchPrefix ?? SHADOW_BRANCH_PREFIX;
  const commitPart = baseCommit.slice(0, SHADOW_BRANCH_HASH_LENGTH);
  if (worktreeID) {
    const worktreeHash = hashWorktreeID(worktreeID);
    return `${prefix}${commitPart}-${worktreeHash}`;
  }
  return `${prefix}${commitPart}`;
}

/**
 * Parse a shadow branch name to extract commit prefix and worktree hash.
 * Returns null if the branch name doesn't match the shadow branch pattern.
 */
export function parseShadowBranchName(
  branchName: string,
  options?: ShadowBranchOptions,
): { commitPrefix: string; worktreeHash: string } | null {
  const prefix = options?.shadowBranchPrefix ?? SHADOW_BRANCH_PREFIX;
  const checkpointsBranch = options?.checkpointsBranch ?? CHECKPOINTS_BRANCH;

  if (!branchName.startsWith(prefix)) return null;
  if (branchName === checkpointsBranch) return null;

  const suffix = branchName.slice(prefix.length);
  const lastDash = suffix.lastIndexOf('-');

  if (lastDash === -1 || lastDash === 0 || lastDash === suffix.length - 1) {
    // No dash or dash at boundary — old format with just commit prefix
    return { commitPrefix: suffix, worktreeHash: '' };
  }

  return {
    commitPrefix: suffix.slice(0, lastDash),
    worktreeHash: suffix.slice(lastDash + 1),
  };
}

/**
 * Returns true if the branch name matches the shadow branch pattern.
 * The checkpoints branch is NOT a shadow branch.
 */
export function isShadowBranch(branchName: string, options?: ShadowBranchOptions): boolean {
  const prefix = options?.shadowBranchPrefix ?? SHADOW_BRANCH_PREFIX;
  const checkpointsBranch = options?.checkpointsBranch ?? CHECKPOINTS_BRANCH;

  if (branchName === checkpointsBranch) return false;
  const pattern = new RegExp(
    `^${prefix.replace('/', '\\/')}[0-9a-f]{${SHADOW_BRANCH_HASH_LENGTH},}(-[0-9a-f]{${WORKTREE_ID_HASH_LENGTH},})?$`,
  );
  return pattern.test(branchName);
}

/**
 * List all shadow branches in the repository.
 * Returns an empty array if no shadow branches exist.
 */
export async function listShadowBranches(cwd?: string, options?: ShadowBranchOptions): Promise<string[]> {
  const allBranches = await listBranches(cwd);
  return allBranches.filter((b) => isShadowBranch(b, options));
}

/**
 * Delete the specified shadow branches from the repository.
 * Returns two arrays: successfully deleted and failed to delete.
 */
export async function deleteShadowBranches(
  branches: string[],
  cwd?: string,
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const branch of branches) {
    try {
      await deleteBranch(branch, false, cwd);
      deleted.push(branch);
    } catch {
      failed.push(branch);
    }
  }

  return { deleted, failed };
}
