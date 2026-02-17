/**
 * E2E Tests: Skill Tracking
 *
 * Verifies that skill usage is tracked during agent sessions/trajectories.
 * Uses real daemon lifecycle (createDaemonWithStore), real Entire watcher/auto-linker,
 * real config-driven enable/disable, and real CLI subprocess invocation.
 * No mocks or stubs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'

import { AGENT_TESTS, AGENT_SKIP_MESSAGE } from './helpers/index.js'
import { createDaemonWithStore } from '../../src/daemon/factory.js'
import type { Daemon } from '../../src/daemon/lifecycle.js'
import { OpenTasksClient } from '../../src/client/client.js'
import type { SkillUsageSummary } from '../../src/tracking/index.js'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a real git repo with .opentasks/ directory in a temp location.
 * Returns paths for the repo root, .opentasks dir, and .git dir.
 */
async function createTestRepo(testName: string): Promise<{
  rootDir: string
  opentasksDir: string
  gitDir: string
  registryDir: string
}> {
  const rootDir = await mkdtemp(join(tmpdir(), `opentasks-${testName}-`))
  const opentasksDir = join(rootDir, '.opentasks')
  const registryDir = join(rootDir, '.registry')

  await mkdir(opentasksDir, { recursive: true })
  await mkdir(registryDir, { recursive: true })

  // Initialize a real git repo
  execSync('git init', { cwd: rootDir, stdio: 'ignore' })

  const gitDir = join(rootDir, '.git')
  return { rootDir, opentasksDir, gitDir, registryDir }
}

/**
 * Clean up a test repo directory
 */
async function cleanupTestRepo(rootDir: string): Promise<void> {
  if (existsSync(rootDir)) {
    await rm(rootDir, { recursive: true, force: true })
  }
}

/**
 * Create a daemon with real lifecycle, pointing at the test repo.
 */
async function createTestDaemon(
  opentasksDir: string,
  registryDir: string,
  options: {
    skillTracking?: boolean
    maxInvocationsPerSession?: number
  } = {},
): Promise<Daemon> {
  const { skillTracking = true, maxInvocationsPerSession } = options

  return createDaemonWithStore({
    locationPath: opentasksDir,
    version: '0.0.0-test',
    registryPath: registryDir,
    shutdownTimeoutMs: 5000,
    openTasksConfig: {
      tracking: {
        skillTracking,
        ...(maxInvocationsPerSession !== undefined
          ? { maxInvocationsPerSession }
          : {}),
      },
    },
  })
}

/**
 * Create a connected client for a daemon
 */
function createTestClient(daemon: Daemon): OpenTasksClient {
  return new OpenTasksClient({ socketPath: daemon.socketPath })
}

/**
 * Write an Entire session file to .git/entire-sessions/
 */
async function writeEntireSession(
  gitDir: string,
  sessionId: string,
  session: Record<string, unknown>,
): Promise<void> {
  const sessionsDir = join(gitDir, 'entire-sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(session, null, 2),
  )
}

/**
 * Poll until a condition is true, with timeout
 */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

/**
 * Run a CLI command via subprocess and capture output
 */
function runCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, '../../src/cli.ts')
    // Strip VITEST env so the subprocess runs main() normally
    const env = { ...process.env, NODE_NO_WARNINGS: '1' }
    delete env.VITEST
    const child = spawn(
      'npx',
      ['tsx', cliPath, ...args],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    child.on('error', () => {
      resolve({ stdout, stderr, exitCode: 1 })
    })
  })
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!AGENT_TESTS)('E2E Skill Tracking', () => {
  // ====================================================================
  // Full lifecycle with real daemon — no mocks
  // ====================================================================
  describe('Full lifecycle with real daemon', () => {
    let rootDir: string
    let opentasksDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-lifecycle')
      rootDir = repo.rootDir
      opentasksDir = repo.opentasksDir
      registryDir = repo.registryDir

      daemon = await createTestDaemon(opentasksDir, registryDir)
      await daemon.start()

      client = createTestClient(daemon)
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await daemon.stop()
      await cleanupTestRepo(rootDir)
    })

    it('should track link invocations with _sessionId', async () => {
      // Create two nodes via the real daemon's graph.create handler
      const ctx = (await client.createNode({
        type: 'context',
        title: 'Spec A',
      })) as { id: string }

      const task = (await client.createNode({
        type: 'task',
        title: 'Task 1',
        status: 'open',
      })) as { id: string }

      // Make a link call with _sessionId for tracking
      const linkResult = await client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: 'test-session-1',
        _agentId: 'test-agent',
      })
      expect(linkResult).toHaveProperty('success', true)

      // Query skill usage for this session
      const summary = (await client.skillUsage(
        'test-session-1',
      )) as SkillUsageSummary | null

      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe('test-session-1')
      expect(summary!.totalInvocations).toBe(1)
      expect(summary!.skillsUsed).toContain('link')
      expect(summary!.stats).toHaveLength(1)
      expect(summary!.stats[0].skill).toBe('link')
      expect(summary!.stats[0].count).toBe(1)
      expect(summary!.stats[0].successCount).toBe(1)
      expect(summary!.stats[0].failureCount).toBe(0)
    })

    it('should track query invocations', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'test-session-2',
        _agentId: 'query-agent',
      })

      await client.call('tools.query', {
        nodes: {},
        _sessionId: 'test-session-2',
      })

      const summary = (await client.skillUsage(
        'test-session-2',
      )) as SkillUsageSummary | null

      expect(summary).not.toBeNull()
      expect(summary!.totalInvocations).toBe(2)
      expect(summary!.skillsUsed).toEqual(['query'])
      expect(summary!.stats[0].count).toBe(2)
      expect(summary!.stats[0].operations).toContain('ready')
      expect(summary!.stats[0].operations).toContain('nodes')
    })

    it('should track multiple skill types in a single session', async () => {
      // Create nodes via the real daemon
      const task = (await client.createNode({
        type: 'task',
        title: 'Multi-skill Task',
        status: 'open',
      })) as { id: string }

      const ctx = (await client.createNode({
        type: 'context',
        title: 'Linked Spec',
      })) as { id: string }

      const sessionId = 'multi-skill-session'

      // Query
      await client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })

      // Link
      await client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: sessionId,
      })

      // Annotate
      await client.call('tools.annotate', {
        targetId: task.id,
        create: { content: 'Needs review', severity: 'info' },
        _sessionId: sessionId,
      })

      // Another query
      await client.call('tools.query', {
        feedback: { targetId: task.id },
        _sessionId: sessionId,
      })

      const summary = (await client.skillUsage(
        sessionId,
      )) as SkillUsageSummary | null

      expect(summary).not.toBeNull()
      expect(summary!.totalInvocations).toBe(4)
      expect(summary!.skillsUsed).toHaveLength(3)
      expect(summary!.skillsUsed).toContain('query')
      expect(summary!.skillsUsed).toContain('link')
      expect(summary!.skillsUsed).toContain('annotate')

      const queryStats = summary!.stats.find((s) => s.skill === 'query')
      expect(queryStats).toBeDefined()
      expect(queryStats!.count).toBe(2)

      const linkStats = summary!.stats.find((s) => s.skill === 'link')
      expect(linkStats).toBeDefined()
      expect(linkStats!.count).toBe(1)

      const annotateStats = summary!.stats.find((s) => s.skill === 'annotate')
      expect(annotateStats).toBeDefined()
      expect(annotateStats!.count).toBe(1)
    })

    it('should isolate tracking between sessions', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'session-a',
      })

      await client.call('tools.query', {
        nodes: {},
        _sessionId: 'session-b',
      })

      await client.call('tools.query', {
        blockers: { id: 'fake-id' },
        _sessionId: 'session-a',
      })

      const summaryA = (await client.skillUsage(
        'session-a',
      )) as SkillUsageSummary | null
      const summaryB = (await client.skillUsage(
        'session-b',
      )) as SkillUsageSummary | null

      expect(summaryA!.totalInvocations).toBe(2)
      expect(summaryB!.totalInvocations).toBe(1)
    })

    it('should not track invocations without _sessionId', async () => {
      // Make a query without _sessionId
      await client.call('tools.query', { ready: {} })

      // All summaries should be empty
      const allSummaries = (await client.allSkillUsage()) as SkillUsageSummary[]
      expect(allSummaries).toHaveLength(0)
    })

    it('should return all active session summaries', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'active-1',
      })
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'active-2',
      })
      await client.call('tools.query', {
        nodes: {},
        _sessionId: 'active-3',
      })

      const allSummaries = (await client.allSkillUsage()) as SkillUsageSummary[]

      expect(allSummaries).toHaveLength(3)
      const sessionIds = allSummaries.map((s) => s.sessionId).sort()
      expect(sessionIds).toEqual(['active-1', 'active-2', 'active-3'])
    })

    it('should end tracking and return final summary', async () => {
      const sessionId = 'ending-session'

      await client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })
      await client.call('tools.query', {
        nodes: {},
        _sessionId: sessionId,
      })

      // End tracking
      const finalSummary = (await client.endSkillTracking(
        sessionId,
      )) as SkillUsageSummary | null

      expect(finalSummary).not.toBeNull()
      expect(finalSummary!.sessionId).toBe(sessionId)
      expect(finalSummary!.totalInvocations).toBe(2)

      // After ending, the session should no longer be tracked
      const afterEnd = (await client.skillUsage(
        sessionId,
      )) as SkillUsageSummary | null
      expect(afterEnd).toBeNull()
    })

    it('should return null for non-existent session', async () => {
      const summary = (await client.skillUsage(
        'does-not-exist',
      )) as SkillUsageSummary | null
      expect(summary).toBeNull()
    })

    it('should return null when ending non-existent session', async () => {
      const summary = (await client.endSkillTracking(
        'never-started',
      )) as SkillUsageSummary | null
      expect(summary).toBeNull()
    })

    it('should record duration for invocations', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'duration-session',
      })

      const summary = (await client.skillUsage(
        'duration-session',
      )) as SkillUsageSummary | null

      expect(summary).not.toBeNull()
      expect(summary!.invocations).toHaveLength(1)
      expect(summary!.invocations[0].durationMs).toBeDefined()
      expect(typeof summary!.invocations[0].durationMs).toBe('number')
      expect(summary!.invocations[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should record timestamps for invocations', async () => {
      const before = new Date().toISOString()

      await client.call('tools.query', {
        nodes: {},
        _sessionId: 'timestamp-session',
      })

      const after = new Date().toISOString()

      const summary = (await client.skillUsage(
        'timestamp-session',
      )) as SkillUsageSummary | null

      expect(summary!.invocations[0].timestamp).toBeDefined()
      expect(summary!.invocations[0].timestamp >= before).toBe(true)
      expect(summary!.invocations[0].timestamp <= after).toBe(true)
    })

    it('should record operation type for queries', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'op-type-session',
      })

      await client.call('tools.query', {
        blockers: { id: 'fake' },
        _sessionId: 'op-type-session',
      })

      const summary = (await client.skillUsage(
        'op-type-session',
      )) as SkillUsageSummary | null

      expect(summary!.invocations[0].operation).toBe('ready')
      expect(summary!.invocations[1].operation).toBe('blockers')
    })

    it('should record target node IDs for link operations', async () => {
      const ctx = (await client.createNode({
        type: 'context',
        title: 'Target Spec',
      })) as { id: string }

      const task = (await client.createNode({
        type: 'task',
        title: 'Target Task',
        status: 'open',
      })) as { id: string }

      await client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: 'targets-session',
      })

      const summary = (await client.skillUsage(
        'targets-session',
      )) as SkillUsageSummary | null

      expect(summary!.invocations[0].targets).toBeDefined()
      expect(summary!.invocations[0].targets).toContain(ctx.id)
      expect(summary!.invocations[0].targets).toContain(task.id)
    })

    it('should track avgDurationMs in stats', async () => {
      for (let i = 0; i < 5; i++) {
        await client.call('tools.query', {
          ready: {},
          _sessionId: 'avg-duration-session',
        })
      }

      const summary = (await client.skillUsage(
        'avg-duration-session',
      )) as SkillUsageSummary | null

      const queryStats = summary!.stats.find((s) => s.skill === 'query')
      expect(queryStats).toBeDefined()
      expect(queryStats!.avgDurationMs).toBeDefined()
      expect(typeof queryStats!.avgDurationMs).toBe('number')
      expect(queryStats!.avgDurationMs).toBeGreaterThanOrEqual(0)
    })

    it('should use client convenience methods', async () => {
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'client-test',
      })

      const summary = (await client.skillUsage(
        'client-test',
      )) as SkillUsageSummary | null
      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe('client-test')

      // allSkillUsage
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'all-test-1',
      })
      const all = (await client.allSkillUsage()) as SkillUsageSummary[]
      expect(all.length).toBeGreaterThanOrEqual(2) // client-test + all-test-1

      // endSkillTracking
      const final = (await client.endSkillTracking(
        'client-test',
      )) as SkillUsageSummary | null
      expect(final).not.toBeNull()
      expect(final!.totalInvocations).toBe(1)

      // Should be gone now
      const after = (await client.skillUsage(
        'client-test',
      )) as SkillUsageSummary | null
      expect(after).toBeNull()
    })
  })

  // ====================================================================
  // Config-driven enable/disable via real daemon config
  // ====================================================================
  describe('Config-driven enable/disable', () => {
    let rootDir: string
    let opentasksDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-disabled')
      rootDir = repo.rootDir
      opentasksDir = repo.opentasksDir
      registryDir = repo.registryDir

      // Create daemon with skill tracking DISABLED via real config
      daemon = await createTestDaemon(opentasksDir, registryDir, {
        skillTracking: false,
      })
      await daemon.start()

      client = createTestClient(daemon)
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await daemon.stop()
      await cleanupTestRepo(rootDir)
    })

    it('should not track when skillTracking is false in config', async () => {
      // Make a call with _sessionId
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'should-not-track',
      })

      // tracking.skills.all should return empty since tracking is disabled
      const allSummaries = (await client.allSkillUsage()) as SkillUsageSummary[]
      expect(allSummaries).toHaveLength(0)
    })

    it('should still allow tool calls to succeed when tracking is disabled', async () => {
      const ctx = (await client.createNode({
        type: 'context',
        title: 'No-track Spec',
      })) as { id: string }

      const task = (await client.createNode({
        type: 'task',
        title: 'No-track Task',
        status: 'open',
      })) as { id: string }

      // Link should succeed
      const result = await client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
        _sessionId: 'disabled-session',
      })
      expect(result).toHaveProperty('success', true)

      // Query should succeed
      const queryResult = await client.call('tools.query', {
        ready: {},
        _sessionId: 'disabled-session',
      })
      expect(queryResult).toBeDefined()

      // But no tracking data should exist
      const summary = (await client.skillUsage(
        'disabled-session',
      )) as SkillUsageSummary | null
      expect(summary).toBeNull()
    })
  })

  // ====================================================================
  // Entire auto-linker integration — skill embedding on session end
  // ====================================================================
  describe('Entire auto-linker skill embedding', () => {
    let rootDir: string
    let opentasksDir: string
    let gitDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-entire')
      rootDir = repo.rootDir
      opentasksDir = repo.opentasksDir
      gitDir = repo.gitDir
      registryDir = repo.registryDir

      daemon = await createTestDaemon(opentasksDir, registryDir)
      await daemon.start()

      client = createTestClient(daemon)
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await daemon.stop()
      await cleanupTestRepo(rootDir)
    })

    it('should embed skillsUsed in session node when session ends', async () => {
      const sessionId = 'entire-test-session'

      // 1. Record some skill invocations with the session ID
      await client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })
      await client.call('tools.query', {
        nodes: {},
        _sessionId: sessionId,
      })

      // Verify skills are being tracked
      const midSummary = (await client.skillUsage(
        sessionId,
      )) as SkillUsageSummary | null
      expect(midSummary).not.toBeNull()
      expect(midSummary!.totalInvocations).toBe(2)

      // 2. Write a "started" session file to trigger Entire watcher
      await writeEntireSession(gitDir, sessionId, {
        agent: 'test-agent',
        phase: 'ACTIVE',
        branch: 'main',
        startedAt: new Date().toISOString(),
        checkpoints: [],
      })

      // 3. Wait for the Entire watcher to detect the session start
      //    and create the session node
      await waitFor(async () => {
        try {
          const result = (await client.call('tools.query', {
            nodes: { type: 'external', search: `entire://session/${sessionId}` },
          })) as { nodes?: unknown[] }
          return Array.isArray(result?.nodes) && result.nodes.length > 0
        } catch {
          return false
        }
      }, 15000, 500)

      // 4. Now record more skill invocations
      const ctx = (await client.createNode({
        type: 'context',
        title: 'Entire-linked Spec',
      })) as { id: string }

      await client.call('tools.link', {
        fromId: ctx.id,
        toId: ctx.id, // self-link for simplicity
        type: 'related',
        _sessionId: sessionId,
      })

      // 5. Update the session file to "ENDED" to trigger auto-linker's ended handler
      await writeEntireSession(gitDir, sessionId, {
        agent: 'test-agent',
        phase: 'ENDED',
        branch: 'main',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        endedAt: new Date().toISOString(),
        checkpoints: [],
      })

      // 6. Wait for the auto-linker to process the ended event
      //    and embed skillsUsed in the session node's metadata
      await waitFor(async () => {
        try {
          const result = (await client.call('tools.query', {
            nodes: { type: 'external', search: `entire://session/${sessionId}` },
          })) as { nodes?: Array<{ metadata?: Record<string, unknown> }> }
          if (!result?.nodes?.[0]?.metadata) return false
          return result.nodes[0].metadata.phase === 'ENDED'
        } catch {
          return false
        }
      }, 15000, 500)

      // 7. Verify the session node has skillsUsed embedded
      const nodesResult = (await client.call('tools.query', {
        nodes: { type: 'external', search: `entire://session/${sessionId}` },
      })) as { nodes?: Array<{ metadata?: Record<string, unknown> }> }

      expect(nodesResult?.nodes).toHaveLength(1)
      const sessionNode = nodesResult.nodes![0]
      const metadata = sessionNode.metadata!

      // The auto-linker should have embedded skillsUsed
      expect(metadata.skillsUsed).toBeDefined()
      const skillsUsed = metadata.skillsUsed as {
        skills: string[]
        totalInvocations: number
        counts: Record<string, number>
        outcomes: Record<string, { success: number; failure: number }>
      }

      expect(skillsUsed.totalInvocations).toBe(3) // 2 queries + 1 link
      expect(skillsUsed.skills).toContain('query')
      expect(skillsUsed.skills).toContain('link')
      expect(skillsUsed.counts.query).toBe(2)
      expect(skillsUsed.counts.link).toBe(1)
    })
  })

  // ====================================================================
  // CLI subprocess invocation
  // ====================================================================
  describe('CLI subprocess invocation', () => {
    let rootDir: string
    let opentasksDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-cli')
      rootDir = repo.rootDir
      opentasksDir = repo.opentasksDir
      registryDir = repo.registryDir

      daemon = await createTestDaemon(opentasksDir, registryDir)
      await daemon.start()

      client = createTestClient(daemon)
      await client.connect()
    })

    afterEach(async () => {
      client.disconnect()
      await daemon.stop()
      await cleanupTestRepo(rootDir)
    })

    it('should report skill usage via CLI skills command', async () => {
      const sessionId = 'cli-test-session'

      // Record some skills
      await client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })
      await client.call('tools.query', {
        nodes: {},
        _sessionId: sessionId,
      })

      // Run CLI subprocess from the test repo root so it discovers the socket
      const result = await runCli(['skills', sessionId], rootDir)

      // CLI should output JSON to stdout
      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout.trim())
      expect(output.sessionId).toBe(sessionId)
      expect(output.totalInvocations).toBe(2)
      expect(output.skillsUsed).toContain('query')
    })

    it('should report all skill usage via CLI skills --all', async () => {
      // Record skills in multiple sessions
      await client.call('tools.query', {
        ready: {},
        _sessionId: 'cli-all-1',
      })
      await client.call('tools.query', {
        nodes: {},
        _sessionId: 'cli-all-2',
      })

      const result = await runCli(['skills', '--all'], rootDir)
      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout.trim())
      expect(Array.isArray(output)).toBe(true)
      expect(output.length).toBeGreaterThanOrEqual(2)

      const sessionIds = output.map((s: { sessionId: string }) => s.sessionId)
      expect(sessionIds).toContain('cli-all-1')
      expect(sessionIds).toContain('cli-all-2')
    })

    it('should end tracking via CLI skills --end', async () => {
      const sessionId = 'cli-end-session'

      await client.call('tools.query', {
        ready: {},
        _sessionId: sessionId,
      })

      // End via CLI
      const result = await runCli(['skills', '--end', sessionId], rootDir)
      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout.trim())
      expect(output.sessionId).toBe(sessionId)
      expect(output.totalInvocations).toBe(1)

      // Verify session is gone
      const afterEnd = (await client.skillUsage(
        sessionId,
      )) as SkillUsageSummary | null
      expect(afterEnd).toBeNull()
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('E2E Skill Tracking (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
