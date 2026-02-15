import { describe, it, expect } from 'vitest';
import { mergeConfigs } from '../merge.js';

describe('Config Merger', () => {
  describe('mergeConfigs', () => {
    it('returns defaults for empty input', () => {
      const result = mergeConfigs();
      expect(result.storage.jsonlPath).toBe('graph.jsonl');
      expect(result.daemon.autoStart).toBe(true);
      expect(result.logging.level).toBe('info');
    });

    it('merges single partial config', () => {
      const result = mergeConfigs({
        storage: { jsonlPath: 'custom.jsonl' },
      });
      expect(result.storage.jsonlPath).toBe('custom.jsonl');
      expect(result.storage.sqlitePath).toBe('cache.db'); // default
    });

    it('merges two partial configs', () => {
      const result = mergeConfigs(
        { storage: { jsonlPath: 'a.jsonl' } },
        { storage: { sqlitePath: 'b.db' } },
      );
      expect(result.storage.jsonlPath).toBe('a.jsonl');
      expect(result.storage.sqlitePath).toBe('b.db');
    });

    it('later configs override earlier ones', () => {
      const result = mergeConfigs(
        { storage: { jsonlPath: 'first.jsonl' } },
        { storage: { jsonlPath: 'second.jsonl' } },
      );
      expect(result.storage.jsonlPath).toBe('second.jsonl');
    });

    it('deep merges nested objects', () => {
      const result = mergeConfigs(
        { providers: { beads: { enabled: false } } },
        { providers: { beads: { timeout: 60000 } } },
      );
      expect(result.providers.beads.enabled).toBe(false);
      expect(result.providers.beads.timeout).toBe(60000);
      expect(result.providers.beads.executable).toBe('bd'); // default
    });

    it('preserves explicit null values', () => {
      const result = mergeConfigs(
        { logging: { file: 'initial.log' } },
        { logging: { file: null } },
      );
      expect(result.logging.file).toBeNull();
    });

    it('does not override with undefined', () => {
      const result = mergeConfigs(
        { logging: { level: 'debug' } },
        { logging: { level: undefined as unknown as 'debug' } },
      );
      expect(result.logging.level).toBe('debug');
    });

    it('returns complete config with defaults filled in', () => {
      const result = mergeConfigs({ logging: { level: 'error' } });

      // Check all sections exist
      expect(result.storage).toBeDefined();
      expect(result.daemon).toBeDefined();
      expect(result.providers).toBeDefined();
      expect(result.logging).toBeDefined();

      // Check defaults are applied
      expect(result.storage.jsonlPath).toBe('graph.jsonl');
      expect(result.daemon.socketPath).toBe('daemon.sock');
      expect(result.providers.beads.enabled).toBe(true);

      // Check override is applied
      expect(result.logging.level).toBe('error');
    });

    it('merges multiple configs in order', () => {
      const result = mergeConfigs(
        { storage: { jsonlPath: 'first.jsonl' } },
        { daemon: { autoStart: false } },
        { logging: { level: 'debug' } },
        { storage: { jsonlPath: 'last.jsonl' } },
      );
      expect(result.storage.jsonlPath).toBe('last.jsonl');
      expect(result.daemon.autoStart).toBe(false);
      expect(result.logging.level).toBe('debug');
    });

    it('handles null configs gracefully', () => {
      const result = mergeConfigs(
        { storage: { jsonlPath: 'test.jsonl' } },
        null as unknown as Record<string, unknown>,
        undefined as unknown as Record<string, unknown>,
        { logging: { level: 'warn' } },
      );
      expect(result.storage.jsonlPath).toBe('test.jsonl');
      expect(result.logging.level).toBe('warn');
    });

    it('validates final merged result', () => {
      // This should work because schema applies defaults
      const result = mergeConfigs({});
      expect(result.storage.autoCompactRatio).toBe(2.0);
      expect(result.daemon.flushInterval).toBe(1000);
    });

    it('merges provider configs correctly', () => {
      const result = mergeConfigs(
        { providers: { beads: { enabled: false } } },
        { providers: { claudeTasks: { enabled: false } } },
      );
      expect(result.providers.beads.enabled).toBe(false);
      expect(result.providers.claudeTasks.enabled).toBe(false);
    });
  });
});
