/**
 * Tests for Filesystem-backed ClaudeTaskStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFilesystemTaskStore } from '../claude-tasks-fs.js';
import type { ClaudeTaskStore } from '../claude-tasks.js';
import { ProviderError } from '../types.js';

describe('FilesystemTaskStore', () => {
  let tmpDir: string;
  let store: ClaudeTaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tasks-fs-test-'));
    store = createFilesystemTaskStore({ basePath: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // CRUD round-trip
  // ==========================================================================

  describe('CRUD round-trip', () => {
    it('should create, get, update, and delete a task', async () => {
      // Create
      const created = await store.create({
        subject: 'Test task',
        description: 'A test description',
        status: 'pending',
      });
      expect(created.id).toBe('1');
      expect(created.subject).toBe('Test task');
      expect(created.status).toBe('pending');

      // Get
      const fetched = await store.get(created.id);
      expect(fetched).toEqual(created);

      // Update
      const updated = await store.update(created.id, {
        status: 'in_progress',
        description: 'Updated description',
      });
      expect(updated.id).toBe(created.id);
      expect(updated.status).toBe('in_progress');
      expect(updated.description).toBe('Updated description');
      expect(updated.subject).toBe('Test task');

      // Verify update persisted
      const reFetched = await store.get(created.id);
      expect(reFetched).toEqual(updated);

      // Delete
      await store.delete(created.id);
      const afterDelete = await store.get(created.id);
      expect(afterDelete).toBeNull();
    });

    it('should return null for nonexistent ID on get', async () => {
      const result = await store.get('999');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // list()
  // ==========================================================================

  describe('list()', () => {
    it('should list tasks sorted by numeric ID ascending', async () => {
      await store.create({ subject: 'First', status: 'pending' });
      await store.create({ subject: 'Second', status: 'pending' });
      await store.create({ subject: 'Third', status: 'pending' });

      const tasks = await store.list();
      expect(tasks).toHaveLength(3);
      expect(tasks[0].id).toBe('1');
      expect(tasks[1].id).toBe('2');
      expect(tasks[2].id).toBe('3');
    });

    it('should exclude dotfiles from listing', async () => {
      await store.create({ subject: 'A task', status: 'pending' });

      // Manually create dotfiles that should be ignored
      fs.writeFileSync(path.join(tmpDir, '.lock'), 'pid\n');
      fs.writeFileSync(path.join(tmpDir, '.highwatermark'), '1');
      fs.writeFileSync(path.join(tmpDir, '.some-other-dotfile.json'), '{}');

      const tasks = await store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].subject).toBe('A task');
    });

    it('should return empty array when no tasks exist', async () => {
      const tasks = await store.list();
      expect(tasks).toHaveLength(0);
    });
  });

  // ==========================================================================
  // .highwatermark
  // ==========================================================================

  describe('highwatermark', () => {
    it('should increment correctly across creates', async () => {
      const t1 = await store.create({ subject: 'Task 1', status: 'pending' });
      const t2 = await store.create({ subject: 'Task 2', status: 'pending' });
      const t3 = await store.create({ subject: 'Task 3', status: 'pending' });

      expect(t1.id).toBe('1');
      expect(t2.id).toBe('2');
      expect(t3.id).toBe('3');

      // Verify the highwatermark file content
      const hwm = fs.readFileSync(path.join(tmpDir, '.highwatermark'), 'utf-8');
      expect(hwm.trim()).toBe('3');
    });

    it('should continue from existing highwatermark after re-creating store', async () => {
      await store.create({ subject: 'Task 1', status: 'pending' });
      await store.create({ subject: 'Task 2', status: 'pending' });

      // Create a new store instance pointing at the same directory
      const store2 = createFilesystemTaskStore({ basePath: tmpDir });
      const t3 = await store2.create({ subject: 'Task 3', status: 'pending' });
      expect(t3.id).toBe('3');
    });
  });

  // ==========================================================================
  // NOT_FOUND errors
  // ==========================================================================

  describe('NOT_FOUND errors', () => {
    it('should throw ProviderError NOT_FOUND on update of missing ID', async () => {
      await expect(store.update('999', { subject: 'nope' })).rejects.toThrow(ProviderError);
      try {
        await store.update('999', { subject: 'nope' });
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).code).toBe('NOT_FOUND');
      }
    });

    it('should throw ProviderError NOT_FOUND on delete of missing ID', async () => {
      await expect(store.delete('999')).rejects.toThrow(ProviderError);
      try {
        await store.delete('999');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).code).toBe('NOT_FOUND');
      }
    });
  });

  // ==========================================================================
  // Directory creation
  // ==========================================================================

  describe('directory creation', () => {
    it('should create basePath directory if it does not exist', () => {
      const nested = path.join(tmpDir, 'deeply', 'nested', 'dir');
      expect(fs.existsSync(nested)).toBe(false);

      createFilesystemTaskStore({ basePath: nested });
      expect(fs.existsSync(nested)).toBe(true);
    });
  });

  // ==========================================================================
  // Update preserves ID
  // ==========================================================================

  describe('update semantics', () => {
    it('should preserve original ID even if updates include a different id', async () => {
      const created = await store.create({ subject: 'Original', status: 'pending' });
      const updated = await store.update(created.id, {
        subject: 'Changed',
        id: '999',
      } as Partial<import('../claude-tasks.js').ClaudeTask>);
      expect(updated.id).toBe(created.id);
    });
  });

  // ==========================================================================
  // Metadata round-trip
  // ==========================================================================

  describe('metadata', () => {
    it('should persist and retrieve metadata', async () => {
      const created = await store.create({
        subject: 'With metadata',
        status: 'pending',
        metadata: { key: 'value', nested: { a: 1 } },
      });

      const fetched = await store.get(created.id);
      expect(fetched?.metadata).toEqual({ key: 'value', nested: { a: 1 } });
    });
  });
});
