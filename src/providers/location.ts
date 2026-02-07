/**
 * Location-as-Provider for OpenTasks (Phase 3)
 *
 * Creates a Provider from a connected OpenTasks location,
 * enabling cross-location queries via the existing ProviderRegistry.
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Connection } from '../core/connections.js'
import type {
  Provider,
  ProviderNode,
  ProviderCapabilities,
  ParsedUri,
  ProviderFilter,
  ProviderCreateInput,
  ProviderUpdateInput,
} from './types.js'
import { ProviderError } from './types.js'

/**
 * Extended provider with ready() support and cleanup
 */
export interface LocationProvider extends Provider {
  /** Get ready issues from this location */
  ready(): Promise<ProviderNode[]>
  /** Close the database connection */
  close(): void
}

/**
 * Convert a SQLite row to a ProviderNode
 */
function toProviderNode(
  row: Record<string, unknown>,
  connection: Connection
): ProviderNode {
  return {
    id: row.id as string,
    uri: `opentasks://${connection.hash}/${row.id as string}`,
    type: (row.type as string) === 'issue' ? 'issue' : 'spec',
    title: row.title as string,
    content: row.content as string | undefined,
    status: row.status as string | undefined,
    priority: row.priority as number | undefined,
    rawData: row,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Create a Provider for a connected OpenTasks location
 *
 * @param connection - The connection to create a provider for
 * @param db - Optional pre-opened database (for daemon in-process use)
 * @returns A LocationProvider instance
 */
/**
 * Options for creating a LocationProvider
 */
export interface LocationProviderOptions {
  /** Pre-opened database (for daemon in-process use) */
  db?: DatabaseType
  /** Query result limit (default: 1000) */
  queryLimit?: number
}

export function createLocationProvider(
  connection: Connection,
  dbOrOptions?: DatabaseType | LocationProviderOptions
): LocationProvider {
  // Support both legacy signature (db) and new options object
  const options: LocationProviderOptions =
    dbOrOptions != null && typeof dbOrOptions === 'object' && 'prepare' in dbOrOptions
      ? { db: dbOrOptions as DatabaseType }
      : (dbOrOptions as LocationProviderOptions) ?? {}
  const db = options.db
  const queryLimit = options.queryLimit ?? 1000
  let ownedDb: DatabaseType | null = null

  function getDb(): DatabaseType {
    if (db) return db

    if (!ownedDb) {
      const cachePath = path.join(connection.path, 'cache.db')
      if (!fs.existsSync(cachePath)) {
        throw new Error(`Cache database not found: ${cachePath}`)
      }
      ownedDb = new Database(cachePath, { readonly: true })
      ownedDb.pragma('journal_mode = WAL')
    }

    return ownedDb
  }

  const capabilities: ProviderCapabilities = {
    read: true,
    write: false,
    search: true,
    watch: false,
  }

  return {
    name: `opentasks-${connection.hash}`,
    schemes: ['opentasks'],
    capabilities,

    parseUri(uri: string): ParsedUri | null {
      const match = uri.match(/^opentasks:\/\/([a-z0-9]+)\/(.+)$/)
      if (match && match[1] === connection.hash) {
        return { scheme: 'opentasks', workspace: match[1], id: match[2], isRelative: false }
      }
      return null
    },

    buildUri(id: string): string {
      return `opentasks://${connection.hash}/${id}`
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null
    },

    async get(id: string): Promise<ProviderNode | null> {
      try {
        const database = getDb()
        const row = database.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
        return row ? toProviderNode(row, connection) : null
      } catch {
        return null
      }
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      try {
        const database = getDb()
        const conditions: string[] = ['1=1']
        const params: unknown[] = []

        if (filter?.status) {
          conditions.push('status = ?')
          params.push(filter.status)
        }
        if (filter?.type) {
          conditions.push('type = ?')
          params.push(filter.type)
        }

        const limit = filter?.limit ?? queryLimit
        const sql = `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`
        const rows = database.prepare(sql).all(...params) as Record<string, unknown>[]
        return rows.map((r) => toProviderNode(r, connection))
      } catch {
        return []
      }
    },

    async create(): Promise<ProviderNode> {
      throw new ProviderError('NOT_SUPPORTED', 'Location provider is read-only', `opentasks-${connection.hash}`)
    },

    async update(): Promise<ProviderNode> {
      throw new ProviderError('NOT_SUPPORTED', 'Location provider is read-only', `opentasks-${connection.hash}`)
    },

    async delete(): Promise<void> {
      throw new ProviderError('NOT_SUPPORTED', 'Location provider is read-only', `opentasks-${connection.hash}`)
    },

    async ready(): Promise<ProviderNode[]> {
      try {
        const database = getDb()
        const rows = database.prepare('SELECT * FROM ready_issues').all() as Record<string, unknown>[]
        return rows.map((r) => toProviderNode(r, connection))
      } catch {
        return []
      }
    },

    close(): void {
      if (ownedDb) {
        ownedDb.close()
        ownedDb = null
      }
    },
  }
}

/**
 * Initialize location providers for all reachable connections
 *
 * @param connections - Available connections
 * @param basePath - Base path for resolving relative connection paths
 * @returns Array of created providers (caller should close when done)
 */
export function initializeLocationProviders(
  connections: Connection[],
  basePath?: string
): LocationProvider[] {
  const providers: LocationProvider[] = []

  for (const conn of connections) {
    const resolvedPath = basePath
      ? path.resolve(basePath, conn.path)
      : path.resolve(conn.path)

    const cachePath = path.join(resolvedPath, 'cache.db')
    if (!fs.existsSync(cachePath)) continue

    try {
      const resolvedConn = { ...conn, path: resolvedPath }
      const provider = createLocationProvider(resolvedConn)
      providers.push(provider)
    } catch {
      // Skip unreachable locations
    }
  }

  return providers
}
