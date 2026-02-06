/**
 * Core utilities for OpenTasks
 *
 * @packageDocumentation
 */

// ID generation
export {
  generateId,
  generateIdFromUuid,
  typePrefix,
  adaptiveLength,
  hexToBase36,
  parseIdPrefix,
  inferTypeFromId,
  type IdNodeType,
  type GeneratedId,
} from './id.js'

// Content hashing
export { sha256, computeContentHash, contentEqual } from './hash.js'

// Location identity (Phase 2)
export {
  generateLocationHash,
  generateLocationHashFallback,
  generateLocationIdentity,
  getGitRemoteUrl,
  getGitRoot,
  isValidLocationHash,
  type LocationIdentity,
} from './location.js'

// URI scheme (Phase 2)
export {
  parseOpentasksUri,
  resolveOpentasksUri,
  isOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
  type ParsedOpentasksUri,
  type ResolvedLocation,
} from './uri.js'

// Connections (Phase 2)
export {
  createConnection,
  checkConnectionHealth,
  addConnection,
  removeConnection,
  findConnection,
  checkAllConnectionHealth,
  type Connection,
  type ConnectionRole,
  type ConnectionHealth,
  type ConnectionStatus,
} from './connections.js'

// Redirects (Phase 2)
export {
  matchPattern,
  findRedirectRule,
  resolveRedirect,
  resolveOperationRedirect,
  type RedirectOperation,
  type RedirectRule,
  type RedirectResult,
} from './redirects.js'
