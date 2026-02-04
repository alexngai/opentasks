/**
 * Process Utilities for Integration Tests
 *
 * Helpers for spawning processes and managing their lifecycle.
 */

import { spawn, type ChildProcess, exec as execCallback } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execCallback)

/**
 * Options for spawning a daemon process
 */
export interface SpawnDaemonOptions {
  /** Path to the daemon script */
  script: string
  /** Arguments to pass to the daemon */
  args?: string[]
  /** Environment variables */
  env?: Record<string, string>
  /** Working directory */
  cwd?: string
}

/**
 * Spawn a daemon process
 */
export function spawnDaemon(options: SpawnDaemonOptions): ChildProcess {
  const { script, args = [], env = {}, cwd } = options

  return spawn('node', [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
}

/**
 * Wait for a process to exit and return its exit code
 */
export function waitForExit(proc: ChildProcess, timeout = 10000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`Process did not exit within ${timeout}ms`))
    }, timeout)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Kill a process gracefully, falling back to SIGKILL
 */
export async function killProcess(proc: ChildProcess, gracefulTimeout = 5000): Promise<void> {
  if (proc.killed || proc.exitCode !== null) {
    return
  }

  proc.kill('SIGTERM')

  try {
    await waitForExit(proc, gracefulTimeout)
  } catch {
    // Force kill if graceful shutdown failed
    proc.kill('SIGKILL')
    await waitForExit(proc, 1000).catch(() => {
      // Process may already be dead
    })
  }
}

/**
 * Collect stdout from a process
 */
export function collectStdout(proc: ChildProcess): { output: string[] } {
  const result = { output: [] as string[] }

  proc.stdout?.on('data', (data: Buffer) => {
    result.output.push(data.toString())
  })

  return result
}

/**
 * Collect stderr from a process
 */
export function collectStderr(proc: ChildProcess): { output: string[] } {
  const result = { output: [] as string[] }

  proc.stderr?.on('data', (data: Buffer) => {
    result.output.push(data.toString())
  })

  return result
}

/**
 * Check if a command is available on the system
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    await exec(`which ${command}`)
    return true
  } catch {
    return false
  }
}

/**
 * Run a command and return stdout
 */
export async function runCommand(
  command: string,
  options?: { cwd?: string; timeout?: number }
): Promise<string> {
  const { stdout } = await exec(command, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 30000,
  })
  return stdout.trim()
}
