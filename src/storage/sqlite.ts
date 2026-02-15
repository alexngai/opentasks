/**
 * SQLite Persister for OpenTasks
 *
 * Fast query cache implementing the Storage interface.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { StoredNode, StoredEdge } from '../schema/storage.js';
import type { EdgeType } from '../schema/edges.js';
import type { Storage, Transaction, NodeFilter } from './interface.js';
import { resolveNodeFilter } from './interface.js';
import { ALL_SCHEMA, applyMigrations } from './sqlite-schema.js';
import { JSONLPersister } from './jsonl.js';

/**
 * Configuration for SQLite Persister
 */
export interface SQLitePersisterConfig {
  /** Path to the database file */
  path: string;

  /** Enable WAL mode for better concurrency (default: true) */
  walMode?: boolean;
}

/**
 * Map a database row to a StoredNode
 */
function rowToNode(row: Record<string, unknown>): StoredNode {
  const node: StoredNode = {
    id: row.id as string,
    uuid: row.uuid as string,
    type: row.type as string,
    title: row.title as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };

  // Add optional fields if present
  if (row.content != null) node.content = row.content as string;
  if (row.content_hash != null) node.content_hash = row.content_hash as string;
  if (row.status != null) node.status = row.status as string;
  if (row.priority != null) node.priority = row.priority as number;
  if (row.assignee != null) node.assignee = row.assignee as string;
  if (row.parent_id != null) node.parent_id = row.parent_id as string;
  if (row.source != null) node.source = row.source as string;
  if (row.archived != null) node.archived = row.archived === 1;
  if (row.target_id != null) node.target_id = row.target_id as string;
  if (row.feedback_type != null) node.feedback_type = row.feedback_type as string;
  if (row.thread_id != null) node.thread_id = row.thread_id as string;
  if (row.reply_to_id != null) node.reply_to_id = row.reply_to_id as string;
  if (row.resolved != null) node.resolved = row.resolved === 1;
  if (row.dismissed != null) node.dismissed = row.dismissed === 1;
  if (row.uri != null) node.uri = row.uri as string;
  if (row.materialized != null) node.materialized = row.materialized === 1;
  if (row.cached_at != null) node.cached_at = row.cached_at as string;
  if (row.stale != null) node.stale = row.stale === 1;
  if (row.external_status != null) node.external_status = row.external_status as string;
  if (row.claimed_by != null) node.claimed_by = row.claimed_by as string;
  if (row.claimed_at != null) node.claimed_at = row.claimed_at as string;
  if (row.lock_until != null) node.lock_until = row.lock_until as string;
  if (row.location != null) node.location = row.location as string;
  if (row.branch != null) node.branch = row.branch as string;

  return node;
}

/**
 * Map a database row to a StoredEdge
 */
function rowToEdge(row: Record<string, unknown>): StoredEdge {
  const edge: StoredEdge = {
    id: row.id as string,
    uuid: row.uuid as string,
    from_id: row.from_id as string,
    to_id: row.to_id as string,
    type: row.type as string,
    created_at: row.created_at as string,
    created_by: row.created_by as string | undefined,
    source: row.source as string | undefined,
  };

  // Add optional fields if present
  if (row.metadata != null) {
    try {
      edge.metadata = JSON.parse(row.metadata as string);
    } catch {
      // Ignore parse errors
    }
  }
  if (row.cached_at != null) edge.cached_at = row.cached_at as string;

  return edge;
}

/**
 * SQLite Persister
 *
 * Implements the Storage interface using better-sqlite3.
 */
export class SQLitePersister implements Storage {
  private db: DatabaseType;
  private readonly config: Required<SQLitePersisterConfig>;

