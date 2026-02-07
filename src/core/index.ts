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
  resolveLocationTarget,
  resolveOpentasksUri,
  isOpentasksUri,
  buildOpentasksUri,
  buildLocalUri,
  type ParsedOpentasksUri,
  type ResolvedLocationTarget,
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

// Conditional Redirects (Phase 3)
export {
  evaluateConditions,
  findConditionalRedirectRule,
  type RedirectCondition,
  type ConditionalRedirectRule,
  type RedirectContext,
} from './conditional-redirects.js'

// Worktree Management (Phase 3)
export {
  worktreeSetup,
  worktreeTeardown,
  registerWorktree,
  unregisterWorktree,
  findWorktree,
  listWorktrees,
  readWorktreeRegistry,
  writeWorktreeRegistry,
  getGitCommonDir,
  getCurrentBranch,
  getRegistryPath,
  type WorktreeEntry,
  type WorktreeRegistry,
  type WorktreeSetupOptions,
  type WorktreeTeardownOptions,
} from './worktree.js'

// Merge Driver (Phase 3)
export {
  mergeJsonl,
  parseJsonlToMap,
  writeJsonlFromMap,
  fieldLevelMerge,
  deepEqual,
  installMergeDriver,
} from './merge-driver.js'
