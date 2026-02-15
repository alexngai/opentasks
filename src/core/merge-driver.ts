/**
 * Custom JSONL Merge Driver for OpenTasks (Phase 3)
 *
 * Three-way merge for graph.jsonl files with field-level resolution.
 * Registered as a git merge driver via .gitattributes.
 */

import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * A parsed JSONL line as a record
 */
type JsonLine = Record<string, unknown>;

/**
 * Parse a JSONL file into a Map keyed by ID
 *
 * For entries with the same ID, keeps the one with the latest updated_at.
 */
export function parseJsonlToMap(filePath: string): Map<string, JsonLine> {
  const map = new Map<string, JsonLine>();

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return map;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed) as JsonLine;
      const id = obj.id as string;
      if (!id) continue;

      const existing = map.get(id);
      if (!existing || (obj.updated_at as string) > (existing.updated_at as string)) {
        map.set(id, obj);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return map;
}

/**
 * Write a map of entries back to a JSONL file
 */
export function writeJsonlFromMap(filePath: string, entries: Map<string, JsonLine>): void {
  const lines: string[] = [];

  // Write nodes first (non x- prefix), then edges (x- prefix)
  const nodes: JsonLine[] = [];
  const edges: JsonLine[] = [];

  for (const entry of entries.values()) {
    if ((entry.id as string).startsWith('x-')) {
      edges.push(entry);
    } else {
      nodes.push(entry);
    }
  }

  for (const entry of [...nodes, ...edges]) {
    lines.push(JSON.stringify(entry));
  }

  fs.writeFileSync(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
}

/**
 * Deep equality check for JSON values
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Pick entry with newer timestamp
 */
function pickByNewerTimestamp(a: JsonLine, b: JsonLine): JsonLine {
  const aTime = (a.updated_at as string) || (a.created_at as string) || '';
  const bTime = (b.updated_at as string) || (b.created_at as string) || '';
  return aTime >= bTime ? a : b;
}

/**
 * Field-level three-way merge
 *
 * For each field:
 * - Both sides agree → use that value
 * - Only one side changed → use the changed value
 * - Both changed differently → last-writer-wins by updated_at
 */
export function fieldLevelMerge(base: JsonLine, ours: JsonLine, theirs: JsonLine): JsonLine {
  const result = { ...base };

  const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);

  for (const key of allKeys) {
    const bVal = base[key];
    const oVal = ours[key];
    const tVal = theirs[key];

    if (deepEqual(oVal, tVal)) {
      // Both agree — take either
      if (oVal !== undefined) {
        result[key] = oVal;
      } else {
        delete result[key];
      }
    } else if (deepEqual(bVal, oVal)) {
      // Only theirs changed
      if (tVal !== undefined) {
        result[key] = tVal;
      } else {
        delete result[key];
      }
    } else if (deepEqual(bVal, tVal)) {
      // Only ours changed
      if (oVal !== undefined) {
        result[key] = oVal;
      } else {
        delete result[key];
      }
    } else {
      // Both changed differently — last writer wins
      const oursTime = (ours.updated_at as string) || '';
      const theirsTime = (theirs.updated_at as string) || '';
      const winner = oursTime >= theirsTime ? oVal : tVal;
      if (winner !== undefined) {
        result[key] = winner;
      } else {
        delete result[key];
      }
    }
  }

  // Ensure updated_at is the latest
  const times = [ours.updated_at as string, theirs.updated_at as string].filter(Boolean);
  if (times.length > 0) {
    result.updated_at = times.sort().pop()!;
  }

  return result;
}

/**
 * Three-way merge of JSONL files
 *
 * @param basePath - Base version (common ancestor)
 * @param oursPath - Our version (current branch)
 * @param theirsPath - Their version (merging branch)
 * @returns 0 on success, 1 on conflict (should not happen with this algorithm)
 */
export function mergeJsonl(basePath: string, oursPath: string, theirsPath: string): number {
  const base = parseJsonlToMap(basePath);
  const ours = parseJsonlToMap(oursPath);
  const theirs = parseJsonlToMap(theirsPath);

  const result = new Map<string, JsonLine>();
  const allIds = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);

  for (const id of allIds) {
    const b = base.get(id);
    const o = ours.get(id);
    const t = theirs.get(id);

    // Both sides agree — take either
    if (deepEqual(o, t)) {
      if (o) result.set(id, o);
      continue;
    }

    // Only theirs changed — take theirs
    if (deepEqual(b, o)) {
      if (t) result.set(id, t);
      continue;
    }

    // Only ours changed — take ours
    if (deepEqual(b, t)) {
      if (o) result.set(id, o);
      continue;
    }

    // Both added same ID with different content
    if (!b && o && t) {
      result.set(id, pickByNewerTimestamp(o, t));
      continue;
    }

    // True conflict: both modified differently
    if (b && o && t) {
      result.set(id, fieldLevelMerge(b, o, t));
      continue;
    }

    // One side deleted, other modified — keep modification
    if (!o && t) {
      result.set(id, t);
      continue;
    }
    if (o && !t) {
      result.set(id, o);
      continue;
    }
  }

  // Write merged result to ours path (git convention)
  writeJsonlFromMap(oursPath, result);

  return 0;
}

/**
 * Install the merge driver in git config and .gitattributes
 *
 * @param worktreePath - Path to the worktree root
 */
export function installMergeDriver(worktreePath: string): void {
  // 1. Add to .gitattributes
  const attrPath = `${worktreePath}/.gitattributes`;
  let attrContent = '';
  try {
    attrContent = fs.readFileSync(attrPath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  if (!attrContent.includes('merge=opentasks')) {
    const addition =
      '\n# OpenTasks merge driver for graph.jsonl\n' + '.opentasks/graph.jsonl merge=opentasks\n';
    fs.writeFileSync(attrPath, attrContent + addition, 'utf-8');
  }

  // 2. Configure merge driver in git config
  try {
    execSync('git config merge.opentasks.name "OpenTasks JSONL merge driver"', {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync('git config merge.opentasks.driver "opentasks merge-driver %O %A %B %L %P"', {
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Non-fatal: git config might not be available
  }
}
