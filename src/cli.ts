#!/usr/bin/env node

/**
 * OpenTasks CLI
 *
 * Command-line interface for OpenTasks.
 * Phase 2 additions: init, connect, disconnect, connections
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateLocationIdentity } from './core/location.js';
import { ensureGlobalStoreInitialized } from './core/init.js';
import { createConnection, checkAllConnectionHealth, type Connection } from './core/connections.js';
import {
  worktreeSetup,
  worktreeTeardown,
  listWorktrees,
  getGitCommonDir,
} from './core/worktree.js';
import { mergeJsonl, installMergeDriver } from './core/merge-driver.js';
import { discoverLocations } from './core/discover.js';
import { OpenTasksClient } from './client/client.js';
import { createDaemonWithStore, createMultiLocationDaemonFromGit, checkExistingDaemon } from './daemon/index.js';
import { VERSION } from './version.js';

const OPENTASKS_DIR = '.opentasks';
const SWARM_OPENTASKS_DIR = '.swarm/opentasks';
const CONFIG_FILE = 'config.json';

/**
 * Resolve the project-level opentasks directory.
 * Priority: OPENTASKS_PROJECT_DIR env var > .swarm/opentasks > .opentasks
 */
function resolveProjectDir(baseDir: string = process.cwd()): string {
  const envDir = process.env.OPENTASKS_PROJECT_DIR;
  if (envDir) return path.resolve(baseDir, envDir);
  const swarmDir = path.resolve(baseDir, SWARM_OPENTASKS_DIR);
  if (fs.existsSync(swarmDir)) return swarmDir;
  return path.resolve(baseDir, OPENTASKS_DIR);
}

function printHelp() {
  console.log(`
opentasks v${VERSION}

Usage:
  opentasks <command> [options]

Tool commands (auto-start the daemon if needed; --no-autostart to opt out):
  link    --from <id> --to <id> --type <type> [--remove] [--metadata <json>]
  query   <json>                Query the graph (pass QueryParams as JSON)
  annotate <json>               Manage feedback (pass AnnotateParams as JSON)
  create  --type <type> --title <title> [options]
  get     <id>                  Get a node by ID
  update  <id> [options]        Update a node
  delete  <id> [--hard]         Delete a node
  context-summary [options]     Get context summary breadcrumbs for session continuity
  claim   <id> --agent <id> [--duration <ms>] [--force]      Atomically claim a task (lease)
  claim-next --agent <id> [--duration <ms>]                  Claim the next ready, unclaimed task
  release <id> --agent <id> [--fence <n>]                    Release a claim
  renew   <id> --agent <id> [--duration <ms>] [--fence <n>]  Renew/extend a claim's lease

Views (compact, human-readable; --json for raw, --limit <n>, default ${DEFAULT_LIST_LIMIT}):
  ready   [--tags a,b]           Unblocked tasks ready to work on
  list    [--type <t>] [--status <s>] [--tags a,b] [--all]   Tasks (closed hidden unless --all)
  blocked                        Open tasks waiting on an unresolved blocker
  tree    <id>                   A task and its blocker dependency tree
  cleanup [--older-than-days <n>] [--dry-run]   Archive terminal tasks older than n days (default 30)

Create options:
  --status <s>                  Status (required for tasks)
  --content <text>              Markdown content
  --uri <uri>                   External URI (for external nodes)
  --source <src>                Source system (for external nodes)
  --tags <t1,t2>                Comma-separated tags
  --priority <n>                Priority 0-4
  --parent <id>                 Parent node ID
  --metadata <json>             Additional metadata as JSON

Update options:
  --title <t>                   Update title
  --status <s>                  Update status
  --archived                    Archive the node
  --metadata <json>             Update metadata (merged)

Context-summary options:
  --task <id>                   Find context related to a specific task
  --tags <t1,t2>                Filter by tags
  --branch <name>               Filter by branch
  --limit <n>                   Max breadcrumbs per section (default: 10)

Daemon commands:
  daemon start [--foreground]   Start the daemon (detaches by default)
  daemon stop                   Stop a running daemon
  daemon status                 Show daemon status

Setup commands:
  init [--name <name>] [--global] [--no-merge-driver] Initialize .opentasks
  connect <path> [--role <role>] Connect to another location
  disconnect <hash>             Disconnect from a location
  connections                   List connections with health status
  worktree setup <path> [opts]  Setup a new worker worktree
  worktree list                 List registered worktrees
  worktree teardown <path|hash> Teardown a worktree
  discover [options]            Find nearby opentasks locations
  merge-driver <O> <A> <B>     JSONL merge driver (for git)

Archive commands (require running daemon with archival enabled):
  archive list [--graph <id>] [--source <src>]   List archived sessions
  archive restore <uri>                          Restore a node from archive
  archive restore --all                          Restore all missing nodes
  archive push                                   Push archive to remote
  archive status                                 Show archive status
  archive node <uri>                             Manually archive a node

Skill tracking commands (require running daemon):
  skills <session-id>                            Get skill usage for a session
  skills --all                                   Get skill usage for all sessions
  skills --end <session-id>                      End tracking and get final summary

MCP server:
  mcp [--socket <path>] [--scope <scopes>]       Start MCP server (stdio transport)
                                                  Scopes: tasks (default), graph, annotate, context, all
                                                  Example: --scope tasks,graph  or  --scope all

All tool commands output JSON to stdout.
`);
}

/**
 * Read config.json from .opentasks directory
 */
