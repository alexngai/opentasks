/**
 * Tests for Sessionlog Session Watcher
 *
 * Unit tests for core watcher logic (event detection, phase normalization, etc.)
 * Filesystem integration tests require RUN_SLOW_TESTS=1 as they depend on
 * chokidar detecting file events, which may not work in all environments.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionlogWatcher, type SessionlogSessionEvent } from '../sessionlog-watcher.js';

const RUN_SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1';

// Helper: wait for event with timeout
function waitForEvent(
  events: SessionlogSessionEvent[],
  predicate: (e: SessionlogSessionEvent) => boolean,
  timeoutMs = 5000,
): Promise<SessionlogSessionEvent | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const found = events.find(predicate);
      if (found) {
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        resolve(null);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

describe('SessionlogWatcher', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let events: SessionlogSessionEvent[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-watcher-test-'));
    sessionsDir = path.join(tmpDir, 'sessionlog-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    events = [];
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSessionFile(id: string, data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(data, null, 2));
  }

  describe('lifecycle', () => {
    it('should not be watching before start', () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      });

      expect(watcher.isWatching).toBe(false);
    });

    it('should be watching after start', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      });

      await watcher.start();
      expect(watcher.isWatching).toBe(true);

      await watcher.stop();
      expect(watcher.isWatching).toBe(false);
    });

    it('should resolve sessions directory', () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      });

      expect(watcher.sessionsDir).toBe(sessionsDir);
    });

    it('should handle missing sessions directory gracefully', async () => {
      fs.rmSync(sessionsDir, { recursive: true });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();
      expect(events).toHaveLength(0);

      await watcher.stop();
    });

    it('should handle multiple start/stop cycles', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      });

      await watcher.start();
      await watcher.stop();
      await watcher.start();
      await watcher.stop();

      expect(watcher.isWatching).toBe(false);
    });

    it('should cache existing sessions on startup without emitting events', async () => {
      writeSessionFile('2026-02-13-abc', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'abc123',
        branch: 'main',
        checkpoints: [],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      // Existing sessions should be cached but not emit events
      expect(watcher.isWatching).toBe(true);
      expect(events).toHaveLength(0);

      await watcher.stop();
    });

    it('should return empty sessionsDir when no git directory found', () => {
      const watcher = createSessionlogWatcher({
        locationPath: '/nonexistent/path/.opentasks',
        // No gitDir override — will try to resolve and fail
      });

      expect(watcher.sessionsDir).toBe('');
    });

    it('should not start when sessionsDir is empty', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: '/nonexistent/path/.opentasks',
      });

      await watcher.start();
      expect(watcher.isWatching).toBe(false);

      await watcher.stop();
    });
  });

  describe('session file parsing - task/plan data', () => {
    it('should parse tasks from session file', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-tasks', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        tasks: {
          '1': {
            id: '1',
            subject: 'Fix auth bug',
            status: 'in_progress',
            createdAt: '2026-03-04T10:00:00Z',
            updatedAt: '2026-03-04T10:01:00Z',
          },
          '2': {
            id: '2',
            subject: 'Write tests',
            status: 'pending',
            createdAt: '2026-03-04T10:00:00Z',
            updatedAt: '2026-03-04T10:00:00Z',
          },
        },
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-tasks');
      expect(event).not.toBeNull();
      expect(event!.session.tasks).toBeDefined();
      expect(Object.keys(event!.session.tasks!)).toHaveLength(2);
      expect(event!.session.tasks!['1'].subject).toBe('Fix auth bug');
      expect(event!.session.tasks!['1'].status).toBe('in_progress');
      expect(event!.session.tasks!['2'].subject).toBe('Write tests');

      await watcher.stop();
    });

    it('should parse plan mode data from session file', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-plan', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: true,
        planModeEntries: 1,
        planEntries: [
          {
            enteredAt: '2026-03-04T10:00:00Z',
          },
        ],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-plan');
      expect(event).not.toBeNull();
      expect(event!.session.inPlanMode).toBe(true);
      expect(event!.session.planModeEntries).toBe(1);
      expect(event!.session.planEntries).toHaveLength(1);
      expect(event!.session.planEntries![0].enteredAt).toBe('2026-03-04T10:00:00Z');

      await watcher.stop();
    });

    it('should parse completed plan entries with content', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-plan-done', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: false,
        planModeEntries: 1,
        planEntries: [
          {
            enteredAt: '2026-03-04T10:00:00Z',
            exitedAt: '2026-03-04T10:05:00Z',
            filePath: 'plan.md',
            content: '## Plan\n1. Fix auth\n2. Add tests',
            allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
          },
        ],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-plan-done');
      expect(event).not.toBeNull();
      expect(event!.session.inPlanMode).toBe(false);

      const entry = event!.session.planEntries![0];
      expect(entry.exitedAt).toBe('2026-03-04T10:05:00Z');
      expect(entry.content).toContain('Fix auth');
      expect(entry.allowedPrompts).toHaveLength(1);

      await watcher.stop();
    });

    it('should parse skillsUsed from session file', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-skills', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        skillsUsed: [
          { name: 'commit', usedAt: '2026-03-04T10:00:00Z' },
          { name: 'review-pr', args: '123', usedAt: '2026-03-04T10:01:00Z' },
        ],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-skills');
      expect(event).not.toBeNull();
      expect(event!.session.skillsUsed).toHaveLength(2);
      expect(event!.session.skillsUsed![0].name).toBe('commit');
      expect(event!.session.skillsUsed![1].args).toBe('123');

      await watcher.stop();
    });

    it('should handle session files without task/plan fields gracefully', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-minimal', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-minimal');
      expect(event).not.toBeNull();
      expect(event!.session.tasks).toBeUndefined();
      expect(event!.session.inPlanMode).toBeUndefined();
      expect(event!.session.planEntries).toBeUndefined();
      expect(event!.session.skillsUsed).toBeUndefined();

      await watcher.stop();
    });
  });

  describe('task/plan change detection', () => {
    it('should emit updated event when a task is added', async () => {
      writeSessionFile('session-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      // Add a task (same phase, no checkpoint change)
      writeSessionFile('session-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        tasks: {
          '1': {
            id: '1',
            subject: 'New task',
            status: 'pending',
            createdAt: '2026-03-04T10:00:00Z',
            updatedAt: '2026-03-04T10:00:00Z',
          },
        },
      });

      const event = await waitForEvent(events, (e) => e.type === 'updated');
      expect(event).not.toBeNull();
      expect(event!.session.tasks).toBeDefined();
      expect(Object.keys(event!.session.tasks!)).toHaveLength(1);

      await watcher.stop();
    });

    it('should emit updated event when plan mode is entered', async () => {
      writeSessionFile('session-plan-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: false,
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      // Enter plan mode (same phase, no checkpoint change)
      writeSessionFile('session-plan-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: true,
        planModeEntries: 1,
        planEntries: [{ enteredAt: '2026-03-04T10:00:00Z' }],
      });

      const event = await waitForEvent(events, (e) => e.type === 'updated');
      expect(event).not.toBeNull();
      expect(event!.session.inPlanMode).toBe(true);

      await watcher.stop();
    });

    it('should emit updated event when plan entries count changes', async () => {
      writeSessionFile('session-plan-exit', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: true,
        planModeEntries: 1,
        planEntries: [{ enteredAt: '2026-03-04T10:00:00Z' }],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      // Exit plan mode and enter again (planEntries grows)
      writeSessionFile('session-plan-exit', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        inPlanMode: true,
        planModeEntries: 2,
        planEntries: [
          { enteredAt: '2026-03-04T10:00:00Z', exitedAt: '2026-03-04T10:05:00Z' },
          { enteredAt: '2026-03-04T10:10:00Z' },
        ],
      });

      const event = await waitForEvent(events, (e) => e.type === 'updated');
      expect(event).not.toBeNull();
      expect(event!.session.planEntries).toHaveLength(2);

      await watcher.stop();
    });

    it('should NOT emit event when only task status changes (same count)', async () => {
      writeSessionFile('session-no-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        tasks: {
          '1': {
            id: '1',
            subject: 'Task',
            status: 'pending',
            createdAt: '2026-03-04T10:00:00Z',
            updatedAt: '2026-03-04T10:00:00Z',
          },
        },
        inPlanMode: false,
        planEntries: [],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      // Change task status but not count, same plan state
      writeSessionFile('session-no-change', {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        checkpoints: [],
        tasks: {
          '1': {
            id: '1',
            subject: 'Task',
            status: 'completed',
            createdAt: '2026-03-04T10:00:00Z',
            updatedAt: '2026-03-04T10:01:00Z',
          },
        },
        inPlanMode: false,
        planEntries: [],
      });

      // Wait a bit and verify no event was emitted
      await new Promise((r) => setTimeout(r, 500));
      expect(events).toHaveLength(0);

      await watcher.stop();
    });
  });

  // Filesystem-dependent tests that require chokidar to detect real file events.
  // These are inherently environment-dependent (inotify, polling, etc.)
  describe.skipIf(!RUN_SLOW_TESTS)('filesystem integration', () => {
    it('should emit started event for new session files', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('2026-02-13-new', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'def456',
        checkpoints: [],
      });

      const event = await waitForEvent(events, (e) => e.type === 'started');
      expect(event).not.toBeNull();
      expect(event?.sessionId).toBe('2026-02-13-new');
      expect(event?.session.agent).toBe('claude-code');
      expect(event?.session.phase).toBe('ACTIVE');

      await watcher.stop();
    });

    it('should emit checkpoint event when checkpoints change', async () => {
      writeSessionFile('session-cp', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-cp', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: ['cp-001'],
      });

      const cpEvent = await waitForEvent(events, (e) => e.type === 'checkpoint');
      expect(cpEvent).not.toBeNull();
      expect(cpEvent?.checkpointId).toBe('cp-001');

      await watcher.stop();
    });

    it('should emit ended event when session phase becomes ENDED', async () => {
      writeSessionFile('session-end', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      });

      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-end', {
        agent: 'claude-code',
        phase: 'ENDED',
        checkpoints: [],
        endedAt: '2026-02-13T16:00:00Z',
      });

      const endEvent = await waitForEvent(events, (e) => e.type === 'ended');
      expect(endEvent).not.toBeNull();
      expect(endEvent?.previousPhase).toBe('ACTIVE');

      await watcher.stop();
    });

    it('should normalize lowercase phase strings', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent((event) => events.push(event));
      await watcher.start();

      writeSessionFile('session-lower', {
        agent: 'claude-code',
        phase: 'active',
        checkpoints: [],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-lower');
      expect(event).not.toBeNull();
      expect(event?.session.phase).toBe('ACTIVE');

      await watcher.stop();
    });

    it('should not crash when handler throws', async () => {
      const watcher = createSessionlogWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      });

      watcher.onSessionEvent(() => {
        throw new Error('handler error');
      });
      watcher.onSessionEvent((event) => events.push(event));

      await watcher.start();

      writeSessionFile('session-err', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      });

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-err');
      expect(event).not.toBeNull();

      await watcher.stop();
    });
  });
});
