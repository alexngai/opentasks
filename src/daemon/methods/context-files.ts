/**
 * Context Files Method Handlers
 *
 * JSON-RPC method handlers for context-file operations via IPC.
 * Delegates to ContextFileManager for file-backed context nodes.
 */

import * as path from 'node:path';
import type { IPCServer } from '../ipc.js';
import type { LocationResolver } from '../location-state.js';
import { createContextFileManager } from '../../context-files/context-files.js';
import type {
  CreateContextFileInput,
  SyncContextFileOptions,
  ContextFileResolution,
  DriftResult,
} from '../../context-files/types.js';
import type { Context } from '../../schema/index.js';

// ============================================================================
// Types
// ============================================================================

export interface ContextFilesMethodsOptions {
  server: IPCServer;
  locationResolver: LocationResolver;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Derive repo root from the opentasks path.
 *
 * Handles both layouts:
 * - `.opentasks/` → parent is repo root
 * - `.git/opentasks/` → grandparent is repo root
 * - `.swarm/opentasks/` → grandparent is repo root
 */
function deriveRepoRoot(opentasksPath: string): string {
  const parent = path.dirname(opentasksPath);
  const parentBase = path.basename(parent);
  if (parentBase === '.git' || parentBase === '.swarm') {
    return path.dirname(parent);
  }
  return parent;
}

// ============================================================================
// Implementation
// ============================================================================

export function registerContextFilesMethods(options: ContextFilesMethodsOptions): void {
  const { server, locationResolver } = options;

  // contextFiles.create - Create a context-file node
  server.handle<CreateContextFileInput & { location?: string }, Context>(
    'contextFiles.create',
    async (params) => {
      if (!params?.filePath) {
        throw new Error('Missing required parameter: filePath');
      }

      const { location, ...input } = params as CreateContextFileInput & { location?: string };
      const state = locationResolver.resolve(location);
      const repoRoot = deriveRepoRoot(state.opentasksPath);
      const manager = createContextFileManager(state.store, repoRoot);

      const node = await manager.create(input);

      state.flushManager.markDirty(node.id);
      state.flushManager.schedule();

      return node;
    },
  );

  // contextFiles.resolve - Resolve a context-file node's content
  server.handle<
    { id: string; atCapturedCommit?: boolean; location?: string },
    ContextFileResolution
  >('contextFiles.resolve', async (params) => {
    if (!params?.id) {
      throw new Error('Missing required parameter: id');
    }

    const state = locationResolver.resolve(params.location);
    const repoRoot = deriveRepoRoot(state.opentasksPath);
    const manager = createContextFileManager(state.store, repoRoot);

    if (params.atCapturedCommit) {
      return manager.resolveAtCapturedCommit(params.id);
    }
    return manager.resolve(params.id);
  });

  // contextFiles.checkDrift - Check if a context-file has drifted
  server.handle<{ id: string; location?: string }, DriftResult>(
    'contextFiles.checkDrift',
    async (params) => {
      if (!params?.id) {
        throw new Error('Missing required parameter: id');
      }

      const state = locationResolver.resolve(params.location);
      const repoRoot = deriveRepoRoot(state.opentasksPath);
      const manager = createContextFileManager(state.store, repoRoot);

      return manager.checkDrift(params.id);
    },
  );

  // contextFiles.sync - Re-pin a context-file to current HEAD
  server.handle<{ id: string; force?: boolean; location?: string }, Context>(
    'contextFiles.sync',
    async (params) => {
      if (!params?.id) {
        throw new Error('Missing required parameter: id');
      }

      const state = locationResolver.resolve(params.location);
      const repoRoot = deriveRepoRoot(state.opentasksPath);
      const manager = createContextFileManager(state.store, repoRoot);

      const syncOptions: SyncContextFileOptions = { force: params.force };
      const node = await manager.sync(params.id, syncOptions);

      state.flushManager.markDirty(node.id);
      state.flushManager.schedule();

      return node;
    },
  );

  // contextFiles.checkDriftBatch - Batch drift check for multiple nodes
  server.handle<{ ids: string[]; location?: string }, DriftResult[]>(
    'contextFiles.checkDriftBatch',
    async (params) => {
      if (!params?.ids?.length) {
        throw new Error('Missing required parameter: ids');
      }

      const state = locationResolver.resolve(params.location);
      const repoRoot = deriveRepoRoot(state.opentasksPath);
      const manager = createContextFileManager(state.store, repoRoot);

      return Promise.all(params.ids.map((id) => manager.checkDrift(id)));
    },
  );
}
