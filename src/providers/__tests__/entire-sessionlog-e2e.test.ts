/**
 * E2E Tests: Sessionlog Integration (checkpoints, watcher, transcript extractor)
 *
 * Complements entire-e2e.test.ts (which covers sessions) by testing:
 *   - Checkpoint reading from real sessionlog/checkpoints/v1 git branches
 *   - Provider checkpoint pipeline (checkpoint → ProviderNode)
 *   - EntireWatcher filesystem event detection
 *   - TranscriptExtractor with real git data
 *   - Full session lifecycle (ACTIVE → checkpoint → ENDED)
 *
 * Uses real git repos in temp dirs. No mocks.
 *
 * TODO: Add E2E tests for createEntireExecStore (Go CLI binary path).
 *   - Requires the `entire` binary to be installed, or stub tests that
 *     mock the binary output to verify JSON parsing in createEntireExecStore.
 *   - Could be gated behind RUN_ENTIRE_CLI_TESTS=1 env var.
 *   - The Go CLI path calls `entire status --json` and `entire rewind --list`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createNativeSessionlogStore } from 'sessionlog';
import {
  createEntireProvider,
  type EntireStore,
} from '../entire.js';
import type { Provider } from '../types.js';
import { createEntireWatcher, type EntireSessionEvent } from '../../daemon/entire-watcher.js';
import { createTranscriptExtractor } from '../../tracking/transcript-extractor.js';

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

  execSync('git init', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config user.email "test@e2e.dev"', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config user.name "E2E Test"', { cwd: rootDir, stdio: 'ignore' });
  execSync('git config commit.gpgsign false', { cwd: rootDir, stdio: 'ignore' });

  fs.writeFileSync(path.join(rootDir, 'README.md'), '# E2E Test Repo\n');
  execSync('git add README.md', { cwd: rootDir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: rootDir, stdio: 'ignore' });

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

function deleteSession(repo: TestRepo, id: string): void {
  const filePath = path.join(repo.sessionsDir, `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function getHeadCommit(repo: TestRepo): string {
  return execSync('git rev-parse HEAD', { cwd: repo.rootDir }).toString().trim();
}

/**
 * Commit checkpoint data to the sessionlog/checkpoints/v1 orphan branch.
 *
 * Tree structure expected by sessionlog's checkpoint store:
 *   <id[:2]>/<id[2:]>/metadata.json        — checkpoint summary
 *   <id[:2]>/<id[2:]>/1/metadata.json      — session metadata
 *   <id[:2]>/<id[2:]>/1/full.jsonl          — transcript
 *   <id[:2]>/<id[2:]>/1/prompt.txt          — prompts
 *   <id[:2]>/<id[2:]>/1/context.md          — context
 */
