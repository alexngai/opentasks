/**
 * Tests for Context Files — Core API
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  isContextFileNode,
  getContextFileMetadata,
  createContextFileManager,
} from '../context-files.js';
import { contentHash } from '../resolver.js';
import type { GraphStore } from '../../graph/store.js';
import type { Context, Node } from '../../schema/index.js';
import type { ContextFileMetadata } from '../types.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Type guards
// ============================================================================

describe('type guards', () => {
  it('isContextFileNode returns true for valid context-file node', () => {
    const node = {
      id: 'c-1234',
      uuid: 'uuid-1',
      type: 'context' as const,
      title: 'test',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      metadata: {
        context_file: true,
        context_file_path: 'src/index.ts',
        context_file_type: 'code',
      },
    } as Context;

    expect(isContextFileNode(node)).toBe(true);
  });

  it('isContextFileNode returns false for plain context node', () => {
    const node = {
      id: 'c-1234',
      uuid: 'uuid-1',
      type: 'context' as const,
      title: 'test',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    } as Context;

    expect(isContextFileNode(node)).toBe(false);
  });

  it('isContextFileNode returns false for task node', () => {
    const node = {
      id: 't-1234',
      uuid: 'uuid-1',
      type: 'task' as const,
      title: 'test',
      status: 'open',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      metadata: {
        context_file: true,
        context_file_path: 'src/index.ts',
      },
    } as unknown as Node;

    expect(isContextFileNode(node)).toBe(false);
  });

  it('getContextFileMetadata extracts metadata', () => {
    const meta: ContextFileMetadata = {
      context_file: true,
      context_file_path: 'docs/arch.md',
      context_file_type: 'markdown',
      context_file_commit: 'abc123',
      context_file_content_hash: 'hash',
    };
    const node = {
      id: 'c-1234',
      uuid: 'uuid-1',
      type: 'context' as const,
      title: 'test',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      metadata: meta as unknown as Record<string, unknown>,
    } as Context;

    const result = getContextFileMetadata(node);
    expect(result).toEqual(meta);
  });

  it('getContextFileMetadata returns null for non-context-file node', () => {
    const node = {
      id: 'c-1234',
      uuid: 'uuid-1',
      type: 'context' as const,
      title: 'test',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    } as Context;

    expect(getContextFileMetadata(node)).toBeNull();
  });
});

// ============================================================================
// ContextFileManager (integration with real git)
// ============================================================================

describe('ContextFileManager', () => {
  let repoDir: string;
  let mockStore: GraphStore;
  let createdNodes: Map<string, Node>;
  let idCounter: number;

  beforeEach(async () => {
    // Set up temp git repo
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'ctx-mgr-test-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

    // Create files and commit
    await mkdir(path.join(repoDir, 'src'), { recursive: true });
    await mkdir(path.join(repoDir, 'docs'), { recursive: true });
    await writeFile(path.join(repoDir, 'src', 'app.ts'), 'const app = "hello";\n');
    await writeFile(path.join(repoDir, 'docs', 'design.md'), '# Design\n\nArchitecture notes.\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoDir });

    // Mock store
    createdNodes = new Map();
    idCounter = 0;

    mockStore = {
      createNode: vi.fn(async (input) => {
        idCounter++;
        const node: Node = {
          id: `c-${idCounter.toString(36)}`,
          uuid: `uuid-${idCounter}`,
          type: input.type,
          title: input.title,
          content: input.content,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: input.status,
          tags: input.tags,
          priority: input.priority,
          metadata: input.metadata,
        } as Node;
        createdNodes.set(node.id, node);
        return node;
      }),
      getNode: vi.fn(async (id: string) => createdNodes.get(id) ?? null),
      updateNode: vi.fn(async (id: string, updates: Record<string, unknown>) => {
        const existing = createdNodes.get(id);
        if (!existing) throw new Error(`Node not found: ${id}`);
        const updated = {
          ...existing,
          ...updates,
          metadata: { ...(existing.metadata ?? {}), ...((updates.metadata as Record<string, unknown>) ?? {}) },
          updated_at: new Date().toISOString(),
        } as Node;
        createdNodes.set(id, updated);
        return updated;
      }),
      query: {
        nodes: vi.fn(async (filter: { type?: string }) => {
          const all = Array.from(createdNodes.values());
          if (filter?.type) return all.filter((n) => n.type === filter.type);
          return all;
        }),
      },
    } as unknown as GraphStore;
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a context-file node for a code file', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      expect(node.type).toBe('context');
      expect(node.title).toBe('src/app.ts');
      expect(node.metadata?.context_file).toBe(true);
      expect(node.metadata?.context_file_path).toBe('src/app.ts');
      expect(node.metadata?.context_file_type).toBe('code');
      expect(node.metadata?.context_file_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(node.metadata?.context_file_content_hash).toBe(contentHash('const app = "hello";\n'));
      expect(node.content).toBeUndefined();
    });

    it('should create a context-file node for a markdown file', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({
        filePath: 'docs/design.md',
        title: 'Design Doc',
        tags: ['architecture'],
      });

      expect(node.title).toBe('Design Doc');
      expect(node.metadata?.context_file_type).toBe('markdown');
      expect(node.tags).toEqual(['architecture']);
    });

    it('should throw for non-existent file', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      await expect(mgr.create({ filePath: 'nope.ts' })).rejects.toThrow('File not found');
    });
  });

  describe('resolve', () => {
    it('should resolve file content from working tree', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      const result = await mgr.resolve(node.id);
      expect(result.content).toBe('const app = "hello";\n');
      expect(result.drifted).toBe(false);
      expect(result.filePath).toBe('src/app.ts');
    });

    it('should detect drift after file change', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      // Modify file (without committing)
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'const app = "changed";\n');

      const result = await mgr.resolve(node.id);
      expect(result.content).toBe('const app = "changed";\n');
      expect(result.drifted).toBe(true);
    });
  });

  describe('resolveAtCapturedCommit', () => {
    it('should return original content even after file changes', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      // Modify file and commit
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'const app = "v2";\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'v2'], { cwd: repoDir });

      const result = await mgr.resolveAtCapturedCommit(node.id);
      expect(result.content).toBe('const app = "hello";\n');
    });
  });

  describe('checkDrift', () => {
    it('should report no drift when file unchanged', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      const drift = await mgr.checkDrift(node.id);
      expect(drift.drifted).toBe(false);
      expect(drift.currentHash).toBe(drift.capturedHash);
    });

    it('should report drift when file changed', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'const app = "new";\n');

      const drift = await mgr.checkDrift(node.id);
      expect(drift.drifted).toBe(true);
      expect(drift.currentHash).not.toBe(drift.capturedHash);
    });
  });

  describe('sync', () => {
    it('should update commit and hash when file changes', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      const originalHash = node.metadata?.context_file_content_hash;

      // Modify and commit
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'const app = "synced";\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'sync'], { cwd: repoDir });

      const synced = await mgr.sync(node.id);
      expect(synced.metadata?.context_file_content_hash).not.toBe(originalHash);
      expect(synced.metadata?.context_file_content_hash).toBe(contentHash('const app = "synced";\n'));
    });

    it('should no-op when file is unchanged', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      const synced = await mgr.sync(node.id);
      // Should return the same node without updating
      expect(synced.id).toBe(node.id);
      expect(mockStore.updateNode).not.toHaveBeenCalled();
    });

    it('should force sync even when unchanged', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      const node = await mgr.create({ filePath: 'src/app.ts' });

      await mgr.sync(node.id, { force: true });
      expect(mockStore.updateNode).toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should return only context-file nodes', async () => {
      const mgr = createContextFileManager(mockStore, repoDir);
      await mgr.create({ filePath: 'src/app.ts' });
      await mgr.create({ filePath: 'docs/design.md' });

      // Also create a plain context node
      await mockStore.createNode({
        type: 'context',
        title: 'Plain context',
      });

      const list = await mgr.list();
      expect(list).toHaveLength(2);
      expect(list.every((n) => n.metadata.context_file === true)).toBe(true);
    });
  });
});
