#!/usr/bin/env tsx
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOpenSwarmJsonl } from '../agent-harness';
import { traceDiagnosticsFromClaudeStream } from '../docker-adapter';

interface CellSummary {
  taskId: string;
  arm: string;
  model: string;
  seed: number;
  status: string;
  partial: number;
  full: boolean;
  envError?: string | null;
  budgetExceeded?: string | null;
  tokens: number;
  durationMs?: number;
  metrics?: Record<string, number>;
}

interface AggregateSummary {
  arm: string;
  model: string;
  n: number;
  envErrors?: number;
  budgetExceeded?: number;
  successRate?: number;
  sPartial?: number;
  fullRate?: number;
  tokens?: number;
  latencyP50Ms?: number;
  metrics?: Record<string, number>;
}

interface PoolSummary {
  runId: string;
  outDir?: string;
  unstartedCells?: number;
  stopReason?: string | null;
  cells?: CellSummary[];
  aggregate?: AggregateSummary[];
}

export interface CellRow {
  runId: string;
  runDir: string;
  model: string;
  seed: number;
  taskId: string;
  arm: string;
  status: string;
  partial: number;
  full: boolean;
  envError: string;
  budgetExceeded: string;
  tokens: number;
  durationSec: number;
  getTask: number;
  seededFullBeforeBash: number;
  seededFullBeforeTaskWork: number;
  openTasksUpdates: number;
  openTasksCalls: number;
  teamInboxAssignment: number;
  teamInboxEvidence: number;
  teamInboxVerifierRequest: number;
  teamInboxVerifierReply: number;
  teamProtocolHelperAssignment: number;
  teamProtocolHelperEvidenceMessage: number;
  teamProtocolHelperEvidenceRecord: number;
  teamProtocolHelperVerificationRequest: number;
  teamProtocolHelperMutationGate: number;
  teamProtocolHelperMutationGatePassed: number;
  teamProtocolMutationBypass: number;
  teamInboxEvidenceBeforeMutation: number;
  teamOpenTasksEvidenceAfterInbox: number;
  teamOpenTasksVerificationAfterVerifier: number;
  teamProtocolPassed: number;
  teamNativeRoleEnforcement: number;
  gitlabHelper: number;
  rawGitlabCurl: number;
  broadFsSearch: number;
  http404: number;
  http5xx: number;
}

export interface AggregateRow {
  runId: string;
  runDir: string;
  arm: string;
  model: string;
  n: number;
  successRate: number;
  sPartial: number;
  envErrors: number;
  budgetExceeded: number;
  tokens: number;
  p50LatencySec: number;
  getTaskMean: number;
  seededFullBeforeBashMean: number;
  seededFullBeforeTaskWorkMean: number;
  openTasksUpdatesMean: number;
  teamInboxAssignmentMean: number;
  teamInboxEvidenceMean: number;
  teamInboxVerifierRequestMean: number;
  teamInboxVerifierReplyMean: number;
  teamProtocolHelperAssignmentMean: number;
  teamProtocolHelperEvidenceMessageMean: number;
  teamProtocolHelperEvidenceRecordMean: number;
  teamProtocolHelperVerificationRequestMean: number;
  teamProtocolHelperMutationGateMean: number;
  teamProtocolHelperMutationGatePassedMean: number;
  teamProtocolMutationBypassMean: number;
  teamInboxEvidenceBeforeMutationMean: number;
  teamOpenTasksEvidenceAfterInboxMean: number;
  teamOpenTasksVerificationAfterVerifierMean: number;
  teamProtocolPassedMean: number;
  teamNativeRoleEnforcementMean: number;
  gitlabHelperMean: number;
  rawGitlabCurlMean: number;
  broadFsSearchMean: number;
  http404Mean: number;
  http5xxMean: number;
}

