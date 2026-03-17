/**
 * Tests for Context Files — Resolver
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  contentHash,
  getHeadCommit,
  readFileFromWorktree,
  readFileAtCommit,
  resolveContextFile,
  fileExists,
  fileExistsAtCommit,
  inferFileType,
} from '../resolver.js';

const execFileAsync = promisify(execFile);

describe('resolver', () => {
  // ── Pure functions (no git needed) ──────────────────────────────────

  describe('contentHash', () => {
    it('should return consistent SHA-256 hex for same input', () => {
      const h1 = contentHash('hello world');
      const h2 = contentHash('hello world');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return different hashes for different input', () => {
      expect(contentHash('a')).not.toBe(contentHash('b'));
    });
  });

  describe('inferFileType', () => {
    it('should detect markdown', () => {
      expect(inferFileType('docs/arch.md')).toBe('markdown');
      expect(inferFileType('README.mdx')).toBe('markdown');
    });

    it('should detect code', () => {
      expect(inferFileType('src/index.ts')).toBe('code');
      expect(inferFileType('main.py')).toBe('code');
      expect(inferFileType('config.json')).toBe('code');
      expect(inferFileType('style.css')).toBe('code');
    });

    it('should fall back to text', () => {
      expect(inferFileType('notes.txt')).toBe('text');
      expect(inferFileType('LICENSE')).toBe('text');
    });
  });

  // ── Git-dependent tests ─────────────────────────────────────────────

  describe('git operations', () => {
    let repoDir: string;

    beforeEach(async () => {
      // Create a temp git repo
      repoDir = await mkdtemp(path.join(os.tmpdir(), 'ctx-files-test-'));
      await execFileAsync('git', ['init'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      // Create initial file and commit
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await writeFile(path.join(repoDir, 'src', 'hello.ts'), 'export const x = 1;\n');
      await writeFile(path.join(repoDir, 'README.md'), '# Test\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
    });

    afterEach(async () => {
      await rm(repoDir, { recursive: true, force: true });
    });

    describe('getHeadCommit', () => {
      it('should return a 40-char hex SHA', async () => {
        const sha = await getHeadCommit(repoDir);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      });
    });

    describe('readFileFromWorktree', () => {
      it('should read file content', async () => {
        const content = await readFileFromWorktree(repoDir, 'src/hello.ts');
        expect(content).toBe('export const x = 1;\n');
      });
    });

    describe('readFileAtCommit', () => {
      it('should read file at a specific commit', async () => {
        const firstCommit = await getHeadCommit(repoDir);

        // Modify file and make a new commit
        await writeFile(path.join(repoDir, 'src', 'hello.ts'), 'export const x = 2;\n');
        await execFileAsync('git', ['add', '.'], { cwd: repoDir });
        await execFileAsync('git', ['commit', '-m', 'update'], { cwd: repoDir });

        // Current worktree has new content
        const current = await readFileFromWorktree(repoDir, 'src/hello.ts');
        expect(current).toBe('export const x = 2;\n');

        // Reading at first commit returns old content
        const old = await readFileAtCommit(repoDir, 'src/hello.ts', firstCommit);
        expect(old).toBe('export const x = 1;\n');
      });
    });

    describe('fileExists', () => {
      it('should return true for existing file', async () => {
        expect(await fileExists(repoDir, 'src/hello.ts')).toBe(true);
      });

      it('should return false for non-existing file', async () => {
        expect(await fileExists(repoDir, 'src/nope.ts')).toBe(false);
      });
    });

    describe('fileExistsAtCommit', () => {
      it('should detect file at commit', async () => {
        const commit = await getHeadCommit(repoDir);
        expect(await fileExistsAtCommit(repoDir, 'src/hello.ts', commit)).toBe(true);
        expect(await fileExistsAtCommit(repoDir, 'src/nope.ts', commit)).toBe(false);
      });
    });

    describe('resolveContextFile', () => {
      it('should resolve from worktree and detect no drift', async () => {
        const hash = contentHash('export const x = 1;\n');
        const result = await resolveContextFile(repoDir, 'src/hello.ts', hash);

        expect(result.content).toBe('export const x = 1;\n');
        expect(result.contentHash).toBe(hash);
        expect(result.drifted).toBe(false);
        expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      });

      it('should detect drift when hash mismatches', async () => {
        const result = await resolveContextFile(repoDir, 'src/hello.ts', 'stale-hash');

        expect(result.drifted).toBe(true);
      });

      it('should resolve at a specific commit', async () => {
        const firstCommit = await getHeadCommit(repoDir);

        // Modify and commit
        await writeFile(path.join(repoDir, 'src', 'hello.ts'), 'export const x = 99;\n');
        await execFileAsync('git', ['add', '.'], { cwd: repoDir });
        await execFileAsync('git', ['commit', '-m', 'v2'], { cwd: repoDir });

        const result = await resolveContextFile(
          repoDir,
          'src/hello.ts',
          undefined,
          firstCommit,
        );

        expect(result.content).toBe('export const x = 1;\n');
        expect(result.commit).toBe(firstCommit);
      });
    });
  });
});
