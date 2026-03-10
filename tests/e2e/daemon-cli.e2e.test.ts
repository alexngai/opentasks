/**
 * E2E: Daemon CLI Commands
 *
 * Tests that `opentasks daemon start` works as a real subprocess
 * (the same way claude-code-swarm's ensureDaemon spawns it), and that
 * clients can connect and operate against the running daemon.
 *
 * Gated by RUN_FULL_AGENT_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as net from 'node:net'

// ============================================================================
// Test Gate
// ============================================================================

const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'
const AGENT_SKIP_MESSAGE = 'Skipping: RUN_FULL_AGENT_TESTS not set'

// ============================================================================
// Helpers
// ============================================================================

const CLI_PATH = path.resolve(__dirname, '../../src/cli.ts')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSocket(socketPath: string, timeout = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fs.existsSync(socketPath)) return
    await sleep(100)
  }
  throw new Error(`Socket ${socketPath} did not appear within ${timeout}ms`)
}

async function waitForSocketRemoved(socketPath: string, timeout = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!fs.existsSync(socketPath)) return
    await sleep(100)
  }
  throw new Error(`Socket ${socketPath} was not removed within ${timeout}ms`)
}

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('VITEST') || key.startsWith('VITE_') || key === 'VITE') continue
    env[key] = value
  }
  return { ...env, ...extra }
}

interface DaemonProcess {
  proc: ChildProcess
  stdout: string[]
  stderr: string[]
  socketPath: string
  opentasksDir: string
  rootDir: string
}

function spawnDaemonProcess(opentasksDir: string, rootDir: string): DaemonProcess {
  const socketPath = path.join(opentasksDir, 'daemon.sock')

  const proc = spawn('npx', ['tsx', CLI_PATH, 'daemon', 'start'], {
    cwd: rootDir,
    env: cleanEnv({ OPENTASKS_PROJECT_DIR: opentasksDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  const stdout: string[] = []
  const stderr: string[] = []

  proc.stdout?.on('data', (data: Buffer) => stdout.push(data.toString()))
  proc.stderr?.on('data', (data: Buffer) => stderr.push(data.toString()))

  return { proc, stdout, stderr, socketPath, opentasksDir, rootDir }
}

async function killDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.proc.killed || daemon.proc.exitCode !== null) return

  daemon.proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      daemon.proc.kill('SIGKILL')
      resolve()
    }, 5000)
    daemon.proc.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  // Wait for socket cleanup
  await sleep(200)
}

/**
 * Send a JSON-RPC 2.0 request directly over the Unix socket.
 */
