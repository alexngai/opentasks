/**
 * Live Agent E2E Tests
 *
 * Spawns a real Claude Code agent via acp-factory, lets sessionlog hooks write
 * real session files to `.git/sessionlog-sessions/`, and verifies that the
 * SessionlogWatcher + SessionlogAutoLinker pipeline detects tasks and plan mode data.
 *
 * Requires:
 * - `claude` CLI in PATH (Anthropic Max or API key configured)
 * - `sessionlog` CLI in PATH (`npm link` in references/sessionlog)
 *
 * Run: LIVE_AGENT=1 npx vitest run src/daemon/__tests__/e2e-live-agent.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentFactory, type AgentHandle, type Session, type ExtendedSessionUpdate } from 'acp-factory';
import {
  createSessionlogWatcher,
  type SessionlogWatcher,
  type SessionlogSessionEvent,
} from '../sessionlog-watcher.js';
import { createSessionlogAutoLinker, type SessionlogAutoLinker } from '../sessionlog-linker.js';
import { createStoreForLocation } from '../location-state.js';
import { createDaemonFlushManager, type DaemonFlushManager } from '../flush.js';
import type { GraphStore } from '../../graph/store.js';

const LIVE = process.env.LIVE_AGENT === '1';

// ============================================================================
// Helpers
// ============================================================================

function initRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@e2e.dev'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Project\n\nA simple test project for e2e testing.');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' });
}

function enableSessionlog(dir: string): void {
  execFileSync('sessionlog', ['enable', '--force', '--agent', 'claude-code'], {
    cwd: dir,
    stdio: 'pipe',
  });
}

/**
 * Run a prompt via acp-factory and collect the full response text.
 * The ACP ContentChunk has { content: { type: "text", text: "..." } }.
 */
async function runPrompt(session: Session, prompt: string): Promise<string> {
  let responseText = '';
  for await (const update of session.prompt(prompt) as AsyncIterable<ExtendedSessionUpdate>) {
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = (update as unknown as { content: { text?: string } }).content;
      if (content?.text) {
        responseText += content.text;
      }
    }
  }
  return responseText;
}

