/**
 * Tests for Entire Session Watcher
 *
 * Unit tests for core watcher logic (event detection, phase normalization, etc.)
 * Filesystem integration tests require RUN_SLOW_TESTS=1 as they depend on
 * chokidar detecting file events, which may not work in all environments.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createEntireWatcher, type EntireSessionEvent } from '../entire-watcher.js'

const RUN_SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'

// Helper: wait for event with timeout
function waitForEvent(
  events: EntireSessionEvent[],
  predicate: (e: EntireSessionEvent) => boolean,
  timeoutMs = 5000
): Promise<EntireSessionEvent | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      const found = events.find(predicate)
      if (found) {
        resolve(found)
      } else if (Date.now() - start > timeoutMs) {
        resolve(null)
      } else {
        setTimeout(check, 50)
      }
    }
    check()
  })
}

describe('EntireWatcher', () => {
  let tmpDir: string
  let sessionsDir: string
  let events: EntireSessionEvent[]

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entire-watcher-test-'))
    sessionsDir = path.join(tmpDir, 'entire-sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    events = []
  })

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSessionFile(id: string, data: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(sessionsDir, `${id}.json`),
      JSON.stringify(data, null, 2)
    )
  }

  describe('lifecycle', () => {
    it('should not be watching before start', () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      })

      expect(watcher.isWatching).toBe(false)
    })

    it('should be watching after start', async () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      })

      await watcher.start()
      expect(watcher.isWatching).toBe(true)

      await watcher.stop()
      expect(watcher.isWatching).toBe(false)
    })

    it('should resolve sessions directory', () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      })

      expect(watcher.sessionsDir).toBe(sessionsDir)
    })

    it('should handle missing sessions directory gracefully', async () => {
      fs.rmSync(sessionsDir, { recursive: true })

      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()
      expect(events).toHaveLength(0)

      await watcher.stop()
    })

    it('should handle multiple start/stop cycles', async () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
      })

      await watcher.start()
      await watcher.stop()
      await watcher.start()
      await watcher.stop()

      expect(watcher.isWatching).toBe(false)
    })

    it('should cache existing sessions on startup without emitting events', async () => {
      writeSessionFile('2026-02-13-abc', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'abc123',
        branch: 'main',
        checkpoints: [],
      })

      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()

      // Existing sessions should be cached but not emit events
      expect(watcher.isWatching).toBe(true)
      expect(events).toHaveLength(0)

      await watcher.stop()
    })

    it('should return empty sessionsDir when no git directory found', () => {
      const watcher = createEntireWatcher({
        locationPath: '/nonexistent/path/.opentasks',
        // No gitDir override — will try to resolve and fail
      })

      expect(watcher.sessionsDir).toBe('')
    })

    it('should not start when sessionsDir is empty', async () => {
      const watcher = createEntireWatcher({
        locationPath: '/nonexistent/path/.opentasks',
      })

      await watcher.start()
      expect(watcher.isWatching).toBe(false)

      await watcher.stop()
    })
  })

  // Filesystem-dependent tests that require chokidar to detect real file events.
  // These are inherently environment-dependent (inotify, polling, etc.)
  describe.skipIf(!RUN_SLOW_TESTS)('filesystem integration', () => {
    it('should emit started event for new session files', async () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()

      writeSessionFile('2026-02-13-new', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'def456',
        checkpoints: [],
      })

      const event = await waitForEvent(events, (e) => e.type === 'started')
      expect(event).not.toBeNull()
      expect(event?.sessionId).toBe('2026-02-13-new')
      expect(event?.session.agent).toBe('claude-code')
      expect(event?.session.phase).toBe('ACTIVE')

      await watcher.stop()
    })

    it('should emit checkpoint event when checkpoints change', async () => {
      writeSessionFile('session-cp', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      })

      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()

      writeSessionFile('session-cp', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: ['cp-001'],
      })

      const cpEvent = await waitForEvent(events, (e) => e.type === 'checkpoint')
      expect(cpEvent).not.toBeNull()
      expect(cpEvent?.checkpointId).toBe('cp-001')

      await watcher.stop()
    })

    it('should emit ended event when session phase becomes ENDED', async () => {
      writeSessionFile('session-end', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      })

      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()

      writeSessionFile('session-end', {
        agent: 'claude-code',
        phase: 'ENDED',
        checkpoints: [],
        endedAt: '2026-02-13T16:00:00Z',
      })

      const endEvent = await waitForEvent(events, (e) => e.type === 'ended')
      expect(endEvent).not.toBeNull()
      expect(endEvent?.previousPhase).toBe('ACTIVE')

      await watcher.stop()
    })

    it('should normalize lowercase phase strings', async () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent((event) => events.push(event))
      await watcher.start()

      writeSessionFile('session-lower', {
        agent: 'claude-code',
        phase: 'active',
        checkpoints: [],
      })

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-lower')
      expect(event).not.toBeNull()
      expect(event?.session.phase).toBe('ACTIVE')

      await watcher.stop()
    })

    it('should not crash when handler throws', async () => {
      const watcher = createEntireWatcher({
        locationPath: path.join(tmpDir, '.opentasks'),
        gitDir: tmpDir,
        debounceMs: 10,
        usePolling: true,
      })

      watcher.onSessionEvent(() => {
        throw new Error('handler error')
      })
      watcher.onSessionEvent((event) => events.push(event))

      await watcher.start()

      writeSessionFile('session-err', {
        agent: 'claude-code',
        phase: 'ACTIVE',
        checkpoints: [],
      })

      const event = await waitForEvent(events, (e) => e.sessionId === 'session-err')
      expect(event).not.toBeNull()

      await watcher.stop()
    })
  })
})
