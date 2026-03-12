/**
 * Snapshot Assembly
 *
 * Builds self-contained MaterializationSnapshots from GraphStore nodes and edges.
 * Snapshots contain everything needed to reconstruct the node in a fresh graph.
 */

import type { GraphStore } from '../graph/store.js';
import type { ExternalNode } from '../schema/nodes.js';
import type { Edge } from '../schema/edges.js';
import type {
  MaterializationSnapshot,
  SessionSnapshot,
  CheckpointSnapshot,
  EdgeSnapshot,
  SnapshotProvenance,
} from './types.js';
import {
  resolveGraphId,
  resolveGitDir,
  getGitRemoteUrl,
  getGitBranch,
  getGitHead,
} from './graph-id.js';

// ============================================================================
// Provenance Resolution
// ============================================================================

/**
 * Build provenance metadata for a snapshot
 */
export function buildProvenance(options: {
  graphId: string;
  opentasksPath: string;
}): SnapshotProvenance {
  const { graphId, opentasksPath } = options;
  const gitDir = resolveGitDir(opentasksPath);

  return {
    graphId,
    graphPath: opentasksPath,
    gitRemote: gitDir ? (getGitRemoteUrl(gitDir) ?? undefined) : undefined,
    gitBranch: gitDir ? (getGitBranch(gitDir) ?? undefined) : undefined,
    gitHead: gitDir ? (getGitHead(gitDir) ?? undefined) : undefined,
  };
}

// ============================================================================
// Node URI Resolution
// ============================================================================

/**
 * Resolve a graph node ID to its URI.
 * External nodes have a URI directly; internal nodes use opentasks:// scheme.
 */
async function resolveNodeUri(nodeId: string, store: GraphStore): Promise<string> {
  try {
    const nodes = await store.query.nodes({
      search: nodeId,
      limit: 1,
    });

    if (nodes.length > 0) {
      const node = nodes[0] as unknown as Record<string, unknown>;
      if (node.type === 'external' && node.uri) {
        return node.uri as string;
      }
      return `opentasks://${node.id}`;
    }
  } catch {
    // Fall through
  }
  return `opentasks://${nodeId}`;
}

// ============================================================================
// Edge Snapshot Building
// ============================================================================

/**
 * Build portable edge snapshots from graph edges.
 * Converts internal node IDs to URIs for cross-graph portability.
 */
export async function buildEdgeSnapshots(
  nodeId: string,
  store: GraphStore,
): Promise<EdgeSnapshot[]> {
  const snapshots: EdgeSnapshot[] = [];

  try {
    // Get all edges involving this node (both directions)
    const edges = await store.query.edges({ from_id: nodeId });
    const incomingEdges = await store.query.edges({ to_id: nodeId });
    const allEdges: Edge[] = [...edges, ...incomingEdges];

    // Deduplicate by edge ID
    const seen = new Set<string>();
    for (const edge of allEdges) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);

      const fromUri = await resolveNodeUri(edge.from_id, store);
      const toUri = await resolveNodeUri(edge.to_id, store);

      snapshots.push({
        fromUri,
        toUri,
        edgeType: edge.type,
        metadata: edge.metadata,
      });
    }
  } catch {
    // Best-effort edge capture
  }

  return snapshots;
}

// ============================================================================
// Snapshot Builders
// ============================================================================

/**
 * Build a session snapshot from a session ExternalNode
 */
export async function buildSessionSnapshot(
  node: ExternalNode,
  store: GraphStore,
  provenance: SnapshotProvenance,
): Promise<SessionSnapshot> {
  const edges = await buildEdgeSnapshots(node.id, store);

  // Extract checkpoint IDs from 'contains' edges
  const checkpointIds = edges
    .filter((e) => e.edgeType === 'contains')
    .map((e) => {
      const match = e.toUri.match(/sessionlog:\/\/checkpoint\/(.+)/);
      return match ? match[1] : e.toUri;
    });

  return {
    version: 1,
    uri: node.uri,
    source: node.source ?? 'sessionlog',
    entityType: 'session',
    createdAt: node.created_at,
    archivedAt: new Date().toISOString(),
    node: {
      title: node.title,
      content: node.content,
      status: (node as unknown as Record<string, unknown>).status as string | undefined,
      external_status: node.external_status,
      external_data: node.external_data ?? (node.metadata as Record<string, unknown>) ?? {},
      tags: node.tags,
    },
    provenance,
    edges,
    checkpointIds,
  };
}

/**
 * Build a checkpoint snapshot from a checkpoint ExternalNode
 */
export async function buildCheckpointSnapshot(
  node: ExternalNode,
  store: GraphStore,
  provenance: SnapshotProvenance,
): Promise<CheckpointSnapshot> {
  const externalData = node.external_data ?? (node.metadata as Record<string, unknown>) ?? {};

  return {
    version: 1,
    uri: node.uri,
    source: node.source ?? 'sessionlog',
    entityType: 'checkpoint',
    createdAt: node.created_at,
    archivedAt: new Date().toISOString(),
    node: {
      title: node.title,
      content: node.content,
      status: (node as unknown as Record<string, unknown>).status as string | undefined,
      external_status: node.external_status,
      external_data: externalData,
      tags: node.tags,
    },
    provenance,
    codeCommit: externalData.commitHash as string | undefined,
    sessionUri: externalData.sessionId ? `sessionlog://session/${externalData.sessionId}` : '',
  };
}

/**
 * Build a generic snapshot for any ExternalNode
 */
export async function buildSnapshot(
  node: ExternalNode,
  store: GraphStore,
  provenance: SnapshotProvenance,
): Promise<MaterializationSnapshot> {
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const entityType = metadata?.entityType as string | undefined;

  if (entityType === 'session') {
    return buildSessionSnapshot(node, store, provenance);
  }
  if (entityType === 'checkpoint') {
    return buildCheckpointSnapshot(node, store, provenance);
  }

  // Generic external node snapshot
  return {
    version: 1,
    uri: node.uri,
    source: node.source ?? 'unknown',
    entityType: entityType ?? 'unknown',
    createdAt: node.created_at,
    archivedAt: new Date().toISOString(),
    node: {
      title: node.title,
      content: node.content,
      status: (node as unknown as Record<string, unknown>).status as string | undefined,
      external_status: node.external_status,
      external_data: node.external_data ?? metadata ?? {},
      tags: node.tags,
    },
    provenance,
  };
}
