/**
 * Materialization Archiver
 *
 * Coordinator between event sources (auto-linker, CLI) and stores
 * (git archive, remote). Builds snapshots and fans out to all enabled stores.
 */

import type { GraphStore } from '../graph/store.js';
import type { ExternalNode } from '../schema/nodes.js';
import type {
  MaterializationArchiver,
  MaterializationArchiverConfig,
  MaterializationStore,
  RemoteStore,
  ArchiveEventResult,
  ArchiveFilter,
  ArchiveListEntry,
  RematerializeAllResult,
} from './types.js';
import { buildSnapshot, buildProvenance } from './snapshot.js';

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a MaterializationArchiver
 */
export function createMaterializationArchiver(
  config: MaterializationArchiverConfig,
): MaterializationArchiver {
  const { gitStore, remoteStores, policy, graphId, graphPath } = config;
  let materializationProvider = config.materializationProvider;
  const provenance = buildProvenance({ graphId, opentasksPath: graphPath });

  /**
   * Find an ExternalNode by URI in the graph store
   */
  async function findNodeByUri(uri: string, store: GraphStore): Promise<ExternalNode | null> {
    try {
      const nodes = await store.query.nodes({
        type: 'external',
        search: uri,
        limit: 1,
      });

      for (const node of nodes) {
        const extNode = node as unknown as ExternalNode;
        if (extNode.uri === uri) {
          return extNode;
        }
      }
    } catch {
      // Node not found
    }
    return null;
  }

  /**
   * Fan out a snapshot to all enabled stores
   */
  async function fanOut(
    snapshot: import('./types.js').MaterializationSnapshot,
    eventType?: string,
  ): Promise<ArchiveEventResult> {
    const allStores: Array<MaterializationStore | RemoteStore> = [gitStore];

    // Add remote stores that are interested in this event
    for (const remote of remoteStores) {
      if (!remote.enabled) continue;
      if (eventType && remote.events.length > 0 && !remote.events.includes(eventType)) continue;
      allStores.push(remote);
    }

    const results = await Promise.allSettled(
      allStores.map(async (store) => {
        const result = await store.archive(snapshot);
        return {
          storeName: store.name,
          stored: result.stored,
          error: result.error,
        };
      }),
    );

    return {
      uri: snapshot.uri,
      stores: results.map((r) =>
        r.status === 'fulfilled'
          ? r.value
          : { storeName: 'unknown', stored: false, error: r.reason?.message ?? 'Unknown error' },
      ),
    };
  }

  return {
    async onSessionEvent(
      eventType: string,
      sessionUri: string,
      store: GraphStore,
    ): Promise<ArchiveEventResult> {
      // Check policy
      if (eventType === 'started' && !policy.archiveOnStart) {
        return { uri: sessionUri, stores: [] };
      }
      if (eventType === 'checkpoint' && !policy.archiveOnCheckpoint) {
        return { uri: sessionUri, stores: [] };
      }
      if (eventType === 'ended' && !policy.archiveOnEnd) {
        return { uri: sessionUri, stores: [] };
      }

      // Find the node in the graph
      let node = await findNodeByUri(sessionUri, store);
      if (!node) {
        return {
          uri: sessionUri,
          stores: [{ storeName: 'all', stored: false, error: 'Node not found in graph' }],
        };
      }

      // Materialize before archive if configured
      if (policy.materializeBeforeArchive && materializationProvider) {
        try {
          node = await materializationProvider.materializeNode(sessionUri);
        } catch {
          // Fall through — use existing node data
        }
      }

      // Build snapshot
      const snapshot = await buildSnapshot(node, store, provenance);

      // Fan out to stores
      return fanOut(snapshot, `session.${eventType}`);
    },

    async archiveNode(uri: string, store: GraphStore): Promise<ArchiveEventResult> {
      let node = await findNodeByUri(uri, store);
      if (!node) {
        return {
          uri,
          stores: [{ storeName: 'all', stored: false, error: 'Node not found in graph' }],
        };
      }

      // Materialize before archive if configured
      if (policy.materializeBeforeArchive && materializationProvider) {
        try {
          node = await materializationProvider.materializeNode(uri);
        } catch {
          // Fall through — use existing node data
        }
      }

      const snapshot = await buildSnapshot(node, store, provenance);
      return fanOut(snapshot);
    },

    async rematerialize(uri: string, store: GraphStore): Promise<boolean> {
      // Try git store first
      const snapshot = await gitStore.retrieve(uri);
      if (!snapshot) {
        // Try remote stores
        for (const remote of remoteStores) {
          if (!remote.enabled) continue;
          const remoteSnapshot = await remote.retrieve(uri);
          if (remoteSnapshot) {
            return reconstructNode(remoteSnapshot, store);
          }
        }
        return false;
      }

      return reconstructNode(snapshot, store);
    },

    async rematerializeAll(store: GraphStore): Promise<RematerializeAllResult> {
      const result: RematerializeAllResult = {
        restored: 0,
        failed: 0,
        skipped: 0,
        errors: [],
      };

      // Find all edges that reference external URIs
      // Then check which URIs don't have corresponding nodes
      try {
        const allEdges = await store.query.edges({});
        const referencedUris = new Set<string>();

        for (const edge of allEdges) {
          if (edge.from_id.includes('://')) referencedUris.add(edge.from_id);
          if (edge.to_id.includes('://')) referencedUris.add(edge.to_id);
        }

        // Check which URIs have nodes
        for (const uri of referencedUris) {
          const existing = await findNodeByUri(uri, store);
          if (existing) {
            result.skipped++;
            continue;
          }

          // Try to rematerialize
          try {
            const restored = await this.rematerialize(uri, store);
            if (restored) {
              result.restored++;
            } else {
              result.skipped++; // Not in archive either
            }
          } catch (error) {
            result.failed++;
            result.errors.push({
              uri,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch {
        // Best-effort
      }

      return result;
    },

    async listArchived(filter?: ArchiveFilter): Promise<ArchiveListEntry[]> {
      // Merge results from all stores
      const entries: ArchiveListEntry[] = [];

      const gitEntries = await gitStore.list(filter);
      entries.push(...gitEntries);

      for (const remote of remoteStores) {
        if (!remote.enabled) continue;
        try {
          const remoteEntries = await remote.list(filter);
          entries.push(...remoteEntries);
        } catch {
          // Best-effort from each store
        }
      }

      // Deduplicate by URI (prefer git store entries)
      const seen = new Set<string>();
      return entries.filter((entry) => {
        if (seen.has(entry.uri)) return false;
        seen.add(entry.uri);
        return true;
      });
    },

    setMaterializationProvider(provider: import('./types.js').MaterializationProvider): void {
      materializationProvider = provider;
    },

    async initialize(): Promise<void> {
      await gitStore.initialize();
      for (const remote of remoteStores) {
        if (remote.enabled) {
          try {
            await remote.initialize();
          } catch {
            // Remote store init failure is non-fatal
          }
        }
      }
    },

    async close(): Promise<void> {
      await gitStore.close();
      for (const remote of remoteStores) {
        try {
          await remote.close();
        } catch {
          // Best-effort
        }
      }
    },
  };
}

// ============================================================================
// Node Reconstruction
// ============================================================================

/**
 * Reconstruct an ExternalNode in the GraphStore from a snapshot
 */
async function reconstructNode(
  snapshot: import('./types.js').MaterializationSnapshot,
  store: GraphStore,
): Promise<boolean> {
  try {
    await store.createNode({
      type: 'external',
      uri: snapshot.uri,
      source: snapshot.source,
      title: snapshot.node.title,
      content: snapshot.node.content,
      metadata: {
        external_status: snapshot.node.external_status,
        external_data: snapshot.node.external_data,
        cached_at: snapshot.archivedAt,
        materialized: true,
        restored_from_archive: true,
        restored_at: new Date().toISOString(),
        entityType: snapshot.entityType,
      },
    });

    return true;
  } catch {
    // Node may already exist
    return false;
  }
}