const CELL_COLUMNS: Array<keyof CellRow> = [
  'runId',
  'model',
  'seed',
  'taskId',
  'arm',
  'status',
  'partial',
  'full',
  'envError',
  'budgetExceeded',
  'tokens',
  'durationSec',
  'getTask',
  'seededFullBeforeBash',
  'seededFullBeforeTaskWork',
  'openTasksUpdates',
  'openTasksCalls',
  'teamInboxAssignment',
  'teamInboxEvidence',
  'teamInboxVerifierRequest',
  'teamInboxVerifierReply',
  'teamProtocolHelperAssignment',
  'teamProtocolHelperEvidenceMessage',
  'teamProtocolHelperEvidenceRecord',
  'teamProtocolHelperVerificationRequest',
  'teamProtocolHelperMutationGate',
  'teamProtocolHelperMutationGatePassed',
  'teamProtocolMutationBypass',
  'teamInboxEvidenceBeforeMutation',
  'teamOpenTasksEvidenceAfterInbox',
  'teamOpenTasksVerificationAfterVerifier',
  'teamProtocolPassed',
  'teamNativeRoleEnforcement',
  'gitlabHelper',
  'rawGitlabCurl',
  'broadFsSearch',
  'http404',
  'http5xx',
];

const AGGREGATE_COLUMNS: Array<keyof AggregateRow> = [
  'runId',
  'arm',
  'model',
  'n',
  'successRate',
  'sPartial',
  'envErrors',
  'budgetExceeded',
  'tokens',
  'p50LatencySec',
  'getTaskMean',
  'seededFullBeforeBashMean',
  'seededFullBeforeTaskWorkMean',
  'openTasksUpdatesMean',
  'teamInboxAssignmentMean',
  'teamInboxEvidenceMean',
  'teamInboxVerifierRequestMean',
  'teamInboxVerifierReplyMean',
  'teamProtocolHelperAssignmentMean',
  'teamProtocolHelperEvidenceMessageMean',
  'teamProtocolHelperEvidenceRecordMean',
  'teamProtocolHelperVerificationRequestMean',
  'teamProtocolHelperMutationGateMean',
  'teamProtocolHelperMutationGatePassedMean',
  'teamProtocolMutationBypassMean',
  'teamInboxEvidenceBeforeMutationMean',
  'teamOpenTasksEvidenceAfterInboxMean',
  'teamOpenTasksVerificationAfterVerifierMean',
  'teamProtocolPassedMean',
  'teamNativeRoleEnforcementMean',
  'gitlabHelperMean',
  'rawGitlabCurlMean',
  'broadFsSearchMean',
  'http404Mean',
  'http5xxMean',
];

export async function loadPoolSummaries(inputs: string[], cwd = process.cwd()): Promise<Array<{ file: string; summary: PoolSummary }>> {
  const files = await resolveSummaryFiles(inputs, cwd);
  return Promise.all(
    files.map(async (file) => {
      const summary = JSON.parse(await fs.readFile(file, 'utf8')) as PoolSummary;
      await backfillMissingTraceMetrics(path.dirname(file), summary);
      return { file, summary };
    }),
  );
}

export async function resolveSummaryFiles(inputs: string[], cwd = process.cwd()): Promise<string[]> {
  const candidates = inputs.length > 0 ? inputs : [path.join(cwd, 'evals/.tac-pool-runs')];
  const files: string[] = [];
  for (const raw of candidates) {
    const input = path.resolve(cwd, raw);
    const stat = await fs.stat(input).catch(() => null);
    if (!stat) throw new Error(`summary input does not exist: ${raw}`);
    if (stat.isFile()) {
      files.push(input);
      continue;
    }
    const direct = path.join(input, 'summary.json');
    if (await exists(direct)) {
      files.push(direct);
      continue;
    }
    const entries = await fs.readdir(input, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(input, entry.name, 'summary.json');
      if (await exists(nested)) files.push(nested);
    }
  }
  return [...new Set(files)].sort();
}

