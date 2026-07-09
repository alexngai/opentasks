/**
 * Tests for Git Graph Syncer
 *
 * Uses real git repos in temp directories following the codebase pattern
 * from materialization/__tests__/git-remote-store.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGitGraphSyncer } from '../git-graph-syncer.js';

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string;

/**
 * Run a git command in the given directory, suppressing output.
 */
function git(cwd: string, args: string): string {
  return execSync(`git -C "${cwd}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Create a working repo with an initial commit containing .opentasks/graph.jsonl.
 */
function createWorkingRepo(name: string): { repoPath: string; opentasksPath: string } {
  const repoPath = path.join(tmpDir, name);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init');
  git(repoPath, 'config user.email "test@test.com"');
  git(repoPath, 'config user.name "Test"');

  const opentasksPath = path.join(repoPath, '.opentasks');
  fs.mkdirSync(opentasksPath, { recursive: true });

  const graphFile = path.join(opentasksPath, 'graph.jsonl');
  fs.writeFileSync(
    graphFile,
    JSON.stringify({ id: 'node-1', title: 'Initial', updated_at: '2026-01-01T00:00:00Z' }) + '\n',
    'utf-8',
  );

  git(repoPath, 'add -A');
  git(repoPath, 'commit -m "initial commit"');

  return { repoPath, opentasksPath };
}

/**
 * Create a bare remote repo.
 */
function createBareRemote(name: string): string {
  const remotePath = path.join(tmpDir, name);
  fs.mkdirSync(remotePath, { recursive: true });
  execSync(`git init --bare "${remotePath}"`, { stdio: 'pipe' });
  return remotePath;
}

/**
 * Create a working repo that is set up with a bare remote.
 * Returns both the working repo paths and the remote path.
 */
function createRepoWithRemote(
  repoName: string,
  remoteName: string,
  remoteAlias = 'origin',
): {
  repoPath: string;
  opentasksPath: string;
  remotePath: string;
} {
  const remotePath = createBareRemote(remoteName);
  const { repoPath, opentasksPath } = createWorkingRepo(repoName);
  git(repoPath, `remote add ${remoteAlias} "${remotePath}"`);
  // Push the initial commit so the remote has a branch
  const branch = git(repoPath, 'rev-parse --abbrev-ref HEAD');
  git(repoPath, `push -u ${remoteAlias} ${branch}`);
  return { repoPath, opentasksPath, remotePath };
}

/**
 * Clone the bare remote into a second working repo (to simulate another contributor).
 */
function cloneFrom(remotePath: string, name: string): {
  repoPath: string;
  opentasksPath: string;
} {
  const repoPath = path.join(tmpDir, name);
  execSync(`git clone "${remotePath}" "${repoPath}"`, { stdio: 'pipe' });
  git(repoPath, 'config user.email "other@test.com"');
  git(repoPath, 'config user.name "Other"');
  const opentasksPath = path.join(repoPath, '.opentasks');
  return { repoPath, opentasksPath };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  // Use realpathSync to resolve symlinks (e.g. /tmp -> /private/tmp on macOS).
  // git rev-parse --show-toplevel returns the real path, so the opentasksPath
  // passed to the syncer must also use real paths for path.relative() to work.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-syncer-test-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================================
// Tests
// ============================================================================

// Spawns real `git` subprocesses; under full-suite parallel load these
// routinely exceed vitest's default 5s per-test timeout. See HARDENING-PLAN P0.
describe('Git Graph Syncer', { timeout: 30_000 }, () => {
  // --------------------------------------------------------------------------
  // commitIfDirty
  // --------------------------------------------------------------------------
  describe('commitIfDirty', () => {
    it('should return committed: false when graph.jsonl has no changes', async () => {
      const { opentasksPath } = createWorkingRepo('repo');
      const syncer = createGitGraphSyncer({ opentasksPath });

      const result = await syncer.commitIfDirty();

      expect(result.committed).toBe(false);
      expect(result.hash).toBeUndefined();
    });

    it('should return committed: true with hash after modifying graph.jsonl', async () => {
      const { opentasksPath } = createWorkingRepo('repo');
      const syncer = createGitGraphSyncer({ opentasksPath });

      // Modify graph.jsonl
      const graphFile = path.join(opentasksPath, 'graph.jsonl');
      fs.appendFileSync(
        graphFile,
        JSON.stringify({ id: 'node-2', title: 'New', updated_at: '2026-01-02T00:00:00Z' }) + '\n',
      );

      const result = await syncer.commitIfDirty();

      expect(result.committed).toBe(true);
      expect(result.hash).toBeDefined();
      expect(result.hash).toMatch(/^[0-9a-f]+$/);
    });

    it('should return committed: false when .opentasks is not in a git repo', async () => {
      // Create a directory that is not a git repo
      const noGitDir = path.join(tmpDir, 'no-git', '.opentasks');
      fs.mkdirSync(noGitDir, { recursive: true });
      fs.writeFileSync(path.join(noGitDir, 'graph.jsonl'), '{"id":"x"}\n', 'utf-8');

      const syncer = createGitGraphSyncer({ opentasksPath: noGitDir });

      const result = await syncer.commitIfDirty();

      expect(result.committed).toBe(false);
    });

    it('should only commit graph.jsonl changes, not other files', async () => {
      const { repoPath, opentasksPath } = createWorkingRepo('repo');
      const syncer = createGitGraphSyncer({ opentasksPath });

      // Add an unrelated file
      fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'hello', 'utf-8');

      // Modify graph.jsonl
      const graphFile = path.join(opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graphFile, '{"id":"node-3"}\n');

      const result = await syncer.commitIfDirty();
      expect(result.committed).toBe(true);

      // The unrelated file should still be untracked
      const status = git(repoPath, 'status --porcelain');
      expect(status).toContain('unrelated.txt');
    });
  });

  // --------------------------------------------------------------------------
  // push
  // --------------------------------------------------------------------------
  describe('push', () => {
    it('should push to remote successfully', async () => {
      const { repoPath, opentasksPath, remotePath } = createRepoWithRemote('repo', 'remote.git');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      // Make a change and commit
      const graphFile = path.join(opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graphFile, '{"id":"node-push"}\n');
      await syncer.commitIfDirty();

      const result = await syncer.push();

      expect(result.pushed).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify the remote received the commit
      const localHead = git(repoPath, 'rev-parse HEAD');
      const branch = git(repoPath, 'rev-parse --abbrev-ref HEAD');
      const remoteHead = git(remotePath, `rev-parse ${branch}`);
      expect(localHead).toBe(remoteHead);
    });

    it('should return error when no remote is configured', async () => {
      const { opentasksPath } = createWorkingRepo('repo');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: null });

      const result = await syncer.push();

      expect(result.pushed).toBe(false);
      expect(result.error).toBe('No remote configured');
    });

    it('should return error when not a git repo', async () => {
      const noGitDir = path.join(tmpDir, 'no-git-push', '.opentasks');
      fs.mkdirSync(noGitDir, { recursive: true });
      fs.writeFileSync(path.join(noGitDir, 'graph.jsonl'), '{"id":"x"}\n', 'utf-8');

      const syncer = createGitGraphSyncer({ opentasksPath: noGitDir, remote: 'origin' });

      const result = await syncer.push();

      expect(result.pushed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fall back to fetch+rebase+retry when push fails due to remote changes', async () => {
      const { repoPath, opentasksPath, remotePath } = createRepoWithRemote(
        'repo1',
        'remote-rebase.git',
      );

      // Clone a second repo and push a non-conflicting change to advance the remote
      const repo2 = cloneFrom(remotePath, 'repo2');
      fs.writeFileSync(path.join(repo2.repoPath, 'other.txt'), 'remote content\n', 'utf-8');
      git(repo2.repoPath, 'add -A');
      git(repo2.repoPath, 'commit -m "remote change on different file"');
      const branch = git(repo2.repoPath, 'rev-parse --abbrev-ref HEAD');
      git(repo2.repoPath, `push origin ${branch}`);

      // Now make a local change in repo1 to graph.jsonl (repo1 is behind the remote)
      const graph1 = path.join(opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graph1, '{"id":"node-local"}\n');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });
      await syncer.commitIfDirty();

      // Push should fail initially (behind remote), then succeed via fetch+rebase+retry
      const result = await syncer.push();

      expect(result.pushed).toBe(true);

      // Verify local repo has both the remote change and the local change
      expect(fs.existsSync(path.join(repoPath, 'other.txt'))).toBe(true);
      const graphContent = fs.readFileSync(graph1, 'utf-8');
      expect(graphContent).toContain('node-local');
    });
  });

  // --------------------------------------------------------------------------
  // pull
  // --------------------------------------------------------------------------
  describe('pull', () => {
    it('should pull new changes from remote successfully', async () => {
      const { opentasksPath, remotePath } = createRepoWithRemote(
        'repo-pull',
        'remote-pull.git',
      );

      // Clone and push a change from a second repo
      const repo2 = cloneFrom(remotePath, 'repo-pull-2');
      const graph2 = path.join(repo2.opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graph2, '{"id":"node-pulled"}\n');
      git(repo2.repoPath, 'add -A');
      git(repo2.repoPath, 'commit -m "new change from remote"');
      const branch = git(repo2.repoPath, 'rev-parse --abbrev-ref HEAD');
      git(repo2.repoPath, `push origin ${branch}`);

      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      const result = await syncer.pull();

      expect(result.pulled).toBe(true);
      expect(result.hasChanges).toBe(true);

      // Verify the file was updated
      const content = fs.readFileSync(path.join(opentasksPath, 'graph.jsonl'), 'utf-8');
      expect(content).toContain('node-pulled');
    });

    it('should return hasChanges: false when already up to date', async () => {
      const { opentasksPath } = createRepoWithRemote('repo-uptodate', 'remote-uptodate.git');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      const result = await syncer.pull();

      expect(result.pulled).toBe(true);
      expect(result.hasChanges).toBe(false);
    });

    it('should return error when no remote is configured', async () => {
      const { opentasksPath } = createWorkingRepo('repo-no-remote-pull');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: null });

      const result = await syncer.pull();

      expect(result.pulled).toBe(false);
      expect(result.hasChanges).toBe(false);
      expect(result.error).toBe('No remote configured');
    });

    it('should return error when not a git repo', async () => {
      const noGitDir = path.join(tmpDir, 'no-git-pull', '.opentasks');
      fs.mkdirSync(noGitDir, { recursive: true });
      fs.writeFileSync(path.join(noGitDir, 'graph.jsonl'), '{"id":"x"}\n', 'utf-8');

      const syncer = createGitGraphSyncer({ opentasksPath: noGitDir, remote: 'origin' });

      const result = await syncer.pull();

      expect(result.pulled).toBe(false);
      expect(result.hasChanges).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // sync
  // --------------------------------------------------------------------------
  describe('sync', () => {
    it('should commit, pull, and push in a full cycle', async () => {
      const { opentasksPath } = createRepoWithRemote('repo-sync', 'remote-sync.git');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      // Make a local change
      const graphFile = path.join(opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graphFile, '{"id":"node-sync"}\n');

      const result = await syncer.sync();

      expect(result.commit.committed).toBe(true);
      expect(result.pull.pulled).toBe(true);
      expect(result.push.pushed).toBe(true);
    });

    it('should handle sync with no local changes', async () => {
      const { opentasksPath } = createRepoWithRemote('repo-sync-clean', 'remote-sync-clean.git');
      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      const result = await syncer.sync();

      expect(result.commit.committed).toBe(false);
      expect(result.pull.pulled).toBe(true);
      expect(result.push.pushed).toBe(true);
    });

    it('should handle sync when remote has new changes', async () => {
      const { opentasksPath, remotePath } = createRepoWithRemote(
        'repo-sync-remote',
        'remote-sync-remote.git',
      );

      // Push a change from a second repo
      const repo2 = cloneFrom(remotePath, 'repo-sync-remote-2');
      const graph2 = path.join(repo2.opentasksPath, 'graph.jsonl');
      fs.appendFileSync(graph2, '{"id":"node-remote-sync"}\n');
      git(repo2.repoPath, 'add -A');
      git(repo2.repoPath, 'commit -m "remote sync change"');
      const branch = git(repo2.repoPath, 'rev-parse --abbrev-ref HEAD');
      git(repo2.repoPath, `push origin ${branch}`);

      const syncer = createGitGraphSyncer({ opentasksPath, remote: 'origin' });

      const result = await syncer.sync();

      expect(result.commit.committed).toBe(false);
      expect(result.pull.pulled).toBe(true);
      expect(result.pull.hasChanges).toBe(true);
      expect(result.push.pushed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // installMergeDriver
  // --------------------------------------------------------------------------
  describe('installMergeDriver', () => {
    it('should create .gitattributes entry for graph.jsonl', () => {
      const { opentasksPath } = createWorkingRepo('repo-merge');
      const syncer = createGitGraphSyncer({ opentasksPath });

      syncer.installMergeDriver();

      const attrPath = path.join(opentasksPath, '.gitattributes');
      expect(fs.existsSync(attrPath)).toBe(true);

      const content = fs.readFileSync(attrPath, 'utf-8');
      expect(content).toContain('merge=opentasks');
      expect(content).toContain('graph.jsonl');
    });

    it('should not create .gitattributes if graph.jsonl does not exist', () => {
      const repoPath = path.join(tmpDir, 'repo-no-graph');
      fs.mkdirSync(repoPath, { recursive: true });
      git(repoPath, 'init');
      git(repoPath, 'config user.email "test@test.com"');
      git(repoPath, 'config user.name "Test"');

      const opentasksPath = path.join(repoPath, '.opentasks');
      fs.mkdirSync(opentasksPath, { recursive: true });
      // Do NOT create graph.jsonl

      // Need at least one commit for the repo root to be detected
      fs.writeFileSync(path.join(repoPath, 'README'), 'x', 'utf-8');
      git(repoPath, 'add -A');
      git(repoPath, 'commit -m "init"');

      const syncer = createGitGraphSyncer({ opentasksPath });
      syncer.installMergeDriver();

      const attrPath = path.join(repoPath, '.gitattributes');
      expect(fs.existsSync(attrPath)).toBe(false);
    });

    it('should be idempotent - not duplicate the entry', () => {
      const { opentasksPath } = createWorkingRepo('repo-merge-idem');
      const syncer = createGitGraphSyncer({ opentasksPath });

      syncer.installMergeDriver();
      syncer.installMergeDriver();

      const attrPath = path.join(opentasksPath, '.gitattributes');
      const content = fs.readFileSync(attrPath, 'utf-8');
      const matches = content.match(/merge=opentasks/g);
      expect(matches).toHaveLength(1);
    });

    it('should do nothing when not in a git repo', () => {
      const noGitDir = path.join(tmpDir, 'no-git-merge', '.opentasks');
      fs.mkdirSync(noGitDir, { recursive: true });
      fs.writeFileSync(path.join(noGitDir, 'graph.jsonl'), '{"id":"x"}\n', 'utf-8');

      const syncer = createGitGraphSyncer({ opentasksPath: noGitDir });

      // Should not throw
      syncer.installMergeDriver();
    });
  });

  // --------------------------------------------------------------------------
  // startAutoSync / stopAutoSync / isAutoSyncRunning
  // --------------------------------------------------------------------------
  describe('autoSync', () => {
    it('isAutoSyncRunning should return false initially', () => {
      const { opentasksPath } = createWorkingRepo('repo-auto');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: true,
      });

      expect(syncer.isAutoSyncRunning()).toBe(false);
    });

    it('startAutoSync should start the timer when autoCommit is true', () => {
      vi.useFakeTimers();

      const { opentasksPath } = createWorkingRepo('repo-auto-start');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: true,
        pushDebounceMs: 30000,
      });

      syncer.startAutoSync();

      expect(syncer.isAutoSyncRunning()).toBe(true);

      syncer.stopAutoSync();
    });

    it('startAutoSync should not start when neither autoCommit nor autoPush is true', () => {
      vi.useFakeTimers();

      const { opentasksPath } = createWorkingRepo('repo-auto-no-flags');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: false,
        autoPush: false,
      });

      syncer.startAutoSync();

      expect(syncer.isAutoSyncRunning()).toBe(false);
    });

    it('stopAutoSync should stop a running timer', () => {
      vi.useFakeTimers();

      const { opentasksPath } = createWorkingRepo('repo-auto-stop');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: true,
        pushDebounceMs: 30000,
      });

      syncer.startAutoSync();
      expect(syncer.isAutoSyncRunning()).toBe(true);

      syncer.stopAutoSync();
      expect(syncer.isAutoSyncRunning()).toBe(false);
    });

    it('stopAutoSync should be safe to call when not running', () => {
      const { opentasksPath } = createWorkingRepo('repo-auto-stop-safe');
      const syncer = createGitGraphSyncer({ opentasksPath });

      // Should not throw
      syncer.stopAutoSync();
      expect(syncer.isAutoSyncRunning()).toBe(false);
    });

    it('startAutoSync should be idempotent - calling twice does not create duplicate timers', () => {
      vi.useFakeTimers();

      const { opentasksPath } = createWorkingRepo('repo-auto-idem');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: true,
        pushDebounceMs: 30000,
      });

      syncer.startAutoSync();
      syncer.startAutoSync();
      expect(syncer.isAutoSyncRunning()).toBe(true);

      syncer.stopAutoSync();
      expect(syncer.isAutoSyncRunning()).toBe(false);
    });

    it('auto-sync timer should invoke commitIfDirty periodically', async () => {
      vi.useFakeTimers();

      const { opentasksPath } = createWorkingRepo('repo-auto-commit');
      const syncer = createGitGraphSyncer({
        opentasksPath,
        autoCommit: true,
        pushDebounceMs: 60000,
      });

      const commitSpy = vi.spyOn(syncer, 'commitIfDirty');

      syncer.startAutoSync();

      // The minimum interval is max(pushDebounceMs, 10000), so 60000 here
      await vi.advanceTimersByTimeAsync(60000);

      expect(commitSpy).toHaveBeenCalled();

      syncer.stopAutoSync();
    });
  });
});
