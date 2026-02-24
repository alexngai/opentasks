/**
 * Tests for client socket discovery and global auto-init
 *
 * Verifies the 3-tier fallback (git → project → global) and
 * that ~/.opentasks/ is auto-initialized when no other socket is found.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock ensureGlobalStoreInitialized before importing client
const mockEnsureGlobalStoreInitialized = vi.fn();

vi.mock('../../core/init.js', () => ({
  ensureGlobalStoreInitialized: (...args: unknown[]) => mockEnsureGlobalStoreInitialized(...args),
}));

// Mock worktree module to control git detection
vi.mock('../../core/worktree.js', () => ({
  getGitCommonDir: vi.fn(() => null),
}));

import { OpenTasksClient, ClientError } from '../client.js';

describe('socket discovery with auto-init', () => {
  let tmpDir: string;
  let originalCwd: typeof process.cwd;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opentasks-discovery-test-'));
    originalCwd = process.cwd;

    // Default: cwd is in a subdirectory with no .opentasks/ in its walk-up path
    // Use a nested dir so findOpenTasksDir() doesn't find anything
    const nestedDir = path.join(tmpDir, 'some', 'deep', 'path');
    await fsp.mkdir(nestedDir, { recursive: true });
    process.cwd = () => nestedDir;

    // Default: ensureGlobalStoreInitialized returns a path (but no daemon.sock there)
    const globalDir = path.join(tmpDir, 'fakehome', '.opentasks');
    await fsp.mkdir(globalDir, { recursive: true });
    mockEnsureGlobalStoreInitialized.mockReturnValue(globalDir);
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('calls ensureGlobalStoreInitialized when no git or project socket found', async () => {
    const client = new OpenTasksClient({ autoConnect: false });

    // connect() resolves socket via getDefaultSocketPath()
    // No git socket, no project .opentasks/, so falls through to global
    // ensureGlobalStoreInitialized is called but no daemon.sock exists → SOCKET_NOT_FOUND
    await expect(client.connect()).rejects.toMatchObject({
      code: 'SOCKET_NOT_FOUND',
    });

    expect(mockEnsureGlobalStoreInitialized).toHaveBeenCalledTimes(1);
  });

  it('throws SOCKET_NOT_FOUND when global dir is initialized but daemon is not running', async () => {
    const globalDir = path.join(tmpDir, 'fakehome', '.opentasks');
    // Directory exists (from beforeEach) but no daemon.sock
    mockEnsureGlobalStoreInitialized.mockReturnValue(globalDir);

    const client = new OpenTasksClient({ autoConnect: false });

    await expect(client.connect()).rejects.toMatchObject({
      code: 'SOCKET_NOT_FOUND',
    });
  });

  it('attempts connection when global daemon.sock exists', async () => {
    const globalDir = path.join(tmpDir, 'fakehome', '.opentasks');
    // Create a fake daemon.sock file so discovery succeeds
    await fsp.writeFile(path.join(globalDir, 'daemon.sock'), '');
    mockEnsureGlobalStoreInitialized.mockReturnValue(globalDir);

    const client = new OpenTasksClient({ autoConnect: false });

    // Gets past SOCKET_NOT_FOUND (socket file exists) but actual IPC connection fails
    await expect(client.connect()).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });

    expect(mockEnsureGlobalStoreInitialized).toHaveBeenCalledTimes(1);
  });

  it('prefers project .opentasks/ socket over global', async () => {
    // Create project-level .opentasks/ with a fake daemon.sock in the cwd walk-up path
    const projectDir = path.join(tmpDir, 'some', '.opentasks');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'daemon.sock'), '');

    const client = new OpenTasksClient({ autoConnect: false });

    // Should find project socket first and skip global fallback
    await expect(client.connect()).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });

    expect(mockEnsureGlobalStoreInitialized).not.toHaveBeenCalled();
  });

  it('does not call ensureGlobalStoreInitialized when socketPath is explicitly provided', async () => {
    const client = new OpenTasksClient({
      socketPath: '/nonexistent/daemon.sock',
      autoConnect: false,
    });

    await expect(client.connect()).rejects.toThrow(ClientError);

    // Socket path was explicit — no discovery, no auto-init
    expect(mockEnsureGlobalStoreInitialized).not.toHaveBeenCalled();
  });
});