function readConfig(opentasksDir: string): Record<string, unknown> {
  const configPath = path.join(opentasksDir, CONFIG_FILE);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write config.json to .opentasks directory
 */
function writeConfig(opentasksDir: string, config: Record<string, unknown>): void {
  const configPath = path.join(opentasksDir, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Initialize .opentasks directory with location identity
 */
function cmdInit(args: string[]): void {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex !== -1 ? args[nameIndex + 1] : undefined;
  const isGlobal = args.includes('--global');

  // Global init delegates to the shared utility
  if (isGlobal) {
    ensureGlobalStoreInitialized(name ?? 'global');
    const globalDir = path.join(os.homedir(), '.opentasks');
    const config = readConfig(globalDir);
    const loc = config.location as Record<string, string>;
    console.log('Initialized ~/.opentasks/ (global)');
    console.log(`  hash: ${loc.hash}`);
    console.log(`  uuid: ${loc.uuid}`);
    console.log(`  name: ${loc.name}`);
    return;
  }

  // Check if already initialized (either layout)
  const existingDir = resolveProjectDir();
  const existingConfig = readConfig(existingDir);
  if (existingConfig.location) {
    console.log('Location already initialized:');
    const loc = existingConfig.location as Record<string, string>;
    console.log(`  hash: ${loc.hash}`);
    console.log(`  uuid: ${loc.uuid}`);
    console.log(`  name: ${loc.name}`);
    return;
  }

  // Determine target directory (env var override or default)
  const opentasksDir = resolveProjectDir();

  // Create directory if it doesn't exist
  fs.mkdirSync(opentasksDir, { recursive: true });

  // Read existing config
  const config = readConfig(opentasksDir);

  // Generate location identity
  const identity = generateLocationIdentity(opentasksDir, name);

  config.version = '1.0';
  config.location = {
    hash: identity.hash,
    uuid: identity.uuid,
    name: identity.name,
  };

  if (!config.connections) {
    config.connections = [];
  }

  writeConfig(opentasksDir, config);

  // Create graph.jsonl if it doesn't exist
  const graphPath = path.join(opentasksDir, 'graph.jsonl');
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, '', 'utf-8');
  }

  // Create .gitignore for ephemeral files
  const gitignorePath = path.join(opentasksDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      [
        'cache.db',
        'cache.db-wal',
        'cache.db-shm',
        'write.lock',
        'daemon.sock',
        'daemon.lock',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  console.log('Initialized .opentasks/');
  console.log(`  hash: ${identity.hash}`);
  console.log(`  uuid: ${identity.uuid}`);
  console.log(`  name: ${identity.name}`);
}

/**
 * Connect to another OpenTasks location
 */
function cmdConnect(args: string[]): void {
  const targetPath = args[0];
  if (!targetPath) {
    console.error('Usage: opentasks connect <path> [--role <role>]');
    process.exit(1);
  }

  const roleIndex = args.indexOf('--role');
  const role = roleIndex !== -1 ? (args[roleIndex + 1] as 'peer' | 'parent' | 'child') : 'peer';

  const opentasksDir = resolveProjectDir();

  if (!fs.existsSync(path.join(opentasksDir, CONFIG_FILE))) {
    console.error('Not initialized. Run `opentasks init` first.');
    process.exit(1);
  }

  try {
    const connection = createConnection(path.resolve(targetPath), role, opentasksDir);

    const config = readConfig(opentasksDir);
    const connections = (config.connections || []) as Connection[];

    // Check for existing connection with same hash
    const existing = connections.find((c) => c.hash === connection.hash);
    if (existing) {
      console.log(`Updated connection: ${connection.name} (${connection.hash})`);
    } else {
      console.log(`Connected: ${connection.name} (${connection.hash})`);
    }

    // Add/update connection
    const updated = connections.filter((c) => c.hash !== connection.hash);
    updated.push(connection);
    config.connections = updated;

    // Auto-enable global provider for parent connections
    if (role === 'parent') {
      const resolvedTarget = path.resolve(targetPath);
      if (!config.providers) config.providers = {};
      const providers = config.providers as Record<string, unknown>;
      if (!providers.global) providers.global = {};
      const globalConfig = providers.global as Record<string, unknown>;
      globalConfig.enabled = true;
      globalConfig.path = resolvedTarget;
    }

    writeConfig(opentasksDir, config);

    console.log(`  path: ${connection.path}`);
    console.log(`  role: ${connection.role}`);
    if (role === 'parent') {
      console.log(`  global provider: enabled (path: ${path.resolve(targetPath)})`);
    }
  } catch (error) {
    console.error(`Failed to connect: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Disconnect from a location
 */
function cmdDisconnect(args: string[]): void {
  const hash = args[0];
  if (!hash) {
    console.error('Usage: opentasks disconnect <hash>');
    process.exit(1);
  }

  const opentasksDir = resolveProjectDir();
  const config = readConfig(opentasksDir);
  const connections = (config.connections || []) as Connection[];

  const found = connections.find((c) => c.hash === hash);
  if (!found) {
    console.error(`No connection with hash: ${hash}`);
    process.exit(1);
  }

  config.connections = connections.filter((c) => c.hash !== hash);
  writeConfig(opentasksDir, config);

  console.log(`Disconnected: ${found.name} (${hash})`);
}

/**
 * List connections with health status
 */
function cmdConnections(): void {
  const opentasksDir = resolveProjectDir();
  const config = readConfig(opentasksDir);
  const connections = (config.connections || []) as Connection[];

  if (connections.length === 0) {
    console.log('No connections.');
    return;
  }

  const statuses = checkAllConnectionHealth(connections, opentasksDir);

  // Header
  console.log(
    padRight('HASH', 12) +
      padRight('NAME', 20) +
      padRight('PATH', 40) +
      padRight('ROLE', 10) +
      'STATUS',
  );

  for (const status of statuses) {
    const { connection, health } = status;
    console.log(
      padRight(connection.hash, 12) +
        padRight(connection.name, 20) +
        padRight(connection.path, 40) +
        padRight(connection.role, 10) +
        health,
    );
  }
}

/**
 * Setup a new worktree
 */
function cmdWorktreeSetup(args: string[]): void {
  const targetPath = args[0];
  if (!targetPath) {
    console.error(
      'Usage: opentasks worktree setup <path> [--branch <name>] [--role <role>] [--redirect-to <target>] [--no-git-worktree]',
    );
    process.exit(1);
  }

  const opentasksDir = resolveProjectDir();
  if (!fs.existsSync(path.join(opentasksDir, CONFIG_FILE))) {
    console.error('Not initialized. Run `opentasks init` first.');
    process.exit(1);
  }

  const branchIndex = args.indexOf('--branch');
  const roleIndex = args.indexOf('--role');
  const redirectIndex = args.indexOf('--redirect-to');
  const noGitWorktree = args.includes('--no-git-worktree');

  try {
    const entry = worktreeSetup(targetPath, opentasksDir, {
      branch: branchIndex !== -1 ? args[branchIndex + 1] : undefined,
      role: roleIndex !== -1 ? (args[roleIndex + 1] as 'manager' | 'worker') : undefined,
      redirectTo: redirectIndex !== -1 ? args[redirectIndex + 1] : undefined,
      noGitWorktree,
    });

    console.log(`Worktree setup complete:`);
    console.log(`  path:   ${entry.path}`);
    console.log(`  hash:   ${entry.hash}`);
    console.log(`  role:   ${entry.role}`);
    console.log(`  branch: ${entry.branch || '(none)'}`);
    if (entry.redirectTarget) {
      console.log(`  redirect: → ${entry.redirectTarget}`);
    }
  } catch (error) {
    console.error(`Failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * List registered worktrees
 */
function cmdWorktreeList(): void {
  const gitCommonDir = getGitCommonDir(process.cwd());
  if (!gitCommonDir) {
    console.error('Not in a git repository.');
    process.exit(1);
  }

  const worktrees = listWorktrees(gitCommonDir);

  if (worktrees.length === 0) {
    console.log('No registered worktrees.');
    return;
  }

  console.log(
    padRight('HASH', 12) +
      padRight('PATH', 40) +
      padRight('BRANCH', 20) +
      padRight('ROLE', 12) +
      'STATUS',
  );

  for (const wt of worktrees) {
    console.log(
      padRight(wt.hash, 12) +
        padRight(wt.path, 40) +
        padRight(wt.branch || '(none)', 20) +
        padRight(wt.role, 12) +
        wt.status,
    );
  }
}

/**
 * Teardown a worktree
 */
function cmdWorktreeTeardown(args: string[]): void {
  const pathOrHash = args[0];
  if (!pathOrHash) {
    console.error(
      'Usage: opentasks worktree teardown <path-or-hash> [--remove-git-worktree] [--keep-data]',
    );
    process.exit(1);
  }

  const opentasksDir = resolveProjectDir();

  try {
    const entry = worktreeTeardown(pathOrHash, opentasksDir, {
      removeGitWorktree: args.includes('--remove-git-worktree'),
      keepData: args.includes('--keep-data'),
    });

    if (entry) {
      console.log(`Worktree torn down: ${entry.hash} (${entry.path})`);
    }
  } catch (error) {
    console.error(`Failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * JSONL merge driver (called by git)
 */
function cmdMergeDriver(args: string[]): void {
  const [basePath, oursPath, theirsPath] = args;
  if (!basePath || !oursPath || !theirsPath) {
    console.error('Usage: opentasks merge-driver <base> <ours> <theirs>');
    process.exit(1);
  }

  try {
    const exitCode = mergeJsonl(basePath, oursPath, theirsPath);
    process.exit(exitCode);
  } catch (error) {
    console.error(`Merge failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Discover nearby opentasks locations
 */
function cmdDiscover(args: string[]): void {
  const dirIndex = args.indexOf('--direction');
  const direction = dirIndex !== -1 ? (args[dirIndex + 1] as 'up' | 'down' | 'both') : 'both';

  const depthIndex = args.indexOf('--max-depth');
  const maxDepth = depthIndex !== -1 ? parseInt(args[depthIndex + 1], 10) : 5;

  if (!['up', 'down', 'both'].includes(direction)) {
    console.error(`Invalid direction: ${direction}. Use up, down, or both.`);
    process.exit(1);
  }

  const locations = discoverLocations(process.cwd(), { direction, maxDepth });

  if (locations.length === 0) {
    console.log('No opentasks locations found.');
    return;
  }

  console.log(
    padRight('HASH', 12) +
      padRight('NAME', 20) +
      padRight('PATH', 50) +
      padRight('DIR', 8) +
      'DEPTH',
  );

  for (const loc of locations) {
    console.log(
      padRight(loc.hash, 12) +
        padRight(loc.name || '(unnamed)', 20) +
        padRight(loc.opentasksPath, 50) +
        padRight(loc.direction, 8) +
        String(loc.depth),
    );
  }
}

// ============================================================================
// Daemon Commands
// ============================================================================

/** Resolve the path to this CLI entrypoint (dist/cli.js) for re-spawning. */
function cliEntrypoint(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * Spawn a detached daemon process (`daemon start --foreground`) and let it
 * outlive this process. The child inherits cwd + env so it resolves the same
 * project as the parent.
 */
function spawnDetachedDaemon(): void {
  const child = spawn(process.execPath, [cliEntrypoint(), 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/** Sleep helper for poll loops. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the daemon for `opentasksDir` reports running, or throw on timeout.
 */
async function waitForDaemon(opentasksDir: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const existing = await checkExistingDaemon(opentasksDir);
    if (existing.running) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Daemon did not start within ${timeoutMs}ms`);
    }
    await delay(100);
  }
}

/**
 * Ensure a daemon is running for `opentasksDir`, auto-starting one if needed
 * (4.1). Auto-start is on by default; opt out with `--no-autostart` or
 * `OPENTASKS_NO_AUTOSTART=1`. When auto-start is disabled and no daemon is
 * running, this is a no-op — the subsequent client connect surfaces a clear
 * "not connected" error.
 */
async function ensureDaemonRunning(
  opentasksDir: string,
  options: { autostart: boolean } = { autostart: true },
): Promise<void> {
  const existing = await checkExistingDaemon(opentasksDir);
  if (existing.running) return;
  if (!options.autostart) return;

  process.stderr.write('opentasks: no daemon running — starting one…\n');
  spawnDetachedDaemon();
  try {
    await waitForDaemon(opentasksDir);
    const started = await checkExistingDaemon(opentasksDir);
    process.stderr.write(`opentasks: daemon started (pid ${started.pid ?? '?'})\n`);
  } catch (error) {
    process.stderr.write(
      `opentasks: daemon auto-start failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Start the daemon process.
 *
 * Detaches by default and returns once the daemon is accepting connections.
 * Pass `--foreground` to run it in the foreground (used by the detached child
 * and by callers that manage the lifecycle themselves).
 */
async function cmdDaemonStart(args: string[]): Promise<void> {
  const opentasksDir = resolveProjectDir();

  if (!fs.existsSync(path.join(opentasksDir, CONFIG_FILE))) {
    // Auto-init if the directory doesn't exist yet
    fs.mkdirSync(opentasksDir, { recursive: true });
    const graphPath = path.join(opentasksDir, 'graph.jsonl');
    if (!fs.existsSync(graphPath)) {
      fs.writeFileSync(graphPath, '', 'utf-8');
    }
  }

  // Check if already running
  const existing = await checkExistingDaemon(opentasksDir);
  if (existing.running) {
    console.log(JSON.stringify({
      status: 'already_running',
      pid: existing.pid,
      socketPath: existing.socketPath,
    }));
    return;
  }

  // Detach by default (4.2): re-spawn ourselves in the foreground, wait until
  // the daemon is accepting connections, then report and return. `--foreground`
  // runs the blocking daemon loop in-process.
  if (!args.includes('--foreground')) {
    spawnDetachedDaemon();
    await waitForDaemon(opentasksDir);
    const started = await checkExistingDaemon(opentasksDir);
    console.log(JSON.stringify({
      status: 'started',
      detached: true,
      pid: started.pid,
      socketPath: started.socketPath,
    }));
    return;
  }

  // Detect multi-location (git worktree) vs single-location mode
  const gitCommonDir = getGitCommonDir(path.dirname(opentasksDir));
  const version = VERSION;

  let daemon;
  if (gitCommonDir) {
    daemon = createMultiLocationDaemonFromGit({
      gitCommonDir,
      version,
      primaryLocationPath: opentasksDir,
    });
  } else {
    daemon = await createDaemonWithStore({
      locationPath: opentasksDir,
      version,
    });
  }

  await daemon.start();

  console.log(JSON.stringify({
    status: 'started',
    pid: process.pid,
    socketPath: daemon.socketPath,
  }));

  // Keep the process alive until signaled
  // Signal handlers are set up inside daemon.start() — they call daemon.stop()
  // which will let the process exit naturally
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const status = daemon.getStatus();
      if (status.state === 'stopped') {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

/**
 * Stop a running daemon by sending shutdown via IPC
 */
async function cmdDaemonStop(): Promise<void> {
  const opentasksDir = resolveProjectDir();

  const existing = await checkExistingDaemon(opentasksDir);
  if (!existing.running) {
    console.log(JSON.stringify({ status: 'not_running' }));
    return;
  }

  // Connect to daemon and send shutdown
  const client = new OpenTasksClient();
  try {
    const result = await client.call('shutdown', {});
    client.disconnect();
    console.log(JSON.stringify({ status: 'stopped', ...result as Record<string, unknown> }));
  } catch (error) {
    client.disconnect();
    // If the connection was refused or reset, the daemon may have already stopped
    console.log(JSON.stringify({ status: 'stopped', note: 'daemon may have already exited' }));
  }
}

/**
 * Show daemon status
 */
async function cmdDaemonStatus(): Promise<void> {
  const opentasksDir = resolveProjectDir();

  const existing = await checkExistingDaemon(opentasksDir);
  if (!existing.running) {
    console.log(JSON.stringify({ status: 'not_running', locationPath: opentasksDir }));
    return;
  }

  // Connect and get full status
  const client = new OpenTasksClient();
  try {
    const result = await client.call('status', {});
    client.disconnect();
    console.log(JSON.stringify(result, null, 2));
  } catch {
    client.disconnect();
    console.log(JSON.stringify({
      status: 'unreachable',
      pid: existing.pid,
      socketPath: existing.socketPath,
    }));
  }
}

// ============================================================================
// Tool Commands (daemon-connected)
// ============================================================================

/**
 * Extract a flag value from args. Returns undefined if not present.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Run an async command, print JSON result, handle errors.
 */
async function runToolCommand(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  }
}

// ============================================================================
// Human-readable commands (token-light sugar over `query`) — P4 4.4
// ============================================================================

const DEFAULT_LIST_LIMIT = 50;
const TERMINAL_STATUSES = new Set(['closed', 'failed', 'abandoned']);

interface TaskRow {
  id: string;
  type?: string;
  title?: string;
  status?: string;
  priority?: number;
}

/** One compact line per task — id, status, priority, truncated title. */
function printTaskRows(rows: TaskRow[], total: number, limit: number): void {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const shown = rows.slice(0, limit);
  for (const r of shown) {
    const id = (r.id ?? '').padEnd(10).slice(0, 10);
    const status = (r.status ?? '').padEnd(11).slice(0, 11);
    const pri = r.priority !== undefined ? `P${r.priority}` : '  ';
    const raw = r.title ?? '';
    const title = raw.length > 64 ? raw.slice(0, 63) + '…' : raw;
    console.log(`${id}  ${status} ${pri}  ${title}`);
  }
  const omitted = total - shown.length;
  if (omitted > 0) {
    console.log(`… ${omitted} more (showing ${shown.length} of ${total}; use --limit / --all)`);
  }
}

/** Run `fn` with a connected client; report errors as JSON; always disconnect. */
async function withClient(fn: (client: OpenTasksClient) => Promise<void>): Promise<void> {
  const client = new OpenTasksClient();
  try {
    await fn(client);
  } catch (error) {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  } finally {
    client.disconnect();
  }
}

export async function cmdReady(args: string[]): Promise<void> {
  const limit = Number(getFlag(args, '--limit') ?? DEFAULT_LIST_LIMIT);
  const tags = getFlag(args, '--tags')?.split(',').map((s) => s.trim());
  const json = hasFlag(args, '--json');
  await withClient(async (client) => {
    const result = (await client.query({ ready: { limit, tags } })) as {
      items?: TaskRow[];
      total?: number;
    };
    const items = result.items ?? [];
    if (json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    printTaskRows(items, result.total ?? items.length, limit);
  });
}

export async function cmdList(args: string[]): Promise<void> {
  const type = getFlag(args, '--type');
  const status = getFlag(args, '--status');
  const tags = getFlag(args, '--tags')?.split(',').map((s) => s.trim());
  const all = hasFlag(args, '--all');
  const limit = Number(getFlag(args, '--limit') ?? DEFAULT_LIST_LIMIT);
  const json = hasFlag(args, '--json');
  await withClient(async (client) => {
    const nodes: Record<string, unknown> = { archived: false };
    if (type) nodes.type = type;
    if (status) nodes.status = status;
    if (tags) nodes.tags = tags;
    const result = (await client.query({ nodes })) as { items?: TaskRow[] };
    let items = result.items ?? [];
    // Hide terminal (closed/failed/abandoned) tasks by default; --all or an
    // explicit --status overrides.
    if (!all && !status) {
      items = items.filter((i) => !TERMINAL_STATUSES.has(i.status ?? ''));
    }
    if (json) {
      console.log(JSON.stringify(items.slice(0, limit), null, 2));
      return;
    }
    printTaskRows(items, items.length, limit);
  });
}

export async function cmdBlocked(args: string[]): Promise<void> {
  const limit = Number(getFlag(args, '--limit') ?? DEFAULT_LIST_LIMIT);
  const json = hasFlag(args, '--json');
  await withClient(async (client) => {
    const [active, ready] = await Promise.all([
      client.query({ nodes: { type: 'task', archived: false } }) as Promise<{ items?: TaskRow[] }>,
      client.query({ ready: { limit: 100_000 } }) as Promise<{ items?: TaskRow[] }>,
    ]);
    const readyIds = new Set((ready.items ?? []).map((i) => i.id));
    // An open/blocked task that isn't in the ready set is waiting on a blocker.
    const blocked = (active.items ?? []).filter(
      (i) => (i.status === 'open' || i.status === 'blocked') && !readyIds.has(i.id),
    );
    if (json) {
      console.log(JSON.stringify(blocked, null, 2));
      return;
    }
    printTaskRows(blocked, blocked.length, limit);
  });
}

export async function cmdCleanup(args: string[]): Promise<void> {
  const ttlDays = Number(getFlag(args, '--older-than-days') ?? 30);
  const dryRun = hasFlag(args, '--dry-run');
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  await withClient(async (client) => {
    // Terminal, not-yet-archived tasks are the cleanup candidates.
    const result = (await client.query({
      nodes: { type: 'task', status: ['closed', 'failed', 'abandoned'], archived: false },
    })) as { items?: TaskRow[] };
    const candidates = result.items ?? [];

    // NodeSummary carries no timestamp, so fetch each candidate to check age.
    const stale: Array<{ id: string; title?: string; status?: string; ts: string }> = [];
    for (const c of candidates) {
      const full = (await client.getNode(c.id)) as
        | { updated_at?: string; created_at?: string }
        | null;
      const ts = full?.updated_at ?? full?.created_at;
      if (ts && new Date(ts).getTime() <= cutoff) {
        stale.push({ id: c.id, title: c.title, status: c.status, ts });
      }
    }

    if (dryRun) {
      console.log(
        JSON.stringify(
          { dryRun: true, olderThanDays: ttlDays, wouldArchive: stale.length, tasks: stale },
          null,
          2,
        ),
      );
      return;
    }

    for (const t of stale) {
      await client.updateNode(t.id, { archived: true });
    }
    console.log(JSON.stringify({ archived: stale.length, olderThanDays: ttlDays }, null, 2));
  });
}

export async function cmdTree(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: opentasks tree <id> [--json]');
    process.exit(1);
  }
  const json = hasFlag(args, '--json');
  await withClient(async (client) => {
    const root = (await client.getNode(id)) as TaskRow | null;
    if (!root) {
      console.error(JSON.stringify({ error: `Not found: ${id}` }));
      process.exitCode = 1;
      return;
    }
    // Walk the blocker tree (what this task depends on), depth-limited + cycle-safe.
    const lines: string[] = [];
    const seen = new Set<string>();
    async function walk(node: TaskRow, depth: number): Promise<void> {
      const indent = '  '.repeat(depth);
      const marker = depth === 0 ? '' : '↳ ';
      lines.push(`${indent}${marker}${node.id}  [${node.status ?? '?'}]  ${node.title ?? ''}`);
      if (seen.has(node.id) || depth >= 6) return;
      seen.add(node.id);
      const blockers = (await client.blockers(node.id)) as unknown as TaskRow[];
      for (const b of blockers) {
        await walk(b, depth + 1);
      }
    }
    await walk(root, 0);
    if (json) {
      console.log(JSON.stringify({ root: id, tree: lines }, null, 2));
      return;
    }
    console.log(lines.join('\n'));
  });
}

export async function cmdLink(args: string[]): Promise<void> {
  const fromId = getFlag(args, '--from');
  const toId = getFlag(args, '--to');
  const type = getFlag(args, '--type');
  const remove = hasFlag(args, '--remove');
  const metadataStr = getFlag(args, '--metadata');

  if (!fromId || !toId || !type) {
    console.error(
      'Usage: opentasks link --from <id> --to <id> --type <type> [--remove] [--metadata <json>]',
    );
    process.exit(1);
  }

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const params: Record<string, unknown> = { fromId, toId, type };
    if (remove) params.remove = true;
    if (metadataStr) params.metadata = JSON.parse(metadataStr);
    const result = await client.link(params as never);
    client.disconnect();
    return result;
  });
}

export async function cmdQuery(args: string[]): Promise<void> {
  const json = args[0];
  if (!json) {
    console.error("Usage: opentasks query '<json>'");
    console.error('Example: opentasks query \'{"ready":{}}\'');
    process.exit(1);
  }

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const params = JSON.parse(json);
    const result = await client.query(params);
    client.disconnect();
    return result;
  });
}

export async function cmdAnnotate(args: string[]): Promise<void> {
  const json = args[0];
  if (!json) {
    console.error("Usage: opentasks annotate '<json>'");
    console.error(
      'Example: opentasks annotate \'{"targetId":"s-a2b3","create":{"content":"...","type":"comment"}}\'',
    );
    process.exit(1);
  }

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const params = JSON.parse(json);
    const result = await client.annotate(params);
    client.disconnect();
    return result;
  });
}

export async function cmdClaim(args: string[]): Promise<void> {
  const id = args[0];
  const agentId = getFlag(args, '--agent');
  if (!id || id.startsWith('--') || !agentId) {
    console.error('Usage: opentasks claim <id> --agent <agentId> [--duration <ms>] [--force]');
    process.exit(1);
  }
  const durationStr = getFlag(args, '--duration');
  const claim: Record<string, unknown> = { id, agentId };
  if (durationStr) claim.durationMs = Number(durationStr);
  if (hasFlag(args, '--force')) claim.force = true;

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.task({ claim } as never);
    client.disconnect();
    return result;
  });
}

export async function cmdClaimNext(args: string[]): Promise<void> {
  const agentId = getFlag(args, '--agent');
  if (!agentId) {
    console.error('Usage: opentasks claim-next --agent <agentId> [--duration <ms>]');
    process.exit(1);
  }
  const durationStr = getFlag(args, '--duration');
  const claimNext: Record<string, unknown> = { agentId };
  if (durationStr) claimNext.durationMs = Number(durationStr);

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.task({ claimNext } as never);
    client.disconnect();
    return result;
  });
}

export async function cmdRelease(args: string[]): Promise<void> {
  const id = args[0];
  const agentId = getFlag(args, '--agent');
  if (!id || id.startsWith('--') || !agentId) {
    console.error('Usage: opentasks release <id> --agent <agentId> [--fence <n>]');
    process.exit(1);
  }
  const fenceStr = getFlag(args, '--fence');
  const release: Record<string, unknown> = { id, agentId };
  if (fenceStr) release.fence = Number(fenceStr);

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.task({ release } as never);
    client.disconnect();
    return result;
  });
}

export async function cmdRenew(args: string[]): Promise<void> {
  const id = args[0];
  const agentId = getFlag(args, '--agent');
  if (!id || id.startsWith('--') || !agentId) {
    console.error('Usage: opentasks renew <id> --agent <agentId> [--duration <ms>] [--fence <n>]');
    process.exit(1);
  }
  const durationStr = getFlag(args, '--duration');
  const fenceStr = getFlag(args, '--fence');
  const renew: Record<string, unknown> = { id, agentId };
  if (durationStr) renew.durationMs = Number(durationStr);
  if (fenceStr) renew.fence = Number(fenceStr);

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.task({ renew } as never);
    client.disconnect();
    return result;
  });
}

export async function cmdCreate(args: string[]): Promise<void> {
  const type = getFlag(args, '--type');
  const title = getFlag(args, '--title');

  if (!type || !title) {
    console.error('Usage: opentasks create --type <type> --title <title> [options]');
    process.exit(1);
  }

  const params: Record<string, unknown> = { type, title };

  const status = getFlag(args, '--status');
  const content = getFlag(args, '--content');
  const uri = getFlag(args, '--uri');
  const source = getFlag(args, '--source');
  const tagsStr = getFlag(args, '--tags');
  const priorityStr = getFlag(args, '--priority');
  const parentId = getFlag(args, '--parent');
  const metadataStr = getFlag(args, '--metadata');

  if (status) params.status = status;
  if (content) params.content = content;
  if (uri) params.uri = uri;
  if (source) params.source = source;
  if (tagsStr) params.tags = tagsStr.split(',').map((t) => t.trim());
  if (priorityStr) params.priority = parseInt(priorityStr, 10);
  if (parentId) params.parent_id = parentId;
  if (metadataStr) params.metadata = JSON.parse(metadataStr);

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.createNode(params as never);
    client.disconnect();
    return result;
  });
}

