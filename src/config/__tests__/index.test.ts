import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, getDefaults, parseEnvConfig, validateConfig, mergeConfigs } from '../index.js';

describe('Config Public API', () => {
  let tempDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-config-api-test-'));
    // Clear any OPENTASKS_ env vars
    process.env = { ...originalEnv };
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith('OPENTASKS_')) {
        delete process.env[key];
      }
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    const configDir = path.join(tempDir, '.opentasks');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'config.json'), content);
  }

  describe('loadConfig', () => {
    it('works with no arguments (uses cwd)', async () => {
      // This test just verifies the function runs without error
      // Since we can't control cwd easily, we test with explicit location instead
      const config = await loadConfig(tempDir);
      expect(config).toBeDefined();
      expect(config.storage.jsonlPath).toBe('graph.jsonl');
    });

    it('uses specified location', async () => {
      await writeConfig(
        JSON.stringify({
          storage: { jsonlPath: 'custom.jsonl' },
        }),
      );

      const config = await loadConfig(tempDir);
      expect(config.storage.jsonlPath).toBe('custom.jsonl');
    });

    it('uses defaults when no config file exists', async () => {
      const config = await loadConfig(tempDir);
      expect(config.storage.jsonlPath).toBe('graph.jsonl');
      expect(config.daemon.autoStart).toBe(true);
      expect(config.logging.level).toBe('info');
    });

    it('merges file config with defaults', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { level: 'debug' },
        }),
      );

      const config = await loadConfig(tempDir);
      expect(config.logging.level).toBe('debug');
      expect(config.storage.jsonlPath).toBe('graph.jsonl'); // default
    });

    it('env vars override file config', async () => {
      await writeConfig(
        JSON.stringify({
          logging: { level: 'debug' },
        }),
      );

      process.env.OPENTASKS_LOGGING_LEVEL = 'error';

      const config = await loadConfig(tempDir);
      expect(config.logging.level).toBe('error'); // env overrides file
    });

    it('env vars override defaults when no file', async () => {
      process.env.OPENTASKS_DAEMON_AUTO_START = 'false';
      process.env.OPENTASKS_STORAGE_JSONL_PATH = 'env.jsonl';

      const config = await loadConfig(tempDir);
      expect(config.daemon.autoStart).toBe(false);
      expect(config.storage.jsonlPath).toBe('env.jsonl');
    });

    it('complete hierarchy: defaults -> file -> env', async () => {
      await writeConfig(
        JSON.stringify({
          storage: { jsonlPath: 'file.jsonl', sqlitePath: 'file.db' },
          daemon: { autoStart: false },
        }),
      );

      process.env.OPENTASKS_STORAGE_JSONL_PATH = 'env.jsonl';
      process.env.OPENTASKS_LOGGING_LEVEL = 'warn';

      const config = await loadConfig(tempDir);

      // From env (highest priority)
      expect(config.storage.jsonlPath).toBe('env.jsonl');
      expect(config.logging.level).toBe('warn');

      // From file
      expect(config.storage.sqlitePath).toBe('file.db');
      expect(config.daemon.autoStart).toBe(false);

      // From defaults
      expect(config.daemon.flushInterval).toBe(1000);
      expect(config.providers.beads.enabled).toBe(true);
    });
  });

  describe('exports', () => {
    it('exports getDefaults', () => {
      const defaults = getDefaults();
      expect(defaults.storage.jsonlPath).toBe('graph.jsonl');
    });

    it('exports parseEnvConfig', () => {
      const envConfig = parseEnvConfig({
        OPENTASKS_LOGGING_LEVEL: 'debug',
      });
      expect(envConfig.logging?.level).toBe('debug');
    });

    it('exports validateConfig', () => {
      const result = validateConfig({});
      expect(result.success).toBe(true);
    });

    it('exports mergeConfigs', () => {
      const merged = mergeConfigs(
        { storage: { jsonlPath: 'a.jsonl' } },
        { storage: { sqlitePath: 'b.db' } },
      );
      expect(merged.storage.jsonlPath).toBe('a.jsonl');
      expect(merged.storage.sqlitePath).toBe('b.db');
    });
  });
});
