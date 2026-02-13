/**
 * Tests for Entire Provider
 *
 * Tests both the in-memory store (unit tests) and the CLI store
 * (exec-mocked integration tests) to ensure correctness across
 * both code paths.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import {
  createEntireProvider,
  createEntireCliStore,
  createInMemoryEntireStore,
  type EntireSession,
  type EntireCheckpoint,
  type EntireStore,
} from '../entire.js'
import type { Provider } from '../types.js'
import { ProviderError } from '../types.js'

// ============================================================================
// Mock child_process for CLI store tests
// ============================================================================

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'

let mockExec: Mock

function mockExecResponse(stdout: string, stderr: string = '') {
  mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
    const cb = (typeof callback === 'function' ? callback : options) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void
    if (typeof cb === 'function') {
      cb(null, { stdout, stderr })
    }
    return { stdout, stderr }
  })
}

function mockExecError(error: Error & { code?: string | number }) {
  mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
    const cb = (typeof callback === 'function' ? callback : options) as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void
    if (typeof cb === 'function') {
      cb(error, { stdout: '', stderr: error.message })
    }
  })
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

// ============================================================================
// Provider Tests (using in-memory store)
// ============================================================================

describe('EntireProvider', () => {
  let provider: Provider
  let store: ReturnType<typeof createInMemoryEntireStore>

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
      expect(provider.parseUri('Entire://Checkpoint/xyz')).toMatchObject({
        scheme: 'entire',
        workspace: 'checkpoint',
        id: 'xyz',
      })
    })

    it('should return null for unknown schemes', () => {
      expect(provider.parseUri('native://s-abc1')).toBeNull()
      expect(provider.parseUri('claude://current/42')).toBeNull()
      expect(provider.parseUri('beads://./bd-123')).toBeNull()
    })

    it('should return null for invalid entire URIs', () => {
      expect(provider.parseUri('entire://invalid')).toBeNull()
      expect(provider.parseUri('entire://')).toBeNull()
      expect(provider.parseUri('entire://session/')).toBeNull()
      expect(provider.parseUri('invalid')).toBeNull()
      expect(provider.parseUri('')).toBeNull()
    })

    it('should handle IDs with special characters', () => {
      const result = provider.parseUri('entire://session/2026-02-13_abc.def')
      expect(result).toMatchObject({
        scheme: 'entire',
        workspace: 'session',
        id: '2026-02-13_abc.def',
      })
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

    it('should use session workspace by default', () => {
      expect(provider.buildUri('test-id')).toBe('entire://session/test-id')
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
      expect(provider.isValidUri('')).toBe(false)
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

    it('should get a session by bare ID (defaults to session type)', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('2026-02-13-a1b2c3d4')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('2026-02-13-a1b2c3d4')
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
      // Sessions come first, then checkpoints
      expect(result[0].rawData?.entityType).toBe('session')
      expect(result[1].rawData?.entityType).toBe('checkpoint')
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

    it('should list sessions with no checkpoints', async () => {
      store.addSession(sampleSession)

      const result = await provider.list()
      expect(result).toHaveLength(1)
      expect(result[0].rawData?.entityType).toBe('session')
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

      await expect(
        provider.update('any-id', { title: 'updated' })
      ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    })

    it('should throw NOT_SUPPORTED for delete', async () => {
      await expect(
        provider.delete('any-id')
      ).rejects.toThrow(ProviderError)

      await expect(
        provider.delete('any-id')
      ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    })
  })

  describe('search', () => {
    it('should search sessions by summary', async () => {
      store.addSession(sampleSession)
      store.addSession({
        ...sampleSession,
        id: 'other-session',
        summary: 'Refactor database layer',
        filesTouched: ['src/db.ts'],
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
        filesModified: ['src/styles.css'],
        filesNew: [],
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

    it('should search sessions by filesTouched', async () => {
      store.addSession(sampleSession)

      const results = await provider.search!('middleware')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(sampleSession.id)
    })

    it('should search checkpoints by filesModified', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const results = await provider.search!('src/auth.ts')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(sampleCheckpoint.id)
    })

    it('should search checkpoints by filesNew', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const results = await provider.search!('routes/login')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(sampleCheckpoint.id)
    })

    it('should be case-insensitive', async () => {
      store.addSession(sampleSession)

      const results = await provider.search!('AUTHENTICATION')
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

    it('should include content from session summary', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.content).toBe('Implement authentication flow')
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

    it('should include token usage in rawData', async () => {
      store.addSession(sampleSession)

      const result = await provider.get('entire://session/2026-02-13-a1b2c3d4')
      expect(result?.rawData?.tokenUsage).toEqual({ input: 12500, output: 8300 })
    })

    it('should include checkpoint token usage with cache', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const result = await provider.get('entire://checkpoint/a3b2c4d5')
      expect(result?.rawData?.tokenUsage).toEqual({ input: 12500, output: 8300, cache: 4200 })
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

    it('should overwrite existing session with same ID', async () => {
      store.addSession(sampleSession)
      store.addSession({ ...sampleSession, phase: 'ENDED' })

      const result = await store.getSession(sampleSession.id)
      expect(result?.phase).toBe('ENDED')

      const sessions = await store.listSessions()
      expect(sessions).toHaveLength(1)
    })

    it('should search sessions by filesTouched', async () => {
      store.addSession(sampleSession)

      const results = await store.search('middleware')
      expect(results).toHaveLength(1)
    })

    it('should search checkpoints by filesModified', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const results = await store.search('auth.ts')
      expect(results).toHaveLength(1)
    })

    it('should search checkpoints by filesNew', async () => {
      store.addCheckpoint(sampleCheckpoint)

      const results = await store.search('routes/login')
      expect(results).toHaveLength(1)
    })
  })
})

// ============================================================================
// CLI Store Tests (mocked exec)
// ============================================================================

describe('EntireCliStore', () => {
  let cliStore: EntireStore

  beforeEach(() => {
    mockExec = exec as unknown as Mock
    mockExec.mockReset()
    cliStore = createEntireCliStore({
      executable: 'entire',
      timeout: 5000,
      cwd: '/test/project',
    })
  })

  describe('getSession', () => {
    it('should call entire status --json and find session by id', async () => {
      const sessionData = {
        id: 'test-session-1',
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'abc123',
        branch: 'feature/test',
        startedAt: '2026-02-13T12:00:00Z',
        checkpoints: ['cp-1'],
        tokenUsage: { input: 100, output: 50 },
        filesTouched: ['src/test.ts'],
        summary: 'Test session',
      }

      mockExecResponse(JSON.stringify([sessionData]))

      const result = await cliStore.getSession('test-session-1')

      // Verify correct command was called
      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('entire status --json')

      // Verify result
      expect(result).not.toBeNull()
      expect(result?.id).toBe('test-session-1')
      expect(result?.agent).toBe('claude-code')
      expect(result?.phase).toBe('ACTIVE')
      expect(result?.branch).toBe('feature/test')
    })

    it('should return null when session not found', async () => {
      mockExecResponse(JSON.stringify([{ id: 'other-session', agent: 'test', phase: 'ACTIVE' }]))

      const result = await cliStore.getSession('nonexistent')
      expect(result).toBeNull()
    })

    it('should return null on CLI error', async () => {
      const error = new Error('Command failed') as Error & { code?: string }
      error.code = 'ENOENT'
      mockExecError(error)

      const result = await cliStore.getSession('any')
      expect(result).toBeNull()
    })

    it('should handle single object response (not array)', async () => {
      mockExecResponse(JSON.stringify({
        id: 'single-session',
        agent: 'claude-code',
        phase: 'IDLE',
      }))

      const result = await cliStore.getSession('single-session')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('single-session')
      expect(result?.phase).toBe('IDLE')
    })

    it('should normalize alternative field names', async () => {
      mockExecResponse(JSON.stringify({
        sessionId: 'alt-session',
        agentType: 'copilot',
        state: 'active',
      }))

      const result = await cliStore.getSession('alt-session')
      expect(result).not.toBeNull()
      expect(result?.id).toBe('alt-session')
      expect(result?.agent).toBe('copilot')
      expect(result?.phase).toBe('ACTIVE')
    })

    it('should handle malformed JSON gracefully', async () => {
      mockExecResponse('not valid json {{{')

      const result = await cliStore.getSession('any')
      expect(result).toBeNull()
    })

    it('should set NO_COLOR environment variable', async () => {
      mockExecResponse(JSON.stringify([]))

      await cliStore.getSession('any')

      const callOptions = mockExec.mock.calls[0][1]
      expect(callOptions.env.NO_COLOR).toBe('1')
    })

    it('should pass correct cwd and timeout', async () => {
      mockExecResponse(JSON.stringify([]))

      await cliStore.getSession('any')

      const callOptions = mockExec.mock.calls[0][1]
      expect(callOptions.cwd).toBe('/test/project')
      expect(callOptions.timeout).toBe(5000)
    })
  })

  describe('listSessions', () => {
    it('should list all sessions from CLI', async () => {
      mockExecResponse(JSON.stringify([
        { id: 'session-1', agent: 'claude', phase: 'ACTIVE' },
        { id: 'session-2', agent: 'cursor', phase: 'ENDED' },
      ]))

      const sessions = await cliStore.listSessions()
      expect(sessions).toHaveLength(2)
      expect(sessions[0].id).toBe('session-1')
      expect(sessions[1].id).toBe('session-2')
    })

    it('should return empty array on error', async () => {
      mockExecError(new Error('CLI not found') as Error & { code?: string })

      const sessions = await cliStore.listSessions()
      expect(sessions).toEqual([])
    })
  })

  describe('getCheckpoint', () => {
    it('should call entire rewind --list and find checkpoint by id', async () => {
      mockExecResponse(JSON.stringify([
        {
          id: 'cp-001',
          sessionId: 'session-1',
          commitHash: 'abc123',
          commitMessage: 'Add feature',
          promptCount: 3,
          filesModified: ['src/app.ts'],
          filesNew: ['src/new.ts'],
          filesDeleted: ['src/old.ts'],
          context: 'Added new feature',
        },
      ]))

      const result = await cliStore.getCheckpoint('cp-001')

      // Verify correct command
      expect(mockExec).toHaveBeenCalled()
      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('entire rewind --list')

      // Verify result
      expect(result).not.toBeNull()
      expect(result?.id).toBe('cp-001')
      expect(result?.commitHash).toBe('abc123')
      expect(result?.commitMessage).toBe('Add feature')
      expect(result?.filesModified).toEqual(['src/app.ts'])
      expect(result?.filesNew).toEqual(['src/new.ts'])
      expect(result?.filesDeleted).toEqual(['src/old.ts'])
    })

    it('should return null when checkpoint not found', async () => {
      mockExecResponse(JSON.stringify([{ id: 'other-cp' }]))

      const result = await cliStore.getCheckpoint('nonexistent')
      expect(result).toBeNull()
    })

    it('should handle alternative field name checkpointId', async () => {
      mockExecResponse(JSON.stringify({
        checkpointId: 'alt-cp',
        commitHash: 'def456',
      }))

      const result = await cliStore.getCheckpoint('alt-cp')
      expect(result?.id).toBe('alt-cp')
    })
  })

  describe('listCheckpoints', () => {
    it('should list all checkpoints from CLI', async () => {
      mockExecResponse(JSON.stringify([
        { id: 'cp-1', commitHash: 'aaa' },
        { id: 'cp-2', commitHash: 'bbb' },
      ]))

      const checkpoints = await cliStore.listCheckpoints()
      expect(checkpoints).toHaveLength(2)
    })

    it('should return empty array on error', async () => {
      mockExecError(new Error('timeout') as Error & { code?: string })

      const checkpoints = await cliStore.listCheckpoints()
      expect(checkpoints).toEqual([])
    })
  })

  describe('search', () => {
    it('should search across sessions and checkpoints', async () => {
      // search calls listSessions then listCheckpoints — mock responds to both
      let callCount = 0
      mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
        const cb = (typeof callback === 'function' ? callback : options) as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void

        callCount++
        if (callCount === 1) {
          // First call: status --json (sessions)
          cb(null, {
            stdout: JSON.stringify([
              { id: 's-1', agent: 'claude', phase: 'ACTIVE', summary: 'Authentication work' },
            ]),
            stderr: '',
          })
        } else {
          // Second call: rewind --list (checkpoints)
          cb(null, {
            stdout: JSON.stringify([
              { id: 'cp-1', commitMessage: 'Add auth endpoint', context: 'Auth context' },
              { id: 'cp-2', commitMessage: 'Fix CSS layout', context: 'Styling' },
            ]),
            stderr: '',
          })
        }
      })

      const results = await cliStore.search('auth')
      expect(results.length).toBeGreaterThanOrEqual(2) // session + checkpoint match
    })

    it('should handle session list error and still return checkpoint results', async () => {
      let callCount = 0
      mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
        const cb = (typeof callback === 'function' ? callback : options) as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void

        callCount++
        if (callCount === 1) {
          // Sessions fail
          const error = new Error('CLI error') as Error & { code?: string }
          error.code = 'ENOENT'
          cb(error, { stdout: '', stderr: 'error' })
        } else {
          // Checkpoints succeed
          cb(null, {
            stdout: JSON.stringify([
              { id: 'cp-1', commitMessage: 'Fix bug', context: 'Bug fix' },
            ]),
            stderr: '',
          })
        }
      })

      const results = await cliStore.search('bug')
      expect(results).toHaveLength(1)
      expect((results[0] as { id: string }).id).toBe('cp-1')
    })

    it('should match on filesTouched for sessions', async () => {
      let callCount = 0
      mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
        const cb = (typeof callback === 'function' ? callback : options) as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void

        callCount++
        if (callCount === 1) {
          cb(null, {
            stdout: JSON.stringify([
              { id: 's-1', agent: 'claude', phase: 'ACTIVE', filesTouched: ['src/auth.ts'] },
            ]),
            stderr: '',
          })
        } else {
          cb(null, { stdout: '[]', stderr: '' })
        }
      })

      const results = await cliStore.search('auth.ts')
      expect(results).toHaveLength(1)
    })

    it('should match on filesModified and filesNew for checkpoints', async () => {
      let callCount = 0
      mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
        const cb = (typeof callback === 'function' ? callback : options) as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void

        callCount++
        if (callCount === 1) {
          cb(null, { stdout: '[]', stderr: '' })
        } else {
          cb(null, {
            stdout: JSON.stringify([
              { id: 'cp-1', filesModified: ['src/index.ts'], filesNew: ['src/new.ts'] },
              { id: 'cp-2', filesModified: ['src/other.ts'] },
            ]),
            stderr: '',
          })
        }
      })

      const modifiedResults = await cliStore.search('index.ts')
      expect(modifiedResults).toHaveLength(1)
    })
  })

  describe('custom executable', () => {
    it('should use custom executable path', async () => {
      const customStore = createEntireCliStore({ executable: '/opt/bin/entire' })
      mockExecResponse(JSON.stringify([]))

      await customStore.listSessions()

      const callArgs = mockExec.mock.calls[0][0]
      expect(callArgs).toContain('/opt/bin/entire status --json')
    })
  })
})

// ============================================================================
// Provider with CLI Store (end-to-end with mocked exec)
// ============================================================================

describe('EntireProvider with CLI store', () => {
  let provider: Provider

  beforeEach(() => {
    mockExec = exec as unknown as Mock
    mockExec.mockReset()
    // Create provider using CLI store (not in-memory)
    provider = createEntireProvider({
      executable: 'entire',
      timeout: 5000,
      cwd: '/test/project',
    })
  })

  it('should get session through CLI and convert to ProviderNode', async () => {
    mockExecResponse(JSON.stringify([
      {
        id: 'cli-session-1',
        agent: 'claude-code',
        phase: 'ACTIVE',
        baseCommit: 'abc',
        branch: 'main',
        startedAt: '2026-02-13T12:00:00Z',
        summary: 'Working on feature X',
        filesTouched: ['src/x.ts'],
      },
    ]))

    const result = await provider.get('entire://session/cli-session-1')

    expect(result).not.toBeNull()
    expect(result?.id).toBe('cli-session-1')
    expect(result?.type).toBe('external')
    expect(result?.title).toContain('Working on feature X')
    expect(result?.status).toBe('open')
    expect(result?.rawData?.agent).toBe('claude-code')
  })

  it('should get checkpoint through CLI and convert to ProviderNode', async () => {
    mockExecResponse(JSON.stringify([
      {
        id: 'cli-cp-1',
        sessionId: 'cli-session-1',
        commitHash: 'def456',
        commitMessage: 'Add endpoint',
        promptCount: 3,
        context: 'Endpoint for users',
      },
    ]))

    const result = await provider.get('entire://checkpoint/cli-cp-1')

    expect(result).not.toBeNull()
    expect(result?.id).toBe('cli-cp-1')
    expect(result?.type).toBe('external')
    expect(result?.status).toBe('closed')
    expect(result?.rawData?.commitHash).toBe('def456')
  })

  it('should list all entities through CLI', async () => {
    let callCount = 0
    mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
      const cb = (typeof callback === 'function' ? callback : options) as (
        err: Error | null,
        result: { stdout: string; stderr: string }
      ) => void

      callCount++
      if (callCount === 1) {
        cb(null, {
          stdout: JSON.stringify([
            { id: 's-1', agent: 'claude', phase: 'ACTIVE', summary: 'Test' },
          ]),
          stderr: '',
        })
      } else {
        cb(null, {
          stdout: JSON.stringify([
            { id: 'cp-1', commitHash: 'abc', commitMessage: 'Fix' },
          ]),
          stderr: '',
        })
      }
    })

    const results = await provider.list()
    expect(results).toHaveLength(2)
    expect(results[0].rawData?.entityType).toBe('session')
    expect(results[1].rawData?.entityType).toBe('checkpoint')
  })

  it('should search through CLI', async () => {
    let callCount = 0
    mockExec.mockImplementation((cmd: string, options: unknown, callback?: unknown) => {
      const cb = (typeof callback === 'function' ? callback : options) as (
        err: Error | null,
        result: { stdout: string; stderr: string }
      ) => void

      callCount++
      if (callCount === 1) {
        cb(null, {
          stdout: JSON.stringify([
            { id: 's-1', agent: 'claude', phase: 'ACTIVE', summary: 'Auth feature' },
          ]),
          stderr: '',
        })
      } else {
        cb(null, {
          stdout: JSON.stringify([
            { id: 'cp-1', commitMessage: 'Add auth', context: 'Auth work' },
          ]),
          stderr: '',
        })
      }
    })

    const results = await provider.search!('auth')
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('should handle CLI unavailable gracefully for get', async () => {
    const error = new Error('spawn ENOENT') as Error & { code?: string }
    error.code = 'ENOENT'
    mockExecError(error)

    const result = await provider.get('entire://session/any')
    expect(result).toBeNull()
  })

  it('should handle CLI unavailable gracefully for list', async () => {
    const error = new Error('spawn ENOENT') as Error & { code?: string }
    error.code = 'ENOENT'
    mockExecError(error)

    // list catches errors and returns empty
    const results = await provider.list()
    expect(results).toEqual([])
  })
})