export async function cmdGet(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: opentasks get <id>');
    process.exit(1);
  }

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.getNode(id);
    client.disconnect();
    return result;
  });
}

export async function cmdUpdate(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(
      'Usage: opentasks update <id> [--title <t>] [--status <s>] [--archived] [--metadata <json>]',
    );
    process.exit(1);
  }

  const rest = args.slice(1);
  const updates: Record<string, unknown> = {};

  const title = getFlag(rest, '--title');
  const status = getFlag(rest, '--status');
  const metadataStr = getFlag(rest, '--metadata');

  if (title) updates.title = title;
  if (status) updates.status = status;
  if (hasFlag(rest, '--archived')) updates.archived = true;
  if (metadataStr) updates.metadata = JSON.parse(metadataStr);

  if (Object.keys(updates).length === 0) {
    console.error('No updates specified. Use --title, --status, --archived, or --metadata.');
    process.exit(1);
  }

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.updateNode(id, updates as never);
    client.disconnect();
    return result;
  });
}

export async function cmdContextSummary(args: string[]): Promise<void> {
  const params: Record<string, unknown> = {};

  const taskId = getFlag(args, '--task');
  const tagsStr = getFlag(args, '--tags');
  const branch = getFlag(args, '--branch');
  const limitStr = getFlag(args, '--limit');

  if (taskId) params.taskId = taskId;
  if (tagsStr) params.tags = tagsStr.split(',').map((t) => t.trim());
  if (branch) params.branch = branch;
  if (limitStr) params.limit = parseInt(limitStr, 10);

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    const result = await client.contextSummary(params);
    client.disconnect();
    return result;
  });
}

