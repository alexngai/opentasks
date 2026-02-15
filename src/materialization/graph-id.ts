/**
 * Graph ID Resolution
 *
 * Resolves a stable, unique graphId for namespacing archives.
 * Uses a fallback chain: explicit config → location name → git remote → directory name.
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Slugify a string for use as a directory name.
 * Replaces non-alphanumeric characters with hyphens,
 * collapses runs, trims edges.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Slugify a git remote URL into a directory-safe string.
 *
 * Examples:
 *   git@github.com:my-org/my-repo.git → my-org--my-repo
 *   https://github.com/my-org/my-repo → my-org--my-repo
 */
export function slugifyRemoteUrl(url: string): string {
  // Strip protocol and .git suffix
  let cleaned = url.replace(/^(https?:\/\/|git@|ssh:\/\/[^@]+@)/, '').replace(/\.git$/, '');

  // For SSH-style URLs: github.com:org/repo → org/repo
  const colonIdx = cleaned.indexOf(':');
  if (colonIdx !== -1 && !cleaned.includes('/')) {
    cleaned = cleaned.slice(colonIdx + 1);
  } else if (colonIdx !== -1) {
    // github.com:org/repo
    const afterHost = cleaned.slice(colonIdx + 1);
    if (afterHost && !afterHost.startsWith('/')) {
      cleaned = afterHost;
    } else {
      // https-style: github.com/org/repo — strip host
      const parts = cleaned.split('/');
      if (parts.length > 2) {
        cleaned = parts.slice(1).join('/');
      }
    }
  } else {
    // Pure path: github.com/org/repo — strip host
    const parts = cleaned.split('/');
    if (parts.length > 2) {
      cleaned = parts.slice(1).join('/');
    }
  }

  // Replace / with -- for readability
  return slugify(cleaned.replace(/\//g, '--'));
}

/**
 * Get the git remote URL for a remote name.
 * Returns null if the remote doesn't exist or git isn't available.
 */
export function getGitRemoteUrl(gitDir: string, remoteName: string = 'origin'): string | null {
  try {
    const repoRoot = path.dirname(gitDir);
    const result = execSync(`git -C "${repoRoot}" remote get-url ${remoteName}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the current HEAD commit SHA.
 */
export function getGitHead(gitDir: string): string | null {
  try {
    const repoRoot = path.dirname(gitDir);
    const result = execSync(`git -C "${repoRoot}" rev-parse HEAD`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the current branch name.
 */
export function getGitBranch(gitDir: string): string | null {
  try {
    const repoRoot = path.dirname(gitDir);
    const result = execSync(`git -C "${repoRoot}" rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const branch = result.trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Resolve the git directory for a given .opentasks path.
 * Handles worktrees correctly.
 */
export function resolveGitDir(opentasksPath: string): string | null {
  try {
    const repoRoot = path.dirname(opentasksPath);
    const result = execSync(`git -C "${repoRoot}" rev-parse --git-dir`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const gitDir = result.trim();
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(repoRoot, gitDir);
  } catch {
    return null;
  }
}

/**
 * Resolve the graphId for a given opentasks location.
 *
 * Fallback chain:
 * 1. Explicit config (highest priority)
 * 2. Location name from config
 * 3. Derive from git remote URL
 * 4. Derive from directory name
 */
export function resolveGraphId(options: {
  explicitGraphId?: string;
  locationName?: string;
  opentasksPath: string;
}): string {
  const { explicitGraphId, locationName, opentasksPath } = options;

  // 1. Explicit config
  if (explicitGraphId) {
    return explicitGraphId;
  }

  // 2. Location name
  if (locationName) {
    return slugify(locationName);
  }

  // 3. Derive from git remote URL
  const gitDir = resolveGitDir(opentasksPath);
  if (gitDir) {
    const remoteUrl = getGitRemoteUrl(gitDir);
    if (remoteUrl) {
      return slugifyRemoteUrl(remoteUrl);
    }
  }

  // 4. Derive from directory name
  const repoRoot = path.dirname(opentasksPath);
  return slugify(path.basename(repoRoot));
}
