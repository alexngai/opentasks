/**
 * Context Files — Resolver
 *
 * Resolves file content from the working tree or at a specific git commit.
 * Computes content hashes for drift detection.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { ContextFileResolution, ContextFileType } from './types.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute SHA-256 hex hash of content.
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Get the current HEAD commit SHA for a repository.
 */
export async function getHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

/**
 * Read file content from the working tree.
 */
export async function readFileFromWorktree(
  repoRoot: string,
  filePath: string,
): Promise<string> {
  const absolute = path.resolve(repoRoot, filePath);
  return readFile(absolute, 'utf8');
}

/**
 * Read file content at a specific git commit via `git show <sha>:<path>`.
 */
export async function readFileAtCommit(
  repoRoot: string,
  filePath: string,
  commit: string,
): Promise<string> {
  // Normalize to forward-slash for git
  const gitPath = filePath.split(path.sep).join('/');
  const { stdout } = await execFileAsync('git', ['show', `${commit}:${gitPath}`], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  return stdout;
}

/**
 * Resolve a context file — read content and compute hashes.
 *
 * If `atCommit` is provided, reads the file at that specific commit.
 * Otherwise reads from the working tree and uses HEAD as the commit.
 */
export async function resolveContextFile(
  repoRoot: string,
  filePath: string,
  capturedHash?: string,
  atCommit?: string,
): Promise<ContextFileResolution> {
  let content: string;
  let commit: string;

  if (atCommit) {
    content = await readFileAtCommit(repoRoot, filePath, atCommit);
    commit = atCommit;
  } else {
    content = await readFileFromWorktree(repoRoot, filePath);
    commit = await getHeadCommit(repoRoot);
  }

  const hash = contentHash(content);
  const drifted = capturedHash !== undefined && hash !== capturedHash;

  return {
    content,
    commit,
    contentHash: hash,
    drifted,
    filePath,
  };
}

/**
 * Check if a file exists in the working tree.
 */
export async function fileExists(repoRoot: string, filePath: string): Promise<boolean> {
  try {
    await readFile(path.resolve(repoRoot, filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists at a specific git commit.
 */
export async function fileExistsAtCommit(
  repoRoot: string,
  filePath: string,
  commit: string,
): Promise<boolean> {
  try {
    const gitPath = filePath.split(path.sep).join('/');
    await execFileAsync('git', ['cat-file', '-e', `${commit}:${gitPath}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Infer the context-file type from a file path.
 */
export function inferFileType(filePath: string): ContextFileType {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.mdx') {
    return 'markdown';
  }

  const codeExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
    '.c', '.cpp', '.cc', '.h', '.hpp',
    '.cs', '.swift', '.scala', '.clj', '.cljs',
    '.sh', '.bash', '.zsh', '.fish',
    '.sql', '.graphql', '.gql',
    '.yaml', '.yml', '.toml', '.json', '.jsonl',
    '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  ]);

  if (codeExtensions.has(ext)) {
    return 'code';
  }

  return 'text';
}