export async function cmdDelete(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: opentasks delete <id> [--hard]');
    process.exit(1);
  }

  const hard = hasFlag(args, '--hard');

  const client = new OpenTasksClient();
  await runToolCommand(async () => {
    await client.deleteNode(id, hard ? { hard: true } : undefined);
    client.disconnect();
    return { success: true, id, hard };
  });
}

// ============================================================================
// Archive Commands
// ============================================================================

export async function cmdArchive(args: string[]): Promise<void> {
  const subCmd = args[0];
  const client = new OpenTasksClient();

  switch (subCmd) {
    case 'list': {
      const graphId = getFlag(args.slice(1), '--graph');
      const source = getFlag(args.slice(1), '--source');
      const filter: Record<string, unknown> = {};
      if (graphId) filter.graphId = graphId;
      if (source) filter.source = source;

      await runToolCommand(async () => {
        const result = await client.call('archive.list', { filter });
        client.disconnect();
        return result;
      });
      break;
    }

    case 'restore': {
      if (hasFlag(args, '--all')) {
        await runToolCommand(async () => {
          const result = await client.call('archive.rematerializeAll', {});
          client.disconnect();
          return result;
        });
      } else {
        const uri = args[1];
        if (!uri || uri.startsWith('--')) {
          console.error('Usage: opentasks archive restore <uri>');
          console.error('       opentasks archive restore --all');
          process.exit(1);
        }
        await runToolCommand(async () => {
          const result = await client.call('archive.rematerialize', { uri });
          client.disconnect();
          return result;
        });
      }
      break;
    }

    case 'push': {
      await runToolCommand(async () => {
        const result = await client.call('archive.push', {});
        client.disconnect();
        return result;
      });
      break;
    }

    case 'status': {
      await runToolCommand(async () => {
        const result = await client.call('archive.status', {});
        client.disconnect();
        return result;
      });
      break;
    }

    case 'node': {
      const uri = args[1];
      if (!uri) {
        console.error('Usage: opentasks archive node <uri>');
        process.exit(1);
      }
      await runToolCommand(async () => {
        const result = await client.call('archive.node', { uri });
        client.disconnect();
        return result;
      });
      break;
    }

    default:
      console.error(`Unknown archive command: ${subCmd}`);
      console.error('Available: list, restore, push, status, node');
      process.exit(1);
  }
}

