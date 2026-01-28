/**
 * OpenTasks Storage - Persistence interfaces and implementations
 *
 * @packageDocumentation
 */

// Interfaces
export type {
  Storage,
  Transaction,
  NodeFilter,
  ResolvedNodeFilter,
} from './interface.js'

export { resolveNodeFilter } from './interface.js'

// JSONL Persister
export {
  JSONLPersister,
  createJSONLPersister,
  type JSONLPersisterConfig,
  type LoadResult,
} from './jsonl.js'

// SQLite Persister
export {
  SQLitePersister,
  createSQLitePersister,
  type SQLitePersisterConfig,
} from './sqlite.js'

// Utilities
export {
  atomicWrite,
  appendToFile,
  fileExists,
  readFileOrEmpty,
} from './atomic-write.js'