function commitCheckpointToGit(
  rootDir: string,
  checkpointId: string,
  opts: {
    sessionId?: string;
    agent?: string;
    transcript?: string;
    context?: string;
    filesTouched?: string[];
    summary?: { intent: string; outcome: string };
    tokenUsage?: Record<string, number>;
  } = {},
): void {
  const shard = checkpointId.slice(0, 2);
  const rest = checkpointId.slice(2);
  const basePath = `${shard}/${rest}`;

  const sessionId = opts.sessionId ?? 'test-session';
  const agent = opts.agent ?? 'Claude Code';
  const transcript = opts.transcript ?? '';
  const context = opts.context ?? '';
  const filesTouched = opts.filesTouched ?? [];

  // Top-level checkpoint metadata (CheckpointSummary format)
  const checkpointMeta = JSON.stringify({
    checkpointID: checkpointId,
    strategy: 'manual-commit',
    branch: 'main',
    checkpointsCount: 1,
    filesTouched,
    sessions: [{
      metadata: `${basePath}/1/metadata.json`,
      transcript: `${basePath}/1/full.jsonl`,
      context: `${basePath}/1/context.md`,
      prompt: `${basePath}/1/prompt.txt`,
    }],
    tokenUsage: opts.tokenUsage,
  });

  // Session-level metadata (CommittedMetadata format)
  const sessionMeta = JSON.stringify({
    checkpointID: checkpointId,
    sessionID: sessionId,
    strategy: 'manual-commit',
    createdAt: new Date().toISOString(),
    branch: 'main',
    checkpointsCount: 1,
    filesTouched,
    agent,
    checkpointTranscriptStart: 0,
    summary: opts.summary ? {
      intent: opts.summary.intent,
      outcome: opts.summary.outcome,
      learnings: { codeLearnings: [], toolLearnings: [] },
      friction: [],
      openItems: [],
    } : undefined,
    tokenUsage: opts.tokenUsage,
  });

  const prompt = 'test prompt';

  function writeBlob(content: string): string {
    return execSync('git hash-object -w --stdin', {
      cwd: rootDir,
      input: content,
      encoding: 'utf-8',
    }).trim();
  }

  function mktree(entries: string): string {
    return execSync('git mktree', {
      cwd: rootDir,
      input: entries,
      encoding: 'utf-8',
    }).trim();
  }

  const checkpointMetaHash = writeBlob(checkpointMeta);
  const sessionMetaHash = writeBlob(sessionMeta);
  const transcriptHash = writeBlob(transcript);
  const promptHash = writeBlob(prompt);
  const contextHash = writeBlob(context);

  // Build tree bottom-up (git mktree only accepts flat entries)

  // 1. Session subtree: <shard>/<rest>/1/
  const sessionTreeHash = mktree([
    `100644 blob ${sessionMetaHash}\tmetadata.json`,
    `100644 blob ${transcriptHash}\tfull.jsonl`,
    `100644 blob ${promptHash}\tprompt.txt`,
    `100644 blob ${contextHash}\tcontext.md`,
  ].join('\n'));

  // 2. Checkpoint subtree: <shard>/<rest>/
  const cpTreeHash = mktree([
    `100644 blob ${checkpointMetaHash}\tmetadata.json`,
    `040000 tree ${sessionTreeHash}\t1`,
  ].join('\n'));

  // 3. Shard subtree: <shard>/
  // If branch already exists, merge with existing shard tree
  let existingShardEntries: string[] = [];
  try {
    const existing = execSync(
      `git ls-tree sessionlog/checkpoints/v1 ${shard}/`,
      { cwd: rootDir, encoding: 'utf-8' },
    ).trim();
    if (existing) {
      existingShardEntries = existing.split('\n').filter(Boolean);
    }
  } catch {
    // Branch or path doesn't exist
  }

  // Filter out any existing entry for our checkpoint rest path
  const filteredEntries = existingShardEntries.filter(
    (entry) => !entry.endsWith(`\t${rest}`),
  );
  filteredEntries.push(`040000 tree ${cpTreeHash}\t${rest}`);

  const shardTreeHash = mktree(filteredEntries.join('\n'));

  // 4. Root tree: merge shard into existing root
  let existingRootEntries: string[] = [];
  try {
    const existing = execSync(
      'git ls-tree sessionlog/checkpoints/v1',
      { cwd: rootDir, encoding: 'utf-8' },
    ).trim();
    if (existing) {
      existingRootEntries = existing.split('\n').filter(Boolean);
    }
  } catch {
    // Branch doesn't exist
  }

  const filteredRoot = existingRootEntries.filter(
    (entry) => !entry.endsWith(`\t${shard}`),
  );
  filteredRoot.push(`040000 tree ${shardTreeHash}\t${shard}`);

  const rootTreeHash = mktree(filteredRoot.join('\n'));

  // Create commit (with or without parent)
  let commitCmd = `git commit-tree ${rootTreeHash} -m "Sessionlog-Checkpoint: ${checkpointId}"`;
  try {
    const parentHash = execSync('git rev-parse sessionlog/checkpoints/v1', {
      cwd: rootDir,
      encoding: 'utf-8',
    }).trim();
    commitCmd += ` -p ${parentHash}`;
  } catch {
    // No parent — first commit on this branch
  }

  const commitHash = execSync(commitCmd, {
    cwd: rootDir,
    encoding: 'utf-8',
  }).trim();

  execSync(
    `git update-ref refs/heads/sessionlog/checkpoints/v1 ${commitHash}`,
    { cwd: rootDir, stdio: 'ignore' },
  );
}

