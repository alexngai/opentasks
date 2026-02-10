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
import { discoverLocations } from './core/discover.js'
import { OpenTasksClient } from './client/client.js'

const OPENTASKS_DIR = '.opentasks'
const CONFIG_FILE = 'config.json'

function printHelp() {
  console.log(`
opentasks v0.1.0

Usage:
  opentasks <command> [options]

Tool commands (require running daemon):
  link    --from <id> --to <id> --type <type> [--remove] [--metadata <json>]
  query   <json>                Query the graph (pass QueryParams as JSON)
  annotate <json>               Manage feedback (pass AnnotateParams as JSON)
  create  --type <type> --title <title> [options]
  get     <id>                  Get a node by ID
  update  <id> [options]        Update a node
  delete  <id> [--hard]         Delete a node

Create options:
  --status <s>                  Status (required for issues)
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

Setup commands:
  init [--name <name>]          Initialize .opentasks in current directory
  connect <path> [--role <role>] Connect to another location
  disconnect <hash>             Disconnect from a location
  connections                   List connections with health status
  worktree setup <path> [opts]  Setup a new worker worktree
  worktree list                 List registered worktrees
  worktree teardown <path|hash> Teardown a worktree
  discover [options]            Find nearby opentasks locations
  merge-driver <O> <A> <B>     JSONL merge driver (for git)

All tool commands output JSON to stdout.
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

  try {
    const exitCode = mergeJsonl(basePath, oursPath, theirsPath)
    process.exit(exitCode)
  } catch (error) {
    console.error(`Merge failed: ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * Discover nearby opentasks locations
 */
function cmdDiscover(args: string[]): void {
  const dirIndex = args.indexOf('--direction')
  const direction = dirIndex !== -1
    ? args[dirIndex + 1] as 'up' | 'down' | 'both'
    : 'both'

  const depthIndex = args.indexOf('--max-depth')
  const maxDepth = depthIndex !== -1
    ? parseInt(args[depthIndex + 1], 10)
    : 5

  if (!['up', 'down', 'both'].includes(direction)) {
    console.error(`Invalid direction: ${direction}. Use up, down, or both.`)
    process.exit(1)
  }

  const locations = discoverLocations(process.cwd(), { direction, maxDepth })

  if (locations.length === 0) {
    console.log('No opentasks locations found.')
    return
  }

  console.log(
    padRight('HASH', 12) +
    padRight('NAME', 20) +
    padRight('PATH', 50) +
    padRight('DIR', 8) +
    'DEPTH'
  )

  for (const loc of locations) {
    console.log(
      padRight(loc.hash, 12) +
      padRight(loc.name || '(unnamed)', 20) +
      padRight(loc.opentasksPath, 50) +
      padRight(loc.direction, 8) +
      String(loc.depth)
    )
  }
}

// ============================================================================
// Tool Commands (daemon-connected)
// ============================================================================

/**
 * Extract a flag value from args. Returns undefined if not present.
 */
export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Run an async command, print JSON result, handle errors.
 */
async function runToolCommand(fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ error: message }))
    process.exit(1)
  }
}

export async function cmdLink(args: string[]): Promise<void> {
  const fromId = getFlag(args, '--from')
  const toId = getFlag(args, '--to')
  const type = getFlag(args, '--type')
  const remove = hasFlag(args, '--remove')
  const metadataStr = getFlag(args, '--metadata')

  if (!fromId || !toId || !type) {
    console.error('Usage: opentasks link --from <id> --to <id> --type <type> [--remove] [--metadata <json>]')
    process.exit(1)
  }

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const params: Record<string, unknown> = { fromId, toId, type }
    if (remove) params.remove = true
    if (metadataStr) params.metadata = JSON.parse(metadataStr)
    const result = await client.link(params as never)
    client.disconnect()
    return result
  })
}

export async function cmdQuery(args: string[]): Promise<void> {
  const json = args[0]
  if (!json) {
    console.error('Usage: opentasks query \'<json>\'')
    console.error('Example: opentasks query \'{"ready":{}}\'')
    process.exit(1)
  }

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const params = JSON.parse(json)
    const result = await client.query(params)
    client.disconnect()
    return result
  })
}

export async function cmdAnnotate(args: string[]): Promise<void> {
  const json = args[0]
  if (!json) {
    console.error('Usage: opentasks annotate \'<json>\'')
    console.error('Example: opentasks annotate \'{"targetId":"s-a2b3","create":{"content":"...","type":"comment"}}\'')
    process.exit(1)
  }

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const params = JSON.parse(json)
    const result = await client.annotate(params)
    client.disconnect()
    return result
  })
}

export async function cmdCreate(args: string[]): Promise<void> {
  const type = getFlag(args, '--type')
  const title = getFlag(args, '--title')

  if (!type || !title) {
    console.error('Usage: opentasks create --type <type> --title <title> [options]')
    process.exit(1)
  }

  const params: Record<string, unknown> = { type, title }

  const status = getFlag(args, '--status')
  const content = getFlag(args, '--content')
  const uri = getFlag(args, '--uri')
  const source = getFlag(args, '--source')
  const tagsStr = getFlag(args, '--tags')
  const priorityStr = getFlag(args, '--priority')
  const parentId = getFlag(args, '--parent')
  const metadataStr = getFlag(args, '--metadata')

  if (status) params.status = status
  if (content) params.content = content
  if (uri) params.uri = uri
  if (source) params.source = source
  if (tagsStr) params.tags = tagsStr.split(',').map(t => t.trim())
  if (priorityStr) params.priority = parseInt(priorityStr, 10)
  if (parentId) params.parent_id = parentId
  if (metadataStr) params.metadata = JSON.parse(metadataStr)

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const result = await client.createNode(params as never)
    client.disconnect()
    return result
  })
}

export async function cmdGet(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error('Usage: opentasks get <id>')
    process.exit(1)
  }

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const result = await client.getNode(id)
    client.disconnect()
    return result
  })
}

export async function cmdUpdate(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error('Usage: opentasks update <id> [--title <t>] [--status <s>] [--archived] [--metadata <json>]')
    process.exit(1)
  }

  const rest = args.slice(1)
  const updates: Record<string, unknown> = {}

  const title = getFlag(rest, '--title')
  const status = getFlag(rest, '--status')
  const metadataStr = getFlag(rest, '--metadata')

  if (title) updates.title = title
  if (status) updates.status = status
  if (hasFlag(rest, '--archived')) updates.archived = true
  if (metadataStr) updates.metadata = JSON.parse(metadataStr)

  if (Object.keys(updates).length === 0) {
    console.error('No updates specified. Use --title, --status, --archived, or --metadata.')
    process.exit(1)
  }

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    const result = await client.updateNode(id, updates as never)
    client.disconnect()
    return result
  })
}

export async function cmdDelete(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error('Usage: opentasks delete <id> [--hard]')
    process.exit(1)
  }

  const hard = hasFlag(args, '--hard')

  const client = new OpenTasksClient()
  await runToolCommand(async () => {
    await client.deleteNode(id, hard ? { hard: true } : undefined)
    client.disconnect()
    return { success: true, id, hard }
  })
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + '  ' : str + ' '.repeat(len - str.length)
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    process.exit(0);
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

    // Setup commands (sync, no daemon needed)
    case 'init':
      cmdInit(args.slice(1));
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
    case 'discover':
      cmdDiscover(args.slice(1));
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

// Only auto-run when executed directly (not when imported for testing)
if (!process.env.VITEST) {
  main();
}
