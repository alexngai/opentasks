import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock os.homedir to point to temp directory
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof os;
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

import { ensureGlobalStoreInitialized } from '../init.js';

describe('ensureGlobalStoreInitialized', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-init-test-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates ~/.opentasks/ with all required files', () => {
    const result = ensureGlobalStoreInitialized();

    const globalDir = path.join(tmpDir, '.opentasks');
    expect(result).toBe(globalDir);
    expect(fs.existsSync(globalDir)).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'graph.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, '.gitignore'))).toBe(true);
  });

  it('creates config.json with location identity', () => {
    ensureGlobalStoreInitialized();

    const configPath = path.join(tmpDir, '.opentasks', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(config.version).toBe('1.0');
    expect(config.location).toBeDefined();
    expect(config.location.hash).toMatch(/^[a-z0-9]+$/);
    expect(config.location.uuid).toBeDefined();
    expect(config.location.name).toBe('global');
    expect(config.connections).toEqual([]);
  });

  it('uses custom name when provided', () => {
    ensureGlobalStoreInitialized('my-global');

    const configPath = path.join(tmpDir, '.opentasks', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(config.location.name).toBe('my-global');
  });

  it('creates empty graph.jsonl', () => {
    ensureGlobalStoreInitialized();

    const graphPath = path.join(tmpDir, '.opentasks', 'graph.jsonl');
    expect(fs.readFileSync(graphPath, 'utf-8')).toBe('');
  });

  it('creates .gitignore with ephemeral file patterns', () => {
    ensureGlobalStoreInitialized();

    const gitignorePath = path.join(tmpDir, '.opentasks', '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf-8');

    expect(content).toContain('cache.db');
    expect(content).toContain('daemon.sock');
    expect(content).toContain('daemon.lock');
    expect(content).toContain('write.lock');
  });

  it('is idempotent — does not overwrite existing config', () => {
    // First call
    ensureGlobalStoreInitialized();
    const configPath = path.join(tmpDir, '.opentasks', 'config.json');
    const firstConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const firstUuid = firstConfig.location.uuid;

    // Second call
    ensureGlobalStoreInitialized();
    const secondConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // UUID should be the same — config was not regenerated
    expect(secondConfig.location.uuid).toBe(firstUuid);
  });

  it('does not overwrite existing graph.jsonl with data', () => {
    // First call creates files
    ensureGlobalStoreInitialized();

    // Add data to graph.jsonl
    const graphPath = path.join(tmpDir, '.opentasks', 'graph.jsonl');
    fs.writeFileSync(graphPath, '{"type":"node","id":"i-test"}\n', 'utf-8');

    // Second call should not overwrite
    ensureGlobalStoreInitialized();
    expect(fs.readFileSync(graphPath, 'utf-8')).toBe('{"type":"node","id":"i-test"}\n');
  });

  it('returns the global directory path', () => {
    const result = ensureGlobalStoreInitialized();
    expect(result).toBe(path.join(tmpDir, '.opentasks'));
  });
});
