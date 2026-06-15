/**
 * E2E: Multi-Location Git Sync (coordinated)
 *
 * Boots a REAL multi-location daemon (createMultiLocationDaemonFromGit) against
 * a real git repo and exercises the location-aware sync methods added to close
 * the C2 gap (per-location sync was previously uncoordinated and had no IPC
 * surface). Verifies:
 *   - the per-location startup pull reloads SQLite (pulled node is queryable)
 *   - sync.status / sync.pull resolve per `location` param
 *   - sync.pull is coordinated: a later local flush does not clobber the pulled
 *     node (full-file overwrite from a stale SQLite snapshot would lose it)
 *
 * The single worktree registry is empty, so the daemon manages just the primary
 * location (hash 'primary') — enough to exercise the multi-location code path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createMultiLocationDaemonFromGit } from '../factory.js';
import type { Daemon } from '../lifecycle.js';
import { createIPCClient, type IPCClient } from '../ipc.js';
import type { Node } from '../../schema/index.js';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('E2E: Multi-Location Git Sync', { timeout: 30_000 }, () => {
  let tempDir: string;
  let repoDir: string;
  let bareRemote: string;
  let opentasksPath: string;
  let gitCommonDir: string;
  let registryPath: string;
  let daemon: Daemon | null;
  let client: IPCClient | null;

  const PEER_ID = 't-mlpeer1';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-mlsync-'));
    repoDir = path.join(tempDir, 'repo');
    bareRemote = path.join(tempDir, 'remote.git');
    opentasksPath = path.join(repoDir, '.opentasks');
    gitCommonDir = path.join(repoDir, '.git');
    registryPath = path.join(tempDir, 'registry', 'registry.json');

    await fs.mkdir(tempDir, { recursive: true });
    git(tempDir, `init --bare "${bareRemote}"`);
    await fs.mkdir(repoDir, { recursive: true });
    git(repoDir, 'init --initial-branch=main');
    git(repoDir, 'config user.email "test@example.com"');
    git(repoDir, 'config user.name "Test"');
    git(repoDir, `remote add origin "${bareRemote}"`);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# test');
    git(repoDir, 'add README.md');
    git(repoDir, 'commit -m "init"');
    git(repoDir, 'push -u origin main');

    // Primary location config lives on disk — the multi-location daemon reads
    // sync.git from .opentasks/config.json (unlike single-location, which takes
    // it via the openTasksConfig param).
    await fs.mkdir(opentasksPath, { recursive: true });
    await fs.writeFile(
      path.join(opentasksPath, 'config.json'),
      JSON.stringify({
        sync: {
          git: {
            enabled: true,
            remote: 'origin',
            autoCommit: false,
            autoPush: false,
            pullOnStartup: true,
          },
        },
      }),
    );

    daemon = null;
    client = null;
  });

  afterEach(async () => {
    if (client?.connected) {
      client.disconnect();
      client = null;
    }
    if (daemon) {
      try { await daemon.stop(); } catch { /* ignore */ }
      daemon = null;
    }
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function startDaemon(): Promise<void> {
    daemon = createMultiLocationDaemonFromGit({
      gitCommonDir,
      version: '1.0.0-test',
      registryPath,
      shutdownTimeoutMs: 5000,
    });
    await daemon.start();
  }

  async function connectClient(): Promise<IPCClient> {
    client = createIPCClient(daemon!.socketPath);
    await client.connect();
    return client;
  }

  // Push a peer node to the remote BEFORE the daemon starts so the per-location
  // startup pull has something to fetch.
  async function pushPeerNode(): Promise<void> {
    const peerDir = path.join(tempDir, 'peer');
    git(tempDir, `clone "${bareRemote}" "${peerDir}"`);
    git(peerDir, 'config user.email "peer@example.com"');
    git(peerDir, 'config user.name "Peer"');
    const peerOpentasks = path.join(peerDir, '.opentasks');
    await fs.mkdir(peerOpentasks, { recursive: true });
    const line = JSON.stringify({
      id: PEER_ID,
      uuid: PEER_ID,
      type: 'task',
      title: 'From the peer',
      status: 'open',
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await fs.writeFile(path.join(peerOpentasks, 'graph.jsonl'), line + '\n');
    git(peerDir, 'add .opentasks/graph.jsonl');
    git(peerDir, 'commit -m "peer: add a task"');
    git(peerDir, 'push origin main');
  }

  it('reports git sync enabled for the primary location', async () => {
    await startDaemon();
    const c = await connectClient();

    const status = await c.request<{ enabled: boolean; remote?: string; pullOnStartup: boolean }>(
      'sync.status',
      { location: 'primary' },
    );
    expect(status.enabled).toBe(true);
    expect(status.remote).toBe('origin');
    expect(status.pullOnStartup).toBe(true);
  });

  it('startup pull reloads SQLite — pulled node is queryable', async () => {
    await pushPeerNode();
    await startDaemon();
    const c = await connectClient();

    const node = await c.request<Node | null>('graph.get', { id: PEER_ID });
    expect(node).not.toBeNull();
    expect(node!.id).toBe(PEER_ID);
    expect(node!.title).toBe('From the peer');
  });

  it('sync.pull is coordinated — a later local flush does not clobber the pulled node', async () => {
    await startDaemon();
    const c = await connectClient();

    // Peer pushes AFTER startup; daemon catches up via an explicit sync.pull.
    await pushPeerNode();
    const pull = await c.request<{ ran: boolean; result?: { pulled: boolean; hasChanges: boolean } }>(
      'sync.pull',
      { location: 'primary' },
    );
    expect(pull.ran).toBe(true);
    expect(pull.result?.pulled).toBe(true);
    expect(pull.result?.hasChanges).toBe(true);

    // Pulled node is queryable (coordinated reload), then a local write + flush
    // must not drop it from graph.jsonl.
    const pulled = await c.request<Node | null>('graph.get', { id: PEER_ID });
    expect(pulled).not.toBeNull();

    await c.request<Node>('graph.create', { type: 'task', title: 'Local task', status: 'open' });
    await c.request('flush');
    await new Promise((r) => setTimeout(r, 200));

    const ourGraph = await fs.readFile(path.join(opentasksPath, 'graph.jsonl'), 'utf-8');
    expect(ourGraph).toContain(PEER_ID);
    expect(ourGraph).toContain('Local task');
  });

  it('sync.now runs the full coordinated cycle for the primary location', async () => {
    await startDaemon();
    const c = await connectClient();

    // Proves sync.now is wired + resolves per location and runs (ran:true).
    const res = await c.request<{ ran: boolean }>('sync.now', { location: 'primary' });
    expect(res.ran).toBe(true);
  });
});
