#!/usr/bin/env node

/**
 * OpenTasks CLI
 *
 * Command-line interface for OpenTasks.
 */

function printHelp() {
  console.log(`
opentasks v0.0.1

Usage:
  opentasks <command> [options]

Commands:
  help              Show this help message

For programmatic usage, import from the opentasks package:
  import { OpenTasksClient, createClient } from 'opentasks'
`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    printHelp();
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main();
