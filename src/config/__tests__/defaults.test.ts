import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, getDefaults } from '../defaults.js';

describe('Config Defaults', () => {
  describe('DEFAULT_CONFIG', () => {
    it('has complete config with all defaults', () => {
      expect(DEFAULT_CONFIG.storage).toBeDefined();
      expect(DEFAULT_CONFIG.daemon).toBeDefined();
      expect(DEFAULT_CONFIG.providers).toBeDefined();
      expect(DEFAULT_CONFIG.logging).toBeDefined();
    });

    it('has correct storage defaults', () => {
      expect(DEFAULT_CONFIG.storage.jsonlPath).toBe('graph.jsonl');
      expect(DEFAULT_CONFIG.storage.sqlitePath).toBe('cache.db');
      expect(DEFAULT_CONFIG.storage.autoCompactRatio).toBe(2.0);
    });

    it('has correct daemon defaults', () => {
      expect(DEFAULT_CONFIG.daemon.socketPath).toBe('daemon.sock');
      expect(DEFAULT_CONFIG.daemon.autoStart).toBe(true);
      expect(DEFAULT_CONFIG.daemon.flushInterval).toBe(1000);
    });

    it('has correct beads provider defaults', () => {
      expect(DEFAULT_CONFIG.providers.beads.enabled).toBe(true);
      expect(DEFAULT_CONFIG.providers.beads.executable).toBe('bd');
      expect(DEFAULT_CONFIG.providers.beads.timeout).toBe(30000);
    });

    it('has correct claudeTasks provider defaults', () => {
      expect(DEFAULT_CONFIG.providers.claudeTasks.enabled).toBe(true);
    });

    it('has correct logging defaults', () => {
      expect(DEFAULT_CONFIG.logging.level).toBe('info');
      expect(DEFAULT_CONFIG.logging.file).toBeNull();
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    });
  });

  describe('getDefaults', () => {
    it('returns complete config', () => {
      const defaults = getDefaults();
      expect(defaults.storage.jsonlPath).toBe('graph.jsonl');
      expect(defaults.daemon.autoStart).toBe(true);
      expect(defaults.providers.beads.enabled).toBe(true);
      expect(defaults.logging.level).toBe('info');
    });

    it('returns the same frozen object', () => {
      const defaults1 = getDefaults();
      const defaults2 = getDefaults();
      expect(defaults1).toBe(defaults2);
      expect(Object.isFrozen(defaults1)).toBe(true);
    });

    it('returns object equal to DEFAULT_CONFIG', () => {
      const defaults = getDefaults();
      expect(defaults).toEqual(DEFAULT_CONFIG);
    });
  });
});
