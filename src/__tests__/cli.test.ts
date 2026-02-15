/**
 * Tests for CLI Entry Point
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

// ============================================================================
// Test Setup
// ============================================================================

const CLI_PATH = path.resolve(__dirname, '../cli.ts');

/**
 * Run the CLI with given arguments and capture output
 */
async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Strip VITEST env var so the subprocess runs main() normally
    const env = { ...process.env };
    delete env.VITEST;
    const proc = spawn('npx', ['tsx', CLI_PATH, ...args], {
      cwd: path.resolve(__dirname, '../..'),
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('CLI', () => {
  describe('help command', () => {
    it('should show help when no command provided', async () => {
      const { stdout, exitCode } = await runCli([]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('opentasks');
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('Tool commands');
    });

    it('should show help when help command provided', async () => {
      const { stdout, exitCode } = await runCli(['help']);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('opentasks');
      expect(stdout).toContain('Usage:');
    });
  });

  describe('unknown commands', () => {
    it('should error on unknown command', async () => {
      const { stderr, exitCode } = await runCli(['unknown-command']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command');
      expect(stderr).toContain('unknown-command');
    });

    it('should show help after unknown command error', async () => {
      const { stdout, stderr, exitCode } = await runCli(['invalid']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command');
      // Help is printed to stdout even on error
      expect(stdout).toContain('Usage:');
    });
  });

  describe('version info', () => {
    it('should include version in help output', async () => {
      const { stdout } = await runCli(['help']);

      expect(stdout).toMatch(/opentasks v\d+\.\d+\.\d+/);
    });
  });
});
