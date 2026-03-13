/**
 * E2E Tests for Sessionlog Provider (no mocking)
 *
 * Tests the full integration path:
 *   real git repo → session JSON files → createNativeSessionlogStore → createSessionlogProvider → ProviderNode
 *
 * Uses real filesystem, real git, real sessionlog internals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createNativeSessionlogStore } from 'sessionlog';
import {
  createSessionlogProvider,
  createSessionlogCliStore,
  type SessionlogStore,
} from '../sessionlog.js';
import type { Provider } from '../types.js';

// ============================================================================
// Test Fixture Helpers
// ============================================================================

interface TestRepo {
  rootDir: string;
  sessionsDir: string;
  cleanup(): void;
}

function createTestRepo(): TestRepo {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-e2e-'));

  // Initialize a real git repository with local config (signing disabled for tests)
  execSync('git init', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config user.email "test@e2e.dev"', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config user.name "E2E Test"', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: rootDir, stdio: 'ignore' });

  // Create initial commit (git needs at least one commit for HEAD to exist)
  fs.writeFileSync(path.join(rootDir, 'README.md'), '# E2E Test Repo\n');
  execSync('git add README.md', { cwd: rootDir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: rootDir, stdio: 'ignore' });

  // Create the sessions directory inside .git
  const sessionsDir = path.join(rootDir, '.git', 'sessionlog-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  return {
    rootDir,
    sessionsDir,
    cleanup() {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function writeSession(repo: TestRepo, id: string, data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(repo.sessionsDir, `${id}.json`),
    JSON.stringify(data, null, 2),
  );
}

function getHeadCommit(repo: TestRepo): string {
  return execSync('git rev-parse HEAD', { cwd: repo.rootDir }).toString().trim();
}

// ============================================================================
// E2E: Native Store (createNativeSessionlogStore from sessionlog)
// ============================================================================

describe('E2E: createNativeSessionlogStore', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should list sessions from .git/sessionlog-sessions/*.json', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'session-e2e-1', {
      sessionID: 'session-e2e-1',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      filesTouched: ['src/app.ts'],
      turnCheckpointIDs: [],
      stepCount: 3,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Build the authentication module',
    });

    writeSession(repo, 'session-e2e-2', {
      sessionID: 'session-e2e-2',
      agentType: 'cursor',
      phase: 'idle',
      baseCommit,
      startedAt: new Date().toISOString(),
      filesTouched: [],
      turnCheckpointIDs: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const sessions = await store.listSessions();

    expect(sessions).toHaveLength(2);

    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['session-e2e-1', 'session-e2e-2']);
  });

  it('should normalize session fields correctly', async () => {
    const baseCommit = getHeadCommit(repo);
    const startedAt = new Date().toISOString();

    writeSession(repo, 'norm-session', {
      sessionID: 'norm-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt,
      filesTouched: ['src/auth.ts', 'src/middleware.ts'],
      turnCheckpointIDs: ['cp-001', 'cp-002'],
      stepCount: 5,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      tokenUsage: {
        inputTokens: 10000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 500,
        outputTokens: 5000,
        apiCallCount: 8,
      },
      firstPrompt: 'Implement login flow',
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const session = await store.getSession('norm-session');

    expect(session).not.toBeNull();
    expect(session!.id).toBe('norm-session');
    expect(session!.agent).toBe('claude-code');
    expect(session!.phase).toBe('ACTIVE');
    expect(session!.baseCommit).toBe(baseCommit);
    expect(session!.startedAt).toBe(startedAt);
    expect(session!.filesTouched).toEqual(['src/auth.ts', 'src/middleware.ts']);
    expect(session!.checkpoints).toEqual(['cp-001', 'cp-002']);
    expect(session!.summary).toBe('Implement login flow');

    // Token usage is normalized: input = inputTokens + cacheReadTokens
    expect(session!.tokenUsage).toEqual({
      input: 10500,   // 10000 + 500
      output: 5000,
      cache: 2000,    // cacheCreationTokens
    });
  });

  it('should return null for non-existent session', async () => {
    const store = createNativeSessionlogStore(repo.rootDir);
    const session = await store.getSession('does-not-exist');

    expect(session).toBeNull();
  });

  it('should return empty array when no sessions exist', async () => {
    const store = createNativeSessionlogStore(repo.rootDir);
    const sessions = await store.listSessions();

    expect(sessions).toEqual([]);
  });

  it('should handle all three phase states', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'active-session', {
      sessionID: 'active-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    writeSession(repo, 'idle-session', {
      sessionID: 'idle-session',
      agentType: 'claude-code',
      phase: 'idle',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    writeSession(repo, 'ended-session', {
      sessionID: 'ended-session',
      agentType: 'claude-code',
      phase: 'ended',
      baseCommit,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: new Date().toISOString(), // Recent — won't be auto-deleted
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const sessions = await store.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));

    expect(byId.get('active-session')?.phase).toBe('ACTIVE');
    expect(byId.get('idle-session')?.phase).toBe('IDLE');
    expect(byId.get('ended-session')?.phase).toBe('ENDED');
  });

  it('should search sessions by summary (firstPrompt)', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'search-session-1', {
      sessionID: 'search-session-1',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Implement authentication flow',
    });

    writeSession(repo, 'search-session-2', {
      sessionID: 'search-session-2',
      agentType: 'cursor',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Refactor database layer',
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const results = await store.search('authentication');

    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe('search-session-1');
  });

  it('should search sessions by filesTouched', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'files-session', {
      sessionID: 'files-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: ['src/auth/login.ts', 'src/middleware.ts'],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createNativeSessionlogStore(repo.rootDir);

    const results = await store.search('middleware');
    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe('files-session');
  });

  it('should search sessions by ID', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'unique-id-abc123', {
      sessionID: 'unique-id-abc123',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const results = await store.search('abc123');

    expect(results).toHaveLength(1);
  });

  it('should handle sessions without optional fields', async () => {
    const baseCommit = getHeadCommit(repo);

    // Minimal session — only required fields
    writeSession(repo, 'minimal-session', {
      phase: 'active',
      baseCommit,
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const session = await store.getSession('minimal-session');

    expect(session).not.toBeNull();
    expect(session!.id).toBe('minimal-session');
    expect(session!.phase).toBe('ACTIVE');
    expect(session!.filesTouched).toBeUndefined();
    expect(session!.checkpoints).toBeUndefined();
    expect(session!.tokenUsage).toBeUndefined();
  });

  it('should handle malformed JSON files gracefully', async () => {
    // Write invalid JSON
    fs.writeFileSync(
      path.join(repo.sessionsDir, 'bad-session.json'),
      'not valid json {{{',
    );

    // Write a valid session alongside it
    writeSession(repo, 'good-session', {
      sessionID: 'good-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit: getHeadCommit(repo),
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const sessions = await store.listSessions();

    // Should still return the good session, skip the bad one
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('good-session');
  });
});

// ============================================================================
// E2E: createSessionlogCliStore (wrapper around native store)
// ============================================================================

describe('E2E: createSessionlogCliStore (wrapper)', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should delegate to createNativeSessionlogStore and return sessions', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'wrapper-session', {
      sessionID: 'wrapper-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: ['src/index.ts'],
      stepCount: 2,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Add error handling',
    });

    const store = createSessionlogCliStore({ cwd: repo.rootDir });
    const sessions = await store.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('wrapper-session');
    expect(sessions[0].agent).toBe('claude-code');
    expect(sessions[0].phase).toBe('ACTIVE');
    expect(sessions[0].filesTouched).toEqual(['src/index.ts']);
    expect(sessions[0].summary).toBe('Add error handling');
  });

  it('should get a single session by ID', async () => {
    writeSession(repo, 'specific-session', {
      sessionID: 'specific-session',
      agentType: 'cursor',
      phase: 'idle',
      baseCommit: getHeadCommit(repo),
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const store = createSessionlogCliStore({ cwd: repo.rootDir });

    const found = await store.getSession('specific-session');
    expect(found).not.toBeNull();
    expect(found!.agent).toBe('cursor');
    expect(found!.phase).toBe('IDLE');

    const notFound = await store.getSession('no-such-session');
    expect(notFound).toBeNull();
  });
});

// ============================================================================
// E2E: Full Provider Pipeline (session files → provider → ProviderNodes)
// ============================================================================

describe('E2E: SessionlogProvider full pipeline', () => {
  let repo: TestRepo;
  let provider: Provider;

  beforeEach(() => {
    repo = createTestRepo();
    const store: SessionlogStore = createNativeSessionlogStore(repo.rootDir);
    provider = createSessionlogProvider({}, store);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should list session files as ProviderNodes', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'pipeline-session', {
      sessionID: 'pipeline-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      filesTouched: ['src/feature.ts', 'tests/feature.test.ts'],
      turnCheckpointIDs: ['cp-a1'],
      stepCount: 4,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      tokenUsage: {
        inputTokens: 8000,
        cacheCreationTokens: 1500,
        cacheReadTokens: 300,
        outputTokens: 4000,
        apiCallCount: 6,
      },
      firstPrompt: 'Add feature flag support',
    });

    const nodes = await provider.list();

    expect(nodes).toHaveLength(1);
    const node = nodes[0];

    expect(node.id).toBe('pipeline-session');
    expect(node.uri).toBe('sessionlog://session/pipeline-session');
    expect(node.type).toBe('external');
    expect(node.title).toContain('Add feature flag support');
    expect(node.content).toBe('Add feature flag support');
    expect(node.status).toBe('open');
    expect(node.fetchedAt).toBeDefined();

    expect(node.rawData).toMatchObject({
      entityType: 'session',
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit,
      filesTouched: ['src/feature.ts', 'tests/feature.test.ts'],
      checkpoints: ['cp-a1'],
      tokenUsage: {
        input: 8300,   // 8000 + 300
        output: 4000,
        cache: 1500,
      },
    });
  });

  it('should get a session by URI', async () => {
    writeSession(repo, 'uri-session', {
      sessionID: 'uri-session',
      agentType: 'claude-code',
      phase: 'ended',
      baseCommit: getHeadCommit(repo),
      startedAt: new Date(Date.now() - 120000).toISOString(),
      endedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Fix the bug',
    });

    const node = await provider.get('sessionlog://session/uri-session');

    expect(node).not.toBeNull();
    expect(node!.id).toBe('uri-session');
    expect(node!.status).toBe('closed'); // ENDED → closed
    expect(node!.rawData?.phase).toBe('ENDED');
    expect(node!.rawData?.endedAt).toBeDefined();
  });

  it('should return null for non-existent session URI', async () => {
    const node = await provider.get('sessionlog://session/no-such-session');
    expect(node).toBeNull();
  });

  it('should search sessions via provider', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'searchable-1', {
      sessionID: 'searchable-1',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: ['src/auth.ts'],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Implement OAuth2 authentication',
    });

    writeSession(repo, 'searchable-2', {
      sessionID: 'searchable-2',
      agentType: 'cursor',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: ['src/styles.css'],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Redesign dashboard layout',
    });

    // Search by summary/prompt
    const authResults = await provider.search!('OAuth2');
    expect(authResults).toHaveLength(1);
    expect(authResults[0].id).toBe('searchable-1');
    expect(authResults[0].type).toBe('external');

    // Search by file
    const cssResults = await provider.search!('styles.css');
    expect(cssResults).toHaveLength(1);
    expect(cssResults[0].id).toBe('searchable-2');

    // Search with no matches
    const noResults = await provider.search!('nonexistent-xyz-123');
    expect(noResults).toEqual([]);
  });

  it('should filter by status in list', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'open-session', {
      sessionID: 'open-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    writeSession(repo, 'closed-session', {
      sessionID: 'closed-session',
      agentType: 'claude-code',
      phase: 'ended',
      baseCommit,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
    });

    const openNodes = await provider.list({ status: 'open' });
    expect(openNodes).toHaveLength(1);
    expect(openNodes[0].id).toBe('open-session');

    const closedNodes = await provider.list({ status: 'closed' });
    expect(closedNodes).toHaveLength(1);
    expect(closedNodes[0].id).toBe('closed-session');
  });

  it('should apply limit in list', async () => {
    const baseCommit = getHeadCommit(repo);

    for (let i = 0; i < 5; i++) {
      writeSession(repo, `limit-session-${i}`, {
        sessionID: `limit-session-${i}`,
        agentType: 'claude-code',
        phase: 'active',
        baseCommit,
        startedAt: new Date().toISOString(),
        turnCheckpointIDs: [],
        filesTouched: [],
        stepCount: 0,
        checkpointTranscriptStart: 0,
        untrackedFilesAtStart: [],
      });
    }

    const all = await provider.list();
    expect(all).toHaveLength(5);

    const limited = await provider.list({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('should handle write operations (read-only provider)', async () => {
    await expect(provider.create({ type: 'issue', title: 'test' })).rejects.toThrow();
    await expect(provider.update('any', { title: 'test' })).rejects.toThrow();
    await expect(provider.delete('any')).rejects.toThrow();
  });

  it('should handle empty repo gracefully', async () => {
    const nodes = await provider.list();
    expect(nodes).toEqual([]);

    const session = await provider.get('sessionlog://session/nonexistent');
    expect(session).toBeNull();

    const results = await provider.search!('anything');
    expect(results).toEqual([]);
  });

  it('should handle multiple agent types', async () => {
    const baseCommit = getHeadCommit(repo);
    const agents = ['claude-code', 'cursor', 'gemini-cli', 'opencode'];

    for (const agent of agents) {
      writeSession(repo, `agent-${agent}`, {
        sessionID: `agent-${agent}`,
        agentType: agent,
        phase: 'active',
        baseCommit,
        startedAt: new Date().toISOString(),
        turnCheckpointIDs: [],
        filesTouched: [],
        stepCount: 0,
        checkpointTranscriptStart: 0,
        untrackedFilesAtStart: [],
      });
    }

    const nodes = await provider.list();
    expect(nodes).toHaveLength(4);

    const agentNames = nodes.map((n) => n.rawData?.agent).sort();
    expect(agentNames).toEqual(['claude-code', 'cursor', 'gemini-cli', 'opencode']);
  });
});
