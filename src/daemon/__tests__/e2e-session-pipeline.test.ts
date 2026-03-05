/**
 * E2E Session Pipeline Tests
 *
 * Tests the full pipeline:
 *   session JSON write (simulating sessionlog) → EntireWatcher detects file change
 *   → EntireAutoLinker processes event → real GraphStore persists external node
 *
 * Uses real instances of all components (no mocks).
 * Gated behind RUN_SLOW_TESTS=1 because chokidar polling is needed.
 *
 * Note: The graph store does not persist node metadata (metadata is accepted
 * in CreateNodeInput but not included in StoredNode by buildStoredNode).
 * Task/plan metadata persistence through the linker is verified in the
 * linker unit tests (entire-linker.test.ts) using mocked stores.
 * These e2e tests verify that:
 * 1. The watcher correctly detects session files and parses task/plan data
 * 2. The linker creates nodes in the real store in response to watcher events
 * 3. The full pipeline works end-to-end for session lifecycle events
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createEntireWatcher,
  type EntireWatcher,
  type EntireSessionEvent,
} from '../entire-watcher.js';
import { createEntireAutoLinker, type EntireAutoLinker } from '../entire-linker.js';
import { createStoreForLocation } from '../location-state.js';
import { createDaemonFlushManager, type DaemonFlushManager } from '../flush.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node } from '../../schema/index.js';

const RUN_SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1';

// ============================================================================
// Helpers
// ============================================================================

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

function writeSessionFile(sessionsDir: string, id: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(data, null, 2));
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!RUN_SLOW_TESTS)('E2E: Session Pipeline (watcher → linker → store)', () => {
  let tmpDir: string;
  let opentasksPath: string;
  let sessionsDir: string;
  let store: GraphStore;
  let flushManager: DaemonFlushManager;
  let watcher: EntireWatcher;
  let linker: EntireAutoLinker;
  let linkerErrors: Error[];
  let watcherEvents: EntireSessionEvent[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-session-pipeline-'));
    opentasksPath = path.join(tmpDir, '.opentasks');
    sessionsDir = path.join(tmpDir, 'sessionlog-sessions');
    fs.mkdirSync(opentasksPath, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    store = await createStoreForLocation(opentasksPath);
    flushManager = createDaemonFlushManager(
      { debounceMs: 10, maxDelayMs: 100 },
      async () => {
        await store.flush();
      },
    );
    linker = createEntireAutoLinker({ store, flushManager });
    watcher = createEntireWatcher({
      locationPath: opentasksPath,
      gitDir: tmpDir,
      debounceMs: 10,
      usePolling: true,
    });

    linkerErrors = [];
    watcherEvents = [];
    watcher.onSessionEvent((event) => {
      watcherEvents.push(event);
      linker.handleSessionEvent(event).catch((err) => linkerErrors.push(err));
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 300));
  });

  afterEach(async () => {
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

  async function findSessionNode(sessionId: string): Promise<Node | null> {
    const nodes = await store.query.nodes({
      type: 'external',
      search: `Session: ${sessionId}`,
      limit: 1,
    });
    return nodes.length > 0 ? nodes[0] : null;
  }

  function assertNoLinkerErrors(): void {
    if (linkerErrors.length > 0) {
      throw new Error(`Linker errors: ${linkerErrors.map((e) => e.message).join(', ')}`);
    }
  }

  it('watcher parses task/plan data and linker creates node', async () => {
    const sessionId = 'test-tasks';

    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt: new Date().toISOString(),
      tasks: {
        'task-1': {
          id: 'task-1',
          subject: 'Implement auth',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
        },
      },
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });

    // Wait for watcher event
    await waitFor(() => watcherEvents.length > 0, 5000);

    // Verify watcher parsed task/plan data correctly
    const event = watcherEvents[0];
    expect(event.type).toBe('started');
    expect(event.session.tasks).toBeTruthy();
    expect(event.session.tasks!['task-1']).toBeTruthy();
    expect(event.session.tasks!['task-1'].subject).toBe('Implement auth');
    expect(event.session.inPlanMode).toBe(false);
    expect(event.session.planModeEntries).toBe(0);
    expect(event.session.planEntries).toHaveLength(0);

    // Wait for linker to process and create node in store
    await waitFor(async () => (await findSessionNode(sessionId)) !== null, 5000);
    assertNoLinkerErrors();

    const node = await findSessionNode(sessionId);
    expect(node).toBeTruthy();
    expect(node!.type).toBe('external');
    expect(node!.title).toBe(`Session: ${sessionId}`);
    expect((node as Record<string, unknown>).uri).toBe(`entire://session/${sessionId}`);
    expect((node as Record<string, unknown>).source).toBe('entire');
  });

  it('watcher emits updated event when tasks are added', async () => {
    const sessionId = 'test-update';

    // Initial session with no tasks
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      tasks: {},
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });

    await waitFor(() => watcherEvents.length > 0, 5000);
    expect(watcherEvents[0].type).toBe('started');

    // Wait for node creation and chokidar to settle
    await waitFor(async () => (await findSessionNode(sessionId)) !== null, 5000);
    await new Promise((r) => setTimeout(r, 200));

    // Add tasks
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      tasks: {
        't1': { id: 't1', subject: 'Setup DB', status: 'completed', createdAt: new Date().toISOString() },
        't2': { id: 't2', subject: 'Add migrations', status: 'in_progress', createdAt: new Date().toISOString() },
      },
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });

    // Wait for updated event (task count changed 0→2)
    await waitFor(() => watcherEvents.some((e) => e.type === 'updated'), 5000);
    assertNoLinkerErrors();

    const updated = watcherEvents.find((e) => e.type === 'updated')!;
    expect(updated.session.tasks).toBeTruthy();
    expect(Object.keys(updated.session.tasks!)).toHaveLength(2);
    expect(updated.session.tasks!['t2'].subject).toBe('Add migrations');
  });

  it('watcher emits updated event when plan mode is entered', async () => {
    const sessionId = 'test-plan';

    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      tasks: {},
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });

    await waitFor(() => watcherEvents.length > 0, 5000);
    await new Promise((r) => setTimeout(r, 200));

    // Enter plan mode
    const enteredAt = new Date().toISOString();
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      tasks: {},
      inPlanMode: true,
      planModeEntries: 1,
      planEntries: [{ enteredAt }],
    });

    await waitFor(() => watcherEvents.some((e) => e.type === 'updated'), 5000);
    assertNoLinkerErrors();

    const updated = watcherEvents.find((e) => e.type === 'updated')!;
    expect(updated.session.inPlanMode).toBe(true);
    expect(updated.session.planModeEntries).toBe(1);
    expect(updated.session.planEntries).toHaveLength(1);
    expect(updated.session.planEntries![0].enteredAt).toBe(enteredAt);
  });

  it('watcher emits ended event with final task/plan data', async () => {
    const sessionId = 'test-ended';
    const startedAt = new Date().toISOString();

    // Start session
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt,
      tasks: {
        't1': { id: 't1', subject: 'Write tests', status: 'in_progress', createdAt: startedAt },
      },
      inPlanMode: true,
      planModeEntries: 1,
      planEntries: [{ enteredAt: startedAt }],
    });

    await waitFor(() => watcherEvents.length > 0, 5000);
    await new Promise((r) => setTimeout(r, 200));

    // End session
    const endedAt = new Date().toISOString();
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ENDED',
      checkpoints: [],
      startedAt,
      endedAt,
      tasks: {
        't1': { id: 't1', subject: 'Write tests', status: 'completed', createdAt: startedAt },
      },
      inPlanMode: false,
      planModeEntries: 1,
      planEntries: [{ enteredAt: startedAt, exitedAt: endedAt }],
    });

    await waitFor(() => watcherEvents.some((e) => e.type === 'ended'), 5000);
    assertNoLinkerErrors();

    const ended = watcherEvents.find((e) => e.type === 'ended')!;
    expect(ended.session.phase).toBe('ENDED');
    expect(ended.session.endedAt).toBe(endedAt);
    expect(ended.session.tasks!['t1'].status).toBe('completed');
    expect(ended.session.planModeEntries).toBe(1);
    expect(ended.session.planEntries![0].exitedAt).toBe(endedAt);
  });

  it('full lifecycle: started → tasks → plan mode → ended', async () => {
    const sessionId = 'test-lifecycle';
    const startedAt = new Date().toISOString();

    // Step 1: Session starts
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt,
      tasks: {},
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });
    await waitFor(() => watcherEvents.some((e) => e.type === 'started'), 5000);
    await waitFor(async () => (await findSessionNode(sessionId)) !== null, 5000);

    // Verify node created in store
    let node = await findSessionNode(sessionId);
    expect(node).toBeTruthy();
    expect(node!.type).toBe('external');

    // Step 2: Task created (triggers updated event)
    await new Promise((r) => setTimeout(r, 200));
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt,
      tasks: {
        't1': { id: 't1', subject: 'Build API', status: 'in_progress', createdAt: startedAt },
      },
      inPlanMode: false,
      planModeEntries: 0,
      planEntries: [],
    });
    await waitFor(
      () => watcherEvents.filter((e) => e.type === 'updated').length >= 1,
      5000,
    );

    // Verify event has task data
    const taskEvent = watcherEvents.filter((e) => e.type === 'updated')[0];
    expect(Object.keys(taskEvent.session.tasks!)).toHaveLength(1);

    // Step 3: Enter plan mode (triggers another updated event)
    await new Promise((r) => setTimeout(r, 200));
    const planEnteredAt = new Date().toISOString();
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt,
      tasks: {
        't1': { id: 't1', subject: 'Build API', status: 'in_progress', createdAt: startedAt },
      },
      inPlanMode: true,
      planModeEntries: 1,
      planEntries: [{ enteredAt: planEnteredAt }],
    });
    await waitFor(
      () => watcherEvents.filter((e) => e.type === 'updated').length >= 2,
      5000,
    );

    // Step 4: Exit plan mode + add second task
    await new Promise((r) => setTimeout(r, 200));
    const planExitedAt = new Date().toISOString();
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ACTIVE',
      checkpoints: [],
      startedAt,
      tasks: {
        't1': { id: 't1', subject: 'Build API', status: 'completed', createdAt: startedAt },
        't2': { id: 't2', subject: 'Write tests', status: 'in_progress', createdAt: planExitedAt },
      },
      inPlanMode: false,
      planModeEntries: 1,
      planEntries: [{ enteredAt: planEnteredAt, exitedAt: planExitedAt }],
    });
    await waitFor(
      () => watcherEvents.filter((e) => e.type === 'updated').length >= 3,
      5000,
    );

    // Step 5: Session ends
    await new Promise((r) => setTimeout(r, 200));
    const endedAt = new Date().toISOString();
    writeSessionFile(sessionsDir, sessionId, {
      agent: 'claude-code',
      phase: 'ENDED',
      checkpoints: [],
      startedAt,
      endedAt,
      tasks: {
        't1': { id: 't1', subject: 'Build API', status: 'completed', createdAt: startedAt },
        't2': { id: 't2', subject: 'Write tests', status: 'completed', createdAt: planExitedAt },
      },
      inPlanMode: false,
      planModeEntries: 1,
      planEntries: [{ enteredAt: planEnteredAt, exitedAt: planExitedAt }],
    });
    await waitFor(() => watcherEvents.some((e) => e.type === 'ended'), 5000);

    assertNoLinkerErrors();

    // Node still exists in store
    node = await findSessionNode(sessionId);
    expect(node).toBeTruthy();

    // Final ended event has complete data
    const ended = watcherEvents.find((e) => e.type === 'ended')!;
    expect(ended.session.phase).toBe('ENDED');
    expect(ended.session.endedAt).toBe(endedAt);
    expect(Object.keys(ended.session.tasks!)).toHaveLength(2);
    expect(ended.session.tasks!['t1'].status).toBe('completed');
    expect(ended.session.tasks!['t2'].status).toBe('completed');
    expect(ended.session.planModeEntries).toBe(1);
    expect(ended.session.planEntries!).toHaveLength(1);
    expect(ended.session.planEntries![0].enteredAt).toBe(planEnteredAt);
    expect(ended.session.planEntries![0].exitedAt).toBe(planExitedAt);

    // Verify event sequence
    const eventTypes = watcherEvents.map((e) => e.type);
    expect(eventTypes[0]).toBe('started');
    expect(eventTypes.filter((t) => t === 'updated').length).toBeGreaterThanOrEqual(3);
    expect(eventTypes[eventTypes.length - 1]).toBe('ended');
  });
});
