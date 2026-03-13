import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseJsonlToMap,
  writeJsonlFromMap,
  deepEqual,
  fieldLevelMerge,
  mergeJsonl,
} from '../merge-driver.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-merge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(name: string, entries: Record<string, unknown>[]): string {
  const filePath = path.join(tmpDir, name);
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('deepEqual', () => {
  it('handles primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it('handles arrays', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
  });

  it('handles objects', () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('handles nested objects', () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
});

describe('parseJsonlToMap', () => {
  it('parses JSONL file into map', () => {
    const filePath = writeJsonl('test.jsonl', [
      { id: 't-1', title: 'First', updated_at: '2025-01-01T00:00:00Z' },
      { id: 't-2', title: 'Second', updated_at: '2025-01-01T00:00:00Z' },
    ]);

    const map = parseJsonlToMap(filePath);
    expect(map.size).toBe(2);
    expect(map.get('t-1')?.title).toBe('First');
    expect(map.get('t-2')?.title).toBe('Second');
  });

  it('deduplicates by latest updated_at', () => {
    const filePath = writeJsonl('test.jsonl', [
      { id: 't-1', title: 'Old', updated_at: '2025-01-01T10:00:00Z' },
      { id: 't-1', title: 'New', updated_at: '2025-01-01T12:00:00Z' },
    ]);

    const map = parseJsonlToMap(filePath);
    expect(map.size).toBe(1);
    expect(map.get('t-1')?.title).toBe('New');
  });

  it('handles non-existent file', () => {
    const map = parseJsonlToMap('/nonexistent/path');
    expect(map.size).toBe(0);
  });
});

describe('writeJsonlFromMap', () => {
  it('writes map to JSONL', () => {
    const map = new Map<string, Record<string, unknown>>();
    map.set('t-1', { id: 't-1', title: 'First' });
    map.set('x-1', { id: 'x-1', from_id: 't-1', to_id: 't-2', type: 'blocks' });

    const filePath = path.join(tmpDir, 'output.jsonl');
    writeJsonlFromMap(filePath, map);

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Nodes before edges
    expect(JSON.parse(lines[0]).id).toBe('t-1');
    expect(JSON.parse(lines[1]).id).toBe('x-1');
  });
});

describe('fieldLevelMerge', () => {
  it('takes agreed-upon value when both sides match', () => {
    const base = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T00:00:00Z' };
    const ours = { id: 't-1', status: 'closed', title: 'Test', updated_at: '2025-01-01T01:00:00Z' };
    const theirs = {
      id: 't-1',
      status: 'closed',
      title: 'Test',
      updated_at: '2025-01-01T02:00:00Z',
    };

    const result = fieldLevelMerge(base, ours, theirs);
    expect(result.status).toBe('closed');
  });

  it('takes theirs when only theirs changed', () => {
    const base = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T00:00:00Z' };
    const ours = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T01:00:00Z' };
    const theirs = {
      id: 't-1',
      status: 'in_progress',
      title: 'Test',
      updated_at: '2025-01-01T02:00:00Z',
    };

    const result = fieldLevelMerge(base, ours, theirs);
    expect(result.status).toBe('in_progress');
  });

  it('takes ours when only ours changed', () => {
    const base = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T00:00:00Z' };
    const ours = { id: 't-1', status: 'closed', title: 'Test', updated_at: '2025-01-01T02:00:00Z' };
    const theirs = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T01:00:00Z' };

    const result = fieldLevelMerge(base, ours, theirs);
    expect(result.status).toBe('closed');
  });

  it('uses last-writer-wins when both changed differently', () => {
    const base = { id: 't-1', status: 'open', title: 'Test', updated_at: '2025-01-01T00:00:00Z' };
    const ours = { id: 't-1', status: 'closed', title: 'Test', updated_at: '2025-01-01T01:00:00Z' };
    const theirs = {
      id: 't-1',
      status: 'in_progress',
      title: 'Test',
      updated_at: '2025-01-01T02:00:00Z',
    };

    const result = fieldLevelMerge(base, ours, theirs);
    // theirs has newer updated_at -> theirs' value wins
    expect(result.status).toBe('in_progress');
  });

  it('ensures updated_at is the latest', () => {
    const base = { id: 't-1', updated_at: '2025-01-01T00:00:00Z' };
    const ours = { id: 't-1', updated_at: '2025-01-01T01:00:00Z' };
    const theirs = { id: 't-1', updated_at: '2025-01-01T02:00:00Z' };

    const result = fieldLevelMerge(base, ours, theirs);
    expect(result.updated_at).toBe('2025-01-01T02:00:00Z');
  });
});

describe('mergeJsonl', () => {
  it('handles no conflicts (only one side changed)', () => {
    const base = writeJsonl('base.jsonl', [
      { id: 't-1', status: 'open', title: 'Task 1', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const ours = writeJsonl('ours.jsonl', [
      { id: 't-1', status: 'open', title: 'Task 1', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const theirs = writeJsonl('theirs.jsonl', [
      { id: 't-1', status: 'closed', title: 'Task 1', updated_at: '2025-01-01T01:00:00Z' },
    ]);

    const exitCode = mergeJsonl(base, ours, theirs);
    expect(exitCode).toBe(0);

    // Result should be in "ours" file
    const result = parseJsonlToMap(ours);
    expect(result.get('t-1')?.status).toBe('closed');
  });

  it('handles additions from both sides', () => {
    const base = writeJsonl('base.jsonl', [
      { id: 't-1', title: 'Existing', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const ours = writeJsonl('ours.jsonl', [
      { id: 't-1', title: 'Existing', updated_at: '2025-01-01T00:00:00Z' },
      { id: 't-2', title: 'Our Addition', updated_at: '2025-01-01T01:00:00Z' },
    ]);
    const theirs = writeJsonl('theirs.jsonl', [
      { id: 't-1', title: 'Existing', updated_at: '2025-01-01T00:00:00Z' },
      { id: 't-3', title: 'Their Addition', updated_at: '2025-01-01T01:00:00Z' },
    ]);

    const exitCode = mergeJsonl(base, ours, theirs);
    expect(exitCode).toBe(0);

    const result = parseJsonlToMap(ours);
    expect(result.size).toBe(3);
    expect(result.has('t-1')).toBe(true);
    expect(result.has('t-2')).toBe(true);
    expect(result.has('t-3')).toBe(true);
  });

  it('handles true conflict with field-level merge', () => {
    const base = writeJsonl('base.jsonl', [
      {
        id: 't-1',
        status: 'open',
        title: 'Original',
        priority: 1,
        updated_at: '2025-01-01T00:00:00Z',
      },
    ]);
    const ours = writeJsonl('ours.jsonl', [
      {
        id: 't-1',
        status: 'closed',
        title: 'Original',
        priority: 1,
        updated_at: '2025-01-01T01:00:00Z',
      },
    ]);
    const theirs = writeJsonl('theirs.jsonl', [
      {
        id: 't-1',
        status: 'open',
        title: 'Updated Title',
        priority: 2,
        updated_at: '2025-01-01T02:00:00Z',
      },
    ]);

    const exitCode = mergeJsonl(base, ours, theirs);
    expect(exitCode).toBe(0);

    const result = parseJsonlToMap(ours);
    const node = result.get('t-1')!;
    // status: ours changed to 'closed', theirs kept 'open' -> take ours
    expect(node.status).toBe('closed');
    // title: only theirs changed -> take theirs
    expect(node.title).toBe('Updated Title');
    // priority: only theirs changed -> take theirs
    expect(node.priority).toBe(2);
  });

  it('handles one side deleting, other modifying', () => {
    const base = writeJsonl('base.jsonl', [
      { id: 't-1', title: 'Original', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const ours = writeJsonl('ours.jsonl', [
      // t-1 deleted from ours
    ]);
    const theirs = writeJsonl('theirs.jsonl', [
      { id: 't-1', title: 'Modified', updated_at: '2025-01-01T01:00:00Z' },
    ]);

    const exitCode = mergeJsonl(base, ours, theirs);
    expect(exitCode).toBe(0);

    // Should keep the modification
    const result = parseJsonlToMap(ours);
    expect(result.size).toBe(1);
    expect(result.get('t-1')?.title).toBe('Modified');
  });

  it('handles both sides deleting', () => {
    const base = writeJsonl('base.jsonl', [
      { id: 't-1', title: 'Original', updated_at: '2025-01-01T00:00:00Z' },
      { id: 't-2', title: 'Surviving', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const ours = writeJsonl('ours.jsonl', [
      { id: 't-2', title: 'Surviving', updated_at: '2025-01-01T00:00:00Z' },
    ]);
    const theirs = writeJsonl('theirs.jsonl', [
      { id: 't-2', title: 'Surviving', updated_at: '2025-01-01T00:00:00Z' },
    ]);

    const exitCode = mergeJsonl(base, ours, theirs);
    expect(exitCode).toBe(0);

    const result = parseJsonlToMap(ours);
    expect(result.size).toBe(1);
    expect(result.has('t-2')).toBe(true);
  });

  it('returns 0 (always succeeds)', () => {
    const base = writeJsonl('base.jsonl', []);
    const ours = writeJsonl('ours.jsonl', []);
    const theirs = writeJsonl('theirs.jsonl', []);

    expect(mergeJsonl(base, ours, theirs)).toBe(0);
  });

  describe('provider-authoritative nodes', () => {
    it('stamps provider_needs_reconcile when both sides modify cached fields', () => {
      const base = writeJsonl('base.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Original',
          status: 'open',
          content: 'Base content',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
            provider_cached_at: '2025-01-01T00:00:00Z',
          },
          updated_at: '2025-01-01T00:00:00Z',
        },
      ]);
      const ours = writeJsonl('ours.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Alice updated title',
          status: 'open',
          content: 'Base content',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
            provider_cached_at: '2025-01-01T01:00:00Z',
          },
          updated_at: '2025-01-01T01:00:00Z',
        },
      ]);
      const theirs = writeJsonl('theirs.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Bob updated title',
          status: 'open',
          content: 'Base content',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
            provider_cached_at: '2025-01-01T02:00:00Z',
          },
          updated_at: '2025-01-01T02:00:00Z',
        },
      ]);

      mergeJsonl(base, ours, theirs);

      const result = parseJsonlToMap(ours);
      const node = result.get('t-1')!;
      const metadata = node.metadata as Record<string, unknown>;
      expect(metadata.provider_needs_reconcile).toBe(true);
      expect(metadata.provider_cached_at).toBeNull();
    });

    it('does NOT stamp provider_needs_reconcile when only one side modified', () => {
      const base = writeJsonl('base.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Original',
          status: 'open',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
          },
          updated_at: '2025-01-01T00:00:00Z',
        },
      ]);
      const ours = writeJsonl('ours.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Original',
          status: 'open',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
          },
          updated_at: '2025-01-01T00:00:00Z',
        },
      ]);
      const theirs = writeJsonl('theirs.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Updated by theirs only',
          status: 'open',
          metadata: {
            provider_uri: 'beads://./bd-1',
            provider_source: 'beads',
            provider_authoritative: true,
          },
          updated_at: '2025-01-01T01:00:00Z',
        },
      ]);

      mergeJsonl(base, ours, theirs);

      const result = parseJsonlToMap(ours);
      const node = result.get('t-1')!;
      // One-side-modified → normal merge, no reconcile flag
      expect(node.title).toBe('Updated by theirs only');
      const metadata = node.metadata as Record<string, unknown>;
      expect(metadata.provider_needs_reconcile).toBeUndefined();
    });

    it('does NOT affect non-authoritative nodes with both-sides conflicts', () => {
      const base = writeJsonl('base.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Original',
          status: 'open',
          updated_at: '2025-01-01T00:00:00Z',
        },
      ]);
      const ours = writeJsonl('ours.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Alice title',
          status: 'open',
          updated_at: '2025-01-01T01:00:00Z',
        },
      ]);
      const theirs = writeJsonl('theirs.jsonl', [
        {
          id: 't-1',
          type: 'task',
          title: 'Bob title',
          status: 'open',
          updated_at: '2025-01-01T02:00:00Z',
        },
      ]);

      mergeJsonl(base, ours, theirs);

      const result = parseJsonlToMap(ours);
      const node = result.get('t-1')!;
      // Normal last-writer-wins — no provider_needs_reconcile
      expect(node.title).toBe('Bob title');
      expect(node.metadata).toBeUndefined();
    });
  });
});
