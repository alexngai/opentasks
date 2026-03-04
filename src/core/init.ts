/**
 * Auto-initialization for the global OpenTasks store (~/.opentasks/)
 *
 * Creates the directory, config.json, graph.jsonl, and .gitignore
 * on first use. Idempotent — skips if already initialized.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateLocationIdentity } from './location.js';

/**
 * Ensure the global store at ~/.opentasks/ is initialized.
 *
 * Creates the directory and minimal files (config.json, graph.jsonl, .gitignore)
 * if they don't exist. Idempotent — safe to call repeatedly.
 *
 * @param name - Optional name for the location identity (default: 'global')
 * @returns The absolute path to ~/.opentasks/
 */
export function ensureGlobalStoreInitialized(name?: string): string {
  const globalDir = process.env.OPENTASKS_HOME || path.join(os.homedir(), '.opentasks');
  const configPath = path.join(globalDir, 'config.json');

  // Already initialized — return early
  if (fs.existsSync(configPath)) {
    return globalDir;
  }

  // Create directory
  fs.mkdirSync(globalDir, { recursive: true });

  // Generate location identity
  const identity = generateLocationIdentity(globalDir, name ?? 'global');

  // Write config.json
  const config = {
    version: '1.0',
    location: {
      hash: identity.hash,
      uuid: identity.uuid,
      name: identity.name,
    },
    connections: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Create empty graph.jsonl
  const graphPath = path.join(globalDir, 'graph.jsonl');
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, '', 'utf-8');
  }

  // Create .gitignore for ephemeral files
  const gitignorePath = path.join(globalDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      ['cache.db', 'cache.db-wal', 'cache.db-shm', 'write.lock', 'daemon.sock', 'daemon.lock', ''].join('\n'),
      'utf-8',
    );
  }

  return globalDir;
}
