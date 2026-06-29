import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildAggregateRows,
  buildCellRows,
  loadPoolSummaries,
  renderCsv,
  renderMarkdown,
  resolveSummaryFiles,
} from '../../evals/tac/scripts/summarize-pool-runs.js';

describe('TAC pool summary extractor', () => {
  it('loads run directories and projects optimization metrics into cell rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-tac-summary-'));
    const runDir = path.join(root, 'run-a');
    await fs.mkdir(runDir);
    await fs.writeFile(
      path.join(runDir, 'summary.json'),
      JSON.stringify(
        {
          runId: 'run-a',
          cells: [
            {
              taskId: 'sde-add-wiki-page',
              arm: 'opentasks',
              model: 'haiku',
              seed: 2,
              status: 'success',
              partial: 1,
              full: true,
              envError: null,
              budgetExceeded: null,
              tokens: 123,
              durationMs: 90000,
              metrics: {
                mainOpenTasksGetTaskCallCount: 1,
                seededTaskFullContentReadBeforeFirstBash: 1,
                seededTaskFullContentReadBeforeFirstTaskWork: 1,
                mainOpenTasksUpdateCallCount: 1,
                mainOpenTasksCallCount: 3,
                teamInboxAssignmentCount: 1,
                teamInboxEvidenceReplyCount: 1,
                teamInboxVerifierRequestCount: 1,
                teamInboxVerifierReplyCount: 1,
                teamInboxEvidenceBeforeMutation: 1,
                teamOpenTasksEvidenceAfterInbox: 1,
                teamOpenTasksVerificationAfterVerifier: 1,
                teamProtocolPassed: 1,
                teamProtocolNativeRoleEnforcement: 0,
                gitlabHelperCallCount: 2,
                rawGitlabApiCurlCallCount: 4,
                broadFilesystemSearchCount: 1,
                http404Count: 5,
                http5xxCount: 0,
              },
            },
          ],
          aggregate: [
            {
              arm: 'opentasks',
              model: 'haiku',
              n: 1,
              successRate: 1,
              sPartial: 1,
              envErrors: 0,
              budgetExceeded: 0,
              tokens: 123,
              latencyP50Ms: 90000,
              metrics: {
                mainOpenTasksGetTaskCallCount: 1,
                seededTaskFullContentReadBeforeFirstBash: 1,
                seededTaskFullContentReadBeforeFirstTaskWork: 1,
                mainOpenTasksUpdateCallCount: 1,
                teamInboxAssignmentCount: 1,
                teamInboxEvidenceReplyCount: 1,
                teamInboxVerifierRequestCount: 1,
                teamInboxVerifierReplyCount: 1,
                teamInboxEvidenceBeforeMutation: 1,
                teamOpenTasksEvidenceAfterInbox: 1,
                teamOpenTasksVerificationAfterVerifier: 1,
                teamProtocolPassed: 1,
                teamProtocolNativeRoleEnforcement: 0,
                gitlabHelperCallCount: 2,
                rawGitlabApiCurlCallCount: 4,
                broadFilesystemSearchCount: 1,
                http404Count: 5,
                http5xxCount: 0,
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    await expect(resolveSummaryFiles([root])).resolves.toEqual([path.join(runDir, 'summary.json')]);

    const summaries = await loadPoolSummaries([runDir]);
    expect(buildCellRows(summaries)).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        taskId: 'sde-add-wiki-page',
        arm: 'opentasks',
        model: 'haiku',
        seed: 2,
        status: 'success',
        tokens: 123,
        durationSec: 90,
        getTask: 1,
        seededFullBeforeBash: 1,
        seededFullBeforeTaskWork: 1,
        openTasksUpdates: 1,
        openTasksCalls: 3,
        teamInboxAssignment: 1,
        teamInboxEvidence: 1,
        teamInboxVerifierRequest: 1,
        teamInboxVerifierReply: 1,
        teamInboxEvidenceBeforeMutation: 1,
        teamOpenTasksEvidenceAfterInbox: 1,
        teamOpenTasksVerificationAfterVerifier: 1,
        teamProtocolPassed: 1,
        teamNativeRoleEnforcement: 0,
        gitlabHelper: 2,
        rawGitlabCurl: 4,
        broadFsSearch: 1,
        http404: 5,
      }),
    ]);

    expect(buildAggregateRows(summaries)).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        arm: 'opentasks',
        model: 'haiku',
        successRate: 1,
        sPartial: 1,
        getTaskMean: 1,
        seededFullBeforeBashMean: 1,
        seededFullBeforeTaskWorkMean: 1,
        teamProtocolPassedMean: 1,
      }),
    ]);
  });

  it('renders markdown aggregate and CSV cell output', () => {
    const aggregateRows = [
      {
        runId: 'run-a',
        runDir: '/tmp/run-a',
        arm: 'opentasks',
        model: 'haiku',
        n: 1,
        successRate: 1,
        sPartial: 1,
        envErrors: 0,
        budgetExceeded: 0,
        tokens: 123,
        p50LatencySec: 90,
        getTaskMean: 1,
        seededFullBeforeBashMean: 1,
        seededFullBeforeTaskWorkMean: 1,
        openTasksUpdatesMean: 1,
        teamInboxAssignmentMean: 1,
        teamInboxEvidenceMean: 1,
        teamInboxVerifierRequestMean: 1,
        teamInboxVerifierReplyMean: 1,
        teamInboxEvidenceBeforeMutationMean: 1,
        teamOpenTasksEvidenceAfterInboxMean: 1,
        teamOpenTasksVerificationAfterVerifierMean: 1,
        teamProtocolPassedMean: 1,
        teamNativeRoleEnforcementMean: 0,
        gitlabHelperMean: 2,
        rawGitlabCurlMean: 4,
        broadFsSearchMean: 1,
        http404Mean: 5,
        http5xxMean: 0,
      },
    ];
    const cellRows = [
      {
        runId: 'run-a',
        runDir: '/tmp/run-a',
        model: 'haiku',
        seed: 2,
        taskId: 'sde-add-wiki-page',
        arm: 'opentasks',
        status: 'success',
        partial: 1,
        full: true,
        envError: '',
        budgetExceeded: '',
        tokens: 123,
        durationSec: 90,
        getTask: 1,
        seededFullBeforeBash: 1,
        seededFullBeforeTaskWork: 1,
        openTasksUpdates: 1,
        openTasksCalls: 3,
        teamInboxAssignment: 1,
        teamInboxEvidence: 1,
        teamInboxVerifierRequest: 1,
        teamInboxVerifierReply: 1,
        teamInboxEvidenceBeforeMutation: 1,
        teamOpenTasksEvidenceAfterInbox: 1,
        teamOpenTasksVerificationAfterVerifier: 1,
        teamProtocolPassed: 1,
        teamNativeRoleEnforcement: 0,
        gitlabHelper: 2,
        rawGitlabCurl: 4,
        broadFsSearch: 1,
        http404: 5,
        http5xx: 0,
      },
    ];

    expect(renderMarkdown(aggregateRows, cellRows)).toContain('| run-a | opentasks | haiku | 1 | 1 | 1 |');
    expect(renderMarkdown(aggregateRows, cellRows)).toContain('| run-a | haiku | 2 | sde-add-wiki-page | opentasks | success |');

    const csv = renderCsv(cellRows);
    expect(csv.split('\n')[0]).toContain('runId,model,seed,taskId,arm,status');
    expect(csv).toContain('run-a,haiku,2,sde-add-wiki-page,opentasks,success');
  });

  it('backfills strict task-work timing metrics from older trace files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-tac-summary-backfill-'));
    const runDir = path.join(root, 'run-backfill');
    const goodCellDir = path.join(runDir, 'cells', 'sde-close-an-issue__opentasks__azureoai-gpt-5.5__seed7');
    const delegatedCellDir = path.join(runDir, 'cells', 'sde-delete-stale-branch__opentasks__azureoai-gpt-5.5__seed7');
    await fs.mkdir(goodCellDir, { recursive: true });
    await fs.mkdir(delegatedCellDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        runId: 'run-backfill',
        cells: [
          {
            taskId: 'sde-close-an-issue',
            arm: 'opentasks',
            model: 'azureoai/gpt-5.5',
            seed: 7,
            status: 'success',
            partial: 1,
            full: true,
            tokens: 100,
            durationMs: 1000,
            metrics: {
              mainOpenTasksGetTaskCallCount: 1,
              seededTaskFullContentReadBeforeFirstBash: 1,
            },
          },
          {
            taskId: 'sde-delete-stale-branch',
            arm: 'opentasks',
            model: 'azureoai/gpt-5.5',
            seed: 7,
            status: 'success',
            partial: 1,
            full: true,
            tokens: 200,
            durationMs: 2000,
            metrics: {
              mainOpenTasksGetTaskCallCount: 1,
              seededTaskFullContentReadBeforeFirstBash: 1,
            },
          },
        ],
      }),
    );
    await writeSeedAndStream(goodCellDir, 't-good', [
      ...swarmToolUse('tool-1', 'tool_search', { query: 'select:mcp__opentasks__get_task' }),
      ...swarmToolUse('tool-2', 'mcp__opentasks__get_task', { id: 't-good' }),
      ...swarmToolUse('tool-3', 'read_file', { path: '/instruction/task.md' }, true),
      ...swarmToolUse('tool-4', 'bash', { command: 'find / -name "*plane*"' }, true),
    ]);
    await writeSeedAndStream(delegatedCellDir, 't-late', [
      toolUse('ToolSearch', { query: 'select:mcp__opentasks__get_task' }),
      toolUse('Agent', { description: 'inspect task' }),
      toolUse('mcp__opentasks__get_task', { id: 't-late' }),
    ]);

    const summaries = await loadPoolSummaries([runDir]);
    const cellRows = buildCellRows(summaries);
    expect(cellRows).toEqual([
      expect.objectContaining({
        taskId: 'sde-close-an-issue',
        seededFullBeforeTaskWork: 1,
        broadFsSearch: 1,
      }),
      expect.objectContaining({
        taskId: 'sde-delete-stale-branch',
        seededFullBeforeTaskWork: 0,
        broadFsSearch: 0,
      }),
    ]);
    expect(buildAggregateRows(summaries)).toEqual([
      expect.objectContaining({
        runId: 'run-backfill',
        seededFullBeforeTaskWorkMean: 0.5,
        broadFsSearchMean: 0.5,
      }),
    ]);
  });
});

async function writeSeedAndStream(cellDir: string, taskId: string, toolEvents: unknown[]): Promise<void> {
  await fs.writeFile(path.join(cellDir, 'opentasks-graph-seed-stdout.log'), JSON.stringify({ taskId }));
  await fs.writeFile(path.join(cellDir, 'agent-stream.jsonl'), toolEvents.map((event) => JSON.stringify(event)).join('\n'));
}

function toolUse(name: string, input: unknown): unknown {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name,
          input,
        },
      ],
    },
  };
}

function swarmToolUse(id: string, name: string, input: unknown, endWithInput = false): unknown[] {
  return [
    { type: 'tool_use_start', id, name },
    ...(endWithInput
      ? [{ type: 'tool_use_end', id, input }]
      : [
          { type: 'tool_use_input', id, jsonDelta: JSON.stringify(input).slice(0, 4) },
          { type: 'tool_use_input', id, jsonDelta: JSON.stringify(input).slice(4) },
          { type: 'tool_use_end', id },
        ]),
  ];
}
