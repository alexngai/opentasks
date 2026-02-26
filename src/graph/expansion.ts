/**
 * Query Expansion for OpenTasks (Phase 3)
 *
 * Enables queries that span multiple OpenTasks locations.
 */

import type { StoredNode, StoredEdge } from '../schema/storage.js';
import type { Storage } from '../storage/interface.js';
import type { Connection } from '../core/connections.js';
import type { ProviderNode } from '../providers/types.js';
import type { LocationProvider } from '../providers/location.js';
import type { NodeResolver } from './query.js';
import { isOpentasksUri, parseOpentasksUri } from '../core/uri.js';

/**
 * Query expansion modes
 */
export type ExpansionMode =
  | 'none' // Only current location (default)
  | 'follow-refs' // Follow outbound edge references via providers
  | 'connections' // Query all declared connections
  | 'all'; // follow-refs + connections

/**
 * Expanded query result
 */
export interface ExpandedResult {
  /** Results from current location */
  local: StoredNode[];
  /** Results from connected locations, keyed by hash */
  connected: Record<string, ProviderNode[]>;
  /** Edges that span across locations */
  crossLocationEdges: StoredEdge[];
  /** All locations queried */
  queriedLocations: string[];
  /** Locations that were unreachable */
  unreachableLocations: string[];
  /** Completeness indicator */
  completeness: 'full' | 'partial';
}

/**
 * Options for expanded queries
 */
export interface ExpansionOptions {
  /** Expansion mode */
  expand?: ExpansionMode;
  /** Maximum number of locations to query (safety limit) */
  maxLocations?: number;
}

/**
 * Query expander for cross-location queries
 */
export interface QueryExpander {
  /**
   * Execute an expanded ready query
   */
  expandedReady(options?: ExpansionOptions): Promise<ExpandedResult>;

  /**
   * Execute an expanded node query
   */
  expandedQuery(
    filter: { type?: string; status?: string },
    options?: ExpansionOptions,
  ): Promise<ExpandedResult>;
}

/**
 * Query multiple providers in parallel using Promise.allSettled
 */
async function queryProvidersParallel(
  providers: Map<string, LocationProvider>,
  queryFn: (provider: LocationProvider) => Promise<ProviderNode[]>,
  maxLocations: number,
): Promise<{
  connected: Record<string, ProviderNode[]>;
  queriedLocations: string[];
  unreachableLocations: string[];
}> {
  const entries = [...providers.entries()].slice(0, maxLocations);

  const results = await Promise.allSettled(
    entries.map(async ([hash, provider]) => {
      const nodes = await queryFn(provider);
      return { hash, nodes };
    }),
  );

  const connected: Record<string, ProviderNode[]> = {};
  const queriedLocations: string[] = [];
  const unreachableLocations: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      connected[result.value.hash] = result.value.nodes;
      queriedLocations.push(result.value.hash);
    } else {
      // Find the hash for this failed entry by index
      const idx = results.indexOf(result);
      unreachableLocations.push(entries[idx][0]);
    }
  }

  return { connected, queriedLocations, unreachableLocations };
}

/**
 * Identify which provider hashes are referenced by local edges
 * via opentasks:// URIs in from_id or to_id fields.
 */
function getReferencedLocationHashes(edges: StoredEdge[], localHash: string): Set<string> {
  const hashes = new Set<string>();

  for (const edge of edges) {
    for (const field of [edge.from_id, edge.to_id]) {
      if (isOpentasksUri(field)) {
        const parsed = parseOpentasksUri(field);
        if (parsed?.locationHash && parsed.locationHash !== localHash) {
          hashes.add(parsed.locationHash);
        }
      }
    }
  }

  return hashes;
}

/**
 * Find edges that reference nodes in other locations
 */
function findCrossLocationEdges(
  edges: StoredEdge[],
  localHash: string,
  connectedHashes: Set<string>,
): StoredEdge[] {
  return edges.filter((edge) => {
    for (const field of [edge.from_id, edge.to_id]) {
      if (isOpentasksUri(field)) {
        const parsed = parseOpentasksUri(field);
        if (parsed?.locationHash && parsed.locationHash !== localHash) {
          return true;
        }
      }
    }
    // Also check if from_id or to_id appears as a hash-prefixed reference
    return false;
  });
}

/**
 * Statuses considered "closed" for cross-location blocker resolution
 */
const CLOSED_STATUSES = new Set(['closed', 'done', 'resolved', 'completed', 'cancelled']);

/**
 * Pattern for external URIs (opentasks:// or global://)
 */
const EXTERNAL_URI_PATTERN = /^(opentasks|global):\/\//;

/**
 * Create a query expander
 *
 * @param storage - Local storage
 * @param locationHash - Current location hash
 * @param locationProviders - Map of location hash → Provider
 * @param nodeResolver - Optional resolver for cross-provider blocker resolution
 */
