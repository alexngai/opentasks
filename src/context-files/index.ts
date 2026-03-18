/**
 * Context Files
 *
 * Support for context nodes that reference codebase files (code, markdown, etc.).
 * Context-file nodes are lightweight pointers with versioning metadata (commit SHA,
 * content hash). File content is resolved on demand, not stored in the graph.
 *
 * @packageDocumentation
 */

// Types
export type {
  ContextFileMetadata,
  ContextFileType,
  ContextFileResolution,
  DriftResult,
  CreateContextFileInput,
  SyncContextFileOptions,
} from './types.js';

// Resolver
export {
  contentHash,
  getHeadCommit,
  readFileFromWorktree,
  readFileAtCommit,
  resolveContextFile,
  fileExists,
  fileExistsAtCommit,
  inferFileType,
} from './resolver.js';

// Core API
export type { ContextFileManager } from './context-files.js';
export {
  isContextFileNode,
  getContextFileMetadata,
  createContextFileManager,
} from './context-files.js';

// Watcher integration
export type { ContextFileWatcherOptions } from './watcher-integration.js';
export { createContextFileChangeHandler } from './watcher-integration.js';
