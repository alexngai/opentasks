/**
 * Content hashing for OpenTasks
 *
 * Used for deduplication during merge and change detection.
 */

import { createHash } from 'node:crypto';
import type { StoredNode } from '../schema/storage.js';

/**
 * Compute SHA256 hash of a string
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute content hash for a node
 *
 * Only includes substantive fields (content that affects semantics).
 * Excludes: id, uuid, timestamps, coordination fields, metadata.
 *
 * @param node - The node to hash
 * @returns SHA256 hash as hex string
 */
export function computeContentHash(node: StoredNode): string {
  // Build object with only substantive fields
  const substantive: Record<string, unknown> = {
    type: node.type,
    title: node.title,
    content: node.content,
    status: node.status,
    priority: node.priority,
    tags: node.tags ? [...node.tags].sort() : undefined,
    parent_id: node.parent_id,
  };

  // Add type-specific substantive fields
  if (node.type === 'task') {
    substantive.assignee = node.assignee;
  }

  if (node.type === 'feedback') {
    substantive.target_id = node.target_id;
    substantive.feedback_type = node.feedback_type;
    substantive.target_anchor = node.target_anchor;
  }

  if (node.type === 'attempt') {
    // The task being attempted + the assignee identify the attempt. The
    // outcome/evidence live in metadata (excluded from the content hash by
    // design) — an attempt is identified by id, not content-deduped.
    substantive.target_id = node.target_id;
    substantive.assignee = node.assignee;
  }

  if (node.type === 'external') {
    substantive.uri = node.uri;
    substantive.source = node.source;
  }

  // Remove undefined values for consistent hashing
  const cleaned = Object.fromEntries(
    Object.entries(substantive).filter(([_, v]) => v !== undefined),
  );

  // Sort keys for deterministic JSON
  const sortedKeys = Object.keys(cleaned).sort();
  const orderedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    orderedObj[key] = cleaned[key];
  }

  return sha256(JSON.stringify(orderedObj));
}

/**
 * Check if two nodes have the same content (ignoring non-substantive fields)
 */
export function contentEqual(a: StoredNode, b: StoredNode): boolean {
  return computeContentHash(a) === computeContentHash(b);
}
