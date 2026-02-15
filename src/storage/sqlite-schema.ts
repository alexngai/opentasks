/**
 * SQLite schema definitions for OpenTasks
 */

/**
 * Create nodes table
 */
export const CREATE_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  uuid TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  content_hash TEXT,
  status TEXT,
  priority INTEGER,
  assignee TEXT,
  parent_id TEXT,
  source TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- Feedback fields
  target_id TEXT,
  feedback_type TEXT,
  thread_id TEXT,
  reply_to_id TEXT,
  resolved INTEGER,
  dismissed INTEGER,

  -- External fields
  uri TEXT,
  materialized INTEGER,
  cached_at TEXT,
  stale INTEGER,
  external_status TEXT,

  -- Coordination
  claimed_by TEXT,
  claimed_at TEXT,
  lock_until TEXT,

  -- Context
  location TEXT,
  branch TEXT,

  FOREIGN KEY (parent_id) REFERENCES nodes(id)
)
`

/**
 * Create tags join table
 */
export const CREATE_NODE_TAGS_TABLE = `
CREATE TABLE IF NOT EXISTS node_tags (
  node_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (node_id, tag),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
)
`

/**
 * Create edges table
 */
export const CREATE_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  uuid TEXT UNIQUE NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  source TEXT,
  metadata TEXT,
  cached_at TEXT
)
`

/**
 * Create dirty tracking table
 */
export const CREATE_DIRTY_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS dirty_nodes (
  node_id TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL
)
`

/**
 * Create export hashes table
 */
export const CREATE_EXPORT_HASHES_TABLE = `
CREATE TABLE IF NOT EXISTS export_hashes (
  node_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL
)
`

/**
 * Create indexes
 */
export const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_nodes_archived ON nodes(archived)',
  'CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag)',
  'CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type)',
  'CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)',
  'CREATE INDEX IF NOT EXISTS idx_edges_cached_at ON edges(cached_at)',
]

/**
 * Create ready_tasks view
 * Shows tasks that are open, not archived, and have no open blockers
 */
export const CREATE_READY_VIEW = `
CREATE VIEW IF NOT EXISTS ready_tasks AS
SELECT n.* FROM nodes n
WHERE n.type = 'task'
  AND n.status = 'open'
  AND n.archived = 0
  AND NOT EXISTS (
    SELECT 1 FROM edges e
    JOIN nodes blocker ON e.from_id = blocker.id
    WHERE e.to_id = n.id
      AND e.type = 'blocks'
      AND blocker.status != 'closed'
      AND blocker.archived = 0
  )
`

/**
 * Migration statements for existing databases
 * These are idempotent (safe to run multiple times)
 */
export const MIGRATIONS = [
  // Add metadata and cached_at columns to edges table (v1.1.0)
  `ALTER TABLE edges ADD COLUMN metadata TEXT`,
  `ALTER TABLE edges ADD COLUMN cached_at TEXT`,
]

/**
 * Apply migrations safely (ignores "duplicate column" errors)
 */
export function applyMigrations(db: { exec: (sql: string) => void }): void {
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration)
    } catch (error) {
      // Ignore "duplicate column name" errors (migration already applied)
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('duplicate column name')) {
        throw error
      }
    }
  }
}

/**
 * All schema creation statements in order
 */
export const ALL_SCHEMA = [
  CREATE_NODES_TABLE,
  CREATE_NODE_TAGS_TABLE,
  CREATE_EDGES_TABLE,
  CREATE_DIRTY_NODES_TABLE,
  CREATE_EXPORT_HASHES_TABLE,
  ...CREATE_INDEXES,
  CREATE_READY_VIEW,
]