async function ipcCall(socketPath: string, method: string, params: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let buffer = ''

    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`IPC call ${method} timed out`))
    }, 10000)

    client.on('connect', () => {
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
    })

    client.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line)
          if (response.id === 1) {
            clearTimeout(timer)
            client.destroy()
            if (response.error) {
              reject(new Error(`${response.error.message} (code: ${response.error.code})`))
            } else {
              resolve(response.result)
            }
            return
          }
        } catch { /* incomplete json */ }
      }
    })

    client.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function runCli(
  args: string[],
  opentasksDir: string,
  timeout = 20000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; json?: unknown }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', CLI_PATH, ...args], {
      env: cleanEnv({ OPENTASKS_PROJECT_DIR: opentasksDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      let json: unknown
      try { json = JSON.parse(stdout.trim()) } catch { /* not json */ }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: null, json })
    }, timeout)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      let json: unknown
      try { json = JSON.parse(stdout.trim()) } catch { /* not json */ }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, json })
    })
  })
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(!AGENT_TESTS)('E2E: Daemon CLI', { timeout: 90000 }, () => {
  let rootDir: string
  let daemon: DaemonProcess

  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-daemon-e2e-'))
    const opentasksDir = path.join(rootDir, '.opentasks')
    fs.mkdirSync(opentasksDir, { recursive: true })
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '', 'utf-8')

    daemon = spawnDaemonProcess(opentasksDir, rootDir)
    await waitForSocket(daemon.socketPath)
    // Give the daemon a moment to fully initialize
    await sleep(500)
  })

  afterAll(async () => {
    await killDaemon(daemon)
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  // --------------------------------------------------------------------------
  // Daemon Lifecycle
  // --------------------------------------------------------------------------

  it('daemon should be running with a socket', () => {
    expect(fs.existsSync(daemon.socketPath)).toBe(true)
  })

  it('daemon should output JSON with started status', () => {
    const output = daemon.stdout.join('')
    expect(output).toContain('"status":"started"')
    expect(output).toContain('"pid"')
    expect(output).toContain('daemon.sock')
  })

  it('daemon should respond to status IPC call', async () => {
    const status = await ipcCall(daemon.socketPath, 'status') as Record<string, unknown>
    expect(status.state).toBe('running')
    expect(status.pid).toBeTypeOf('number')
    expect(status.socketPath).toContain('daemon.sock')
  })

  it('daemon start should report already_running when started twice', async () => {
    const result = await runCli(['daemon', 'start'], daemon.opentasksDir)
    expect(result.json).toMatchObject({ status: 'already_running' })
    expect((result.json as Record<string, unknown>).pid).toBeTypeOf('number')
  })

  it('daemon status should show not_running for uninitialised dir', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-no-daemon-'))
    const emptyOt = path.join(tempDir, '.opentasks')
    fs.mkdirSync(emptyOt, { recursive: true })
    try {
      const result = await runCli(['daemon', 'status'], emptyOt)
      expect(result.json).toMatchObject({ status: 'not_running' })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // --------------------------------------------------------------------------
  // Tool Commands (via IPC)
  // --------------------------------------------------------------------------

  it('should create a task', async () => {
    const result = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'E2E Task', status: 'open',
    }) as Record<string, unknown>

    expect(result.id).toMatch(/^t-/)
    expect(result.title).toBe('E2E Task')
    expect(result.type).toBe('task')
    expect(result.status).toBe('open')
  })

  it('should create a context', async () => {
    const result = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'context', title: 'Auth Spec', content: 'OAuth2 with PKCE',
    }) as Record<string, unknown>

    expect(result.id).toMatch(/^c-/)
    expect(result.title).toBe('Auth Spec')
  })

  it('should get a node by ID', async () => {
    const created = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'Get Test', status: 'open',
    }) as Record<string, unknown>

    const retrieved = await ipcCall(daemon.socketPath, 'graph.get', {
      id: created.id,
    }) as Record<string, unknown>

    expect(retrieved.id).toBe(created.id)
    expect(retrieved.title).toBe('Get Test')
  })

  it('should update a task status', async () => {
    const created = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'Update Test', status: 'open',
    }) as Record<string, unknown>

    const updated = await ipcCall(daemon.socketPath, 'graph.update', {
      id: created.id, status: 'in_progress',
    }) as Record<string, unknown>

    expect(updated.status).toBe('in_progress')
  })

  it('should link two nodes', async () => {
    const ctx = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'context', title: 'Link Spec',
    }) as Record<string, unknown>

    const task = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'Link Task', status: 'open',
    }) as Record<string, unknown>

    const result = await ipcCall(daemon.socketPath, 'tools.link', {
      fromId: task.id, toId: ctx.id, type: 'implements',
    }) as Record<string, unknown>
    expect(result.success).toBe(true)
  })

  it('should query for ready tasks', async () => {
    const task = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'Ready Query Task', status: 'open',
    }) as Record<string, unknown>

    const result = await ipcCall(daemon.socketPath, 'tools.query', {
      ready: {},
    }) as { items: Record<string, unknown>[]; hasMore: boolean }

    expect(Array.isArray(result.items)).toBe(true)
    expect(result.items.some(n => n.id === task.id)).toBe(true)
  })

  it('should query for blockers', async () => {
    const blocker = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'E2E Blocker', status: 'open',
    }) as Record<string, unknown>

    const blocked = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'E2E Blocked', status: 'open',
    }) as Record<string, unknown>

    await ipcCall(daemon.socketPath, 'tools.link', {
      fromId: blocker.id, toId: blocked.id, type: 'blocks',
    })

    const result = await ipcCall(daemon.socketPath, 'tools.query', {
      blockers: { nodeId: blocked.id },
    }) as { items: Record<string, unknown>[] }

    expect(result.items.some(n => n.id === blocker.id)).toBe(true)
  })

  it('should delete a node', async () => {
    const created = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'task', title: 'Delete Me', status: 'open',
    }) as Record<string, unknown>

    await ipcCall(daemon.socketPath, 'graph.delete', {
      id: created.id, options: { hard: true },
    })

    // After hard delete, graph.get returns null
    const result = await ipcCall(daemon.socketPath, 'graph.get', { id: created.id })
    expect(result).toBeNull()
  })

  it('should support annotate (feedback)', async () => {
    const ctx = await ipcCall(daemon.socketPath, 'graph.create', {
      type: 'context', title: 'Review Target',
    }) as Record<string, unknown>

    const annotateResult = await ipcCall(daemon.socketPath, 'tools.annotate', {
      targetId: ctx.id,
      create: { content: 'Consider rate limiting', type: 'suggestion' },
    }) as Record<string, unknown>
    expect(annotateResult.success).toBe(true)

    const result = await ipcCall(daemon.socketPath, 'tools.query', {
      feedback: { nodeId: ctx.id },
    }) as { items: Record<string, unknown>[] }

    expect(result.items.length).toBeGreaterThanOrEqual(1)
  })

  // --------------------------------------------------------------------------
  // Multi-agent workflow
  // --------------------------------------------------------------------------

  it('should support a full multi-agent workflow with blocking', async () => {
    const call = (method: string, params: unknown) =>
      ipcCall(daemon.socketPath, method, params) as Promise<Record<string, unknown>>

    // Planner creates spec and tasks
    const spec = await call('graph.create', {
      type: 'context', title: 'Multi-Agent Spec', content: 'OAuth2 feature',
    })
    const task1 = await call('graph.create', {
      type: 'task', title: 'Setup config', status: 'open',
    })
    const task2 = await call('graph.create', {
      type: 'task', title: 'Implement flow', status: 'open',
    })

    await call('tools.link', { fromId: task1.id, toId: spec.id, type: 'implements' })
    await call('tools.link', { fromId: task2.id, toId: spec.id, type: 'implements' })
    await call('tools.link', { fromId: task1.id, toId: task2.id, type: 'blocks' })

    // Only task1 should be ready
    const ready1 = await call('tools.query', { ready: {} }) as unknown as { items: Record<string, unknown>[] }
    const readyIds1 = ready1.items.map(n => n.id)
    expect(readyIds1).toContain(task1.id)
    expect(readyIds1).not.toContain(task2.id)

    // Complete task1
    await call('graph.update', { id: task1.id, status: 'closed' })

    // Now task2 is ready
    const ready2 = await call('tools.query', { ready: {} }) as unknown as { items: Record<string, unknown>[] }
    expect(ready2.items.map(n => n.id)).toContain(task2.id)

    // Complete task2
    await call('graph.update', { id: task2.id, status: 'closed' })

    // task1 and task2 no longer in ready
    const ready3 = await call('tools.query', { ready: {} }) as unknown as { items: Record<string, unknown>[] }
    expect(ready3.items.map(n => n.id)).not.toContain(task1.id)
    expect(ready3.items.map(n => n.id)).not.toContain(task2.id)
  })

  // --------------------------------------------------------------------------
  // CLI roundtrip (verify CLI tool commands work with the daemon)
  // --------------------------------------------------------------------------

  it('should create via CLI subprocess', { timeout: 30000 }, async () => {
    // The CLI may hang after outputting results due to unclosed handles.
    // We use a shorter kill timeout and verify the output was produced.
    const createResult = await runCli(
      ['create', '--type', 'task', '--title', 'CLI Roundtrip', '--status', 'open'],
      daemon.opentasksDir,
      15000,
    )
    // Verify the CLI produced valid JSON output regardless of exit code
    // (the process may hang after output due to socket handle not being unref'd)
    expect(createResult.json).toBeDefined()
    const created = createResult.json as Record<string, unknown>
    expect(created.id).toMatch(/^t-/)
    expect(created.title).toBe('CLI Roundtrip')
  })
})

