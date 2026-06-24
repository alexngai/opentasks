#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const opts = {
    command: 'node',
    args: [],
    required: [],
    timeoutMs: 15_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--command') opts.command = argv[++i];
    else if (arg === '--arg') opts.args.push(argv[++i]);
    else if (arg === '--project-dir') opts.projectDir = argv[++i];
    else if (arg === '--required') opts.required = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.projectDir) throw new Error('--project-dir is required');

const startedAt = Date.now();
const env = {
  ...process.env,
  OPENTASKS_PROJECT_DIR: opts.projectDir,
};
const transport = new StdioClientTransport({
  command: opts.command,
  args: opts.args,
  env,
});
const client = new Client({ name: 'opentasks-tac-preflight', version: '0.0.0' });

let report;
try {
  await withTimeout(client.connect(transport), opts.timeoutMs, 'MCP connect');
  const listed = await withTimeout(client.listTools(), opts.timeoutMs, 'MCP listTools');
  const names = listed.tools.map((tool) => tool.name).sort();
  const missing = opts.required.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`OpenTasks MCP missing required tools: ${missing.join(', ')}`);
  }

  const listResult = await withTimeout(
    client.callTool({ name: 'list_tasks', arguments: {} }),
    opts.timeoutMs,
    'MCP list_tasks',
  );
  report = {
    ok: true,
    durationMs: Date.now() - startedAt,
    toolCount: names.length,
    tools: names,
    listTasksIsError: listResult.isError === true,
  };
  if (listResult.isError === true) throw new Error('OpenTasks MCP list_tasks returned isError=true');
} catch (error) {
  report = {
    ok: false,
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error),
  };
  throw error;
} finally {
  if (opts.out) await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  await client.close().catch(() => undefined);
}
