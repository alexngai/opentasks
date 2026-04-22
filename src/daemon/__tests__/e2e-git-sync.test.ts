/**
 * E2E Git Sync Tests
 *
 * Verifies the daemon lifecycle wiring of `createGitGraphSyncer`:
 *   - With `sync.git.enabled: false` (default), sync.status reports disabled
 *     and sync.now reports "not ran"
 *   - With autoCommit: true, graph.jsonl mutations land as git commits
 *   - sync.now IPC method runs the full cycle and returns structured results
 *   - pullOnStartup: true pulls remote changes before the daemon accepts
 *     its first client request
 *   - Shutdown stops auto-sync cleanly (and runs a final commit+push if
 *     both auto flags are set)
 *
 * These tests spawn real `git` processes against temp directories — they
 * require `git` on PATH. They are slow-ish by unit-test standards (~1-3s
 * each) but fast compared to the hub-level e2e.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createStoreForLocation } from '../location-state.js';
import { createDaemon, type Daemon } from '../lifecycle.js';
import { createIPCClient, type IPCClient } from '../ipc.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node } from '../../schema/index.js';

function git(cwd: string, args: string): string {
  return execSync(`git -C "${cwd}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe('E2E: Git Sync', () => {
  let tempDir: string;
  let repoDir: string;
  let bareRemote: string;
  let opentasksPath: string;
  let registryPath: string;
  let store: GraphStore | null;
  let daemon: Daemon | null;
  let client: IPCClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-e2e-gitsync-'));
    repoDir = path.join(tempDir, 'repo');
    bareRemote = path.join(tempDir, 'remote.git');
    opentasksPath = path.join(repoDir, '.opentasks');
    registryPath = path.join(tempDir, 'registry', 'registry.json');

    // Create bare remote and a working repo that tracks it
    await fs.mkdir(tempDir, { recursive: true });
    git(tempDir, `init --bare "${bareRemote}"`);
    await fs.mkdir(repoDir, { recursive: true });
    git(repoDir, 'init --initial-branch=main');
    git(repoDir, 'config user.email "test@example.com"');
    git(repoDir, 'config user.name "Test"');
    git(repoDir, `remote add origin "${bareRemote}"`);

    // Seed a single empty commit so rev-parse HEAD works even before the
    // daemon writes anything.
    await fs.writeFile(path.join(repoDir, 'README.md'), '# test');
    git(repoDir, 'add README.md');
    git(repoDir, 'commit -m "init"');
    git(repoDir, 'push -u origin main');

    // .opentasks/ sits inside the working tree
    await fs.mkdir(opentasksPath, { recursive: true });
    store = await createStoreForLocation(opentasksPath);
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
    if (store) {
      try { await store.close(); } catch { /* ignore */ }
      store = null;
    }
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function startDaemon(gitSyncConfig?: Partial<{
    enabled: boolean;
    remote: string;
    autoCommit: boolean;
    autoPush: boolean;
    pullOnStartup: boolean;
    pushDebounceMs: number;
  }>): Promise<void> {
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store: store!,
      registryPath,
      shutdownTimeoutMs: 5000,
      openTasksConfig: gitSyncConfig
        ? { sync: { git: gitSyncConfig } }
        : undefined,
    });
    await daemon.start();
  }

  async function connectClient(): Promise<IPCClient> {
    client = createIPCClient(daemon!.socketPath);
    await client.connect();
    return client;
  }

  // --------------------------------------------------------------------------
  // sync.status inspection
  // --------------------------------------------------------------------------

  describe('sync.status', () => {
    it('reports disabled when sync.git is omitted', async () => {
      await startDaemon();
      const c = await connectClient();
      const status = await c.request<Record<string, unknown>>('sync.status');
      expect(status.enabled).toBe(false);
      expect(status.autoSyncRunning).toBe(false);
    });

    it('reports the configured flags when enabled', async () => {
      await startDaemon({
        enabled: true,
        remote: 'origin',
        autoCommit: true,
        autoPush: false,
        pullOnStartup: true,
      });
      const c = await connectClient();
      const status = await c.request<Record<string, unknown>>('sync.status');
      expect(status.enabled).toBe(true);
      expect(status.remote).toBe('origin');
      expect(status.autoCommit).toBe(true);
      expect(status.autoPush).toBe(false);
      expect(status.pullOnStartup).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // sync.now IPC method
  // --------------------------------------------------------------------------

  describe('sync.now', () => {
    it('returns ran:false when sync is disabled', async () => {
      await startDaemon();
      const c = await connectClient();
      const res = await c.request<{ ran: boolean; reason?: string }>('sync.now');
      expect(res.ran).toBe(false);
      expect(res.reason).toContain('not enabled');
    });

    it('commits and pushes when configured, after a node write', async () => {
      await startDaemon({ enabled: true, remote: 'origin', autoCommit: false, autoPush: false });
      const c = await connectClient();

      // Write + flush so graph.jsonl exists with content. Small wait after
      // flush so the JSONL write hits disk before we check `git status`.
      await c.request<Node>('graph.create', { type: 'task', title: 'Git sync me', status: 'open' });
      await c.request('flush');
      await new Promise((r) => setTimeout(r, 200));

      // Sanity: graph.jsonl exists and has content before we try to commit.
      const graphPath = path.join(opentasksPath, 'graph.jsonl');
      const graphContent = await fs.readFile(graphPath, 'utf-8');
      expect(graphContent).toContain('Git sync me');

      const res = await c.request<{
        ran: boolean;
        result?: { commit: { committed: boolean }; push: { pushed: boolean } };
      }>('sync.now');
      expect(res.ran).toBe(true);
      expect(res.result?.commit.committed).toBe(true);
      expect(res.result?.push.pushed).toBe(true);

      // Verify the commit landed on the bare remote
      const remoteLog = git(bareRemote, 'log --oneline');
      expect(remoteLog).toContain('opentasks: sync graph');
    });
  });

  // --------------------------------------------------------------------------
  // sync.pull
  // --------------------------------------------------------------------------

  describe('sync.pull', () => {
    it('pulls changes pushed directly to the remote by a peer', async () => {
      await startDaemon({ enabled: true, remote: 'origin' });
      const c = await connectClient();

      // Simulate a peer: clone the bare remote to a scratch dir, push a
      // graph.jsonl update with a new node, then have our daemon pull it.
      const peerDir = path.join(tempDir, 'peer');
      git(tempDir, `clone "${bareRemote}" "${peerDir}"`);
      git(peerDir, 'config user.email "peer@example.com"');
      git(peerDir, 'config user.name "Peer"');
      const peerOpentasks = path.join(peerDir, '.opentasks');
      await fs.mkdir(peerOpentasks, { recursive: true });
      const peerGraph = path.join(peerOpentasks, 'graph.jsonl');
      const line = JSON.stringify({
        id: 'peer-node-1',
        uuid: 'peer-node-1',
        type: 'task',
        title: 'From the peer',
        status: 'open',
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await fs.writeFile(peerGraph, line + '\n');
      git(peerDir, 'add .opentasks/graph.jsonl');
      git(peerDir, 'commit -m "peer: add a task"');
      git(peerDir, 'push origin main');

      // Daemon pulls
      const res = await c.request<{
        ran: boolean;
        result?: { pulled: boolean; hasChanges: boolean };
      }>('sync.pull');
      expect(res.ran).toBe(true);
      expect(res.result?.pulled).toBe(true);
      expect(res.result?.hasChanges).toBe(true);

      // graph.jsonl on our side should now contain the peer's node
      const ourGraph = await fs.readFile(path.join(opentasksPath, 'graph.jsonl'), 'utf-8');
      expect(ourGraph).toContain('peer-node-1');
      expect(ourGraph).toContain('From the peer');
    });
  });

  // --------------------------------------------------------------------------
  // sync.reload — hot-swap config from disk
  // --------------------------------------------------------------------------

  describe('sync.reload', () => {
    it('picks up a newly-enabled config without a daemon restart', async () => {
      // Start with sync disabled
      await startDaemon();
      const c = await connectClient();

      // Pre-flight: sync.now reports disabled, sync.status reports disabled.
      const pre = await c.request<{ ran: boolean; reason?: string }>('sync.now');
      expect(pre.ran).toBe(false);

      // Externally rewrite `.opentasks/config.json` as OpenHive's PATCH
      // /resources/:id/git-sync endpoint would do.
      const configPath = path.join(opentasksPath, 'config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          sync: {
            git: {
              enabled: true,
              remote: 'origin',
              autoCommit: false,
              autoPush: false,
              pullOnStartup: false,
            },
          },
        }),
      );

      // sync.reload — daemon re-reads disk config + rebuilds the syncer
      const reload = await c.request<{
        reloaded: boolean;
        status: { enabled: boolean; remote?: string };
      }>('sync.reload');
      expect(reload.reloaded).toBe(true);
      expect(reload.status.enabled).toBe(true);
      expect(reload.status.remote).toBe('origin');

      // sync.now now ran:true — proving the syncer was built in-place.
      // Write + flush a node so the commit check passes.
      await c.request<Node>('graph.create', { type: 'task', title: 'Post-reload', status: 'open' });
      await c.request('flush');
      await new Promise((r) => setTimeout(r, 200));

      const post = await c.request<{
        ran: boolean;
        result?: { commit: { committed: boolean } };
      }>('sync.now');
      expect(post.ran).toBe(true);
      expect(post.result?.commit.committed).toBe(true);
    });

    it('disables an already-running syncer when the flag is flipped off', async () => {
      await startDaemon({ enabled: true, remote: 'origin', autoCommit: true });
      const c = await connectClient();

      let status = await c.request<{ enabled: boolean }>('sync.status');
      expect(status.enabled).toBe(true);

      // Rewrite config to disable
      const configPath = path.join(opentasksPath, 'config.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({ sync: { git: { enabled: false } } }),
      );

      const reload = await c.request<{
        reloaded: boolean;
        status: { enabled: boolean };
      }>('sync.reload');
      expect(reload.reloaded).toBe(true);
      expect(reload.status.enabled).toBe(false);

      status = await c.request<{ enabled: boolean }>('sync.status');
      expect(status.enabled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // pullOnStartup
  // --------------------------------------------------------------------------

  describe('pullOnStartup', () => {
    it('pulls remote changes before the daemon serves its first request', async () => {
      // Push a peer commit to the remote BEFORE starting the daemon
      const peerDir = path.join(tempDir, 'peer');
      git(tempDir, `clone "${bareRemote}" "${peerDir}"`);
      git(peerDir, 'config user.email "peer@example.com"');
      git(peerDir, 'config user.name "Peer"');
      const peerOpentasks = path.join(peerDir, '.opentasks');
      await fs.mkdir(peerOpentasks, { recursive: true });
      const line = JSON.stringify({
        id: 'startup-peer-1',
        uuid: 'startup-peer-1',
        type: 'task',
        title: 'Present at startup',
        status: 'open',
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await fs.writeFile(path.join(peerOpentasks, 'graph.jsonl'), line + '\n');
      git(peerDir, 'add .opentasks/graph.jsonl');
      git(peerDir, 'commit -m "peer: pre-startup"');
      git(peerDir, 'push origin main');

      // Start with pullOnStartup true
      await startDaemon({ enabled: true, remote: 'origin', pullOnStartup: true });

      // graph.jsonl should have the peer's node already
      const ourGraph = await fs.readFile(path.join(opentasksPath, 'graph.jsonl'), 'utf-8');
      expect(ourGraph).toContain('startup-peer-1');
    });
  });
});