export function buildCellRows(items: Array<{ file: string; summary: PoolSummary }>): CellRow[] {
  return items.flatMap(({ file, summary }) => {
    const runDir = path.dirname(file);
    return [...(summary.cells ?? [])]
      .sort((a, b) => compareCell(a, b))
      .map((cell) => cellRow(summary.runId, runDir, cell));
  });
}

export function buildAggregateRows(items: Array<{ file: string; summary: PoolSummary }>): AggregateRow[] {
  return items.flatMap(({ file, summary }) => {
    const runDir = path.dirname(file);
    const aggregates = summary.cells?.length ? aggregateFromCells(summary.cells) : (summary.aggregate ?? []);
    return [...aggregates]
      .sort((a, b) => `${a.arm}\t${a.model}`.localeCompare(`${b.arm}\t${b.model}`))
      .map((aggregate) => aggregateRow(summary.runId, runDir, aggregate));
  });
}

export function renderMarkdown(aggregateRows: AggregateRow[], cellRows: CellRow[]): string {
  return [
    '# TAC Pool Cross-Run Summary',
    '',
    '## Aggregate',
    '',
    renderMarkdownTable(AGGREGATE_COLUMNS, aggregateRows),
    '',
    '## Cells',
    '',
    renderMarkdownTable(CELL_COLUMNS, cellRows),
    '',
  ].join('\n');
}

export function renderCsv(rows: CellRow[]): string {
  return [CELL_COLUMNS.join(','), ...rows.map((row) => CELL_COLUMNS.map((column) => csvValue(row[column])).join(','))].join('\n') + '\n';
}

