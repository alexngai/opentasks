import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readWorktreeRegistry,
  writeWorktreeRegistry,
  registerWorktree,
  unregisterWorktree,
  findWorktree,
  listWorktrees,
  type WorktreeEntry,
} from '../worktree.js';

let tmpDir: string;
let gitCommonDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-wt-test-'));
  gitCommonDir = path.join(tmpDir, '.git');
  fs.mkdirSync(path.join(gitCommonDir, 'opentasks'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: '/home/user/repo',
    opentasksPath: '/home/user/repo/.opentasks',
    hash: 'k7m2x9p4',
    branch: 'main',
    role: 'manager',
    ...overrides,
  };
}

describe('readWorktreeRegistry', () => {
  it('returns empty registry for non-existent file', () => {
    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toEqual([]);
  });

  it('reads existing registry', () => {
    const entry = makeEntry();
    writeWorktreeRegistry(gitCommonDir, { worktrees: [entry] });

    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toHaveLength(1);
    expect(registry.worktrees[0].hash).toBe('k7m2x9p4');
  });
});

describe('writeWorktreeRegistry', () => {
  it('creates directory structure if needed', () => {
    const newDir = path.join(tmpDir, 'new-git');
    writeWorktreeRegistry(newDir, { worktrees: [] });

    const registryPath = path.join(newDir, 'opentasks', 'worktrees.json');
    expect(fs.existsSync(registryPath)).toBe(true);
  });
});

describe('registerWorktree', () => {
  it('adds a new worktree', () => {
    const entry = makeEntry();
    registerWorktree(gitCommonDir, entry);

    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toHaveLength(1);
    expect(registry.worktrees[0].hash).toBe('k7m2x9p4');
  });

  it('replaces existing entry with same hash', () => {
    registerWorktree(gitCommonDir, makeEntry({ branch: 'main' }));
    registerWorktree(gitCommonDir, makeEntry({ branch: 'develop' }));

    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toHaveLength(1);
    expect(registry.worktrees[0].branch).toBe('develop');
  });

  it('handles multiple entries', () => {
    registerWorktree(gitCommonDir, makeEntry({ hash: 'aaaa1111', path: '/path/a' }));
    registerWorktree(gitCommonDir, makeEntry({ hash: 'bbbb2222', path: '/path/b' }));

    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toHaveLength(2);
  });
});

describe('unregisterWorktree', () => {
  it('removes an existing worktree', () => {
    registerWorktree(gitCommonDir, makeEntry({ hash: 'aaaa1111' }));
    registerWorktree(gitCommonDir, makeEntry({ hash: 'bbbb2222' }));

    const removed = unregisterWorktree(gitCommonDir, 'aaaa1111');
    expect(removed?.hash).toBe('aaaa1111');

    const registry = readWorktreeRegistry(gitCommonDir);
    expect(registry.worktrees).toHaveLength(1);
    expect(registry.worktrees[0].hash).toBe('bbbb2222');
  });

  it('returns null for non-existent hash', () => {
    const removed = unregisterWorktree(gitCommonDir, 'notfound');
    expect(removed).toBeNull();
  });
});

describe('findWorktree', () => {
  it('finds by hash', () => {
    registerWorktree(gitCommonDir, makeEntry({ hash: 'aaaa1111' }));
    const found = findWorktree(gitCommonDir, 'aaaa1111');
    expect(found?.hash).toBe('aaaa1111');
  });

  it('finds by path', () => {
    registerWorktree(gitCommonDir, makeEntry({ hash: 'aaaa1111', path: '/tmp/test-repo' }));
    const found = findWorktree(gitCommonDir, '/tmp/test-repo');
    expect(found?.hash).toBe('aaaa1111');
  });

  it('returns null when not found', () => {
    expect(findWorktree(gitCommonDir, 'notfound')).toBeNull();
  });
});

describe('listWorktrees', () => {
  it('lists with status', () => {
    // Create a reachable directory
    const reachablePath = path.join(tmpDir, 'reachable', '.opentasks');
    fs.mkdirSync(reachablePath, { recursive: true });

    registerWorktree(
      gitCommonDir,
      makeEntry({
        hash: 'aaaa1111',
        opentasksPath: reachablePath,
      }),
    );
    registerWorktree(
      gitCommonDir,
      makeEntry({
        hash: 'bbbb2222',
        opentasksPath: '/nonexistent/.opentasks',
      }),
    );

    const list = listWorktrees(gitCommonDir);
    expect(list).toHaveLength(2);

    const reachable = list.find((w) => w.hash === 'aaaa1111');
    const unreachable = list.find((w) => w.hash === 'bbbb2222');

    expect(reachable?.status).toBe('active');
    expect(unreachable?.status).toBe('unreachable');
  });
});
