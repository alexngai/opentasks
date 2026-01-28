/**
 * Tests for File Watcher
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  createFileWatcher,
  type FileWatcher,
  type FileChangeEvent,
  type WatcherConfig,
} from '../watcher.js'

describe('FileWatcher', () => {
  let tempDir: string
  let locationPath: string
  let watcher: FileWatcher

  const createConfig = (overrides: Partial<WatcherConfig> = {}): WatcherConfig => ({
    locationPath,
    debounceMs: 50, // Short debounce for tests
    ...overrides,
  })

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-watcher-test-'))
    locationPath = path.join(tempDir, '.opentasks')

    // Create directory structure
    await fs.mkdir(locationPath, { recursive: true })
    await fs.mkdir(path.join(locationPath, 'specs'), { recursive: true })
    await fs.mkdir(path.join(locationPath, 'issues'), { recursive: true })

    // Create initial files
    await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '')
    await fs.writeFile(path.join(locationPath, 'config.json'), '{}')
  })

  afterEach(async () => {
    if (watcher) {
      await watcher.stop()
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  describe('start/stop', () => {
    it('should start watching', async () => {
      watcher = createFileWatcher(createConfig())

      await expect(watcher.start()).resolves.not.toThrow()
    })

    it('should be idempotent for start', async () => {
      watcher = createFileWatcher(createConfig())

      await watcher.start()
      await watcher.start()
      await watcher.start()
    })

    it('should stop watching', async () => {
      watcher = createFileWatcher(createConfig())
      await watcher.start()

      await expect(watcher.stop()).resolves.not.toThrow()
    })

    it('should be safe to stop without starting', async () => {
      watcher = createFileWatcher(createConfig())

      await expect(watcher.stop()).resolves.not.toThrow()
    })
  })

  describe('change detection', () => {
    it('should detect graph.jsonl changes', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      // Modify file
      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"test":true}')

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].category).toBe('graph')
      expect(events[0].type).toBe('change')
    })

    it('should detect config.json changes', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'config.json'), '{"updated":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].category).toBe('config')
    })

    it('should detect new spec files', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'specs', 'test.md'), '# Test')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].category).toBe('spec')
      expect(events[0].type).toBe('add')
    })

    it('should detect new issue files', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'issues', 'test.md'), '# Test')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].category).toBe('issue')
    })

    it('should detect file deletion', async () => {
      // graph.jsonl is created in beforeEach and watched from start
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      // Give watcher time to fully initialize
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Delete graph.jsonl (which was watched from the start)
      await fs.unlink(path.join(locationPath, 'graph.jsonl'))

      // Wait longer for unlink to be detected (can be slow)
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].type).toBe('unlink')
      expect(events[0].category).toBe('graph')
    })

    it('should ignore non-markdown files in specs/issues', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'specs', 'test.txt'), 'text')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBe(0)
    })
  })

  describe('pause/resume', () => {
    it('should not emit events when paused', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      watcher.pause()
      expect(watcher.paused).toBe(true)

      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"paused":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBe(0)
    })

    it('should emit events after resume', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      watcher.pause()
      watcher.resume()
      expect(watcher.paused).toBe(false)

      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"resumed":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
    })
  })

  describe('debouncing', () => {
    it('should debounce rapid changes', async () => {
      watcher = createFileWatcher(createConfig({ debounceMs: 100 }))
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      // Rapid writes
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(locationPath, 'graph.jsonl'), `{"i":${i}}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      // Wait for debounce to settle
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should have fewer events than writes due to debouncing
      expect(events.length).toBeLessThan(5)
    })
  })

  describe('watchMarkdown option', () => {
    it('should not watch markdown when disabled', async () => {
      watcher = createFileWatcher(createConfig({ watchMarkdown: false }))
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'specs', 'test.md'), '# Test')

      await new Promise((resolve) => setTimeout(resolve, 150))

      // Should not detect markdown
      const markdownEvents = events.filter(
        (e) => e.category === 'spec' || e.category === 'issue'
      )
      expect(markdownEvents.length).toBe(0)
    })

    it('should still watch graph.jsonl when markdown disabled', async () => {
      watcher = createFileWatcher(createConfig({ watchMarkdown: false }))
      const events: FileChangeEvent[] = []
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"test":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events.length).toBeGreaterThan(0)
      expect(events[0].category).toBe('graph')
    })
  })

  describe('multiple handlers', () => {
    it('should notify all handlers', async () => {
      watcher = createFileWatcher(createConfig())
      const events1: FileChangeEvent[] = []
      const events2: FileChangeEvent[] = []

      watcher.onchange((event) => events1.push(event))
      watcher.onchange((event) => events2.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"multi":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(events1.length).toBeGreaterThan(0)
      expect(events2.length).toBeGreaterThan(0)
    })

    it('should continue with other handlers if one throws', async () => {
      watcher = createFileWatcher(createConfig())
      const events: FileChangeEvent[] = []

      watcher.onchange(() => {
        throw new Error('Handler error')
      })
      watcher.onchange((event) => events.push(event))

      await watcher.start()

      await fs.writeFile(path.join(locationPath, 'graph.jsonl'), '{"error":true}')

      await new Promise((resolve) => setTimeout(resolve, 150))

      // Second handler should still receive event
      expect(events.length).toBeGreaterThan(0)
    })
  })
})