export function renderJsonl(rows: CellRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function cellRow(runId: string, runDir: string, cell: CellSummary): CellRow {
  const metrics = cell.metrics ?? {};
  return {
    runId,
    runDir,
    model: cell.model,
    seed: cell.seed,
    taskId: cell.taskId,
    arm: cell.arm,
    status: cell.status,
    partial: round(cell.partial),
    full: cell.full,
    envError: cell.envError ?? '',
    budgetExceeded: cell.budgetExceeded ?? '',
    tokens: cell.tokens,
    durationSec: round((cell.durationMs ?? 0) / 1000),
    getTask: metric(metrics, 'mainOpenTasksGetTaskCallCount'),
    seededFullBeforeBash: metric(metrics, 'seededTaskFullContentReadBeforeFirstBash'),
    seededFullBeforeTaskWork: metric(metrics, 'seededTaskFullContentReadBeforeFirstTaskWork'),
    openTasksUpdates: metric(metrics, 'mainOpenTasksUpdateCallCount'),
    openTasksCalls: metric(metrics, 'mainOpenTasksCallCount'),
    teamInboxAssignment: metric(metrics, 'teamInboxAssignmentCount'),
    teamInboxEvidence: metric(metrics, 'teamInboxEvidenceReplyCount'),
    teamInboxVerifierRequest: metric(metrics, 'teamInboxVerifierRequestCount'),
    teamInboxVerifierReply: metric(metrics, 'teamInboxVerifierReplyCount'),
    teamProtocolHelperAssignment: metric(metrics, 'teamProtocolHelperAssignmentCount'),
    teamProtocolHelperEvidenceMessage: metric(metrics, 'teamProtocolHelperEvidenceMessageCount'),
    teamProtocolHelperEvidenceRecord: metric(metrics, 'teamProtocolHelperEvidenceRecordCount'),
    teamProtocolHelperVerificationRequest: metric(metrics, 'teamProtocolHelperVerificationRequestCount'),
    teamProtocolHelperMutationGate: metric(metrics, 'teamProtocolHelperMutationGateCount'),
    teamProtocolHelperMutationGatePassed: metric(metrics, 'teamProtocolHelperMutationGatePassedCount'),
    teamProtocolMutationBypass: metric(metrics, 'teamProtocolMutationBypassCount'),
    teamInboxEvidenceBeforeMutation: metric(metrics, 'teamInboxEvidenceBeforeMutation'),
    teamOpenTasksEvidenceAfterInbox: metric(metrics, 'teamOpenTasksEvidenceAfterInbox'),
    teamOpenTasksVerificationAfterVerifier: metric(metrics, 'teamOpenTasksVerificationAfterVerifier'),
    teamProtocolPassed: metric(metrics, 'teamProtocolPassed'),
    teamNativeRoleEnforcement: metric(metrics, 'teamProtocolNativeRoleEnforcement'),
    gitlabHelper: metric(metrics, 'gitlabHelperCallCount'),
    rawGitlabCurl: metric(metrics, 'rawGitlabApiCurlCallCount'),
    broadFsSearch: metric(metrics, 'broadFilesystemSearchCount'),
    http404: metric(metrics, 'http404Count'),
    http5xx: metric(metrics, 'http5xxCount'),
  };
}

async function backfillMissingTraceMetrics(runDir: string, summary: PoolSummary): Promise<void> {
  await Promise.all((summary.cells ?? []).map((cell) => backfillCellTraceMetrics(runDir, cell)));
}

async function backfillCellTraceMetrics(runDir: string, cell: CellSummary): Promise<void> {
  const metrics = (cell.metrics ??= {});
  const needsTaskTimingBackfill = !(
    metrics.openTasksGetTaskCallsBeforeFirstTaskWork !== undefined &&
    metrics.mainFullTaskContentReadBeforeFirstTaskWork !== undefined &&
    metrics.seededTaskGetTaskBeforeFirstTaskWorkCallCount !== undefined &&
    metrics.seededTaskFullContentReadBeforeFirstTaskWork !== undefined
  );
  const needsBroadFsBackfill = metrics.broadFilesystemSearchCount === undefined;
  if (!needsTaskTimingBackfill && !needsBroadFsBackfill) {
    return;
  }

  const cellDir = path.join(runDir, 'cells', slug(`${cell.taskId}__${cell.arm}__${cell.model}__seed${cell.seed}`));
  const streamFile = path.join(cellDir, 'agent-stream.jsonl');
  if (!(await exists(streamFile))) return;

  const stdout = await fs.readFile(streamFile, 'utf8');
  if (needsBroadFsBackfill) {
    const stderr = await fs.readFile(path.join(cellDir, 'agent-stderr.log'), 'utf8').catch(() => '');
    metrics.broadFilesystemSearchCount = traceDiagnosticsFromClaudeStream(stdout, stderr).broadFilesystemSearchCount;
  }
  if (!needsTaskTimingBackfill) return;

  const seededTaskId = await readSeededTaskId(cellDir);
  const toolEvents = readToolEvents(stdout);
  const firstTaskWorkIndex = toolEvents.findIndex(isTaskWorkTool);
  let openTasksGetTaskCallsBeforeFirstTaskWork = 0;
  let seededTaskGetTaskBeforeFirstTaskWorkCallCount = 0;

  for (let index = 0; index < toolEvents.length; index += 1) {
    const event = toolEvents[index]!;
    if (event.name !== 'mcp__opentasks__get_task') continue;
    if (firstTaskWorkIndex >= 0 && index >= firstTaskWorkIndex) continue;
    openTasksGetTaskCallsBeforeFirstTaskWork += 1;
    if (seededTaskId && String((event.input as { id?: unknown } | undefined)?.id ?? '') === seededTaskId) {
      seededTaskGetTaskBeforeFirstTaskWorkCallCount += 1;
    }
  }

  metrics.openTasksGetTaskCallsBeforeFirstTaskWork ??= openTasksGetTaskCallsBeforeFirstTaskWork;
  metrics.mainFullTaskContentReadBeforeFirstTaskWork ??= openTasksGetTaskCallsBeforeFirstTaskWork > 0 ? 1 : 0;
  if (seededTaskId) {
    metrics.seededTaskGetTaskBeforeFirstTaskWorkCallCount ??= seededTaskGetTaskBeforeFirstTaskWorkCallCount;
    metrics.seededTaskFullContentReadBeforeFirstTaskWork ??= seededTaskGetTaskBeforeFirstTaskWorkCallCount > 0 ? 1 : 0;
  }
}

async function readSeededTaskId(cellDir: string): Promise<string | undefined> {
  const file = path.join(cellDir, 'opentasks-graph-seed-stdout.log');
  if (!(await exists(file))) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { taskId?: unknown };
    return typeof parsed.taskId === 'string' ? parsed.taskId : undefined;
  } catch {
    return undefined;
  }
}