// ============================================================================
// Skill Tracking Commands
// ============================================================================

export async function cmdSkills(args: string[]): Promise<void> {
  const client = new OpenTasksClient();

  if (hasFlag(args, '--all')) {
    // Get all active session skill summaries
    await runToolCommand(async () => {
      const result = await client.allSkillUsage();
      client.disconnect();
      return result;
    });
  } else if (hasFlag(args, '--end')) {
    // End tracking for a session
    const sessionId = getFlag(args, '--end');
    if (!sessionId) {
      console.error('Usage: opentasks skills --end <session-id>');
      process.exit(1);
    }
    await runToolCommand(async () => {
      const result = await client.endSkillTracking(sessionId);
      client.disconnect();
      return result;
    });
  } else {
    // Get skill usage for a specific session
    const sessionId = args[0];
    if (!sessionId || sessionId.startsWith('--')) {
      console.error('Usage: opentasks skills <session-id>');
      console.error('       opentasks skills --all');
      console.error('       opentasks skills --end <session-id>');
      process.exit(1);
    }
    await runToolCommand(async () => {
      const result = await client.skillUsage(sessionId);
      client.disconnect();
      return result;
    });
  }
}

// ============================================================================
// MCP Server Command
// ============================================================================

async function cmdMcp(args: string[]): Promise<void> {
  let socketPath: string | undefined;
  let scopeStr: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket' && args[i + 1]) {
      socketPath = args[++i];
    } else if (args[i] === '--scope' && args[i + 1]) {
      scopeStr = args[++i];
    }
  }

  // Auto-start the project daemon so a fresh MCP session works with zero manual
  // daemon management (4.1). Skip when an explicit `--socket` is given (the
  // daemon is externally managed) or auto-start is disabled. Notices go to
  // stderr so they don't corrupt the stdio JSON-RPC channel.
  if (!socketPath && process.env.OPENTASKS_NO_AUTOSTART !== '1') {
    await ensureDaemonRunning(resolveProjectDir(), { autostart: true });
  }

  const { startMCPServer, ALL_SCOPES } = await import('./mcp/index.js');
  const scopes = scopeStr === 'all'
    ? [...ALL_SCOPES]
    : scopeStr
      ? (scopeStr.split(',').map((s) => s.trim()) as Array<'tasks' | 'graph' | 'annotate' | 'context'>)
      : undefined;

  await startMCPServer({
    clientOptions: socketPath ? { socketPath } : undefined,
    scopes,
  });
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + '  ' : str + ' '.repeat(len - str.length);
}

