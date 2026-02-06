#!/usr/bin/env node

/**
 * OpenTasks CLI
 *
 * Command-line interface for OpenTasks.
 * Phase 2 additions: init, connect, disconnect, connections
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { generateLocationIdentity } from './core/location.js'
import { createConnection, checkAllConnectionHealth, type Connection } from './core/connections.js'
import { worktreeSetup, worktreeTeardown, listWorktrees, getGitCommonDir } from './core/worktree.js'
import { mergeJsonl, installMergeDriver } from './core/merge-driver.js'

const OPENTASKS_DIR = '.opentasks'
const CONFIG_FILE = 'config.json'

function printHelp() {
  console.log(`
opentasks v0.1.0

Usage:
  opentasks <command> [options]

Commands:
  help                          Show this help message
  init [--name <name>]          Initialize .opentasks in current directory
  connect <path> [--role <role>] Connect to another location
  disconnect <hash>             Disconnect from a location
  connections                   List connections with health status
  worktree setup <path> [opts]  Setup a new worker worktree
  worktree list                 List registered worktrees
  worktree teardown <path|hash> Teardown a worktree
  merge-driver <O> <A> <B>     JSONL merge driver (for git)

For programmatic usage, import from the opentasks package:
  import { OpenTasksClient, createClient } from 'opentasks'
`);
}

/**
 * Read config.json from .opentasks directory
 */
function readConfig(opentasksDir: string): Record<string, unknown> {
  const configPath = path.join(opentasksDir, CONFIG_FILE)
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

/**
 * Write config.json to .opentasks directory
 */
function writeConfig(opentasksDir: string, config: Record<string, unknown>): void {
  const configPath = path.join(opentasksDir, CONFIG_FILE)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/**
 * Initialize .opentasks directory with location identity
 */
function cmdInit(args: string[]): void {
  const nameIndex = args.indexOf('--name')
  const name = nameIndex !== -1 ? args[nameIndex + 1] : undefined

  const opentasksDir = path.resolve(OPENTASKS_DIR)

  // Create directory if it doesn't exist
  fs.mkdirSync(opentasksDir, { recursive: true })

  // Read existing config
  const config = readConfig(opentasksDir)

  // Check if already initialized
  if (config.location) {
    console.log('Location already initialized:')
    const loc = config.location as Record<string, string>
    console.log(`  hash: ${loc.hash}`)
    console.log(`  uuid: ${loc.uuid}`)
    console.log(`  name: ${loc.name}`)
    return
  }

  // Generate location identity
  const identity = generateLocationIdentity(opentasksDir, name)

  config.version = '1.0'
  config.location = {
    hash: identity.hash,
    uuid: identity.uuid,
    name: identity.name,
  }

  if (!config.connections) {
    config.connections = []
  }

  writeConfig(opentasksDir, config)

  // Create graph.jsonl if it doesn't exist
  const graphPath = path.join(opentasksDir, 'graph.jsonl')
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, '', 'utf-8')
  }

  // Create .gitignore for ephemeral files
  const gitignorePath = path.join(opentasksDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, [
      'cache.db',
      'cache.db-wal',
      'cache.db-shm',
      'write.lock',
      'daemon.sock',
      'daemon.lock',
      '',
    ].join('\n'), 'utf-8')
  }

  console.log('Initialized .opentasks/')
  console.log(`  hash: ${identity.hash}`)
  console.log(`  uuid: ${identity.uuid}`)
  console.log(`  name: ${identity.name}`)
}

/**
 * Connect to another OpenTasks location
 */
