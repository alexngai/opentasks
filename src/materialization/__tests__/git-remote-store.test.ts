/**
 * Tests for Git Remote Store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGitRemoteStore } from '../git-remote-store.js';
import type {
  RemoteStoreConfig,
  MaterializationSnapshot,
  SessionSnapshot,
  CheckpointSnapshot,
} from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeSnapshot(overrides?: Partial<MaterializationSnapshot>): MaterializationSnapshot {
  return {
    version: 1,
    uri: 'sessionlog://session/test-123',
    source: 'sessionlog',
    entityType: 'session',
    createdAt: '2026-01-01T00:00:00Z',
    archivedAt: '2026-01-01T01:00:00Z',
    node: {
      title: 'Test Session',
      content: 'Test content',
      external_data: { agent: 'claude' },
    },
    provenance: {
      graphId: 'test-graph',
      graphPath: '/test/.opentasks',
    },
    ...overrides,
  };
}

function makeSessionSnapshot(overrides?: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    ...makeSnapshot({ entityType: 'session' }),
    edges: [
      { fromUri: 'sessionlog://session/test-123', toUri: 'opentasks://task/1', edgeType: 'linked' },
    ],
    checkpointIds: ['cp-1'],
    ...overrides,
  } as SessionSnapshot;
}

function makeCheckpointSnapshot(overrides?: Partial<CheckpointSnapshot>): CheckpointSnapshot {
  return {
    ...makeSnapshot({
      uri: 'sessionlog://checkpoint/cp-1',
      entityType: 'checkpoint',
    }),
    codeCommit: 'abc123',
    sessionUri: 'sessionlog://session/test-123',
    ...overrides,
  } as CheckpointSnapshot;
}

let tmpDir: string;
let remoteRepoPath: string;
let cacheRepoPath: string;

function createBareRemoteRepo(): string {
  const repoPath = path.join(tmpDir, 'remote.git');
  fs.mkdirSync(repoPath, { recursive: true });
  execSync(`git init --bare "${repoPath}"`, { stdio: 'pipe' });
  return repoPath;
}

function makeConfig(overrides?: Partial<RemoteStoreConfig>): RemoteStoreConfig {
  return {
    type: 'git-remote',
    name: 'test-git-remote',
    enabled: true,
    config: {
      url: remoteRepoPath,
      cachePath: cacheRepoPath,
      pushPolicy: 'immediate',
      fetchBeforeRead: false, // Disable to avoid extra fetches in unit tests
    },
    events: ['session.ended'],
    ...overrides,
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-remote-store-test-'));
  remoteRepoPath = createBareRemoteRepo();
  cacheRepoPath = path.join(tmpDir, 'cache.git');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('Git Remote Store', () => {
  describe('creation', () => {
    it('should create a store with valid config', () => {
      const store = createGitRemoteStore(makeConfig());
      expect(store.name).toBe('test-git-remote');
      expect(store.type).toBe('git-remote');
      expect(store.enabled).toBe(true);
      expect(store.events).toEqual(['session.ended']);
    });

    it('should throw if URL is missing', () => {
      expect(() =>
        createGitRemoteStore(
          makeConfig({
            config: {},
          }),
        ),
      ).toThrow('url');
    });
  });

  describe('initialize', () => {
    it('should create bare repo cache and archive branch', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      // Cache repo should exist
      expect(fs.existsSync(path.join(cacheRepoPath, 'HEAD'))).toBe(true);

      // Archive branch should exist
      const branches = execSync(`git -C "${cacheRepoPath}" branch`, {
        encoding: 'utf-8',
      });
      expect(branches).toContain('opentasks/archive');
    });

    it('should be idempotent', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();
      await store.initialize(); // Should not throw
    });

    it('should use custom branch name', async () => {
      const store = createGitRemoteStore(
        makeConfig({
          config: {
            url: remoteRepoPath,
            cachePath: cacheRepoPath,
            branch: 'custom/archive',
          },
        }),
      );
      await store.initialize();

      const branches = execSync(`git -C "${cacheRepoPath}" branch`, {
        encoding: 'utf-8',
      });
      expect(branches).toContain('custom/archive');
    });
  });

  describe('archive', () => {
    it('should archive a session snapshot', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const snapshot = makeSnapshot();
      const result = await store.archive(snapshot);

      expect(result.stored).toBe(true);
      expect(result.uri).toBe('sessionlog://session/test-123');
    });

    it('should archive a session with edges', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const snapshot = makeSessionSnapshot();
      const result = await store.archive(snapshot);

      expect(result.stored).toBe(true);

      // Verify edges.json was written
      const edgesContent = execSync(
        `git -C "${cacheRepoPath}" show opentasks/archive:"test-graph/sessions/test-123/edges.json"`,
        { encoding: 'utf-8' },
      );
      const edges = JSON.parse(edgesContent);
      expect(edges).toHaveLength(1);
      expect(edges[0].edgeType).toBe('linked');
    });

    it('should archive a checkpoint snapshot', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const snapshot = makeCheckpointSnapshot();
      const result = await store.archive(snapshot);

      expect(result.stored).toBe(true);
      expect(result.uri).toBe('sessionlog://checkpoint/cp-1');

      // Verify file path
      const content = execSync(
        `git -C "${cacheRepoPath}" show opentasks/archive:"test-graph/sessions/test-123/checkpoints/cp-1.json"`,
        { encoding: 'utf-8' },
      );
      const parsed = JSON.parse(content);
      expect(parsed.codeCommit).toBe('abc123');
    });

    it('should push to remote on immediate policy', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(makeSnapshot());

      // Remote should have the branch
      const remoteBranches = execSync(`git -C "${remoteRepoPath}" branch`, { encoding: 'utf-8' });
      expect(remoteBranches).toContain('opentasks/archive');
    });

    it('should not push on on-close policy until close', async () => {
      const store = createGitRemoteStore(
        makeConfig({
          config: {
            url: remoteRepoPath,
            cachePath: cacheRepoPath,
            pushPolicy: 'on-close',
          },
        }),
      );
      await store.initialize();

      await store.archive(makeSnapshot());

      // Remote should NOT have the branch yet (it's a fresh repo)
      const remoteBranches = execSync(`git -C "${remoteRepoPath}" branch`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      // Fresh bare repo with no pushes has no branches
      expect(remoteBranches).not.toContain('opentasks/archive');

      // Now close — should push
      await store.close();

      const remoteBranchesAfter = execSync(`git -C "${remoteRepoPath}" branch`, {
        encoding: 'utf-8',
      });
      expect(remoteBranchesAfter).toContain('opentasks/archive');
    });

    it('should handle multiple archives', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const r1 = await store.archive(makeSnapshot({ uri: 'sessionlog://session/s1' }));
      const r2 = await store.archive(makeSnapshot({ uri: 'sessionlog://session/s2' }));

      expect(r1.stored).toBe(true);
      expect(r2.stored).toBe(true);
    });
  });

  describe('archiveBatch', () => {
    it('should archive multiple snapshots', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const result = await store.archiveBatch([
        makeSnapshot({ uri: 'sessionlog://session/s1' }),
        makeSnapshot({ uri: 'sessionlog://session/s2' }),
      ]);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
    });
  });

  describe('retrieve', () => {
    it('should retrieve an archived session snapshot', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const snapshot = makeSnapshot();
      await store.archive(snapshot);

      const retrieved = await store.retrieve('sessionlog://session/test-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.uri).toBe('sessionlog://session/test-123');
      expect(retrieved!.node.title).toBe('Test Session');
    });

    it('should retrieve an archived checkpoint snapshot', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(makeCheckpointSnapshot());

      const retrieved = await store.retrieve('sessionlog://checkpoint/cp-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.uri).toBe('sessionlog://checkpoint/cp-1');
      expect((retrieved as CheckpointSnapshot).codeCommit).toBe('abc123');
    });

    it('should return null for unknown URI', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const retrieved = await store.retrieve('sessionlog://session/nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should return null for invalid URI format', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const retrieved = await store.retrieve('invalid-uri');
      expect(retrieved).toBeNull();
    });

    it('should fetch from remote before reading when fetchBeforeRead is enabled', async () => {
      const store = createGitRemoteStore(
        makeConfig({
          config: {
            url: remoteRepoPath,
            cachePath: cacheRepoPath,
            fetchBeforeRead: true,
            pushPolicy: 'immediate',
          },
        }),
      );
      await store.initialize();

      // Archive a snapshot (pushes to remote)
      await store.archive(makeSnapshot());

      // Create a second cache that reads from the same remote
      const secondCachePath = path.join(tmpDir, 'cache2.git');
      const store2 = createGitRemoteStore(
        makeConfig({
          config: {
            url: remoteRepoPath,
            cachePath: secondCachePath,
            fetchBeforeRead: true,
          },
        }),
      );
      await store2.initialize();

      // Should be able to retrieve what store1 pushed
      const retrieved = await store2.retrieve('sessionlog://session/test-123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.uri).toBe('sessionlog://session/test-123');
    });
  });

  describe('list', () => {
    it('should list archived sessions', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(makeSnapshot({ uri: 'sessionlog://session/s1' }));
      await store.archive(
        makeSnapshot({
          uri: 'sessionlog://session/s2',
          node: {
            title: 'Second Session',
            external_data: {},
          },
        }),
      );

      const entries = await store.list();
      expect(entries).toHaveLength(2);

      const uris = entries.map((e) => e.uri).sort();
      expect(uris).toEqual(['sessionlog://session/s1', 'sessionlog://session/s2']);
    });

    it('should filter by graphId', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(
        makeSnapshot({
          uri: 'sessionlog://session/s1',
          provenance: { graphId: 'graph-a', graphPath: '/a/.opentasks' },
        }),
      );
      await store.archive(
        makeSnapshot({
          uri: 'sessionlog://session/s2',
          provenance: { graphId: 'graph-b', graphPath: '/b/.opentasks' },
        }),
      );

      const entries = await store.list({ graphId: 'graph-a' });
      expect(entries).toHaveLength(1);
      expect(entries[0].uri).toBe('sessionlog://session/s1');
    });

    it('should filter by source', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(makeSnapshot({ uri: 'sessionlog://session/s1', source: 'sessionlog' }));
      await store.archive(makeSnapshot({ uri: 'sessionlog://session/s2', source: 'other' }));

      const entries = await store.list({ source: 'sessionlog' });
      expect(entries).toHaveLength(1);
      expect(entries[0].uri).toBe('sessionlog://session/s1');
    });

    it('should return empty for no archives', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const entries = await store.list();
      expect(entries).toEqual([]);
    });
  });

  describe('status', () => {
    it('should report not initialized before init', async () => {
      const store = createGitRemoteStore(makeConfig());
      const status = await store.status();
      expect(status.healthy).toBe(false);
      expect(status.message).toBe('Not initialized');
    });

    it('should report healthy after init', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      const status = await store.status();
      expect(status.healthy).toBe(true);
      expect(status.message).toBe('OK');
    });

    it('should track lastArchiveAt', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();

      await store.archive(makeSnapshot());

      const status = await store.status();
      expect(status.lastArchiveAt).toBeDefined();
    });
  });

  describe('close', () => {
    it('should push pending commits on close', async () => {
      const store = createGitRemoteStore(
        makeConfig({
          config: {
            url: remoteRepoPath,
            cachePath: cacheRepoPath,
            pushPolicy: 'on-close',
          },
        }),
      );
      await store.initialize();
      await store.archive(makeSnapshot());

      await store.close();

      // Verify remote has the data
      const remoteBranches = execSync(`git -C "${remoteRepoPath}" branch`, { encoding: 'utf-8' });
      expect(remoteBranches).toContain('opentasks/archive');
    });

    it('should be safe to close without archives', async () => {
      const store = createGitRemoteStore(makeConfig());
      await store.initialize();
      await store.close(); // Should not throw
    });
  });

  describe('conflict resolution', () => {
    it('should handle concurrent pushes from different caches', async () => {
      // Two stores writing to the same remote
      const cache1 = path.join(tmpDir, 'cache-1.git');
      const cache2 = path.join(tmpDir, 'cache-2.git');

      const store1 = createGitRemoteStore(
        makeConfig({
          name: 'store-1',
          config: { url: remoteRepoPath, cachePath: cache1, pushPolicy: 'immediate' },
        }),
      );
      const store2 = createGitRemoteStore(
        makeConfig({
          name: 'store-2',
          config: { url: remoteRepoPath, cachePath: cache2, pushPolicy: 'immediate' },
        }),
      );

      await store1.initialize();
      await store2.initialize();

      // Store 1 archives first
      await store1.archive(
        makeSnapshot({
          uri: 'sessionlog://session/s1',
          provenance: { graphId: 'graph-1', graphPath: '/g1/.opentasks' },
        }),
      );

      // Store 2 archives second — should handle the conflict
      const result = await store2.archive(
        makeSnapshot({
          uri: 'sessionlog://session/s2',
          provenance: { graphId: 'graph-2', graphPath: '/g2/.opentasks' },
        }),
      );

      expect(result.stored).toBe(true);
    });
  });
});
