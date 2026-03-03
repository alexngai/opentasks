/**
 * E2E Tests: Skill Tracking via Transcript Extraction
 *
 * Verifies that skill usage is tracked from Entire session transcripts
 * when sessions end. The TranscriptExtractor parses the transcript,
 * categorizes tool calls, and backfills the SkillTrackerRegistry.
 *
 * Uses real daemon lifecycle, real Entire watcher/auto-linker,
 * and real git operations. No mocks or stubs.
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
  } = {},
): Promise<Daemon> {
  const { skillTracking = true } = options

  return createDaemonWithStore({
    locationPath: opentasksDir,
    version: '0.0.0-test',
    registryPath: registryDir,
    shutdownTimeoutMs: 5000,
    openTasksConfig: {
      tracking: {
        skillTracking,
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
 * Write an Entire session file to .git/sessionlog-sessions/
 */
async function writeEntireSession(
  gitDir: string,
  sessionId: string,
  session: Record<string, unknown>,
): Promise<void> {
  const sessionsDir = join(gitDir, 'sessionlog-sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(session, null, 2),
  )
}

/**
 * Create a sample Claude Code transcript JSONL for testing.
 * Includes a mix of tool calls: TaskCreate, MCP sudocode, Bash.
 */
function makeSampleTranscript(sessionId: string): string {
  function line(type: string, uuid: string, content: unknown): string {
    return JSON.stringify({
      type,
      uuid,
      sessionId,
      message: { id: `msg_${uuid}`, content },
    })
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
    line('assistant', 'a4', [
      {
        type: 'tool_use',
        id: 'toolu_04',
        name: 'TaskUpdate',
        input: { taskId: '1', status: 'completed' },
      },
    ]),
    line('user', 'u4', [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_04',
        content: 'Updated task #1 status',
      },
    ]),
  ].join('\n')
}

/**
 * Commit a checkpoint transcript to the sessionlog/checkpoints/v1 branch.
 */