/**
 * Commands that talk to the daemon. For these, `main` ensures a daemon is
 * running first (auto-starting one unless opted out).
 */
const DAEMON_COMMANDS = new Set([
  'link',
  'query',
  'annotate',
  'create',
  'get',
  'update',
  'delete',
  'context-summary',
  'claim',
  'claim-next',
  'release',
  'renew',
  'ready',
  'list',
  'tree',
  'blocked',
  'cleanup',
]);

async function main() {
  const rawArgs = process.argv.slice(2);
  // Global flag: strip it so per-command arg parsing isn't disturbed.
  const autostart =
    !rawArgs.includes('--no-autostart') && process.env.OPENTASKS_NO_AUTOSTART !== '1';
  const args = rawArgs.filter((a) => a !== '--no-autostart');
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    process.exit(0);
  }

  // Auto-start the daemon for commands that need it (4.1).
  if (DAEMON_COMMANDS.has(command)) {
    await ensureDaemonRunning(resolveProjectDir(), { autostart });
  }

  switch (command) {
    // Tool commands (async, require daemon)
    case 'link':
      await cmdLink(args.slice(1));
      break;
    case 'query':
      await cmdQuery(args.slice(1));
      break;
    case 'annotate':
      await cmdAnnotate(args.slice(1));
      break;
    case 'create':
      await cmdCreate(args.slice(1));
      break;
    case 'get':
      await cmdGet(args.slice(1));
      break;
    case 'update':
      await cmdUpdate(args.slice(1));
      break;
    case 'delete':
      await cmdDelete(args.slice(1));
      break;
    case 'context-summary':
      await cmdContextSummary(args.slice(1));
      break;
    case 'claim':
      await cmdClaim(args.slice(1));
      break;
    case 'claim-next':
      await cmdClaimNext(args.slice(1));
      break;
    case 'release':
      await cmdRelease(args.slice(1));
      break;
    case 'renew':
      await cmdRenew(args.slice(1));
      break;

    // Human-readable commands (sugar over query)
    case 'ready':
      await cmdReady(args.slice(1));
      break;
    case 'list':
      await cmdList(args.slice(1));
      break;
    case 'blocked':
      await cmdBlocked(args.slice(1));
      break;
    case 'tree':
      await cmdTree(args.slice(1));
      break;
    case 'cleanup':
      await cmdCleanup(args.slice(1));
      break;

    // Setup commands (sync, no daemon needed)
    case 'init': {
      const initArgs = args.slice(1);
      cmdInit(initArgs);
      if (!initArgs.includes('--no-merge-driver')) {
        try {
          installMergeDriver(resolveProjectDir());
        } catch {
          // Non-fatal
        }
      }
      break;
    }
    case 'connect':
      cmdConnect(args.slice(1));
      break;
    case 'disconnect':
      cmdDisconnect(args.slice(1));
      break;
    case 'connections':
      cmdConnections();
      break;
    case 'worktree':
      {
        const subCmd = args[1];
        switch (subCmd) {
          case 'setup':
            cmdWorktreeSetup(args.slice(2));
            break;
          case 'list':
            cmdWorktreeList();
            break;
          case 'teardown':
            cmdWorktreeTeardown(args.slice(2));
            break;
          default:
            console.error(`Unknown worktree command: ${subCmd}`);
            console.error('Available: setup, list, teardown');
            process.exit(1);
        }
      }
      break;
    case 'archive':
      await cmdArchive(args.slice(1));
      break;
    case 'skills':
      await cmdSkills(args.slice(1));
      break;
    case 'daemon':
      {
        const subCmd = args[1];
        switch (subCmd) {
          case 'start':
            await cmdDaemonStart(args.slice(2));
            break;
          case 'stop':
            await cmdDaemonStop();
            break;
          case 'status':
            await cmdDaemonStatus();
            break;
          default:
            console.error(`Unknown daemon command: ${subCmd}`);
            console.error('Available: start, stop, status');
            process.exit(1);
        }
      }
      break;
    case 'discover':
      cmdDiscover(args.slice(1));
      break;
    case 'merge-driver':
      cmdMergeDriver(args.slice(1));
      break;
    case 'mcp':
      await cmdMcp(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported for testing)
if (!process.env.VITEST) {
  main();
}