interface ToolEvent {
  name: string;
  input?: unknown;
}

function readToolEvents(stdout: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  for (const event of parseOpenSwarmJsonl(stdout).trajectory) {
    if (event.type === 'tool') events.push({ name: event.name, input: event.input });
  }
  if (events.length > 0) return events;

  for (const line of stdout.split(/\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (parsed as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const tool = item as { type?: unknown; name?: unknown; input?: unknown };
      if (tool.type === 'tool_use' && typeof tool.name === 'string') {
        events.push({ name: tool.name, input: tool.input });
      }
    }
  }
  return events;
}

function isTaskWorkTool(event: ToolEvent): boolean {
  return event.name !== 'ToolSearch' && event.name !== 'Skill' && !event.name.startsWith('mcp__opentasks__');
}

function aggregateRow(runId: string, runDir: string, aggregate: AggregateSummary): AggregateRow {
  const metrics = aggregate.metrics ?? {};
  return {
    runId,
    runDir,
    arm: aggregate.arm,
    model: aggregate.model,
    n: aggregate.n,
    successRate: round(aggregate.successRate ?? 0),
    sPartial: round(aggregate.sPartial ?? 0),
    envErrors: aggregate.envErrors ?? 0,
    budgetExceeded: aggregate.budgetExceeded ?? 0,
    tokens: aggregate.tokens ?? 0,
    p50LatencySec: round((aggregate.latencyP50Ms ?? 0) / 1000),
    getTaskMean: metric(metrics, 'mainOpenTasksGetTaskCallCount'),
    seededFullBeforeBashMean: metric(metrics, 'seededTaskFullContentReadBeforeFirstBash'),
    seededFullBeforeTaskWorkMean: metric(metrics, 'seededTaskFullContentReadBeforeFirstTaskWork'),
    openTasksUpdatesMean: metric(metrics, 'mainOpenTasksUpdateCallCount'),
    teamInboxAssignmentMean: metric(metrics, 'teamInboxAssignmentCount'),
    teamInboxEvidenceMean: metric(metrics, 'teamInboxEvidenceReplyCount'),
    teamInboxVerifierRequestMean: metric(metrics, 'teamInboxVerifierRequestCount'),
    teamInboxVerifierReplyMean: metric(metrics, 'teamInboxVerifierReplyCount'),
    teamProtocolHelperAssignmentMean: metric(metrics, 'teamProtocolHelperAssignmentCount'),
    teamProtocolHelperEvidenceMessageMean: metric(metrics, 'teamProtocolHelperEvidenceMessageCount'),
    teamProtocolHelperEvidenceRecordMean: metric(metrics, 'teamProtocolHelperEvidenceRecordCount'),
    teamProtocolHelperVerificationRequestMean: metric(metrics, 'teamProtocolHelperVerificationRequestCount'),
    teamProtocolHelperMutationGateMean: metric(metrics, 'teamProtocolHelperMutationGateCount'),
    teamProtocolHelperMutationGatePassedMean: metric(metrics, 'teamProtocolHelperMutationGatePassedCount'),
    teamProtocolMutationBypassMean: metric(metrics, 'teamProtocolMutationBypassCount'),
    teamInboxEvidenceBeforeMutationMean: metric(metrics, 'teamInboxEvidenceBeforeMutation'),
    teamOpenTasksEvidenceAfterInboxMean: metric(metrics, 'teamOpenTasksEvidenceAfterInbox'),
    teamOpenTasksVerificationAfterVerifierMean: metric(metrics, 'teamOpenTasksVerificationAfterVerifier'),
    teamProtocolPassedMean: metric(metrics, 'teamProtocolPassed'),
    teamNativeRoleEnforcementMean: metric(metrics, 'teamProtocolNativeRoleEnforcement'),
    gitlabHelperMean: metric(metrics, 'gitlabHelperCallCount'),
    rawGitlabCurlMean: metric(metrics, 'rawGitlabApiCurlCallCount'),
    broadFsSearchMean: metric(metrics, 'broadFilesystemSearchCount'),
    http404Mean: metric(metrics, 'http404Count'),
    http5xxMean: metric(metrics, 'http5xxCount'),
  };
}

function aggregateFromCells(cells: CellSummary[]): AggregateSummary[] {
  const groups = new Map<string, CellSummary[]>();
  for (const cell of cells) {
    const key = `${cell.arm}\t${cell.model}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups.entries()].map(([key, values]) => {
    const [arm, model] = key.split('\t');
    return {
      arm,
      model,
      n: values.length,
      envErrors: values.filter((value) => value.envError).length,
      budgetExceeded: values.filter((value) => value.budgetExceeded).length,
      successRate: mean(values.map((value) => (value.status === 'success' ? 1 : 0))),
      sPartial: mean(values.map((value) => value.partial)),
      fullRate: mean(values.map((value) => (value.full ? 1 : 0))),
      tokens: sum(values.map((value) => value.tokens)),
      latencyP50Ms: percentile(values.map((value) => value.durationMs ?? 0), 0.5),
      metrics: aggregateMetrics(values),
    };
  });
}

function aggregateMetrics(values: CellSummary[]): Record<string, number> {
  const keys = new Set(values.flatMap((value) => Object.keys(value.metrics ?? {})));
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = mean(values.map((value) => value.metrics?.[key] ?? 0));
  return out;
}

function renderMarkdownTable<T extends Record<string, unknown>>(columns: Array<keyof T>, rows: T[]): string {
  if (rows.length === 0) return '_No rows._';
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => markdownValue(row[column])).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function compareCell(a: CellSummary, b: CellSummary): number {
  return `${a.taskId}\t${a.arm}\t${a.model}\t${a.seed}`.localeCompare(`${b.taskId}\t${b.arm}\t${b.model}\t${b.seed}`);
}

function metric(metrics: Record<string, number>, key: string): number {
  return round(metrics[key] ?? 0);
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
}

function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function markdownValue(value: unknown): string {
  return String(value).replaceAll('|', '\\|');
}

function csvValue(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

function parseArgs(argv: string[]): { format: 'markdown' | 'csv' | 'jsonl'; inputs: string[] } {
  let format: 'markdown' | 'csv' | 'jsonl' = 'markdown';
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'markdown' && value !== 'csv' && value !== 'jsonl') {
        throw new Error(`unsupported --format ${value}`);
      }
      format = value;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'markdown' && value !== 'csv' && value !== 'jsonl') {
        throw new Error(`unsupported --format ${value}`);
      }
      format = value;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      inputs.push(arg);
    }
  }
  return { format, inputs };
}

function printHelp(): void {
  console.log(`Usage: npx tsx evals/tac/scripts/summarize-pool-runs.ts [--format markdown|csv|jsonl] [summary.json|run-dir|runs-root ...]

Reads TAC EC2 pool summary.json files and emits cross-run aggregate plus cell-level tables.
With no inputs, scans evals/.tac-pool-runs/*/summary.json.`);
}

async function main(): Promise<void> {
  const { format, inputs } = parseArgs(process.argv.slice(2));
  const summaries = await loadPoolSummaries(inputs);
  const cellRows = buildCellRows(summaries);
  const aggregateRows = buildAggregateRows(summaries);
  if (format === 'csv') {
    process.stdout.write(renderCsv(cellRows));
  } else if (format === 'jsonl') {
    process.stdout.write(renderJsonl(cellRows));
  } else {
    process.stdout.write(renderMarkdown(aggregateRows, cellRows));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
