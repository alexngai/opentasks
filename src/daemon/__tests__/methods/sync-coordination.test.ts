/**
 * Sync ↔ flush coordination tests (HARDENING-PLAN P2 / F2 race).
 *
 * sync.now / sync.pull must serialize with the debounced SQLite→JSONL flush so
 * a pending flush can't fire mid-pull and overwrite the freshly-pulled
 * graph.jsonl. This verifies the ordering deterministically (no git/daemon):
 *   drain flush → pause → (commit) → pull → reload-if-changed → resume.
 */

import { describe, it, expect, vi } from 'vitest';
import { registerSyncMethods } from '../../methods/sync.js';
import type { PullResult, SyncCycleResult } from '../../../graph/git-graph-syncer.js';

type Handler = (params: unknown) => Promise<unknown>;

function setup(pull: PullResult, opts: { withFlush?: boolean; pullThrows?: boolean } = {}) {
  const { withFlush = true, pullThrows = false } = opts;
  const calls: string[] = [];
  const handlers: Record<string, Handler> = {};
  const server = {
    handle: (method: string, fn: Handler) => {
      handlers[method] = fn;
    },
  };

  const flushManager = {
    flush: vi.fn(async () => {
      calls.push('flush');
    }),
    pause: vi.fn(() => {
      calls.push('pause');
    }),
    resume: vi.fn(() => {
      calls.push('resume');
    }),
  };
  const reloadStore = vi.fn(async () => {
    calls.push('reload');
  });
  const syncer = {
    commitIfDirty: vi.fn(async () => {
      calls.push('commit');
      return { committed: false };
    }),
    pull: vi.fn(async () => {
      calls.push('pull');
      if (pullThrows) throw new Error('pull boom');
      return pull;
    }),
    push: vi.fn(async () => ({ pushed: true })),
    sync: vi.fn(async (): Promise<SyncCycleResult> => {
      calls.push('sync');
      return { commit: { committed: false }, pull, push: { pushed: true } };
    }),
  };

  registerSyncMethods({
    server: server as never,
    getSyncer: () => syncer as never,
    getSyncStatus: () => ({}) as never,
    reloadSyncer: async () => ({}) as never,
    flushManager: withFlush ? flushManager : undefined,
    reloadStore: withFlush ? reloadStore : undefined,
  });

  return { handlers, calls, flushManager, reloadStore, syncer };
}

const CHANGED: PullResult = { pulled: true, hasChanges: true };
const NO_CHANGES: PullResult = { pulled: true, hasChanges: false };

describe('sync ↔ flush coordination (F2)', () => {
  it('sync.pull: drains+freezes the flush, commits, pulls, reloads, resumes — in order', async () => {
    const { handlers, calls, reloadStore } = setup(CHANGED);

    const result = await handlers['sync.pull']({});

    expect(calls).toEqual(['flush', 'pause', 'commit', 'pull', 'reload', 'resume']);
    expect(reloadStore).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ran: true, result: CHANGED });
  });

  it('sync.pull: skips the reload when the pull brought no changes', async () => {
    const { handlers, calls, reloadStore } = setup(NO_CHANGES);

    await handlers['sync.pull']({});

    expect(calls).toEqual(['flush', 'pause', 'commit', 'pull', 'resume']);
    expect(reloadStore).not.toHaveBeenCalled();
  });

  it('sync.now: freezes the flush around the cycle and reloads after pulled changes', async () => {
    const { handlers, calls } = setup(CHANGED);

    await handlers['sync.now']({});

    expect(calls).toEqual(['flush', 'pause', 'sync', 'reload', 'resume']);
  });

  it('always resumes the flush even if the git op throws', async () => {
    const { handlers, calls, flushManager } = setup(CHANGED, { pullThrows: true });

    await expect(handlers['sync.pull']({})).rejects.toThrow('pull boom');

    expect(flushManager.resume).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1]).toBe('resume');
    // never reload after a failed op
    expect(calls).not.toContain('reload');
  });

  it('runs uncoordinated (legacy) when no flush manager is wired', async () => {
    const { handlers, calls } = setup(CHANGED, { withFlush: false });

    const result = await handlers['sync.pull']({});

    expect(calls).toEqual(['commit', 'pull']);
    expect(result).toEqual({ ran: true, result: CHANGED });
  });
});
