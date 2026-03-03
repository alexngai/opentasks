/**
 * Tests for Entire Provider
 *
 * Tests the in-memory store (unit tests), native store (mocked sessionlog),
 * exec store (CLI shell-out), and the async store factory with CLI→native fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createEntireProvider,
  createEntireCliStore,
  createEntireCliStoreAsync,
  createEntireExecStore,
  createInMemoryEntireStore,
  type EntireSession,
  type EntireCheckpoint,
  type EntireStore,
} from '../entire.js';
import type { Provider } from '../types.js';
import { ProviderError } from '../types.js';

// ============================================================================
// Mock sessionlog's createNativeSessionlogStore
// ============================================================================

const mockNativeStore: EntireStore = {
  getSession: vi.fn(),
  listSessions: vi.fn(),
  getCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  search: vi.fn(),
};

vi.mock('sessionlog', () => ({
  createNativeSessionlogStore: vi.fn(() => mockNativeStore),
}));

function resetMockStore() {
  vi.mocked(mockNativeStore.getSession).mockReset();
  vi.mocked(mockNativeStore.listSessions).mockReset();
  vi.mocked(mockNativeStore.getCheckpoint).mockReset();
  vi.mocked(mockNativeStore.listCheckpoints).mockReset();
  vi.mocked(mockNativeStore.search).mockReset();
}

// ============================================================================
// Shared Test Data
// ============================================================================

const sampleSession: EntireSession = {
  id: '2026-02-13-a1b2c3d4',
  agent: 'claude-code',
  phase: 'ACTIVE',
  baseCommit: 'f4a2b1c',
  branch: 'feature/login',
  startedAt: '2026-02-13T15:00:00Z',
  checkpoints: ['a3b2c4d5'],
  tokenUsage: { input: 12500, output: 8300 },
  filesTouched: ['src/auth.ts', 'src/middleware.ts'],
  summary: 'Implement authentication flow',
};

const sampleCheckpoint: EntireCheckpoint = {
  id: 'a3b2c4d5',
  sessionId: '2026-02-13-a1b2c3d4',
  commitHash: 'd7e8f9a',
  commitMessage: 'Add login endpoint',
  promptCount: 5,
  filesModified: ['src/auth.ts'],
  filesNew: ['src/routes/login.ts'],
  filesDeleted: [],
  tokenUsage: { input: 12500, output: 8300, cache: 4200 },
  context: '## Session Summary\nImplemented login endpoint with JWT.',
};

// ============================================================================
// Provider Tests (using in-memory store)
// ============================================================================

describe('EntireProvider', () => {
  let provider: Provider;
  let store: ReturnType<typeof createInMemoryEntireStore>;

  beforeEach(() => {
    store = createInMemoryEntireStore();
    provider = createEntireProvider({}, store);
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('entire');
    });

    it('should have correct schemes', () => {
      expect(provider.schemes).toEqual(['entire']);
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: false,
        search: true,
        watch: false,
        mount: false,
        feedback: false,
      });
    });
  });

  describe('parseUri', () => {
    it('should parse session URIs', () => {
      const result = provider.parseUri('entire://session/2026-02-13-abc');
      expect(result).toEqual({
        scheme: 'entire',
        workspace: 'session',
        id: '2026-02-13-abc',
        isRelative: false,
      });
    });

    it('should parse checkpoint URIs', () => {
      const result = provider.parseUri('entire://checkpoint/a3b2c4d5');
      expect(result).toEqual({
        scheme: 'entire',
        workspace: 'checkpoint',
        id: 'a3b2c4d5',
        isRelative: false,
      });
    });

    it('should be case-insensitive for scheme', () => {
      expect(provider.parseUri('ENTIRE://session/abc')).toMatchObject({
        scheme: 'entire',
        id: 'abc',
      });
      expect(provider.parseUri('Entire://Checkpoint/xyz')).toMatchObject({
        scheme: 'entire',
        workspace: 'checkpoint',
        id: 'xyz',
      });
    });

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('native://s-abc1')).toBeNull();
      expect(provider.parseUri('claude://current/42')).toBeNull();
      expect(provider.parseUri('beads://./bd-123')).toBeNull();
    });

    it('should return null for invalid entire URIs', () => {
      expect(provider.parseUri('entire://invalid')).toBeNull();
      expect(provider.parseUri('entire://')).toBeNull();
      expect(provider.parseUri('entire://session/')).toBeNull();
      expect(provider.parseUri('invalid')).toBeNull();
      expect(provider.parseUri('')).toBeNull();
    });

    it('should handle IDs with special characters', () => {
      const result = provider.parseUri('entire://session/2026-02-13_abc.def');
      expect(result).toMatchObject({
        scheme: 'entire',
        workspace: 'session',
        id: '2026-02-13_abc.def',
      });
    });
  });

  describe('buildUri', () => {
    it('should build session URI by default', () => {
      expect(provider.buildUri('2026-02-13-abc')).toBe('entire://session/2026-02-13-abc');
    });

    it('should build checkpoint URI with workspace', () => {
      expect(provider.buildUri('a3b2c4d5', { workspace: 'checkpoint' })).toBe(
        'entire://checkpoint/a3b2c4d5',
      );
    });

    it('should build relative URI when requested', () => {
      expect(provider.buildUri('abc', { relative: true })).toBe('abc');
    });

    it('should use session workspace by default', () => {
      expect(provider.buildUri('test-id')).toBe('entire://session/test-id');
    });
  });

  describe('isValidUri', () => {
    it('should return true for valid URIs', () => {
      expect(provider.isValidUri('entire://session/abc')).toBe(true);
      expect(provider.isValidUri('entire://checkpoint/abc')).toBe(true);
    });

    it('should return false for invalid URIs', () => {
      expect(provider.isValidUri('native://s-abc1')).toBe(false);
      expect(provider.isValidUri('entire://invalid')).toBe(false);
      expect(provider.isValidUri('invalid')).toBe(false);
      expect(provider.isValidUri('')).toBe(false);
    });
  });

  describe('get', () => {
    it('should get a session by full URI', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('2026-02-13-a1b2c3d4');
      expect(result?.uri).toBe('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.type).toBe('external');
      expect(result?.title).toContain('Implement authentication flow');
      expect(result?.status).toBe('open');
      expect(result?.rawData?.entityType).toBe('session');
      expect(result?.rawData?.agent).toBe('claude-code');
    });

    it('should get a checkpoint by full URI', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.get('entire://checkpoint/a3b2c4d5');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('a3b2c4d5');
      expect(result?.uri).toBe('entire://checkpoint/a3b2c4d5');
      expect(result?.type).toBe('external');
      expect(result?.title).toContain('Add login endpoint');
      expect(result?.status).toBe('closed');
      expect(result?.rawData?.entityType).toBe('checkpoint');
      expect(result?.rawData?.commitHash).toBe('d7e8f9a');
    });

    it('should get a session by bare ID (defaults to session type)', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('2026-02-13-a1b2c3d4');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('2026-02-13-a1b2c3d4');
    });

    it('should return null for non-existent session', async () => {
      const result = await provider.get('entire://session/nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for non-existent checkpoint', async () => {
      const result = await provider.get('entire://checkpoint/nonexistent');
      expect(result).toBeNull();
    });

    it('should map ENDED session to closed status', async () => {
      store.addSession({ ...sampleSession, phase: 'ENDED' });

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.status).toBe('closed');
    });

    it('should map ACTIVE session to open status', async () => {
      store.addSession({ ...sampleSession, phase: 'ACTIVE' });

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.status).toBe('open');
    });

    it('should map IDLE session to open status', async () => {
      store.addSession({ ...sampleSession, phase: 'IDLE' });

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.status).toBe('open');
    });
  });

  describe('list', () => {
    it('should list all sessions and checkpoints', async () => {
      store.addSession(sampleSession);
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.list();

      expect(result).toHaveLength(2);
      // Sessions come first, then checkpoints
      expect(result[0].rawData?.entityType).toBe('session');
      expect(result[1].rawData?.entityType).toBe('checkpoint');
    });

    it('should filter by status', async () => {
      store.addSession({ ...sampleSession, phase: 'ACTIVE' });
      store.addSession({
        ...sampleSession,
        id: 'ended-session',
        phase: 'ENDED',
      });
      store.addCheckpoint(sampleCheckpoint);

      const openItems = await provider.list({ status: 'open' });
      expect(openItems).toHaveLength(1);
      expect(openItems[0].id).toBe(sampleSession.id);

      const closedItems = await provider.list({ status: 'closed' });
      expect(closedItems).toHaveLength(2); // ended session + checkpoint
    });

    it('should apply limit', async () => {
      store.addSession(sampleSession);
      store.addSession({ ...sampleSession, id: 'session-2' });
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.list({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no data', async () => {
      const result = await provider.list();
      expect(result).toEqual([]);
    });

    it('should list sessions with no checkpoints', async () => {
      store.addSession(sampleSession);

      const result = await provider.list();
      expect(result).toHaveLength(1);
      expect(result[0].rawData?.entityType).toBe('session');
    });
  });

  describe('write operations (read-only)', () => {
    it('should throw NOT_SUPPORTED for create', async () => {
      await expect(provider.create({ type: 'issue', title: 'test' })).rejects.toThrow(
        ProviderError,
      );

      await expect(provider.create({ type: 'issue', title: 'test' })).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('should throw NOT_SUPPORTED for update', async () => {
      await expect(provider.update('any-id', { title: 'updated' })).rejects.toThrow(ProviderError);

      await expect(provider.update('any-id', { title: 'updated' })).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    });

    it('should throw NOT_SUPPORTED for delete', async () => {
      await expect(provider.delete('any-id')).rejects.toThrow(ProviderError);

      await expect(provider.delete('any-id')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });
  });

  describe('search', () => {
    it('should search sessions by summary', async () => {
      store.addSession(sampleSession);
      store.addSession({
        ...sampleSession,
        id: 'other-session',
        summary: 'Refactor database layer',
        filesTouched: ['src/db.ts'],
      });

      const results = await provider.search!('authentication');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(sampleSession.id);
    });

    it('should search checkpoints by commit message', async () => {
      store.addCheckpoint(sampleCheckpoint);
      store.addCheckpoint({
        ...sampleCheckpoint,
        id: 'other-checkpoint',
        commitMessage: 'Fix CSS styles',
        context: 'Fixed stylesheet issues',
        filesModified: ['src/styles.css'],
        filesNew: [],
      });

      const results = await provider.search!('login');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(sampleCheckpoint.id);
    });

    it('should search checkpoints by context', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const results = await provider.search!('JWT');
      expect(results).toHaveLength(1);
    });

    it('should search by ID', async () => {
      store.addSession(sampleSession);

      const results = await provider.search!('a1b2c3d4');
      expect(results).toHaveLength(1);
    });

    it('should search sessions by filesTouched', async () => {
      store.addSession(sampleSession);

      const results = await provider.search!('middleware');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(sampleSession.id);
    });

    it('should search checkpoints by filesModified', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const results = await provider.search!('src/auth.ts');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(sampleCheckpoint.id);
    });

    it('should search checkpoints by filesNew', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const results = await provider.search!('routes/login');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(sampleCheckpoint.id);
    });

    it('should be case-insensitive', async () => {
      store.addSession(sampleSession);

      const results = await provider.search!('AUTHENTICATION');
      expect(results).toHaveLength(1);
    });

    it('should apply search limit', async () => {
      store.addSession(sampleSession);
      store.addSession({ ...sampleSession, id: 'session-2', summary: 'auth test' });
      store.addCheckpoint({ ...sampleCheckpoint, context: 'auth related' });

      const results = await provider.search!('auth', { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('should return empty array for no matches', async () => {
      store.addSession(sampleSession);
      store.addCheckpoint(sampleCheckpoint);

      const results = await provider.search!('nonexistent-xyz');
      expect(results).toEqual([]);
    });
  });

  describe('node conversion', () => {
    it('should include rawData with session details', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');

      expect(result?.rawData).toMatchObject({
        entityType: 'session',
        agent: 'claude-code',
        baseCommit: 'f4a2b1c',
        branch: 'feature/login',
        phase: 'ACTIVE',
        filesTouched: ['src/auth.ts', 'src/middleware.ts'],
      });
    });

    it('should include rawData with checkpoint details', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.get('entire://checkpoint/a3b2c4d5');

      expect(result?.rawData).toMatchObject({
        entityType: 'checkpoint',
        sessionId: '2026-02-13-a1b2c3d4',
        commitHash: 'd7e8f9a',
        promptCount: 5,
        filesModified: ['src/auth.ts'],
        filesNew: ['src/routes/login.ts'],
      });
    });

    it('should include content from session summary', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.content).toBe('Implement authentication flow');
    });

    it('should include content from checkpoint context', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.get('entire://checkpoint/a3b2c4d5');
      expect(result?.content).toBe('## Session Summary\nImplemented login endpoint with JWT.');
    });

    it('should include fetchedAt timestamp', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');

      expect(result?.fetchedAt).toBeDefined();
      expect(new Date(result!.fetchedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should use session ID in title when no summary', async () => {
      store.addSession({ ...sampleSession, summary: undefined });

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.title).toBe('Session: 2026-02-13-a1b2c3d4');
    });

    it('should use checkpoint ID in title when no commit message', async () => {
      store.addCheckpoint({ ...sampleCheckpoint, commitMessage: undefined });

      const result = await provider.get('entire://checkpoint/a3b2c4d5');
      expect(result?.title).toBe('Checkpoint: a3b2c4d5');
    });

    it('should include token usage in rawData', async () => {
      store.addSession(sampleSession);

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4');
      expect(result?.rawData?.tokenUsage).toEqual({ input: 12500, output: 8300 });
    });

    it('should include checkpoint token usage with cache', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const result = await provider.get('entire://checkpoint/a3b2c4d5');
      expect(result?.rawData?.tokenUsage).toEqual({ input: 12500, output: 8300, cache: 4200 });
    });
  });

  describe('in-memory store', () => {
    it('should store and retrieve sessions', async () => {
      store.addSession(sampleSession);

      const result = await store.getSession(sampleSession.id);
      expect(result).toEqual(sampleSession);
    });

    it('should store and retrieve checkpoints', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const result = await store.getCheckpoint(sampleCheckpoint.id);
      expect(result).toEqual(sampleCheckpoint);
    });

    it('should list all sessions', async () => {
      store.addSession(sampleSession);
      store.addSession({ ...sampleSession, id: 'session-2' });

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should list all checkpoints', async () => {
      store.addCheckpoint(sampleCheckpoint);
      store.addCheckpoint({ ...sampleCheckpoint, id: 'cp-2' });

      const checkpoints = await store.listCheckpoints();
      expect(checkpoints).toHaveLength(2);
    });

    it('should return null for non-existent entries', async () => {
      expect(await store.getSession('nonexistent')).toBeNull();
      expect(await store.getCheckpoint('nonexistent')).toBeNull();
    });

    it('should overwrite existing session with same ID', async () => {
      store.addSession(sampleSession);
      store.addSession({ ...sampleSession, phase: 'ENDED' });

      const result = await store.getSession(sampleSession.id);
      expect(result?.phase).toBe('ENDED');

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(1);
    });

    it('should search sessions by filesTouched', async () => {
      store.addSession(sampleSession);

      const results = await store.search('middleware');
      expect(results).toHaveLength(1);
    });

    it('should search checkpoints by filesModified', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const results = await store.search('auth.ts');
      expect(results).toHaveLength(1);
    });

    it('should search checkpoints by filesNew', async () => {
      store.addCheckpoint(sampleCheckpoint);

      const results = await store.search('routes/login');
      expect(results).toHaveLength(1);
    });
  });
});

// ============================================================================
// Native Store Tests (mocked sessionlog)
// ============================================================================

describe('EntireCliStore (native)', () => {
  let nativeStore: EntireStore;

  beforeEach(() => {
    resetMockStore();
    nativeStore = createEntireCliStore({ cwd: '/test/project' });
  });

  describe('createEntireCliStore', () => {
    it('should delegate to createNativeSessionlogStore from sessionlog', async () => {
      const { createNativeSessionlogStore } = await import('sessionlog');
      expect(createNativeSessionlogStore).toHaveBeenCalledWith('/test/project');
    });

    it('should default cwd to process.cwd()', () => {
      createEntireCliStore();
      // No error means it created successfully with default cwd
    });
  });

  describe('getSession', () => {
    it('should delegate to native store', async () => {
      vi.mocked(mockNativeStore.getSession).mockResolvedValue(sampleSession);

      const result = await nativeStore.getSession('2026-02-13-a1b2c3d4');

      expect(mockNativeStore.getSession).toHaveBeenCalledWith('2026-02-13-a1b2c3d4');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('2026-02-13-a1b2c3d4');
      expect(result?.agent).toBe('claude-code');
      expect(result?.phase).toBe('ACTIVE');
    });

    it('should return null when session not found', async () => {
      vi.mocked(mockNativeStore.getSession).mockResolvedValue(null);

      const result = await nativeStore.getSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should delegate to native store', async () => {
      vi.mocked(mockNativeStore.listSessions).mockResolvedValue([
        { ...sampleSession, id: 'session-1' },
        { ...sampleSession, id: 'session-2', phase: 'ENDED' },
      ]);

      const sessions = await nativeStore.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[1].id).toBe('session-2');
    });

    it('should return empty array when no sessions', async () => {
      vi.mocked(mockNativeStore.listSessions).mockResolvedValue([]);

      const sessions = await nativeStore.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('getCheckpoint', () => {
    it('should delegate to native store', async () => {
      vi.mocked(mockNativeStore.getCheckpoint).mockResolvedValue(sampleCheckpoint);

      const result = await nativeStore.getCheckpoint('a3b2c4d5');

      expect(mockNativeStore.getCheckpoint).toHaveBeenCalledWith('a3b2c4d5');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('a3b2c4d5');
      expect(result?.commitHash).toBe('d7e8f9a');
    });

    it('should return null when checkpoint not found', async () => {
      vi.mocked(mockNativeStore.getCheckpoint).mockResolvedValue(null);

      const result = await nativeStore.getCheckpoint('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listCheckpoints', () => {
    it('should delegate to native store', async () => {
      vi.mocked(mockNativeStore.listCheckpoints).mockResolvedValue([
        { ...sampleCheckpoint, id: 'cp-1' },
        { ...sampleCheckpoint, id: 'cp-2' },
      ]);

      const checkpoints = await nativeStore.listCheckpoints();
      expect(checkpoints).toHaveLength(2);
    });

    it('should return empty array when no checkpoints', async () => {
      vi.mocked(mockNativeStore.listCheckpoints).mockResolvedValue([]);

      const checkpoints = await nativeStore.listCheckpoints();
      expect(checkpoints).toEqual([]);
    });
  });

  describe('search', () => {
    it('should delegate to native store', async () => {
      vi.mocked(mockNativeStore.search).mockResolvedValue([sampleSession, sampleCheckpoint]);

      const results = await nativeStore.search('auth');
      expect(mockNativeStore.search).toHaveBeenCalledWith('auth');
      expect(results).toHaveLength(2);
    });
  });
});

// ============================================================================
// Provider with Native Store (end-to-end with mocked sessionlog)
// ============================================================================

describe('EntireProvider with native store', () => {
  let provider: Provider;

  beforeEach(() => {
    resetMockStore();
    // Create provider using native store (default, no explicit store passed)
    provider = createEntireProvider({ cwd: '/test/project' });
  });

  it('should get session through native store and convert to ProviderNode', async () => {
    vi.mocked(mockNativeStore.getSession).mockResolvedValue({
      id: 'native-session-1',
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc',
      branch: 'main',
      startedAt: '2026-02-13T12:00:00Z',
      summary: 'Working on feature X',
      filesTouched: ['src/x.ts'],
    });

    const result = await provider.get('entire://session/native-session-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('native-session-1');
    expect(result?.type).toBe('external');
    expect(result?.title).toContain('Working on feature X');
    expect(result?.status).toBe('open');
    expect(result?.rawData?.agent).toBe('claude-code');
  });

  it('should get checkpoint through native store and convert to ProviderNode', async () => {
    vi.mocked(mockNativeStore.getCheckpoint).mockResolvedValue({
      id: 'native-cp-1',
      sessionId: 'native-session-1',
      commitHash: 'def456',
      commitMessage: 'Add endpoint',
      promptCount: 3,
      context: 'Endpoint for users',
    });

    const result = await provider.get('entire://checkpoint/native-cp-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('native-cp-1');
    expect(result?.type).toBe('external');
    expect(result?.status).toBe('closed');
    expect(result?.rawData?.commitHash).toBe('def456');
  });

  it('should list all entities through native store', async () => {
    vi.mocked(mockNativeStore.listSessions).mockResolvedValue([
      { id: 's-1', agent: 'claude', phase: 'ACTIVE', summary: 'Test' },
    ]);
    vi.mocked(mockNativeStore.listCheckpoints).mockResolvedValue([
      { id: 'cp-1', commitHash: 'abc', commitMessage: 'Fix' },
    ]);

    const results = await provider.list();
    expect(results).toHaveLength(2);
    expect(results[0].rawData?.entityType).toBe('session');
    expect(results[1].rawData?.entityType).toBe('checkpoint');
  });

  it('should search through native store', async () => {
    vi.mocked(mockNativeStore.search).mockResolvedValue([
      { id: 's-1', agent: 'claude', phase: 'ACTIVE', summary: 'Auth feature' },
      { id: 'cp-1', commitMessage: 'Add auth', context: 'Auth work' },
    ]);

    const results = await provider.search!('auth');
    expect(results).toHaveLength(2);
  });

  it('should handle store errors gracefully for get', async () => {
    vi.mocked(mockNativeStore.getSession).mockRejectedValue(new Error('store error'));

    await expect(provider.get('entire://session/any')).rejects.toThrow(ProviderError);
  });

  it('should handle store errors gracefully for list', async () => {
    vi.mocked(mockNativeStore.listSessions).mockRejectedValue(new Error('store error'));

    await expect(provider.list()).rejects.toThrow(ProviderError);
  });
});

// ============================================================================
// Async Store Factory (CLI → native fallback)
// ============================================================================

// Mock child_process for the async factory and exec store tests
vi.mock('child_process', () => {
  const execFn = vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, result?: { stdout: string }) => void) => {
    cb(new Error('not found'));
  });
  return {
    exec: execFn,
  };
});

vi.mock('util', async () => {
  const actual = await vi.importActual('util');
  return {
    ...actual,
    promisify: (fn: Function) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: Error | null, result?: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    },
  };
});

describe('createEntireCliStoreAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use native store when no executable is configured', async () => {
    const { createNativeSessionlogStore } = await import('sessionlog');
    vi.mocked(createNativeSessionlogStore).mockClear();

    const store = await createEntireCliStoreAsync({ cwd: '/test/repo' });

    expect(createNativeSessionlogStore).toHaveBeenCalledWith('/test/repo');
    expect(store).toBeDefined();
  });

  it('should use native store when executable is configured but not available', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(new Error('command not found'));
      return {} as ReturnType<typeof exec>;
    });

    const { createNativeSessionlogStore } = await import('sessionlog');
    vi.mocked(createNativeSessionlogStore).mockClear();

    const store = await createEntireCliStoreAsync({
      executable: 'entire',
      cwd: '/test/repo',
    });

    // Should fall back to native store
    expect(createNativeSessionlogStore).toHaveBeenCalledWith('/test/repo');
    expect(store).toBeDefined();
  });

  it('should use exec store when executable is configured and available', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(null, { stdout: 'entire v1.2.3\n' });
      return {} as ReturnType<typeof exec>;
    });

    const { createNativeSessionlogStore } = await import('sessionlog');
    vi.mocked(createNativeSessionlogStore).mockClear();

    const store = await createEntireCliStoreAsync({
      executable: '/usr/local/bin/entire',
      cwd: '/test/repo',
    });

    // Should NOT fall back to native store
    expect(createNativeSessionlogStore).not.toHaveBeenCalled();
    expect(store).toBeDefined();
  });

  it('should default cwd to process.cwd() when not specified', async () => {
    const { createNativeSessionlogStore } = await import('sessionlog');
    vi.mocked(createNativeSessionlogStore).mockClear();

    await createEntireCliStoreAsync();

    expect(createNativeSessionlogStore).toHaveBeenCalledWith(process.cwd());
  });
});

describe('createEntireExecStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a store with all 5 EntireStore methods', () => {
    const store = createEntireExecStore({ executable: 'entire' });
    expect(store.getSession).toBeDefined();
    expect(store.listSessions).toBeDefined();
    expect(store.getCheckpoint).toBeDefined();
    expect(store.listCheckpoints).toBeDefined();
    expect(store.search).toBeDefined();
  });

  it('should return null for getSession when CLI fails', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(new Error('CLI error'));
      return {} as ReturnType<typeof exec>;
    });

    const store = createEntireExecStore({ executable: 'entire', cwd: '/test' });
    const result = await store.getSession('some-id');
    expect(result).toBeNull();
  });

  it('should return empty array for listSessions when CLI fails', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(new Error('CLI error'));
      return {} as ReturnType<typeof exec>;
    });

    const store = createEntireExecStore({ executable: 'entire', cwd: '/test' });
    const result = await store.listSessions();
    expect(result).toEqual([]);
  });

  it('should parse session JSON from CLI output', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(null, {
        stdout: JSON.stringify([{
          id: 'sess-1',
          agent: 'claude-code',
          phase: 'active',
          baseCommit: 'abc123',
          summary: 'Working on feature',
          filesTouched: ['src/main.ts'],
        }]),
      });
      return {} as ReturnType<typeof exec>;
    });

    const store = createEntireExecStore({ executable: 'entire', cwd: '/test' });
    const sessions = await store.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[0].phase).toBe('ACTIVE'); // Uppercased
    expect(sessions[0].agent).toBe('claude-code');
  });

  it('should parse checkpoint JSON from CLI output', async () => {
    const { exec } = await import('child_process');
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      (cb as Function)(null, {
        stdout: JSON.stringify([{
          id: 'cp-1',
          sessionId: 'sess-1',
          commitHash: 'def456',
          commitMessage: 'Add endpoint',
          filesModified: ['src/api.ts'],
        }]),
      });
      return {} as ReturnType<typeof exec>;
    });

    const store = createEntireExecStore({ executable: 'entire', cwd: '/test' });
    const checkpoints = await store.listCheckpoints();

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].id).toBe('cp-1');
    expect(checkpoints[0].commitHash).toBe('def456');
  });

  it('should search across sessions and checkpoints', async () => {
    const { exec } = await import('child_process');
    let callCount = 0;
    vi.mocked(exec).mockImplementation((_cmd: unknown, _opts: unknown, cb: unknown) => {
      callCount++;
      if (callCount <= 2) {
        // status --json (called twice: once for search sessions, once for getSession)
        (cb as Function)(null, {
          stdout: JSON.stringify([{
            id: 'sess-1', agent: 'claude', phase: 'ACTIVE',
            summary: 'Auth feature', filesTouched: ['src/auth.ts'],
          }]),
        });
      } else {
        // rewind --list
        (cb as Function)(null, {
          stdout: JSON.stringify([{
            id: 'cp-1', commitMessage: 'Add auth', context: 'Auth work',
          }]),
        });
      }
      return {} as ReturnType<typeof exec>;
    });

    const store = createEntireExecStore({ executable: 'entire', cwd: '/test' });
    const results = await store.search('auth');

    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
