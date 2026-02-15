/**
 * Tests for Registry Manager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRegistryManager, type RegistryManager } from '../registry.js';
import type { DaemonEntry } from '../types.js';

describe('RegistryManager', () => {
  let tempDir: string;
  let registryPath: string;
  let registryManager: RegistryManager;

  const createTestEntry = (overrides: Partial<DaemonEntry> = {}): DaemonEntry => ({
    locationPath: '/test/project/.opentasks',
    socketPath: '/test/project/.opentasks/daemon.sock',
    pid: process.pid, // Use current PID so it appears alive
    version: '1.0.0',
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-registry-test-'));
    registryPath = path.join(tempDir, '.opentasks', 'registry.json');
    registryManager = createRegistryManager(registryPath);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('register', () => {
    it('should create registry directory and file on first register', async () => {
      const entry = createTestEntry();

      await registryManager.register(entry);

      const exists = await fs
        .access(registryPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('should register a daemon entry', async () => {
      const entry = createTestEntry();

      await registryManager.register(entry);

      const entries = await registryManager.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it('should replace existing entry for same location', async () => {
      const entry1 = createTestEntry({ version: '1.0.0' });
      const entry2 = createTestEntry({ version: '2.0.0' });

      await registryManager.register(entry1);
      await registryManager.register(entry2);

      const entries = await registryManager.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].version).toBe('2.0.0');
    });

    it('should allow multiple entries for different locations', async () => {
      const entry1 = createTestEntry({ locationPath: '/project1/.opentasks' });
      const entry2 = createTestEntry({ locationPath: '/project2/.opentasks' });

      await registryManager.register(entry1);
      await registryManager.register(entry2);

      const entries = await registryManager.list();
      expect(entries).toHaveLength(2);
    });
  });

  describe('unregister', () => {
    it('should remove registered daemon', async () => {
      const entry = createTestEntry();
      await registryManager.register(entry);

      await registryManager.unregister(entry.locationPath);

      const entries = await registryManager.list();
      expect(entries).toHaveLength(0);
    });

    it('should not fail when unregistering non-existent daemon', async () => {
      await expect(registryManager.unregister('/nonexistent/.opentasks')).resolves.not.toThrow();
    });

    it('should only remove specified daemon', async () => {
      const entry1 = createTestEntry({ locationPath: '/project1/.opentasks' });
      const entry2 = createTestEntry({ locationPath: '/project2/.opentasks' });
      await registryManager.register(entry1);
      await registryManager.register(entry2);

      await registryManager.unregister(entry1.locationPath);

      const entries = await registryManager.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].locationPath).toBe(entry2.locationPath);
    });
  });

  describe('find', () => {
    it('should return null when no daemon registered', async () => {
      const result = await registryManager.find('/test/.opentasks');
      expect(result).toBeNull();
    });

    it('should find registered daemon by location', async () => {
      const entry = createTestEntry();
      await registryManager.register(entry);

      const result = await registryManager.find(entry.locationPath);

      expect(result).toEqual(entry);
    });

    it('should return null when daemon PID is dead', async () => {
      const entry = createTestEntry({ pid: 999999999 }); // Non-existent PID
      await registryManager.register(entry);

      const result = await registryManager.find(entry.locationPath);

      expect(result).toBeNull();
    });

    it('should return entry when daemon PID is alive', async () => {
      const entry = createTestEntry({ pid: process.pid }); // Our PID is alive
      await registryManager.register(entry);

      const result = await registryManager.find(entry.locationPath);

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(process.pid);
    });
  });

  describe('list', () => {
    it('should return empty array when no daemons registered', async () => {
      const entries = await registryManager.list();
      expect(entries).toEqual([]);
    });

    it('should return all registered daemons', async () => {
      const entry1 = createTestEntry({ locationPath: '/project1/.opentasks' });
      const entry2 = createTestEntry({ locationPath: '/project2/.opentasks' });
      await registryManager.register(entry1);
      await registryManager.register(entry2);

      const entries = await registryManager.list();

      expect(entries).toHaveLength(2);
    });

    it('should include dead daemon entries (list does not filter)', async () => {
      const entry = createTestEntry({ pid: 999999999 }); // Dead PID
      await registryManager.register(entry);

      const entries = await registryManager.list();

      expect(entries).toHaveLength(1);
    });
  });

  describe('cleanup', () => {
    it('should remove dead daemon entries', async () => {
      const aliveEntry = createTestEntry({
        locationPath: '/alive/.opentasks',
        pid: process.pid,
      });
      const deadEntry = createTestEntry({
        locationPath: '/dead/.opentasks',
        pid: 999999999,
      });
      await registryManager.register(aliveEntry);
      await registryManager.register(deadEntry);

      const removedCount = await registryManager.cleanup();

      expect(removedCount).toBe(1);
      const entries = await registryManager.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].locationPath).toBe(aliveEntry.locationPath);
    });

    it('should return 0 when no dead entries', async () => {
      const entry = createTestEntry({ pid: process.pid });
      await registryManager.register(entry);

      const removedCount = await registryManager.cleanup();

      expect(removedCount).toBe(0);
    });

    it('should return 0 when registry is empty', async () => {
      const removedCount = await registryManager.cleanup();
      expect(removedCount).toBe(0);
    });

    it('should remove multiple dead entries', async () => {
      const deadEntry1 = createTestEntry({
        locationPath: '/dead1/.opentasks',
        pid: 999999998,
      });
      const deadEntry2 = createTestEntry({
        locationPath: '/dead2/.opentasks',
        pid: 999999999,
      });
      await registryManager.register(deadEntry1);
      await registryManager.register(deadEntry2);

      const removedCount = await registryManager.cleanup();

      expect(removedCount).toBe(2);
      const entries = await registryManager.list();
      expect(entries).toHaveLength(0);
    });
  });

  describe('registryPath', () => {
    it('should return the configured registry path', () => {
      expect(registryManager.registryPath).toBe(registryPath);
    });
  });

  describe('persistence', () => {
    it('should persist across manager instances', async () => {
      const entry = createTestEntry();
      await registryManager.register(entry);

      // Create new manager instance
      const newManager = createRegistryManager(registryPath);
      const entries = await newManager.list();

      expect(entries).toHaveLength(1);
      expect(entries[0].locationPath).toBe(entry.locationPath);
    });
  });

  describe('registry format', () => {
    it('should write valid JSON with version', async () => {
      const entry = createTestEntry();
      await registryManager.register(entry);

      const contents = await fs.readFile(registryPath, 'utf8');
      const registry = JSON.parse(contents);

      expect(registry.version).toBe('1.0.0');
      expect(registry.daemons).toHaveLength(1);
    });
  });
});