// --------------------------------------------------------------------------
// Separate describe for daemon stop/SIGTERM (needs its own daemon lifecycle)
// --------------------------------------------------------------------------

describe.skipIf(!AGENT_TESTS)('E2E: Daemon CLI - Stop/Cleanup', { timeout: 60000 }, () => {
  it('should clean up socket on SIGTERM', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-e2e-sigterm-'))
    const opentasksDir = path.join(rootDir, '.opentasks')
    fs.mkdirSync(opentasksDir, { recursive: true })
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '', 'utf-8')

    const daemon = spawnDaemonProcess(opentasksDir, rootDir)

    try {
      await waitForSocket(daemon.socketPath)
      expect(fs.existsSync(daemon.socketPath)).toBe(true)

      daemon.proc.kill('SIGTERM')

      await waitForSocketRemoved(daemon.socketPath)
      expect(fs.existsSync(daemon.socketPath)).toBe(false)
    } finally {
      if (!daemon.proc.killed && daemon.proc.exitCode === null) {
        daemon.proc.kill('SIGKILL')
      }
      await sleep(200)
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true })
      }
    }
  })

  it('should stop via IPC shutdown', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-e2e-stop-'))
    const opentasksDir = path.join(rootDir, '.opentasks')
    fs.mkdirSync(opentasksDir, { recursive: true })
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '', 'utf-8')

    const daemon = spawnDaemonProcess(opentasksDir, rootDir)

    try {
      await waitForSocket(daemon.socketPath)

      try {
        await ipcCall(daemon.socketPath, 'shutdown')
      } catch { /* connection may reset */ }

      await waitForSocketRemoved(daemon.socketPath)
      expect(fs.existsSync(daemon.socketPath)).toBe(false)
    } finally {
      if (!daemon.proc.killed && daemon.proc.exitCode === null) {
        daemon.proc.kill('SIGKILL')
      }
      await sleep(200)
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true })
      }
    }
  })

  it('should support .swarm/opentasks layout', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-e2e-swarm-'))
    const swarmDir = path.join(rootDir, '.swarm', 'opentasks')
    fs.mkdirSync(swarmDir, { recursive: true })
    fs.writeFileSync(path.join(swarmDir, 'graph.jsonl'), '', 'utf-8')

    const daemon = spawnDaemonProcess(swarmDir, rootDir)

    try {
      await waitForSocket(daemon.socketPath)
      expect(fs.existsSync(daemon.socketPath)).toBe(true)

      const task = await ipcCall(daemon.socketPath, 'graph.create', {
        type: 'task', title: 'Swarm Task', status: 'open',
      }) as Record<string, unknown>

      expect(task.title).toBe('Swarm Task')
    } finally {
      await killDaemon(daemon)
      if (fs.existsSync(rootDir)) {
        fs.rmSync(rootDir, { recursive: true, force: true })
      }
    }
  })
})

if (!AGENT_TESTS) {
  describe('E2E: Daemon CLI (skipped)', () => {
    it.skip(AGENT_SKIP_MESSAGE, () => {})
  })
}