  constructor(config: SQLitePersisterConfig) {
    this.config = {
      path: config.path,
      walMode: config.walMode ?? true,
    };

    this.db = new Database(this.config.path);

    // Enable WAL mode
    if (this.config.walMode) {
      this.db.pragma('journal_mode = WAL');
    }

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Initialize the database schema
   */
  initialize(): void {
    for (const sql of ALL_SCHEMA) {
      this.db.exec(sql);
    }
    // Apply any pending migrations for existing databases
    applyMigrations(this.db);
  }

  /**
   * Rebuild the database from a JSONL file
   */
  async rebuildFromJsonl(jsonlPath: string): Promise<void> {
    const persister = new JSONLPersister({ path: jsonlPath });
    const { nodes, edges } = await persister.load();

    // Clear existing data
    this.db.exec('DELETE FROM node_tags');
    this.db.exec('DELETE FROM edges');
    this.db.exec('DELETE FROM nodes');
    this.db.exec('DELETE FROM dirty_nodes');

    // Insert nodes
    for (const node of nodes) {
      await this.createNode(node);

      // Insert tags
      if (node.tags) {
        for (const tag of node.tags) {
          await this.addTag(node.id, tag);
        }
      }
    }

    // Insert edges
    for (const edge of edges) {
      await this.createEdge(edge);
    }
  }

  // === Node Operations ===

  async createNode(node: StoredNode): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (
        id, uuid, type, title, content, content_hash, status, priority,
        assignee, parent_id, source, archived, created_at, updated_at,
        target_id, feedback_type, thread_id, reply_to_id, resolved, dismissed,
        uri, materialized, cached_at, stale, external_status,
        claimed_by, claimed_at, lock_until, location, branch
      ) VALUES (
        @id, @uuid, @type, @title, @content, @content_hash, @status, @priority,
        @assignee, @parent_id, @source, @archived, @created_at, @updated_at,
        @target_id, @feedback_type, @thread_id, @reply_to_id, @resolved, @dismissed,
        @uri, @materialized, @cached_at, @stale, @external_status,
        @claimed_by, @claimed_at, @lock_until, @location, @branch
      )
    `);

    stmt.run({
      id: node.id,
      uuid: node.uuid,
      type: node.type,
      title: node.title,
      content: node.content ?? null,
      content_hash: node.content_hash ?? null,
      status: node.status ?? null,
      priority: node.priority ?? null,
      assignee: node.assignee ?? null,
      parent_id: node.parent_id ?? null,
      source: node.source ?? null,
      archived: node.archived ? 1 : 0,
      created_at: node.created_at,
      updated_at: node.updated_at,
      target_id: node.target_id ?? null,
      feedback_type: node.feedback_type ?? null,
      thread_id: node.thread_id ?? null,
      reply_to_id: node.reply_to_id ?? null,
      resolved: node.resolved ? 1 : null,
      dismissed: node.dismissed ? 1 : null,
      uri: node.uri ?? null,
      materialized: node.materialized ? 1 : node.materialized === false ? 0 : null,
      cached_at: node.cached_at ?? null,
      stale: node.stale ? 1 : null,
      external_status: node.external_status ?? null,
      claimed_by: node.claimed_by ?? null,
      claimed_at: node.claimed_at ?? null,
      lock_until: node.lock_until ?? null,
      location: node.location ?? null,
      branch: node.branch ?? null,
    });
  }

  async getNode(id: string): Promise<StoredNode | null> {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    const node = rowToNode(row);

    // Fetch tags
    const tags = await this.getTags(id);
    if (tags.length > 0) {
      node.tags = tags;
    }

    return node;
  }

  async updateNode(id: string, updates: Partial<StoredNode>): Promise<void> {
    const existing = await this.getNode(id);
    if (!existing) {
      throw new Error(`Node not found: ${id}`);
    }

    // Build SET clause dynamically
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    const updateableFields = [
      'title',
      'content',
      'content_hash',
      'status',
      'priority',
      'assignee',
      'parent_id',
      'source',
      'archived',
      'updated_at',
      'target_id',
      'feedback_type',
      'thread_id',
      'reply_to_id',
      'resolved',
      'dismissed',
      'uri',
      'materialized',
      'cached_at',
      'stale',
      'external_status',
      'claimed_by',
      'claimed_at',
      'lock_until',
      'location',
      'branch',
    ];

    for (const field of updateableFields) {
      if (field in updates) {
        fields.push(`${field} = @${field}`);
        let value = (updates as Record<string, unknown>)[field];

        // Convert booleans to integers
        if (typeof value === 'boolean') {
          value = value ? 1 : 0;
        }

        values[field] = value ?? null;
      }
    }

    if (fields.length === 0) return;

    const sql = `UPDATE nodes SET ${fields.join(', ')} WHERE id = @id`;
    const stmt = this.db.prepare(sql);
    stmt.run(values);
  }

  async deleteNode(id: string): Promise<void> {
    // Delete tags first (foreign key)
    this.db.prepare('DELETE FROM node_tags WHERE node_id = ?').run(id);

    // Delete edges involving this node
    this.db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id);

    // Delete the node
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  }

  async queryNodes(filter: NodeFilter): Promise<StoredNode[]> {
    const resolved = resolveNodeFilter(filter);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (resolved.type) {
      const placeholders = resolved.type.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
      params.push(...resolved.type);
    }

    if (resolved.status) {
      const placeholders = resolved.status.map(() => '?').join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...resolved.status);
    }

    if (resolved.parent_id) {
      conditions.push('parent_id = ?');
      params.push(resolved.parent_id);
    }

    if (resolved.archived !== null) {
      conditions.push('archived = ?');
      params.push(resolved.archived ? 1 : 0);
    }

    if (resolved.search) {
      conditions.push('(title LIKE ? OR content LIKE ?)');
      const pattern = `%${resolved.search}%`;
      params.push(pattern, pattern);
    }

    let sql = 'SELECT * FROM nodes';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY updated_at DESC';
    sql += ` LIMIT ${resolved.limit} OFFSET ${resolved.offset}`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    const nodes = rows.map(rowToNode);

    // Filter by tags if specified (AND semantics)
    if (resolved.tags && resolved.tags.length > 0) {
      const nodeIds = nodes.map((n) => n.id);
      const tagsMap = await this.getTagsForNodes(nodeIds);

      return nodes.filter((node) => {
        const nodeTags = tagsMap.get(node.id) || [];
        return resolved.tags!.every((tag) => nodeTags.includes(tag));
      });
    }

    return nodes;
  }

  // === Edge Operations ===

  async createEdge(edge: StoredEdge): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO edges (id, uuid, from_id, to_id, type, created_at, created_by, source, metadata, cached_at)
      VALUES (@id, @uuid, @from_id, @to_id, @type, @created_at, @created_by, @source, @metadata, @cached_at)
    `);