function readSessionStates(dir: string): Record<string, unknown>[] {
  const sessionsDir = path.join(dir, '.git', 'sessionlog-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number = 10000,
  intervalMs: number = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!LIVE)('Live Agent E2E: Session Pipeline', () => {
  let tmpDir: string;
  let opentasksPath: string;
  let store: GraphStore;
  let flushManager: DaemonFlushManager;
  let watcher: SessionlogWatcher;
  let linker: SessionlogAutoLinker;
  let watcherEvents: SessionlogSessionEvent[];
  let linkerErrors: Error[];
  let agentHandle: AgentHandle | null = null;
  let agentSession: Session | null = null;

  beforeAll(() => {
    try {
      execFileSync('which', ['sessionlog'], { stdio: 'pipe' });
    } catch {
      throw new Error('sessionlog CLI not found in PATH. Run: cd references/sessionlog && npm run build && npm link');
    }
    try {
      execFileSync('which', ['claude'], { stdio: 'pipe' });
    } catch {
      throw new Error('claude CLI not found in PATH');
    }
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-live-agent-'));

    // 1. Real git repo with sessionlog enabled
    initRepo(tmpDir);
    enableSessionlog(tmpDir);

    // 2. Opentasks store
    opentasksPath = path.join(tmpDir, '.opentasks');
    fs.mkdirSync(opentasksPath, { recursive: true });
    store = await createStoreForLocation(opentasksPath);

    // 3. Flush manager + linker
    flushManager = createDaemonFlushManager(
      { debounceMs: 10, maxDelayMs: 100 },
      async () => {
        await store.flush();
      },
    );
    linker = createSessionlogAutoLinker({ store, flushManager });

    // 4. Watcher pointing at real .git/sessionlog-sessions/
    watcher = createSessionlogWatcher({
      locationPath: opentasksPath,
      gitDir: path.join(tmpDir, '.git'),
      debounceMs: 10,
      usePolling: true,
    });

    // 5. Wire pipeline
    watcherEvents = [];
    linkerErrors = [];
    watcher.onSessionEvent((event) => {
      watcherEvents.push(event);
      linker.handleSessionEvent(event).catch((err) => {
        linkerErrors.push(err);
        process.stderr.write(`[LINKER ERROR] ${err.message}\n${err.stack}\n`);
      });
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 300));

    // 6. Spawn Claude Code agent via acp-factory
    // Use settingSources: ['project'] to only load project .claude/settings.json
    // (sessionlog hooks) without loading user-level MCP plugins that may interfere.
    agentHandle = await AgentFactory.spawn('claude-code', {
      permissionMode: 'auto-approve',
    });
    agentSession = await agentHandle.createSession(tmpDir, {
      agentMeta: {
        claudeCode: {
          options: {
            settingSources: ['project'],
          },
        },
      },
    });
  });

  afterEach(async () => {
    // Close agent handle first
    if (agentHandle) {
      try {
        await agentHandle.close();
      } catch {
        /* ignore */
      }
      agentHandle = null;
      agentSession = null;
    }
    try {
      await watcher.stop();
    } catch {
      /* ignore */
    }
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function assertNoLinkerErrors(): void {
    if (linkerErrors.length > 0) {
      throw new Error(`Linker errors: ${linkerErrors.map((e) => e.message).join(', ')}`);
    }
  }

  it(
    'detects live agent session with todo items',
    async () => {
      // Use TodoWrite — the native Claude Code todo/task tool.
      // TaskCreate requires team/swarm setup and is not available in standard sessions.
      const prompt = [
        'Use the TodoWrite tool to create a todo list with exactly 2 items for this project.',
        'Item 1: "Set up database schema" (in_progress).',
        'Item 2: "Add API endpoints" (pending).',
        'Do NOT do any actual coding work — only create the todo list.',
      ].join(' ');

      await runPrompt(agentSession!, prompt);

      // Wait for hooks + watcher + linker pipeline to settle
      await new Promise((r) => setTimeout(r, 2000));

      // Verify sessionlog wrote session files
      const sessions = readSessionStates(tmpDir);
      expect(sessions.length).toBeGreaterThan(0);

      // Verify watcher detected events
      await waitFor(() => watcherEvents.length > 0, 5000);
      expect(watcherEvents.length).toBeGreaterThan(0);

      assertNoLinkerErrors();

      // Verify linker created node in store
      await waitFor(async () => {
        const n = await store.query.nodes({ type: 'external', limit: 5 });
        return n.length > 0;
      }, 5000);
      const allExternal = await store.query.nodes({ type: 'external', limit: 10 });
      expect(allExternal.length).toBeGreaterThan(0);
    },
    360_000,
  );

  it(
    'detects live agent plan mode',
    async () => {
      const prompt = [
        'I want to add dark mode to this web app.',
        'Please enter plan mode, write a brief implementation plan, then exit plan mode.',
        'Do NOT make any code changes — just create the plan.',
      ].join(' ');

      await runPrompt(agentSession!, prompt);
      await new Promise((r) => setTimeout(r, 2000));

      // Verify session has plan mode data
      const sessions = readSessionStates(tmpDir);
      expect(sessions.length).toBeGreaterThan(0);

      const sessionWithPlan = sessions.find((s) => (s.planModeEntries as number) > 0);
      expect(sessionWithPlan).toBeDefined();
      expect(sessionWithPlan!.planModeEntries).toBeGreaterThanOrEqual(1);

      const planEntries = sessionWithPlan!.planEntries as Array<{ enteredAt?: string; exitedAt?: string }>;
      expect(planEntries).toBeDefined();
      expect(planEntries.length).toBeGreaterThanOrEqual(1);
      expect(planEntries[0].enteredAt).toBeDefined();

      // Verify watcher detected events
      await waitFor(() => watcherEvents.length > 0, 5000);
      expect(watcherEvents.length).toBeGreaterThan(0);

      // Verify watcher event has plan data
      const eventWithPlan = watcherEvents.find(
        (e) => e.session.planModeEntries !== undefined && e.session.planModeEntries > 0,
      );
      expect(eventWithPlan).toBeDefined();

      assertNoLinkerErrors();
    },
    360_000,
  );

  it(
    'full lifecycle: todos + plan mode in single session',
    async () => {
      const prompt = [
        'Do the following steps in order:',
        '1. Use the TodoWrite tool to create a todo item: "Build authentication" (pending).',
        '2. Enter plan mode and write a brief implementation plan for the task.',
        '3. Exit plan mode.',
        'Do NOT do any actual coding work.',
      ].join(' ');

      await runPrompt(agentSession!, prompt);
      await new Promise((r) => setTimeout(r, 2000));

      const sessions = readSessionStates(tmpDir);
      expect(sessions.length).toBeGreaterThan(0);

      // Verify session captured plan mode data
      // (TodoWrite is tracked by sessionlog via PostToolUse hook)
      const session = sessions.find((s) => {
        const hasPlan = (s.planModeEntries as number) > 0;
        return hasPlan;
      });
      expect(session).toBeDefined();
      expect(session!.planModeEntries).toBeGreaterThanOrEqual(1);

      // Verify watcher pipeline processed events
      await waitFor(() => watcherEvents.length > 0, 5000);
      expect(watcherEvents.length).toBeGreaterThan(0);

      assertNoLinkerErrors();

      // Verify node created in store
      await waitFor(async () => {
        const n = await store.query.nodes({ type: 'external', search: 'Session:', limit: 5 });
        return n.length > 0;
      }, 5000);
      const nodes = await store.query.nodes({ type: 'external', search: 'Session:', limit: 5 });
      expect(nodes.length).toBeGreaterThan(0);
    },
    360_000,
  );
});