export function createQueryExpander(
  storage: Storage,
  locationHash: string,
  locationProviders: Map<string, LocationProvider>,
  nodeResolver?: NodeResolver,
): QueryExpander {
  /**
   * Get all local edges for cross-location analysis
   */
  async function getLocalEdges(localNodeIds: string[]): Promise<StoredEdge[]> {
    const allEdges: StoredEdge[] = [];
    for (const nodeId of localNodeIds) {
      const edges = await storage.getEdgesFrom(nodeId);
      allEdges.push(...edges);
    }
    return allEdges;
  }

  /**
   * Select providers based on expansion mode
   */
  function selectProviders(
    mode: ExpansionMode,
    referencedHashes?: Set<string>,
  ): Map<string, LocationProvider> {
    if (mode === 'follow-refs' && referencedHashes) {
      // Only query locations referenced by local edges
      const selected = new Map<string, LocationProvider>();
      for (const hash of referencedHashes) {
        const provider = locationProviders.get(hash);
        if (provider) {
          selected.set(hash, provider);
        }
      }
      return selected;
    }

    if (mode === 'connections' || mode === 'all') {
      return locationProviders;
    }

    return new Map();
  }

  return {
    async expandedReady(options?: ExpansionOptions): Promise<ExpandedResult> {
      const mode = options?.expand ?? 'none';
      const maxLocations = options?.maxLocations ?? 10;

      // Always query local
      let local = await storage.getReady();

      // Post-filter: exclude tasks with active cross-location blockers
      if (nodeResolver && local.length > 0) {
        const filtered: StoredNode[] = [];
        for (const task of local) {
          const blockerEdges = await storage.getEdgesTo(task.id, 'blocks');
          let hasActiveCrossLocationBlocker = false;

          for (const edge of blockerEdges) {
            if (EXTERNAL_URI_PATTERN.test(edge.from_id)) {
              const blocker = await nodeResolver(edge.from_id);
              if (blocker && !blocker.archived && !CLOSED_STATUSES.has(blocker.status ?? '')) {
                hasActiveCrossLocationBlocker = true;
                break;
              }
            }
          }

          if (!hasActiveCrossLocationBlocker) {
            filtered.push(task);
          }
        }
        local = filtered;
      }

      if (mode === 'none') {
        return {
          local,
          connected: {},
          crossLocationEdges: [],
          queriedLocations: [locationHash],
          unreachableLocations: [],
          completeness: 'full',
        };
      }

      // For follow-refs, analyze local edges to find referenced locations
      let referencedHashes: Set<string> | undefined;
      let localEdges: StoredEdge[] = [];
      if (mode === 'follow-refs' || mode === 'all') {
        localEdges = await getLocalEdges(local.map((n) => n.id));
        referencedHashes = getReferencedLocationHashes(localEdges, locationHash);
      }

      // Select providers based on mode
      const providers = selectProviders(mode, referencedHashes);

      // For 'all' mode, include all connected providers too
      if (mode === 'all') {
        for (const [hash, provider] of locationProviders.entries()) {
          providers.set(hash, provider);
        }
      }

      // Query providers in parallel
      const { connected, queriedLocations, unreachableLocations } = await queryProvidersParallel(
        providers,
        (provider) => provider.ready(),
        maxLocations,
      );

      // Identify cross-location edges
      if (localEdges.length === 0 && mode === 'connections') {
        localEdges = await getLocalEdges(local.map((n) => n.id));
      }
      const connectedHashes = new Set(queriedLocations);
      const crossLocationEdges = findCrossLocationEdges(localEdges, locationHash, connectedHashes);

      return {
        local,
        connected,
        crossLocationEdges,
        queriedLocations: [locationHash, ...queriedLocations],
        unreachableLocations,
        completeness: unreachableLocations.length === 0 ? 'full' : 'partial',
      };
    },

    async expandedQuery(
      filter: { type?: string; status?: string },
      options?: ExpansionOptions,
    ): Promise<ExpandedResult> {
      const mode = options?.expand ?? 'none';
      const maxLocations = options?.maxLocations ?? 10;

      const local = await storage.queryNodes({
        type: filter.type,
        status: filter.status,
      });

      if (mode === 'none') {
        return {
          local,
          connected: {},
          crossLocationEdges: [],
          queriedLocations: [locationHash],
          unreachableLocations: [],
          completeness: 'full',
        };
      }

      // For follow-refs, analyze local edges to find referenced locations
      let referencedHashes: Set<string> | undefined;
      let localEdges: StoredEdge[] = [];
      if (mode === 'follow-refs' || mode === 'all') {
        localEdges = await getLocalEdges(local.map((n) => n.id));
        referencedHashes = getReferencedLocationHashes(localEdges, locationHash);
      }

      // Select providers based on mode
      const providers = selectProviders(mode, referencedHashes);

      // For 'all' mode, include all connected providers too
      if (mode === 'all') {
        for (const [hash, provider] of locationProviders.entries()) {
          providers.set(hash, provider);
        }
      }

      // Query providers in parallel
      const { connected, queriedLocations, unreachableLocations } = await queryProvidersParallel(
        providers,
        (provider) => provider.list(filter),
        maxLocations,
      );

      // Identify cross-location edges
      if (localEdges.length === 0 && mode === 'connections') {
        localEdges = await getLocalEdges(local.map((n) => n.id));
      }
      const connectedHashes = new Set(queriedLocations);
      const crossLocationEdges = findCrossLocationEdges(localEdges, locationHash, connectedHashes);

      return {
        local,
        connected,
        crossLocationEdges,
        queriedLocations: [locationHash, ...queriedLocations],
        unreachableLocations,
        completeness: unreachableLocations.length === 0 ? 'full' : 'partial',
      };
    },
  };
}