    stmt.run({
      id: edge.id,
      uuid: edge.uuid,
      from_id: edge.from_id,
      to_id: edge.to_id,
      type: edge.type,
      created_at: edge.created_at,
      created_by: edge.created_by ?? null,
      source: edge.source ?? null,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      cached_at: edge.cached_at ?? null,
    });
  }

  async getEdge(id: string): Promise<StoredEdge | null> {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToEdge(row) : null;
  }

  async deleteEdge(id: string): Promise<void> {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  }

  async getEdgesFrom(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
    let sql = 'SELECT * FROM edges WHERE from_id = ?';
    const params: unknown[] = [nodeId];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  async getEdgesTo(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
    let sql = 'SELECT * FROM edges WHERE to_id = ?';
    const params: unknown[] = [nodeId];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  // === Tag Operations ===

  async addTag(nodeId: string, tag: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)
    `);
    stmt.run(nodeId, tag);
    await this.markDirty(nodeId);
  }

  async removeTag(nodeId: string, tag: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM node_tags WHERE node_id = ? AND tag = ?');
    stmt.run(nodeId, tag);
    await this.markDirty(nodeId);
  }

  async getTags(nodeId: string): Promise<string[]> {
    const stmt = this.db.prepare('SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag');
    const rows = stmt.all(nodeId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  async getTagsForNodes(nodeIds: string[]): Promise<Map<string, string[]>> {
    if (nodeIds.length === 0) {
      return new Map();
    }

    const placeholders = nodeIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT node_id, tag FROM node_tags WHERE node_id IN (${placeholders}) ORDER BY tag
    `);
    const rows = stmt.all(...nodeIds) as Array<{ node_id: string; tag: string }>;

    const result = new Map<string, string[]>();
    for (const row of rows) {
      const tags = result.get(row.node_id) || [];
      tags.push(row.tag);
      result.set(row.node_id, tags);
    }

    return result;
  }

  async getNodesByTag(tag: string): Promise<StoredNode[]> {
    const stmt = this.db.prepare(`
      SELECT n.* FROM nodes n
      JOIN node_tags t ON n.id = t.node_id
      WHERE t.tag = ?
    `);
    const rows = stmt.all(tag) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  // === Queries ===

  async getReady(): Promise<StoredNode[]> {
    const stmt = this.db.prepare('SELECT * FROM ready_tasks');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  // === Transactions ===

  async runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous, so we wrap the sync operations
    // in a transaction block and execute async operations sequentially.
    //
    // Note: Reads within the transaction see committed state. Writes are deferred
    // until the end and executed atomically. This means reads won't see pending
    // writes from the same transaction, but this is acceptable for validation
    // use cases where we check existence of committed nodes.
    const operations: Array<() => void> = [];
    let result: T;

    const tx: Transaction = {
      // Read operations - execute immediately against committed state
      getNode: (id) => {
        return Promise.resolve(this.getNodeSync(id));
      },
      getEdge: (id) => {
        return Promise.resolve(this.getEdgeSync(id));
      },
      getTags: (nodeId) => {
        return Promise.resolve(this.getTagsSync(nodeId));
      },
      getEdgesFrom: (nodeId, type) => {
        return Promise.resolve(this.getEdgesFromSync(nodeId, type));
      },

      // Write operations - deferred until transaction commit
      createNode: (node) => {
        operations.push(() => this.createNodeSync(node));
        return Promise.resolve();
      },
      updateNode: (id, updates) => {
        operations.push(() => this.updateNodeSync(id, updates));
        return Promise.resolve();
      },
      createEdge: (edge) => {
        operations.push(() => this.createEdgeSync(edge));
        return Promise.resolve();
      },
      deleteEdge: (id) => {
        operations.push(() => this.deleteEdgeSync(id));
        return Promise.resolve();
      },
      addTag: (nodeId, tag) => {
        operations.push(() => this.addTagSync(nodeId, tag));
        return Promise.resolve();
      },
      removeTag: (nodeId, tag) => {
        operations.push(() => this.removeTagSync(nodeId, tag));
        return Promise.resolve();
      },
    };

    // Collect all operations from the async function
    result = await fn(tx);

    // Execute all operations in a sync transaction
    const syncTransaction = this.db.transaction(() => {
      for (const op of operations) {
        op();
      }
    });
    syncTransaction();

    return result;
  }

  // === Sync Internal Methods for Transactions ===

  private createNodeSync(node: StoredNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (
        id, uuid, type, title, content, content_hash, status, priority,
        assignee, parent_id, source, archived, created_at, updated_at,
        target_id, feedback_type, thread_id, reply_to_id, resolved, dismissed,
        uri, materialized, cached_at, stale, external_status,
        claimed_by, claimed_at, lock_until, location, branch
      ) VALUES (
        @id, @uuid, @type, @title, @content, @content_hash, @status, @priority,
        @assignee, @parent_id, @source, @archived, @created_at, @updated_at,
        @target_id, @feedback_type, @thread_id, @reply_to_id, @resolved, @dismissed,
        @uri, @materialized, @cached_at, @stale, @external_status,
        @claimed_by, @claimed_at, @lock_until, @location, @branch
      )
    `);

    stmt.run({
      id: node.id,
      uuid: node.uuid,
      type: node.type,
      title: node.title,
      content: node.content ?? null,
      content_hash: node.content_hash ?? null,
      status: node.status ?? null,
      priority: node.priority ?? null,
      assignee: node.assignee ?? null,
      parent_id: node.parent_id ?? null,
      source: node.source ?? null,
      archived: node.archived ? 1 : 0,
      created_at: node.created_at,
      updated_at: node.updated_at,
      target_id: node.target_id ?? null,
      feedback_type: node.feedback_type ?? null,
      thread_id: node.thread_id ?? null,
      reply_to_id: node.reply_to_id ?? null,
      resolved: node.resolved ? 1 : null,
      dismissed: node.dismissed ? 1 : null,
      uri: node.uri ?? null,
      materialized: node.materialized ? 1 : node.materialized === false ? 0 : null,
      cached_at: node.cached_at ?? null,
      stale: node.stale ? 1 : null,
      external_status: node.external_status ?? null,
      claimed_by: node.claimed_by ?? null,
      claimed_at: node.claimed_at ?? null,
      lock_until: node.lock_until ?? null,
      location: node.location ?? null,
      branch: node.branch ?? null,
    });
  }

  private updateNodeSync(id: string, updates: Partial<StoredNode>): void {
    // Build SET clause dynamically
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    const updateableFields = [
      'title',
      'content',
      'content_hash',
      'status',
      'priority',
      'assignee',
      'parent_id',
      'source',
      'archived',
      'updated_at',
      'target_id',
      'feedback_type',
      'thread_id',
      'reply_to_id',
      'resolved',
      'dismissed',
      'uri',
      'materialized',
      'cached_at',
      'stale',
      'external_status',
      'claimed_by',
      'claimed_at',
      'lock_until',
      'location',
      'branch',
    ];

    for (const field of updateableFields) {
      if (field in updates) {
        fields.push(`${field} = @${field}`);
        let value = (updates as Record<string, unknown>)[field];

        if (typeof value === 'boolean') {
          value = value ? 1 : 0;
        }

        values[field] = value ?? null;
      }
    }

    if (fields.length === 0) return;

    const sql = `UPDATE nodes SET ${fields.join(', ')} WHERE id = @id`;
    const stmt = this.db.prepare(sql);
    stmt.run(values);
  }

  private createEdgeSync(edge: StoredEdge): void {
    const stmt = this.db.prepare(`
      INSERT INTO edges (id, uuid, from_id, to_id, type, created_at, created_by, source, metadata, cached_at)
      VALUES (@id, @uuid, @from_id, @to_id, @type, @created_at, @created_by, @source, @metadata, @cached_at)
    `);

    stmt.run({
      id: edge.id,
      uuid: edge.uuid,
      from_id: edge.from_id,
      to_id: edge.to_id,
      type: edge.type,
      created_at: edge.created_at,
      created_by: edge.created_by ?? null,
      source: edge.source ?? null,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      cached_at: edge.cached_at ?? null,
    });
  }

  private deleteEdgeSync(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  }

  private addTagSync(nodeId: string, tag: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)
    `);
    stmt.run(nodeId, tag);
    this.markDirtySync(nodeId);
  }

  private removeTagSync(nodeId: string, tag: string): void {
    const stmt = this.db.prepare('DELETE FROM node_tags WHERE node_id = ? AND tag = ?');
    stmt.run(nodeId, tag);
    this.markDirtySync(nodeId);
  }

  private markDirtySync(nodeId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dirty_nodes (node_id, marked_at)
      VALUES (?, datetime('now'))
    `);
    stmt.run(nodeId);
  }

  // === Sync Read Methods for Transactions ===

  private getNodeSync(id: string): StoredNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const node = rowToNode(row);
    const tags = this.getTagsSync(id);
    if (tags.length > 0) {
      node.tags = tags;
    }
    return node;
  }

  private getEdgeSync(id: string): StoredEdge | null {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToEdge(row) : null;
  }

  private getTagsSync(nodeId: string): string[] {
    const stmt = this.db.prepare('SELECT tag FROM node_tags WHERE node_id = ? ORDER BY tag');
    const rows = stmt.all(nodeId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  private getEdgesFromSync(nodeId: string, type?: EdgeType): StoredEdge[] {
    let sql = 'SELECT * FROM edges WHERE from_id = ?';
    const params: unknown[] = [nodeId];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  // === Dirty Tracking ===

  async markDirty(nodeId: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dirty_nodes (node_id, marked_at)
      VALUES (?, datetime('now'))
    `);
    stmt.run(nodeId);
  }

  async getDirtyNodes(): Promise<string[]> {
    const stmt = this.db.prepare('SELECT node_id FROM dirty_nodes ORDER BY marked_at');
    const rows = stmt.all() as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  async clearDirty(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    const placeholders = nodeIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`DELETE FROM dirty_nodes WHERE node_id IN (${placeholders})`);
    stmt.run(...nodeIds);
  }

  // === Lifecycle ===

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Create a SQLite persister with default configuration
 */
export function createSQLitePersister(basePath: string): SQLitePersister {
  const persister = new SQLitePersister({
    path: `${basePath}/cache.db`,
    walMode: true,
  });
  persister.initialize();
  return persister;
}