function cmdConnect(args: string[]): void {
  const targetPath = args[0]
  if (!targetPath) {
    console.error('Usage: opentasks connect <path> [--role <role>]')
    process.exit(1)
  }

  const roleIndex = args.indexOf('--role')
  const role = roleIndex !== -1 ? args[roleIndex + 1] as 'peer' | 'parent' | 'child' : 'peer'

  const opentasksDir = path.resolve(OPENTASKS_DIR)

  if (!fs.existsSync(path.join(opentasksDir, CONFIG_FILE))) {
    console.error('Not initialized. Run `opentasks init` first.')
    process.exit(1)
  }

  try {
    const connection = createConnection(
      path.resolve(targetPath),
      role,
      opentasksDir
    )

    const config = readConfig(opentasksDir)
    const connections = (config.connections || []) as Connection[]

    // Check for existing connection with same hash
    const existing = connections.find(c => c.hash === connection.hash)
    if (existing) {
      console.log(`Updated connection: ${connection.name} (${connection.hash})`)
    } else {
      console.log(`Connected: ${connection.name} (${connection.hash})`)
    }

    // Add/update connection
    const updated = connections.filter(c => c.hash !== connection.hash)
    updated.push(connection)
    config.connections = updated

    writeConfig(opentasksDir, config)

    console.log(`  path: ${connection.path}`)
    console.log(`  role: ${connection.role}`)
  } catch (error) {
    console.error(`Failed to connect: ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * Disconnect from a location
 */
function cmdDisconnect(args: string[]): void {
  const hash = args[0]
  if (!hash) {
    console.error('Usage: opentasks disconnect <hash>')
    process.exit(1)
  }

  const opentasksDir = path.resolve(OPENTASKS_DIR)
  const config = readConfig(opentasksDir)
  const connections = (config.connections || []) as Connection[]

  const found = connections.find(c => c.hash === hash)
  if (!found) {
    console.error(`No connection with hash: ${hash}`)
    process.exit(1)
  }

  config.connections = connections.filter(c => c.hash !== hash)
  writeConfig(opentasksDir, config)

  console.log(`Disconnected: ${found.name} (${hash})`)
}

/**
 * List connections with health status
 */
function cmdConnections(): void {
  const opentasksDir = path.resolve(OPENTASKS_DIR)
  const config = readConfig(opentasksDir)
  const connections = (config.connections || []) as Connection[]

  if (connections.length === 0) {
    console.log('No connections.')
    return
  }

  const statuses = checkAllConnectionHealth(connections, opentasksDir)

  // Header
  console.log(
    padRight('HASH', 12) +
    padRight('NAME', 20) +
    padRight('PATH', 40) +
    padRight('ROLE', 10) +
    'STATUS'
  )

  for (const status of statuses) {
    const { connection, health } = status
    console.log(
      padRight(connection.hash, 12) +
      padRight(connection.name, 20) +
      padRight(connection.path, 40) +
      padRight(connection.role, 10) +
      health
    )
  }
}

/**
 * Setup a new worktree
 */
function cmdWorktreeSetup(args: string[]): void {
  const targetPath = args[0]
  if (!targetPath) {
    console.error('Usage: opentasks worktree setup <path> [--branch <name>] [--role <role>] [--redirect-to <target>] [--no-git-worktree]')
    process.exit(1)
  }

  const opentasksDir = path.resolve(OPENTASKS_DIR)
  if (!fs.existsSync(path.join(opentasksDir, CONFIG_FILE))) {
    console.error('Not initialized. Run `opentasks init` first.')
    process.exit(1)
  }

  const branchIndex = args.indexOf('--branch')
  const roleIndex = args.indexOf('--role')
  const redirectIndex = args.indexOf('--redirect-to')
  const noGitWorktree = args.includes('--no-git-worktree')

  try {
    const entry = worktreeSetup(targetPath, opentasksDir, {
      branch: branchIndex !== -1 ? args[branchIndex + 1] : undefined,
      role: roleIndex !== -1 ? args[roleIndex + 1] as 'manager' | 'worker' : undefined,
      redirectTo: redirectIndex !== -1 ? args[redirectIndex + 1] : undefined,
      noGitWorktree,
    })

    console.log(`Worktree setup complete:`)
    console.log(`  path:   ${entry.path}`)
    console.log(`  hash:   ${entry.hash}`)
    console.log(`  role:   ${entry.role}`)
    console.log(`  branch: ${entry.branch || '(none)'}`)
    if (entry.redirectTarget) {
      console.log(`  redirect: → ${entry.redirectTarget}`)
    }
  } catch (error) {
    console.error(`Failed: ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * List registered worktrees
 */
function cmdWorktreeList(): void {
  const gitCommonDir = getGitCommonDir(process.cwd())
  if (!gitCommonDir) {
    console.error('Not in a git repository.')
    process.exit(1)
  }

  const worktrees = listWorktrees(gitCommonDir)

  if (worktrees.length === 0) {
    console.log('No registered worktrees.')
    return
  }

  console.log(
    padRight('HASH', 12) +
    padRight('PATH', 40) +
    padRight('BRANCH', 20) +
    padRight('ROLE', 12) +
    'STATUS'
  )

  for (const wt of worktrees) {
    console.log(
      padRight(wt.hash, 12) +
      padRight(wt.path, 40) +
      padRight(wt.branch || '(none)', 20) +
      padRight(wt.role, 12) +
      wt.status
    )
  }
}

/**
 * Teardown a worktree
 */
function cmdWorktreeTeardown(args: string[]): void {
  const pathOrHash = args[0]
  if (!pathOrHash) {
    console.error('Usage: opentasks worktree teardown <path-or-hash> [--remove-git-worktree] [--keep-data]')
    process.exit(1)
  }

  const opentasksDir = path.resolve(OPENTASKS_DIR)

  try {
    const entry = worktreeTeardown(pathOrHash, opentasksDir, {
      removeGitWorktree: args.includes('--remove-git-worktree'),
      keepData: args.includes('--keep-data'),
    })

    if (entry) {
      console.log(`Worktree torn down: ${entry.hash} (${entry.path})`)
    }
  } catch (error) {
    console.error(`Failed: ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * JSONL merge driver (called by git)
 */
function cmdMergeDriver(args: string[]): void {
  const [basePath, oursPath, theirsPath] = args
  if (!basePath || !oursPath || !theirsPath) {
    console.error('Usage: opentasks merge-driver <base> <ours> <theirs>')
    process.exit(1)
  }

  const exitCode = mergeJsonl(basePath, oursPath, theirsPath)
  process.exit(exitCode)
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + '  ' : str + ' '.repeat(len - str.length)
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'init':
      cmdInit(args.slice(1));
      // Install merge driver on init
      try {
        installMergeDriver(process.cwd())
      } catch {
        // Non-fatal
      }
      break;
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
        const subCmd = args[1]
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
            console.error(`Unknown worktree command: ${subCmd}`)
            console.error('Available: setup, list, teardown')
            process.exit(1)
        }
      }
      break;
    case 'merge-driver':
      cmdMergeDriver(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