/**
 * Create a sample Claude Code JSONL transcript with tool calls.
 */
function makeSampleTranscript(sessionId: string): string {
  function line(type: string, uuid: string, content: unknown): string {
    return JSON.stringify({
      type,
      uuid,
      sessionId,
      message: { id: `msg_${uuid}`, content },
    });
  }

  return [
    line('assistant', 'a1', [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'TaskCreate',
        input: { subject: 'Fix bug', description: 'Fix login flow' },
      },
    ]),
    line('user', 'u1', [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01',
        content: 'Task #1 created successfully: Fix bug',
      },
    ]),
    line('assistant', 'a2', [
      {
        type: 'tool_use',
        id: 'toolu_02',
        name: 'mcp__plugin_sudocode_sudocode__show_issue',
        input: { issue_id: 'i-1234' },
      },
    ]),
    line('user', 'u2', [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_02',
        content: '{"id":"i-1234","title":"Test Issue"}',
      },
    ]),
    line('assistant', 'a3', [
      {
        type: 'tool_use',
        id: 'toolu_03',
        name: 'Bash',
        input: { command: 'npm test' },
      },
    ]),
    line('user', 'u3', [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_03',
        content: 'All tests passed',
      },
    ]),
  ].join('\n');
}

/**
 * Wait for a condition with timeout.
 */
async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ============================================================================
// 1. Checkpoint Store E2E
// ============================================================================

