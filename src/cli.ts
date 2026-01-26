#!/usr/bin/env node

import { createTask, completeTask } from "./index.js";

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
opentasks v0.0.1

Usage:
  opentasks <command> [options]

Commands:
  create <title>    Create a new task
  help              Show this help message

Examples:
  opentasks create "My first task"
`);
}

function main() {
  if (!command || command === "help") {
    printHelp();
    process.exit(0);
  }

  if (command === "create") {
    const title = args.slice(1).join(" ");
    if (!title) {
      console.error("Error: Please provide a task title");
      process.exit(1);
    }
    const task = createTask({ title });
    console.log("Created task:", JSON.stringify(task, null, 2));
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main();
