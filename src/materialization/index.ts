/**
 * Materialization Stores — public API
 *
 * Git-native archival and rematerialization for external node snapshots.
 */

// Types
export type {
  MaterializationSnapshot,
  SessionSnapshot,
  CheckpointSnapshot,
  EdgeSnapshot,
  SnapshotProvenance,
  ArchivePolicy,
  GitArchiveStoreConfig,
  MaterializationStore,
  RemoteStore,
  RemoteStoreConfig,
  MaterializationArchiver,
  MaterializationArchiverConfig,
  ArchiveResult,
  BatchArchiveResult,
  ArchiveFilter,
  ArchiveListEntry,
  ArchiveEventResult,
  RematerializeAllResult,
  StoreStatus,
  GitArchiveStoreExtended,
  MaterializationProvider,
} from './types.js';

export { DEFAULT_ARCHIVE_POLICY, DEFAULT_GIT_ARCHIVE_CONFIG } from './types.js';

// Factories
export { createGitArchiveStore } from './git-archive-store.js';
export { createMaterializationArchiver } from './archiver.js';
export { createHttpRemoteStore } from './http-remote-store.js';
export { createGitRemoteStore } from './git-remote-store.js';
export {
  createRemoteStoresFromConfig,
  registerRemoteStoreFactory,
} from './remote-store-factory.js';

// Snapshot assembly
export {
  buildSnapshot,
  buildSessionSnapshot,
  buildCheckpointSnapshot,
  buildEdgeSnapshots,
  buildProvenance,
} from './snapshot.js';

// Graph ID resolution
export {
  resolveGraphId,
  slugify,
  slugifyRemoteUrl,
  getGitRemoteUrl,
  getGitBranch,
  getGitHead,
  resolveGitDir,
} from './graph-id.js';