describe('E2E: Checkpoint Store via createNativeSessionlogStore', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should return empty array when no checkpoints branch exists', async () => {
    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoints = await store.listCheckpoints();
    expect(checkpoints).toEqual([]);
  });

  it('should return null for non-existent checkpoint', async () => {
    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoint = await store.getCheckpoint('does-not-exist');
    expect(checkpoint).toBeNull();
  });

  it('should list checkpoints from sessionlog/checkpoints/v1 branch', async () => {
    commitCheckpointToGit(repo.rootDir, 'ab12cd34ef56', {
      sessionId: 'session-1',
      filesTouched: ['src/app.ts'],
      summary: { intent: 'Fix auth bug', outcome: 'Fixed login flow' },
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoints = await store.listCheckpoints();

    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const cp = checkpoints.find((c) => c.id === 'ab12cd34ef56');
    expect(cp).toBeDefined();
    expect(cp!.sessionId).toBe('session-1');
    expect(cp!.filesModified).toEqual(['src/app.ts']);
    expect(cp!.commitMessage).toBe('Fix auth bug');
  });

  it('should get a single checkpoint by ID', async () => {
    commitCheckpointToGit(repo.rootDir, 'cd34ef56ab12', {
      sessionId: 'session-2',
      context: 'Working on database layer',
      summary: { intent: 'Refactor DB', outcome: 'DB refactored' },
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoint = await store.getCheckpoint('cd34ef56ab12');

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.id).toBe('cd34ef56ab12');
    expect(checkpoint!.sessionId).toBe('session-2');
    expect(checkpoint!.context).toBe('Working on database layer');
    expect(checkpoint!.commitMessage).toBe('Refactor DB');
  });

  it('should handle multiple checkpoints from different sessions', async () => {
    commitCheckpointToGit(repo.rootDir, 'aa11bb22cc33', {
      sessionId: 'session-a',
      filesTouched: ['src/auth.ts'],
      summary: { intent: 'Auth feature', outcome: 'Done' },
    });

    commitCheckpointToGit(repo.rootDir, 'dd44ee55ff66', {
      sessionId: 'session-b',
      filesTouched: ['src/db.ts'],
      summary: { intent: 'DB migration', outcome: 'Done' },
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoints = await store.listCheckpoints();

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    const ids = checkpoints.map((c) => c.id);
    expect(ids).toContain('aa11bb22cc33');
    expect(ids).toContain('dd44ee55ff66');
  });

  it('should handle checkpoint with token usage', async () => {
    commitCheckpointToGit(repo.rootDir, 'ff99ee88dd77', {
      sessionId: 'session-tokens',
      tokenUsage: {
        inputTokens: 5000,
        cacheReadTokens: 200,
        outputTokens: 3000,
        cacheCreationTokens: 1000,
      },
    });

    const store = createNativeSessionlogStore(repo.rootDir);
    const checkpoint = await store.getCheckpoint('ff99ee88dd77');

    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.tokenUsage).toEqual({
      input: 5200,   // 5000 + 200
      output: 3000,
      cache: 1000,
    });
  });
});

// ============================================================================
// 2. Provider Checkpoint Pipeline
// ============================================================================

describe('E2E: Provider Checkpoint Pipeline', () => {
  let repo: TestRepo;
  let provider: Provider;

  beforeEach(() => {
    repo = createTestRepo();
    const store: EntireStore = createNativeSessionlogStore(repo.rootDir);
    provider = createEntireProvider({}, store);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should expose checkpoints as ProviderNodes', async () => {
    commitCheckpointToGit(repo.rootDir, 'ab12cd34ef56', {
      sessionId: 'session-cp',
      filesTouched: ['src/feature.ts'],
      context: 'Adding feature flags',
      summary: { intent: 'Add feature flags', outcome: 'Feature flags added' },
    });

    const nodes = await provider.list();
    const cpNode = nodes.find((n) => n.id === 'ab12cd34ef56');

    expect(cpNode).toBeDefined();
    expect(cpNode!.uri).toBe('entire://checkpoint/ab12cd34ef56');
    expect(cpNode!.type).toBe('external');
    expect(cpNode!.status).toBe('closed'); // Checkpoints are immutable
    expect(cpNode!.rawData?.entityType).toBe('checkpoint');
    expect(cpNode!.rawData?.sessionId).toBe('session-cp');
  });

  it('should get checkpoint by URI', async () => {
    commitCheckpointToGit(repo.rootDir, 'cd34ef56ab12', {
      sessionId: 'session-uri',
      context: 'Testing context',
      summary: { intent: 'Test commit', outcome: 'Done' },
    });

    const node = await provider.get('entire://checkpoint/cd34ef56ab12');

    expect(node).not.toBeNull();
    expect(node!.id).toBe('cd34ef56ab12');
    expect(node!.status).toBe('closed');
    expect(node!.rawData?.entityType).toBe('checkpoint');
    expect(node!.content).toBe('Testing context');
  });

  it('should return null for non-existent checkpoint URI', async () => {
    const node = await provider.get('entire://checkpoint/does-not-exist');
    expect(node).toBeNull();
  });

  it('should list both sessions and checkpoints', async () => {
    const baseCommit = getHeadCommit(repo);

    writeSession(repo, 'mixed-session', {
      sessionID: 'mixed-session',
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: [],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Some work',
    });

    commitCheckpointToGit(repo.rootDir, 'aa11bb22cc33', {
      sessionId: 'mixed-session',
      summary: { intent: 'Checkpoint work', outcome: 'Done' },
    });

    const nodes = await provider.list();

    const sessionNode = nodes.find((n) => n.rawData?.entityType === 'session');
    const cpNode = nodes.find((n) => n.rawData?.entityType === 'checkpoint');

    expect(sessionNode).toBeDefined();
    expect(cpNode).toBeDefined();
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('should search checkpoints by context', async () => {
    commitCheckpointToGit(repo.rootDir, 'ab12cd34ef56', {
      sessionId: 'search-cp-1',
      context: 'Implementing OAuth2 authentication',
      summary: { intent: 'OAuth2', outcome: 'Done' },
    });

    commitCheckpointToGit(repo.rootDir, 'cd34ef56ab12', {
      sessionId: 'search-cp-2',
      context: 'Database optimization',
      summary: { intent: 'DB optimization', outcome: 'Done' },
    });

    const results = await provider.search!('OAuth2');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((n) => n.rawData?.sessionId === 'search-cp-1');
    expect(found).toBeDefined();
  });
});

// ============================================================================
// 3. Watcher Lifecycle E2E (requires RUN_SLOW_TESTS=1 due to filesystem polling)
// ============================================================================

const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1' || process.env.RUN_FULL_AGENT_TESTS === '1';

describe.skipIf(!SLOW_TESTS)('E2E: EntireWatcher filesystem events', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should emit started event for new session file', async () => {
    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    expect(watcher.isWatching).toBe(true);

    // Write a new session file
    writeSession(repo, 'watcher-new', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    await waitFor(() => events.length > 0, 15000);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const startEvent = events.find((e) => e.type === 'started');
    expect(startEvent).toBeDefined();
    expect(startEvent!.sessionId).toBe('watcher-new');
    expect(startEvent!.session.phase).toBe('ACTIVE');
    expect(startEvent!.session.agent).toBe('claude-code');

    await watcher.stop();
    expect(watcher.isWatching).toBe(false);
  });

  it('should emit ended event when phase transitions to ENDED', async () => {
    // Pre-create session so it's cached on startup
    writeSession(repo, 'watcher-end', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    // Transition to ENDED
    writeSession(repo, 'watcher-end', {
      agent: 'claude-code',
      phase: 'ENDED',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
      endedAt: new Date().toISOString(),
    });

    await waitFor(() => events.some((e) => e.type === 'ended'), 15000);

    const endEvent = events.find((e) => e.type === 'ended');
    expect(endEvent).toBeDefined();
    expect(endEvent!.sessionId).toBe('watcher-end');
    expect(endEvent!.previousPhase).toBe('ACTIVE');
    expect(endEvent!.session.phase).toBe('ENDED');

    await watcher.stop();
  });

  it('should emit checkpoint event when checkpoints array grows', async () => {
    // Pre-create session with no checkpoints
    writeSession(repo, 'watcher-cp', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    // Add a checkpoint
    writeSession(repo, 'watcher-cp', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: ['cp-001'],
    });

    await waitFor(() => events.some((e) => e.type === 'checkpoint'), 15000);

    const cpEvent = events.find((e) => e.type === 'checkpoint');
    expect(cpEvent).toBeDefined();
    expect(cpEvent!.sessionId).toBe('watcher-cp');
    expect(cpEvent!.checkpointId).toBe('cp-001');

    await watcher.stop();
  });

  it('should emit deleted event when session file is removed', async () => {
    // Pre-create session
    writeSession(repo, 'watcher-del', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    // Delete the session file
    deleteSession(repo, 'watcher-del');

    await waitFor(() => events.some((e) => e.type === 'deleted'), 15000);

    const delEvent = events.find((e) => e.type === 'deleted');
    expect(delEvent).toBeDefined();
    expect(delEvent!.sessionId).toBe('watcher-del');

    await watcher.stop();
  });

  it('should not emit events for pre-existing sessions on startup', async () => {
    // Write session BEFORE starting watcher
    writeSession(repo, 'pre-existing', {
      agent: 'claude-code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    // Wait a bit to ensure no events fire
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toHaveLength(0);

    await watcher.stop();
  });

  it('should normalize lowercase phase to uppercase', async () => {
    const events: EntireSessionEvent[] = [];

    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    writeSession(repo, 'watcher-norm', {
      agent: 'claude-code',
      phase: 'active',   // lowercase
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [],
    });

    await waitFor(() => events.length > 0, 15000);

    expect(events[0].session.phase).toBe('ACTIVE');

    await watcher.stop();
  });
});

// ============================================================================
// 4. Transcript Extractor E2E
// ============================================================================

describe('E2E: TranscriptExtractor with real git', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should extract tool calls from a Claude Code transcript', async () => {
    const sessionId = 'extractor-session';
    const checkpointId = 'ab12cd34ef56';

    const transcript = makeSampleTranscript(sessionId);
    commitCheckpointToGit(repo.rootDir, checkpointId, {
      sessionId,
      agent: 'Claude Code',
      transcript,
    });

    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const result = await extractor.extract({
      type: 'ended',
      sessionId,
      session: {
        id: sessionId,
        agent: 'Claude Code',
        phase: 'ENDED',
        checkpoints: [checkpointId],
      },
      timestamp: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(sessionId);
    expect(result!.agentType).toBe('Claude Code');
    expect(result!.toolCalls.length).toBe(3); // TaskCreate, show_issue, Bash

    const toolNames = result!.toolCalls.map((tc) => tc.toolName).sort();
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('TaskCreate');
    expect(toolNames).toContain('mcp__plugin_sudocode_sudocode__show_issue');

    // Verify categories
    expect(result!.toolCategories['claude-native']).toBeGreaterThanOrEqual(1);
    expect(result!.toolCategories['mcp-sudocode']).toBeGreaterThanOrEqual(1);
  });

  it('should return null for non-ended events', async () => {
    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const result = await extractor.extract({
      type: 'started',
      sessionId: 'test',
      session: {
        id: 'test',
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
      },
      timestamp: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it('should return null when session has no checkpoints', async () => {
    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const result = await extractor.extract({
      type: 'ended',
      sessionId: 'no-cp-session',
      session: {
        id: 'no-cp-session',
        agent: 'Claude Code',
        phase: 'ENDED',
        checkpoints: [],
      },
      timestamp: new Date().toISOString(),
    });

    expect(result).toBeNull();
  });

  it('should return empty tool calls for non-Claude agent', async () => {
    const checkpointId = 'ee55ff66aa11';
    const transcript = '{"some":"gemini-format-data"}\n';

    commitCheckpointToGit(repo.rootDir, checkpointId, {
      sessionId: 'gemini-session',
      agent: 'Gemini CLI',
      transcript,
    });

    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const result = await extractor.extract({
      type: 'ended',
      sessionId: 'gemini-session',
      session: {
        id: 'gemini-session',
        agent: 'Gemini CLI',
        phase: 'ENDED',
        checkpoints: [checkpointId],
      },
      timestamp: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    expect(result!.agentType).toBe('Gemini CLI');
    expect(result!.toolCalls).toEqual([]);
  });
});

// ============================================================================
// 5. Full Session Lifecycle
// ============================================================================

describe('E2E: Full session lifecycle (store + watcher + extractor)', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('should track session from ACTIVE through checkpoint to ENDED', async () => {
    const sessionId = 'lifecycle-session';
    const checkpointId = 'ab12cd34ef56';
    const baseCommit = getHeadCommit(repo);
    const store = createNativeSessionlogStore(repo.rootDir);
    const provider = createEntireProvider({}, store);

    // Phase 1: Create ACTIVE session
    writeSession(repo, sessionId, {
      sessionID: sessionId,
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [],
      filesTouched: ['src/auth.ts'],
      stepCount: 0,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Implement authentication',
    });

    // Verify ACTIVE session via store
    const activeSession = await store.getSession(sessionId);
    expect(activeSession).not.toBeNull();
    expect(activeSession!.phase).toBe('ACTIVE');
    expect(activeSession!.summary).toBe('Implement authentication');

    // Verify via provider
    const activeNode = await provider.get(`entire://session/${sessionId}`);
    expect(activeNode).not.toBeNull();
    expect(activeNode!.status).toBe('open');

    // Phase 2: Commit a checkpoint to git
    const transcript = makeSampleTranscript(sessionId);
    commitCheckpointToGit(repo.rootDir, checkpointId, {
      sessionId,
      agent: 'Claude Code',
      transcript,
      filesTouched: ['src/auth.ts'],
      summary: { intent: 'Implement auth', outcome: 'Auth implemented' },
    });

    // Update session with checkpoint
    writeSession(repo, sessionId, {
      sessionID: sessionId,
      agentType: 'claude-code',
      phase: 'active',
      baseCommit,
      startedAt: new Date().toISOString(),
      turnCheckpointIDs: [checkpointId],
      filesTouched: ['src/auth.ts'],
      stepCount: 5,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Implement authentication',
    });

    // Verify checkpoint is accessible
    const checkpoint = await store.getCheckpoint(checkpointId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.sessionId).toBe(sessionId);

    // Session now has checkpoint
    const sessionWithCp = await store.getSession(sessionId);
    expect(sessionWithCp!.checkpoints).toEqual([checkpointId]);

    // Phase 3: End session
    writeSession(repo, sessionId, {
      sessionID: sessionId,
      agentType: 'claude-code',
      phase: 'ended',
      baseCommit,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: new Date().toISOString(),
      turnCheckpointIDs: [checkpointId],
      filesTouched: ['src/auth.ts'],
      stepCount: 5,
      checkpointTranscriptStart: 0,
      untrackedFilesAtStart: [],
      firstPrompt: 'Implement authentication',
    });

    // Verify ended session
    const endedSession = await store.getSession(sessionId);
    expect(endedSession!.phase).toBe('ENDED');

    const endedNode = await provider.get(`entire://session/${sessionId}`);
    expect(endedNode!.status).toBe('closed');

    // Phase 4: Extract transcript
    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const extractionResult = await extractor.extract({
      type: 'ended',
      sessionId,
      session: {
        id: sessionId,
        agent: 'Claude Code',
        phase: 'ENDED',
        checkpoints: [checkpointId],
      },
      timestamp: new Date().toISOString(),
    });

    expect(extractionResult).not.toBeNull();
    expect(extractionResult!.sessionId).toBe(sessionId);
    expect(extractionResult!.agentType).toBe('Claude Code');
    expect(extractionResult!.toolCalls.length).toBeGreaterThan(0);

    // Verify provider list returns both session and checkpoint
    const allNodes = await provider.list();
    const sessionNodes = allNodes.filter((n) => n.rawData?.entityType === 'session');
    const cpNodes = allNodes.filter((n) => n.rawData?.entityType === 'checkpoint');
    expect(sessionNodes.length).toBeGreaterThanOrEqual(1);
    expect(cpNodes.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!SLOW_TESTS)('should handle watcher + extractor together on session end', async () => {
    const sessionId = 'watcher-extractor-session';
    const checkpointId = 'ff99ee88dd77';
    const events: EntireSessionEvent[] = [];

    // Commit transcript to git first
    const transcript = makeSampleTranscript(sessionId);
    commitCheckpointToGit(repo.rootDir, checkpointId, {
      sessionId,
      agent: 'Claude Code',
      transcript,
    });

    // Pre-create ACTIVE session
    writeSession(repo, sessionId, {
      agent: 'Claude Code',
      phase: 'ACTIVE',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [checkpointId],
    });

    // Start watcher
    const watcher = createEntireWatcher({
      locationPath: path.join(repo.rootDir, '.opentasks'),
      gitDir: path.join(repo.rootDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });
    watcher.onSessionEvent((event) => events.push(event));
    await watcher.start();

    // Transition to ENDED
    writeSession(repo, sessionId, {
      agent: 'Claude Code',
      phase: 'ENDED',
      baseCommit: 'abc123',
      branch: 'main',
      checkpoints: [checkpointId],
      endedAt: new Date().toISOString(),
    });

    // Wait for ended event
    await waitFor(() => events.some((e) => e.type === 'ended'), 15000);

    const endEvent = events.find((e) => e.type === 'ended')!;
    expect(endEvent.sessionId).toBe(sessionId);
    expect(endEvent.session.checkpoints).toContain(checkpointId);

    // Feed the ended event into the transcript extractor
    const extractor = createTranscriptExtractor({
      repoPath: repo.rootDir,
    });

    const result = await extractor.extract(endEvent);
    expect(result).not.toBeNull();
    expect(result!.toolCalls.length).toBeGreaterThan(0);
    expect(result!.agentType).toBe('Claude Code');

    await watcher.stop();
  });
});
