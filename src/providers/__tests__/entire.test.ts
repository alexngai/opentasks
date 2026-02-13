/**
 * Tests for Entire Provider
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createEntireProvider,
  createInMemoryEntireStore,
  type EntireSession,
  type EntireCheckpoint,
} from '../entire.js'
import type { Provider } from '../types.js'
import { ProviderError } from '../types.js'

describe('EntireProvider', () => {
  let provider: Provider
  let store: ReturnType<typeof createInMemoryEntireStore>

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
  }

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
  }

  beforeEach(() => {
    store = createInMemoryEntireStore()
    provider = createEntireProvider({}, store)
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('entire')
    })

    it('should have correct schemes', () => {
      expect(provider.schemes).toEqual(['entire'])
    })

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        read: true,
        write: false,
        search: true,
        watch: false,
      })
    })
  })

  describe('parseUri', () => {
    it('should parse session URIs', () => {
      const result = provider.parseUri('entire://session/2026-02-13-abc')
      expect(result).toEqual({
        scheme: 'entire',
        workspace: 'session',
        id: '2026-02-13-abc',
        isRelative: false,
      })
    })

    it('should parse checkpoint URIs', () => {
      const result = provider.parseUri('entire://checkpoint/a3b2c4d5')
      expect(result).toEqual({
        scheme: 'entire',
        workspace: 'checkpoint',
        id: 'a3b2c4d5',
        isRelative: false,
      })
    })

    it('should be case-insensitive for scheme', () => {
      expect(provider.parseUri('ENTIRE://session/abc')).toMatchObject({
        scheme: 'entire',
        id: 'abc',
      })
    })

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('native://s-abc1')).toBeNull()
      expect(provider.parseUri('claude://current/42')).toBeNull()
    })

    it('should return null for invalid entire URIs', () => {
      expect(provider.parseUri('entire://invalid')).toBeNull()
      expect(provider.parseUri('entire://')).toBeNull()
      expect(provider.parseUri('invalid')).toBeNull()
    })
  })

  describe('buildUri', () => {
    it('should build session URI by default', () => {
      expect(provider.buildUri('2026-02-13-abc')).toBe('entire://session/2026-02-13-abc')
    })

    it('should build checkpoint URI with workspace', () => {
      expect(provider.buildUri('a3b2c4d5', { workspace: 'checkpoint' })).toBe(
        'entire://checkpoint/a3b2c4d5'
      )
    })

    it('should build relative URI when requested', () => {
      expect(provider.buildUri('abc', { relative: true })).toBe('abc')
    })
  })

  describe('isValidUri', () => {
    it('should return true for valid URIs', () => {
      expect(provider.isValidUri('entire://session/abc')).toBe(true)
      expect(provider.isValidUri('entire://checkpoint/abc')).toBe(true)
    })

    it('should return false for invalid URIs', () => {
      expect(provider.isValidUri('native://s-abc1')).toBe(false)
      expect(provider.isValidUri('entire://invalid')).toBe(false)
      expect(provider.isValidUri('invalid')).toBe(false)
    })
  })

  describe('get', () => {
    it('should get a session by full URI', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('2026-02-13-a1b2c3d4')
      expect(result?.uri).toBe('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.type).toBe('external')
      expect(result?.title).toContain('Implement authentication flow')
      expect(result?.status).toBe('open')
      expect(result?.rawData?.entityType).toBe('session')
      expect(result?.rawData?.agent).toBe('claude-code')
    })

    it('should get a checkpoint by full URI', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.get('entire://checkpoint/a3b2c4d5')

      expect(result).not.toBeNull()
      expect(result?.id).toBe('a3b2c4d5')
      expect(result?.uri).toBe('entire://checkpoint/a3b2c4d5')
      expect(result?.type).toBe('external')
      expect(result?.title).toContain('Add login endpoint')
      expect(result?.status).toBe('closed')
      expect(result?.rawData?.entityType).toBe('checkpoint')
      expect(result?.rawData?.commitHash).toBe('d7e8f9a')
    })

    it('should return null for non-existent session', async () => {
      const result = await provider.get('entire://session/nonexistent')
      expect(result).toBeNull()
    })

    it('should return null for non-existent checkpoint', async () => {
      const result = await provider.get('entire://checkpoint/nonexistent')
      expect(result).toBeNull()
    })

    it('should map ENDED session to closed status', async () => {
      store.addSession({ ...sampleSession, phase: 'ENDED' })

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.status).toBe('closed')
    })

    it('should map ACTIVE session to open status', async () => {
      store.addSession({ ...sampleSession, phase: 'ACTIVE' })

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.status).toBe('open')
    })

    it('should map IDLE session to open status', async () => {
      store.addSession({ ...sampleSession, phase: 'IDLE' })

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.status).toBe('open')
    })
  })

  describe('list', () => {
    it('should list all sessions and checkpoints', async () => {
      store.addSession(sampleSession)
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.list()

      expect(result).toHaveLength(2)
    })

    it('should filter by status', async () => {
      store.addSession({ ...sampleSession, phase: 'ACTIVE' })
      store.addSession({
        ...sampleSession,
        id: 'ended-session',
        phase: 'ENDED',
      })
      store.addCheckpoint(sampleCheckpoint)

      const openItems = await provider.list({ status: 'open' })
      expect(openItems).toHaveLength(1)
      expect(openItems[0].id).toBe(sampleSession.id)

      const closedItems = await provider.list({ status: 'closed' })
      expect(closedItems).toHaveLength(2) // ended session + checkpoint
    })

    it('should apply limit', async () => {
      store.addSession(sampleSession)
      store.addSession({ ...sampleSession, id: 'session-2' })
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.list({ limit: 2 })
      expect(result).toHaveLength(2)
    })

    it('should return empty array when no data', async () => {
      const result = await provider.list()
      expect(result).toEqual([])
    })
  })

  describe('write operations (read-only)', () => {
    it('should throw NOT_SUPPORTED for create', async () => {
      await expect(
        provider.create({ type: 'issue', title: 'test' })
      ).rejects.toThrow(ProviderError)

      await expect(
        provider.create({ type: 'issue', title: 'test' })
      ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    })

    it('should throw NOT_SUPPORTED for update', async () => {
      await expect(
        provider.update('any-id', { title: 'updated' })
      ).rejects.toThrow(ProviderError)
    })

    it('should throw NOT_SUPPORTED for delete', async () => {
      await expect(
        provider.delete('any-id')
      ).rejects.toThrow(ProviderError)
    })
  })

  describe('search', () => {
    it('should search sessions by summary', async () => {
      store.addSession(sampleSession)
      store.addSession({
        ...sampleSession,
        id: 'other-session',
        summary: 'Refactor database layer',
      })

      const results = await provider.search!('authentication')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(sampleSession.id)
    })

    it('should search checkpoints by commit message', async () => {
      store.addCheckpoint(sampleCheckpoint)
      store.addCheckpoint({
        ...sampleCheckpoint,
        id: 'other-checkpoint',
        commitMessage: 'Fix CSS styles',
        context: 'Fixed stylesheet issues',
      })

      const results = await provider.search!('login')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(sampleCheckpoint.id)
    })

    it('should search checkpoints by context', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const results = await provider.search!('JWT')
      expect(results).toHaveLength(1)
    })

    it('should search by ID', async () => {
      store.addSession(sampleSession)

      const results = await provider.search!('a1b2c3d4')
      expect(results).toHaveLength(1)
    })

    it('should apply search limit', async () => {
      store.addSession(sampleSession)
      store.addSession({ ...sampleSession, id: 'session-2', summary: 'auth test' })
      store.addCheckpoint({ ...sampleCheckpoint, context: 'auth related' })

      const results = await provider.search!('auth', { limit: 1 })
      expect(results).toHaveLength(1)
    })

    it('should return empty array for no matches', async () => {
      store.addSession(sampleSession)
      store.addCheckpoint(sampleCheckpoint)

      const results = await provider.search!('nonexistent-xyz')
      expect(results).toEqual([])
    })
  })

  describe('node conversion', () => {
    it('should include rawData with session details', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')

      expect(result?.rawData).toMatchObject({
        entityType: 'session',
        agent: 'claude-code',
        baseCommit: 'f4a2b1c',
        branch: 'feature/login',
        phase: 'ACTIVE',
        filesTouched: ['src/auth.ts', 'src/middleware.ts'],
      })
    })

    it('should include rawData with checkpoint details', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.get('entire://checkpoint/a3b2c4d5')

      expect(result?.rawData).toMatchObject({
        entityType: 'checkpoint',
        sessionId: '2026-02-13-a1b2c3d4',
        commitHash: 'd7e8f9a',
        promptCount: 5,
        filesModified: ['src/auth.ts'],
        filesNew: ['src/routes/login.ts'],
      })
    })

    it('should include content from checkpoint context', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.get('entire://checkpoint/a3b2c4d5')
      expect(result?.content).toBe('## Session Summary\nImplemented login endpoint with JWT.')
    })

    it('should include fetchedAt timestamp', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')

      expect(result?.fetchedAt).toBeDefined()
      expect(new Date(result!.fetchedAt).getTime()).toBeLessThanOrEqual(Date.now())
    })

    it('should use session ID in title when no summary', async () => {
      store.addSession({ ...sampleSession, summary: undefined })

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.title).toBe('Session: 2026-02-13-a1b2c3d4')
    })

    it('should use checkpoint ID in title when no commit message', async () => {
      store.addCheckpoint({ ...sampleCheckpoint, commitMessage: undefined })

      const result = await provider.get('entire://checkpoint/a3b2c4d5')
      expect(result?.title).toBe('Checkpoint: a3b2c4d5')
    })
  })

  describe('in-memory store', () => {
    it('should store and retrieve sessions', async () => {
      store.addSession(sampleSession)

      const result = await store.getSession(sampleSession.id)
      expect(result).toEqual(sampleSession)
    })

    it('should store and retrieve checkpoints', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const result = await store.getCheckpoint(sampleCheckpoint.id)
      expect(result).toEqual(sampleCheckpoint)
    })

    it('should list all sessions', async () => {
      store.addSession(sampleSession)
      store.addSession({ ...sampleSession, id: 'session-2' })

      const sessions = await store.listSessions()
      expect(sessions).toHaveLength(2)
    })

    it('should list all checkpoints', async () => {
      store.addCheckpoint(sampleCheckpoint)
      store.addCheckpoint({ ...sampleCheckpoint, id: 'cp-2' })

      const checkpoints = await store.listCheckpoints()
      expect(checkpoints).toHaveLength(2)
    })

    it('should return null for non-existent entries', async () => {
      expect(await store.getSession('nonexistent')).toBeNull()
      expect(await store.getCheckpoint('nonexistent')).toBeNull()
    })
  })
})