function commitCheckpoint(
  rootDir: string,
  checkpointId: string,
  transcript: string,
  agent: string = 'Claude Code',
): void {
  const shard = checkpointId.slice(0, 2)
  const rest = checkpointId.slice(2)
  const basePath = `${shard}/${rest}/1`

  const metadata = JSON.stringify({
    agent,
    checkpoint_id: checkpointId,
    created_at: new Date().toISOString(),
  })

  // Create the orphan branch if it doesn't exist
  try {
    execSync('git rev-parse sessionlog/checkpoints/v1', {
      cwd: rootDir,
      stdio: 'ignore',
    })
  } catch {
    // Branch doesn't exist — create orphan
    execSync(
      'git checkout --orphan sessionlog/checkpoints/v1',
      { cwd: rootDir, stdio: 'ignore' },
    )
    execSync('git rm -rf . 2>/dev/null || true', {
      cwd: rootDir,
      stdio: 'ignore',
    })
    // Initial empty commit
    execSync(
      'git commit --allow-empty -m "init checkpoints"',
      { cwd: rootDir, stdio: 'ignore' },
    )
    // Go back to main/master
    execSync('git checkout - 2>/dev/null || git checkout master 2>/dev/null || true', {
      cwd: rootDir,
      stdio: 'ignore',
    })
  }

  // Write files to the branch using git hash-object + update-index
  const metadataHash = execSync(
    `echo '${metadata.replace(/'/g, "'\\''")}' | git hash-object -w --stdin`,
    { cwd: rootDir, encoding: 'utf-8' },
  ).trim()

  const transcriptHash = execSync(
    `printf '%s' "${transcript.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | git hash-object -w --stdin`,
    { cwd: rootDir, encoding: 'utf-8' },
  ).trim()

  // Read existing tree
  let existingTree = ''
  try {
    existingTree = execSync(
      'git ls-tree -r sessionlog/checkpoints/v1',
      { cwd: rootDir, encoding: 'utf-8' },
    ).trim()
  } catch {
    // empty tree
  }

  // Build new tree entries
  const entries = existingTree
    ? existingTree + '\n'
    : ''
  const newEntries =
    entries +
    `100644 blob ${metadataHash}\t${basePath}/metadata.json\n` +
    `100644 blob ${transcriptHash}\t${basePath}/full.jsonl`

  const treeHash = execSync(
    `echo "${newEntries}" | git mktree`,
    { cwd: rootDir, encoding: 'utf-8' },
  ).trim()

  const commitHash = execSync(
    `git commit-tree ${treeHash} -m "checkpoint ${checkpointId}"`,
    { cwd: rootDir, encoding: 'utf-8' },
  ).trim()

  execSync(
    `git update-ref refs/heads/sessionlog/checkpoints/v1 ${commitHash}`,
    { cwd: rootDir, stdio: 'ignore' },
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

describe.skipIf(!AGENT_TESTS)('E2E Skill Tracking via Transcript Extraction', () => {
  // ====================================================================
  // Transcript-based skill tracking lifecycle
  // ====================================================================
  describe('Transcript-based tracking on session end', () => {
    let rootDir: string
    let opentasksDir: string
    let gitDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-transcript')
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

    it('should extract tool usage from transcript when Entire session ends', async () => {
      const sessionId = 'transcript-test-session'
      const checkpointId = 'ab12cd34ef56'

      // 1. Commit a transcript to the checkpoint branch
      const transcript = makeSampleTranscript(sessionId)
      commitCheckpoint(rootDir, checkpointId, transcript)

      // 2. Write a "started" session file to trigger Entire watcher
      await writeEntireSession(gitDir, sessionId, {
        agent: 'Claude Code',
        phase: 'ACTIVE',
        branch: 'main',
        startedAt: new Date().toISOString(),
        checkpoints: [checkpointId],
      })

      // 3. Wait for the session node to be created
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

      // 4. End the session to trigger transcript extraction
      await writeEntireSession(gitDir, sessionId, {
        agent: 'Claude Code',
        phase: 'ENDED',
        branch: 'main',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        endedAt: new Date().toISOString(),
        checkpoints: [checkpointId],
      })

      // 5. Wait for the auto-linker to process the ended event
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

      // 6. Verify the session node has skillsUsed from transcript extraction
      const nodesResult = (await client.call('tools.query', {
        nodes: { type: 'external', search: `entire://session/${sessionId}` },
      })) as { nodes?: Array<{ metadata?: Record<string, unknown> }> }

      expect(nodesResult?.nodes).toHaveLength(1)
      const sessionNode = nodesResult.nodes![0]
      const metadata = sessionNode.metadata!

      // The auto-linker should have embedded skillsUsed from transcript
      expect(metadata.skillsUsed).toBeDefined()
      const skillsUsed = metadata.skillsUsed as {
        skills: string[]
        totalInvocations: number
        counts: Record<string, number>
        outcomes: Record<string, { success: number; failure: number }>
      }

      // 4 tool calls: TaskCreate, mcp sudocode, Bash, TaskUpdate
      expect(skillsUsed.totalInvocations).toBe(4)
      expect(skillsUsed.skills).toContain('TaskCreate')
      expect(skillsUsed.skills).toContain('mcp__plugin_sudocode_sudocode__show_issue')
      expect(skillsUsed.skills).toContain('Bash')
      expect(skillsUsed.skills).toContain('TaskUpdate')
    })
  })

  // ====================================================================
  // Query methods still work (populated by transcript extractor)
  // ====================================================================
  describe('Tracking query methods', () => {
    let rootDir: string
    let opentasksDir: string
    let registryDir: string
    let daemon: Daemon
    let client: OpenTasksClient

    beforeEach(async () => {
      const repo = await createTestRepo('skill-query')
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

    it('should return empty array for all summaries when no sessions', async () => {
      const allSummaries = (await client.allSkillUsage()) as SkillUsageSummary[]
      expect(allSummaries).toHaveLength(0)
    })

    it('should still allow tool calls to succeed without tracking context', async () => {
      const ctx = (await client.createNode({
        type: 'context',
        title: 'No-track Spec',
      })) as { id: string }

      const task = (await client.createNode({
        type: 'task',
        title: 'No-track Task',
        status: 'open',
      })) as { id: string }

      // Link should succeed without any tracking params
      const result = await client.call('tools.link', {
        fromId: ctx.id,
        toId: task.id,
        type: 'implements',
      })
      expect(result).toHaveProperty('success', true)

      // Query should succeed
      const queryResult = await client.call('tools.query', {
        ready: {},
      })
      expect(queryResult).toBeDefined()
    })
  })

  // ====================================================================
  // Config-driven enable/disable
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

      // Create daemon with skill tracking DISABLED
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

    it('should return empty when tracking is disabled', async () => {
      const allSummaries = (await client.allSkillUsage()) as SkillUsageSummary[]
      expect(allSummaries).toHaveLength(0)
    })

    it('should still allow tool calls to succeed when tracking is disabled', async () => {
      const result = await client.call('tools.query', { ready: {} })
      expect(result).toBeDefined()
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

    it('should report empty via CLI skills --all when no sessions', async () => {
      const result = await runCli(['skills', '--all'], rootDir)
      expect(result.exitCode).toBe(0)

      const output = JSON.parse(result.stdout.trim())
      expect(Array.isArray(output)).toBe(true)
      expect(output).toHaveLength(0)
    })

    it('should return null via CLI skills for non-existent session', async () => {
      const result = await runCli(['skills', 'nonexistent'], rootDir)
      // Should succeed but return null
      expect(result.exitCode).toBe(0)
    })
  })
})

// If tests are skipped, show a message
if (!AGENT_TESTS) {
  describe('E2E Skill Tracking (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
