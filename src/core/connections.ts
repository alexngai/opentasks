/**
 * Connection Management for OpenTasks (Phase 2)
 *
 * Manages explicit connections between OpenTasks locations.
 * No filesystem discovery — all connections are declared in config.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LocationIdentity } from './location.js';

/**
 * Connection role
 */
export type ConnectionRole = 'peer' | 'parent' | 'child';

/**
 * Connection to another OpenTasks location
 */
export interface Connection {
  /** Location hash of the target */
  hash: string;
  /** Path to the target .opentasks directory (relative or absolute) */
  path: string;
  /** Relationship role */
  role: ConnectionRole;
  /** Human-readable name */
  name: string;
}

/**
 * Health status of a connection
 */
export type ConnectionHealth = 'reachable' | 'unreachable' | 'hash-mismatch';

/**
 * Connection with health information
 */
export interface ConnectionStatus {
  connection: Connection;
  health: ConnectionHealth;
  error?: string;
}

/**
 * Read the config.json of a target location
 *
 * @param opentasksPath - Path to the target .opentasks directory
 * @returns The parsed config or null if not readable
 */
function readTargetConfig(opentasksPath: string): Record<string, unknown> | null {
  try {
    const configPath = path.join(opentasksPath, 'config.json');
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Extract location identity from a config object
 */
function extractLocation(config: Record<string, unknown>): LocationIdentity | null {
  const loc = config.location as Record<string, unknown> | undefined;
  if (!loc || typeof loc.hash !== 'string' || typeof loc.uuid !== 'string') {
    return null;
  }
  return {
    hash: loc.hash as string,
    uuid: loc.uuid as string,
    name: (loc.name as string) || '',
  };
}

/**
 * Create a connection to another OpenTasks location
 *
 * Reads the target's config.json to get its hash and name.
 *
 * @param targetPath - Path to the target .opentasks directory
 * @param role - Relationship role (default: 'peer')
 * @param basePath - Base path for computing relative paths
 * @returns New connection, or throws on error
 */
export function createConnection(
  targetPath: string,
  role: ConnectionRole = 'peer',
  basePath?: string,
): Connection {
  const resolvedTarget = path.resolve(targetPath);

  // Read target config
  const config = readTargetConfig(resolvedTarget);
  if (!config) {
    throw new Error(`Cannot read config at: ${resolvedTarget}/config.json`);
  }

  const location = extractLocation(config);
  if (!location) {
    throw new Error(`No valid location identity in: ${resolvedTarget}/config.json`);
  }

  // Compute relative path if base is provided
  const connectionPath = basePath ? path.relative(basePath, resolvedTarget) : resolvedTarget;

  return {
    hash: location.hash,
    path: connectionPath,
    role,
    name: location.name,
  };
}

/**
 * Check the health of a connection
 *
 * @param connection - The connection to check
 * @param basePath - Base path for resolving relative paths
 * @returns Connection status with health information
 */
export function checkConnectionHealth(connection: Connection, basePath?: string): ConnectionStatus {
  const resolvedPath = basePath
    ? path.resolve(basePath, connection.path)
    : path.resolve(connection.path);

  // 1. Does the path exist?
  if (!fs.existsSync(resolvedPath)) {
    return {
      connection,
      health: 'unreachable',
      error: `Path does not exist: ${resolvedPath}`,
    };
  }

  // 2. Is there a valid config.json?
  const config = readTargetConfig(resolvedPath);
  if (!config) {
    return {
      connection,
      health: 'unreachable',
      error: `Cannot read config.json at: ${resolvedPath}`,
    };
  }

  // 3. Does the hash match?
  const location = extractLocation(config);
  if (!location) {
    return {
      connection,
      health: 'unreachable',
      error: `No valid location identity in config.json`,
    };
  }

  if (location.hash !== connection.hash) {
    return {
      connection,
      health: 'hash-mismatch',
      error: `Expected hash ${connection.hash}, found ${location.hash}`,
    };
  }

  return {
    connection,
    health: 'reachable',
  };
}

/**
 * Add a connection to a list, replacing any existing connection with the same hash
 *
 * @param connections - Existing connections
 * @param newConnection - Connection to add
 * @returns Updated connections list
 */
export function addConnection(connections: Connection[], newConnection: Connection): Connection[] {
  // Remove existing with same hash
  const filtered = connections.filter((c) => c.hash !== newConnection.hash);
  return [...filtered, newConnection];
}

/**
 * Remove a connection by hash
 *
 * @param connections - Existing connections
 * @param hash - Hash of the connection to remove
 * @returns Updated connections list
 */
export function removeConnection(connections: Connection[], hash: string): Connection[] {
  return connections.filter((c) => c.hash !== hash);
}

/**
 * Find a connection by hash
 *
 * @param connections - Connections to search
 * @param hash - Location hash to find
 * @returns The connection or undefined
 */
export function findConnection(connections: Connection[], hash: string): Connection | undefined {
  return connections.find((c) => c.hash === hash);
}

/**
 * Get health status for all connections
 *
 * @param connections - Connections to check
 * @param basePath - Base path for resolving relative paths
 * @returns Array of connection statuses
 */
export function checkAllConnectionHealth(
  connections: Connection[],
  basePath?: string,
): ConnectionStatus[] {
  return connections.map((c) => checkConnectionHealth(c, basePath));
}
