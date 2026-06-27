import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  classifyEnvError,
  type EnvError,
  type ExecutionAdapter,
  type FileSeed,
  type PublicCell,
  type RawRun,
  type RunContext,
  type TokenUsage,
  type TraceEvent,
  type Workspace,
} from 'swarmkit-eval';
import {
  TAC_BASE_TOOLS,
  tacAgentHarnessFromId,
  tacDefaultAgentSetupCommand,
  type TacAgentHarness,
} from './agent-harness.js';
import { scoreFromTacResult, type TacResultJson } from './score.js';

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const OPENTASKS_PROJECT_DIR = '/workspace/.opentasks';
const OPENTASKS_REQUIRED_MCP_TOOLS = ['create_task', 'get_task', 'list_tasks', 'record_attempt', 'query', 'update_task'];
const OPENTASKS_MCP_TOOL_PREFIX = 'mcp__opentasks__';
type OpenTasksMcpCommandVariant = 'wrapper' | 'sh-lc' | 'direct';
type OpenTasksPreludeFailureMode = 'fail-fast' | 'degrade';
type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

export interface TacDockerAdapterOptions {
  timeoutMs: number;
  initTimeoutMs: number;
  evalTimeoutMs: number;
  serverHostname: string;
  network: string;
  dockerCommand?: string;
  env?: Record<string, string>;
  /** Optional command run inside the TAC task container before invoking the selected agent harness. */
  agentSetupCommand?: string;
  /** Swappable agent runtime used inside the TAC task container. Defaults to claude-code. */
  agentHarness?: TacAgentHarness;
  agentHarnessId?: string;
  /** Optional non-root user for the agent phase. Init/eval still run as root. */
  agentUser?: string;
  /** Mount local OpenTasks checkout for the opentasks arm. Local/EC2 path only. */
  opentasksMount?: string;
  opentasksContainerDir?: string;
  decryptionKey: string;
  /** Shared TAC operating guidance applied equally to all arms. Set false to disable. */
  operatingPrompt?: string | false;
  /** Optional experiment-specific prompt text applied equally to all arms. */
  agentPromptAppendix?: string;
  /** Verify the OpenTasks MCP server inside the TAC task container before invoking the agent. */
  opentasksMcpPreflight?: boolean;
  /** Run a tiny agent invocation to verify it can call native OpenTasks MCP tools. */
  opentasksClaudeMcpSmoke?: boolean;
  /** Stop before the expensive TAC task if the harness-level MCP smoke fails. */
  opentasksClaudeMcpSmokeFailFast?: boolean;
  /** Test Claude Code with/without --strict-mcp-config. Defaults to strict. */
  strictMcpConfig?: boolean;
  /** Omit --allowed-tools for debugging Claude MCP registration. */
  allowedTools?: boolean;
  /** MCP command shape used for the OpenTasks server. */
  opentasksMcpCommandVariant?: OpenTasksMcpCommandVariant;
  /** Run an optional LLM task-graph prelude before the main TAC agent. Defaults to disabled. */
  opentasksTaskPrelude?: boolean;
  /** Deterministically seed one OpenTasks graph task from /instruction/task.md. Defaults to enabled for the OpenTasks arm. */
  opentasksGraphSeed?: boolean;
  /** Stop before the expensive TAC task if the OpenTasks task prelude fails. */
  opentasksTaskPreludeFailFast?: boolean;
  /** Explicit prelude failure behavior. Overrides opentasksTaskPreludeFailFast when set. */
  opentasksTaskPreludeFailureMode?: OpenTasksPreludeFailureMode;
  /** Number of retries after the first prelude attempt. Defaults to 1 for init-only timeouts. */
  opentasksTaskPreludeRetries?: number;
  /** Per-attempt timeout for the OpenTasks task prelude. Defaults to min(initTimeoutMs, 240000). */
  opentasksTaskPreludeTimeoutMs?: number;
  /** Recreate TAC's documented GitLab root token after each TAC reset. */
  tacGitlabTokenRefresh?: boolean;
  /** Verify TAC service/auth readiness before spending model tokens. */
  tacEnvPreflight?: boolean;
  /** Verify GitLab wiki create/read/delete mechanics on a scratch project before spending model tokens. */
  tacGitlabWikiSmoke?: boolean;
  /** Require the diagnostic Git HTTP wiki clone/push path to pass, not just the API wiki path. */
  tacGitlabWikiSmokeRequireGit?: boolean;
  /** Verify TAC's LLM grader route before spending agent tokens on tasks that call llm_complete. */
  tacEvalLlmPreflight?: boolean;
  /** Destructive target-project wiki write smoke. Only allowed with preflightOnly. */
  tacGitlabWikiTargetSmokeProject?: string;
  /** Stop after environment/preflight checks and return a self-scored diagnostic success. */
  preflightOnly?: boolean;
  /** Kill the main Claude task when its live stream usage crosses this token count. */
  liveTokenLimit?: number;
}

export const TAC_TASK_PROMPT = 'Complete the task in /instruction/task.md.';

export const DEFAULT_TAC_OPERATING_PROMPT = [
  'You are running inside a TAC task container with CLI tools and network access to the TAC services.',
  'Do not ask for clarification; make the best reasonable interpretation and proceed.',
  '',
  'If the task says to navigate to a URL, interact with that service using Bash, curl, python, git, or service APIs.',
  'You may not have a browser. Treat web UI instructions as service-state instructions.',
  '',
  'TAC service facts:',
  '- GitLab is usually at http://the-agent-company.com:8929 unless the task URL says otherwise.',
  '- GitLab web login: username root, password theagentcompany.',
  '- GitLab API writes should use header PRIVATE-TOKEN: root-token. The TAC base image exposes the same value as GITLAB_ACCESS_TOKEN in /utils/config.py.',
  '- OwnCloud login is theagentcompany / theagentcompany.',
  '- RocketChat login is theagentcompany / theagentcompany.',
  '- Plane login is agent@company.com / theagentcompany; Plane API requests usually use the x-api-key from /utils/config.py.',
  '',
  'For GitLab tasks, prefer the REST API or git over the web UI. For GitLab REST API calls, prefer the installed helper `tac-gitlab-api METHOD PATH [JSON_BODY]` instead of raw curl. It adds the token, accepts API shorthand paths, normalizes common project path encodings, redacts credentials, and caps response output.',
  'Use the target URL to derive the project path, then resolve the project with `tac-gitlab-api GET projects/root/repo` or `tac-gitlab-api GET projects/root%2Frepo` instead of guessing numeric project ids.',
  'For GitLab writes through raw curl, include PRIVATE-TOKEN: root-token. Unauthenticated GET requests can succeed; that does not mean POST/PUT/PATCH/DELETE will succeed. Raw curl is mainly for cases the helper cannot express.',
  'Helpful GitLab helper examples: `tac-gitlab-api GET projects/root/repo`, `tac-gitlab-api GET projects/root/repo/repository/branches/main`, `tac-gitlab-api DELETE projects/root/repo/repository/branches/feature/old`, `tac-gitlab-api POST projects/root/repo/issues \'{"title":"Done"}\'`.',
  'For GitLab protected branch policy changes, prefer `tac-gitlab-protect-branch root/repo main PUSH_LEVEL MERGE_LEVEL`; access levels are 0 no one, 30 developers, 40 maintainers. It safely delete/recreates the branch protection and verifies the result.',
  'If you need git push access, use an authenticated HTTP remote such as http://root:root-token@the-agent-company.com:8929/group/project.git, but avoid printing credentials.',
  'Inspect the target project, modify the requested files or configuration, commit changes when requested, and verify the resulting state through GitLab, git, or HTTP/API calls.',
  'For documentation or wiki tasks, keep generated content tightly grounded in the requested source material. Do not add broad external background or speculative structure unless the task explicitly asks for it and you verified it from the repository.',
  'When a requested write has succeeded and you have verified the final state, stop. Do not continue with extra inspection or optional improvements after successful verification.',
  '',
  'Output discipline:',
  '- Avoid dumping full HTML, full API pages, large logs, or broad recursive greps into the conversation.',
  '- For unknown URLs, first request status and headers or cap content with `head -c 4000`.',
  '- Prefer jq-selected JSON fields, grep -n with a narrow pattern, and small file previews.',
  '- If a response is HTML from a web UI or a Not Found page, do not keep reading it; switch to the API or git route.',
  '',
  'Avoid unbounded retry loops. If the same command, API request, write attempt, or login/permission approach fails repeatedly with the same evidence, stop repeating it, try at most one materially different strategy, then proceed with the best verified state and report the blocker.',
  'Do not brute-force credentials, tokens, URLs, or forms. If GitLab returns 401/403 on a write, use the documented root-token header rather than trying passwords, CSRF/session flows, SSH key generation, or token guessing.',
  'Prefer concise evidence over repeated near-identical probes.',
  '',
  'Record the concrete target URL/project you acted on and the verification evidence in your final answer.',
].join('\n');

export const OPENTASKS_TAC_SKILL = [
  '---',
  'name: opentasks',
  'description: Use when OpenTasks MCP tools are available in TAC eval tasks; follow the minimal graph protocol for planning, progress, and evidence.',
  '---',
  '# OpenTasks',
  '',
  'Use native MCP tools named `mcp__opentasks__...` for task graph state. Never run those tool names in Bash, curl, node, python, or a shell command.',
  'If an OpenTasks tool is hidden or still pending, call `ToolSearch` with one exact select query such as `select:mcp__opentasks__get_task`, then call the returned native tool directly.',
  'After ToolSearch returns a tool reference, the next tool call should be the native `mcp__opentasks__...` tool, not Bash or Read.',
  'Do not insert Bash status commands such as echo, printf, or logging between ToolSearch and the native OpenTasks tool call.',
  'Do not combine multiple select queries with commas. Do not delegate OpenTasks reads to a subagent. Do not test OpenTasks by echoing tool names or simulating MCP calls in Bash.',
  '',
  'Minimal TAC graph protocol:',
  '',
  '1. If the prompt gives a seeded TAC task id, call `mcp__opentasks__get_task` on that exact id and read the full `content` before task-specific Bash, curl, git, python, or service API work.',
  '2. Do not read `/instruction/task.md` before the seeded `get_task` call unless `get_task` is unavailable after one exact ToolSearch attempt.',
  '3. If no seeded id is given, inspect the graph once near the start with `mcp__opentasks__list_tasks`, then call `mcp__opentasks__get_task` for the relevant task.',
  '4. Use that seeded task id. Do not create a duplicate top-level task.',
  '5. If no seeded task exists, create one top-level task with `mcp__opentasks__create_task` and `status: "open"`.',
  '6. Use Bash, curl, git, python, and service APIs for the TAC work itself.',
  '7. At the end, record the final outcome and concrete verification evidence with `mcp__opentasks__record_attempt` or `mcp__opentasks__update_task`.',
  '',
  'Efficiency rules:',
  '',
  '- Do not create subtasks for simple single-action TAC tasks.',
  '- Do not update OpenTasks after every minor discovery.',
  '- Add a mid-task OpenTasks update only for a material blocker, changed target, or important verification result.',
  '- Stop updating the graph after verified task success.',
].join('\n');

export function buildTacAgentPrompt(opts: { operatingPrompt?: string | false; appendix?: string } = {}): string {
  const chunks = [TAC_TASK_PROMPT];
  if (opts.operatingPrompt !== false) chunks.push((opts.operatingPrompt ?? DEFAULT_TAC_OPERATING_PROMPT).trim());
  if (opts.appendix?.trim()) chunks.push(opts.appendix.trim());
  return `${chunks.join('\n\n')}\n`;
}

export class TacDockerAdapter implements ExecutionAdapter {
  readonly id = 'tac-docker';
  readonly placement = 'backend' as const;
  private readonly agentHarness: TacAgentHarness;

  constructor(private readonly opts: TacDockerAdapterOptions) {
    this.agentHarness = opts.agentHarness ?? tacAgentHarnessFromId(opts.agentHarnessId);
  }

  async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
    const ws = ctx.workspace;
    if (!ws) throw new Error('TacDockerAdapter requires a backend workspace');

    const start = Date.now();
    const taskId = cell.task.id;
    const image = stringMeta(cell, 'image') ?? cell.task.setup?.image;
    if (!image) return envRaw('other', `TAC task ${taskId} has no image`, start);

    const runDir = `.tac/${safeId(cell.cellKey)}`;
    const container = `tac-${safeId(cell.task.id)}-${safeId(cell.arm.id)}-${cell.seed}-${Date.now().toString(36)}`;
    let created = false;
    let opentasksPreludeTrajectory: TraceEvent[] = [];
    let opentasksPreludeUsage: TokenUsage = ZERO_USAGE;
    let opentasksGraphSeedReport: OpenTasksGraphSeedReport | undefined;

    try {
      await ws.writeFiles([
        {
          path: `${runDir}/prompt.txt`,
          content: buildTacAgentPrompt({
            operatingPrompt: this.opts.operatingPrompt,
            appendix: this.opts.agentPromptAppendix,
          }),
        },
        { path: `${runDir}/mcp.json`, content: JSON.stringify(this.mcpConfig(cell, runDir), null, 2) },
        ...(usesOpenTasks(cell)
          ? [
              { path: `${runDir}/opentasks-skill.md`, content: OPENTASKS_TAC_SKILL } satisfies FileSeed,
              { path: `${runDir}/opentasks-mcp-wrapper.sh`, content: this.opentasksMcpWrapperScript(runDir) } satisfies FileSeed,
            ]
          : []),
        ...(cell.arm.scaffold.systemPromptAppendix
          ? [{ path: `${runDir}/system.txt`, content: cell.arm.scaffold.systemPromptAppendix } satisfies FileSeed]
          : []),
      ]);

      const run = await ws.run(this.dockerRunCommand(cell, container, image, ws.root), { timeoutMs: 180_000 });
      if (run.exitCode !== 0) return envRaw('sandbox', `docker run failed: ${run.stderr || run.stdout}`, start);
      created = true;

      const setup = await this.runInContainer(ws, container, this.agentSetup(), {
        timeoutMs: this.opts.initTimeoutMs,
        cwd: '/workspace',
        allowEmpty: true,
      });
      if (setup.exitCode !== 0) return envRaw('crash', `agent setup failed: ${setup.stderr || setup.stdout}`, start);

      const gitlabRequired = await this.taskRequiresGitlab(ws, container);
      let gitlabRootTokenRefreshed = false;
      const init = gitlabRequired
        ? await this.runGitlabAwareTacInit(ws, container, runDir, start)
        : await this.runInContainer(ws, container, 'bash /utils/init.sh', {
            timeoutMs: this.opts.initTimeoutMs,
            cwd: '/workspace',
            env: this.initEnv(),
          });
      if ('raw' in init) return init.raw;
      gitlabRootTokenRefreshed = init.gitlabRootTokenRefreshed;
      await this.writeCommandArtifacts(ws, runDir, 'tac-init', init);
      if (init.exitCode !== 0) return envRaw('sandbox', `TAC init failed: ${init.stderr || init.stdout}`, start);

      const helperInstall = await this.runInContainer(ws, container, this.tacAgentHelperInstallCommand(), {
        timeoutMs: Math.min(this.opts.initTimeoutMs, 60_000),
        cwd: '/workspace',
      });
      await this.writeCommandArtifacts(ws, runDir, 'tac-agent-helpers', helperInstall);
      if (helperInstall.exitCode !== 0) return envRaw('crash', `TAC agent helper install failed: ${helperInstall.stderr || helperInstall.stdout}`, start);

      if (gitlabRequired && this.opts.tacGitlabTokenRefresh !== false && !gitlabRootTokenRefreshed) {
        const tokenRefresh = await this.refreshTacGitlabRootToken(ws);
        await this.writeCommandArtifacts(ws, runDir, 'tac-gitlab-token-refresh', tokenRefresh);
        if (!this.tacGitlabRootTokenRefreshOk(tokenRefresh)) {
          return envRaw('sandbox', `TAC GitLab token refresh failed: ${tokenRefresh.stderr || tokenRefresh.stdout}`, start);
        }
      }

      if (gitlabRequired && this.opts.tacEnvPreflight !== false) {
        const envPreflight = await this.runInContainer(ws, container, this.tacEnvPreflightCommand(runDir), {
          timeoutMs: Math.min(this.opts.initTimeoutMs, 180_000),
          cwd: '/workspace',
          env: this.initEnv(),
        });
        await this.writeCommandArtifacts(ws, runDir, 'tac-env-preflight', envPreflight);
        const envPreflightReport = await ws.readFile(`${runDir}/tac-env-preflight.json`);
        if (envPreflightReport) await writeLocalArtifact('tac-env-preflight.json', redactSensitiveText(envPreflightReport));
        if (envPreflight.exitCode !== 0) {
          return envRaw('sandbox', `TAC environment preflight failed: ${envPreflight.stderr || envPreflight.stdout}`, start);
        }
      }

      if (gitlabRequired && this.opts.tacGitlabWikiSmoke !== false) {
        const wikiSmoke = await this.runInContainer(ws, container, this.tacGitlabWikiSmokeCommand(runDir), {
          timeoutMs: Math.min(this.opts.initTimeoutMs, 180_000),
          cwd: '/workspace',
          env: {
            ...this.initEnv(),
            TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT: this.opts.tacGitlabWikiSmokeRequireGit === true ? '1' : '0',
          },
        });
        await this.writeCommandArtifacts(ws, runDir, 'tac-gitlab-wiki-smoke', wikiSmoke);
        const wikiSmokeReport = await ws.readFile(`${runDir}/tac-gitlab-wiki-smoke.json`);
        if (wikiSmokeReport) await writeLocalArtifact('tac-gitlab-wiki-smoke.json', redactSensitiveText(wikiSmokeReport));
        if (wikiSmoke.exitCode !== 0) {
          return envRaw('sandbox', `TAC GitLab wiki smoke failed: ${wikiSmoke.stderr || wikiSmoke.stdout}`, start);
        }
      }

      if (gitlabRequired && this.opts.tacGitlabWikiTargetSmokeProject) {
        if (!this.opts.preflightOnly) {
          return envRaw('sandbox', 'TAC GitLab target wiki smoke requires TAC_PREFLIGHT_ONLY=1 to avoid modifying scored benchmark tasks', start);
        }
        const targetWikiSmoke = await this.runInContainer(
          ws,
          container,
          this.tacGitlabWikiTargetSmokeCommand(runDir, this.opts.tacGitlabWikiTargetSmokeProject),
          {
            timeoutMs: Math.min(this.opts.initTimeoutMs, 180_000),
            cwd: '/workspace',
            env: {
              ...this.initEnv(),
              TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT: this.opts.tacGitlabWikiSmokeRequireGit === true ? '1' : '0',
            },
          },
        );
        await this.writeCommandArtifacts(ws, runDir, 'tac-gitlab-wiki-target-smoke', targetWikiSmoke);
        const targetWikiSmokeReport = await ws.readFile(`${runDir}/tac-gitlab-wiki-target-smoke.json`);
        if (targetWikiSmokeReport) await writeLocalArtifact('tac-gitlab-wiki-target-smoke.json', redactSensitiveText(targetWikiSmokeReport));
        if (targetWikiSmoke.exitCode !== 0) {
          return envRaw('sandbox', `TAC GitLab target wiki smoke failed: ${targetWikiSmoke.stderr || targetWikiSmoke.stdout}`, start);
        }
      }

      const llmGraderRequired = taskUsesLlmGrader(cell);
      if (llmGraderRequired && this.opts.tacEvalLlmPreflight !== false) {
        const llmPreflight = await this.runInContainer(ws, container, this.tacEvalLlmPreflightCommand(runDir), {
          timeoutMs: Math.min(this.opts.evalTimeoutMs, 120_000),
          cwd: '/workspace',
          env: { DECRYPTION_KEY: this.opts.decryptionKey, ...this.envLlmEnv() },
        });
        await this.writeCommandArtifacts(ws, runDir, 'tac-eval-llm-preflight', llmPreflight);
        const llmPreflightReport = await ws.readFile(`${runDir}/tac-eval-llm-preflight.json`);
        if (llmPreflightReport) await writeLocalArtifact('tac-eval-llm-preflight.json', redactSensitiveText(llmPreflightReport));
        if (llmPreflight.exitCode !== 0) {
          return envRaw(
            'sandbox',
            `TAC LLM grader preflight failed: ${(llmPreflight.stderr || llmPreflight.stdout).slice(0, 500)}`,
            start,
          );
        }
      }

      if (this.opts.preflightOnly) {
        return {
          output: `TAC preflight-only checks passed for ${taskId}`,
          usage: ZERO_USAGE,
          trajectory: [
            {
              type: 'tool',
              ts: Date.now(),
              name: 'tac_preflight_only',
              input: {
                gitlabRequired,
                envPreflight: gitlabRequired && this.opts.tacEnvPreflight !== false,
                wikiSmoke: gitlabRequired && this.opts.tacGitlabWikiSmoke !== false,
                targetWikiSmokeProject: this.opts.tacGitlabWikiTargetSmokeProject ?? null,
                llmGraderRequired,
                llmGraderPreflight: llmGraderRequired && this.opts.tacEvalLlmPreflight !== false,
              },
            },
          ],
          selfScore: scoreFromTacResult(
            { final_score: { total: 1, result: 1 } },
            {
              tacPreflightOnly: 1,
              tacGitlabRequired: gitlabRequired ? 1 : 0,
              tacEnvPreflightRan: gitlabRequired && this.opts.tacEnvPreflight !== false ? 1 : 0,
              tacGitlabWikiSmokeRan: gitlabRequired && this.opts.tacGitlabWikiSmoke !== false ? 1 : 0,
              tacGitlabWikiTargetSmokeRan: gitlabRequired && this.opts.tacGitlabWikiTargetSmokeProject ? 1 : 0,
              tacEvalLlmGraderRequired: llmGraderRequired ? 1 : 0,
              tacEvalLlmPreflightRan: llmGraderRequired && this.opts.tacEvalLlmPreflight !== false ? 1 : 0,
            },
          ),
          durationMs: Date.now() - start,
        };
      }

      if (usesOpenTasks(cell)) {
        const skill = await this.runInContainer(ws, container, this.opentasksSkillInstallCommand(runDir), {
          timeoutMs: this.opts.initTimeoutMs,
          cwd: '/workspace',
          user: this.opts.agentUser,
        });
        if (skill.exitCode !== 0) {
          return envRaw('crash', `OpenTasks skill install failed: ${skill.stderr || skill.stdout}`, start);
        }

        const opentasksInit = await this.runInContainer(ws, container, this.opentasksInitCommand(cell), {
          timeoutMs: this.opts.initTimeoutMs,
          cwd: '/workspace',
          user: this.opts.agentUser,
        });
        if (opentasksInit.exitCode !== 0) {
          return envRaw('crash', `OpenTasks init failed: ${opentasksInit.stderr || opentasksInit.stdout}`, start);
        }

        if (this.opts.opentasksMcpPreflight !== false) {
          const preflight = await this.runInContainer(ws, container, this.opentasksMcpPreflightCommand(runDir), {
            timeoutMs: this.opts.initTimeoutMs,
            cwd: '/workspace',
            user: this.opts.agentUser,
          });
          const preflightReport = await ws.readFile(`${runDir}/opentasks-mcp-preflight.json`);
          if (preflightReport) await writeLocalArtifact('opentasks-mcp-preflight.json', preflightReport);
          if (preflight.exitCode !== 0) {
            return envRaw('crash', `OpenTasks MCP preflight failed: ${preflight.stderr || preflight.stdout}`, start);
          }
        }

        if (this.opts.opentasksClaudeMcpSmoke !== false) {
          const smoke = await this.runInContainer(ws, container, this.opentasksMcpSmokeCommand(cell, runDir), {
            timeoutMs: Math.min(this.opts.initTimeoutMs, 180_000),
            cwd: '/workspace',
            env: this.agentEnv(cell),
            user: this.opts.agentUser,
          });
          const sanitizedSmoke = {
            ...smoke,
            stdout: redactSensitiveText(smoke.stdout),
            stderr: redactSensitiveText(smoke.stderr),
          };
          const smokeReport = this.opentasksMcpSmokeReport(cell, sanitizedSmoke);
          await ws.writeFiles([
            { path: `${runDir}/opentasks-mcp-smoke.jsonl`, content: sanitizedSmoke.stdout },
            { path: `${runDir}/opentasks-mcp-smoke-report.json`, content: `${JSON.stringify(smokeReport, null, 2)}\n` },
            { path: `${runDir}/claude-mcp-smoke.jsonl`, content: sanitizedSmoke.stdout },
            { path: `${runDir}/claude-mcp-smoke-report.json`, content: `${JSON.stringify(smokeReport, null, 2)}\n` },
          ]);
          await writeLocalArtifact('opentasks-mcp-smoke.jsonl', sanitizedSmoke.stdout);
          await writeLocalArtifact('opentasks-mcp-smoke-stderr.log', sanitizedSmoke.stderr);
          await writeLocalArtifact('opentasks-mcp-smoke-report.json', `${JSON.stringify(smokeReport, null, 2)}\n`);
          await this.copyOpenTasksMcpWrapperLog(ws, runDir);
          if (smokeReport.ok !== true && this.opts.opentasksClaudeMcpSmokeFailFast !== false) {
            return envRaw(
              'crash',
              `OpenTasks MCP smoke failed: ${smokeReport.failureReason ?? 'unknown failure'}`,
              start,
              smokeReport.usage ?? ZERO_USAGE,
              smokeReport.trajectory ?? [],
            );
          }
        }

        if (this.opts.opentasksGraphSeed !== false && this.opts.opentasksTaskPrelude !== true) {
          const seed = await this.runInContainer(ws, container, this.opentasksGraphSeedCommand(cell, runDir), {
            timeoutMs: Math.min(this.opts.initTimeoutMs, 60_000),
            cwd: '/workspace',
            env: this.agentEnv(cell),
            user: this.opts.agentUser,
          });
          const sanitizedSeed = {
            ...seed,
            stdout: redactSensitiveText(seed.stdout),
            stderr: redactSensitiveText(seed.stderr),
          };
          await this.writeCommandArtifacts(ws, runDir, 'opentasks-graph-seed', sanitizedSeed);
          const seedReportText = await ws.readFile(`${runDir}/opentasks-graph-seed-report.json`);
          if (seedReportText) {
            await writeLocalArtifact('opentasks-graph-seed-report.json', redactSensitiveText(seedReportText));
            opentasksGraphSeedReport = JSON.parse(seedReportText) as OpenTasksGraphSeedReport;
          }
          const seedSummary = await ws.readFile(`${runDir}/opentasks-graph-seed-summary.txt`);
          if (seedSummary) await writeLocalArtifact('opentasks-graph-seed-summary.txt', redactSensitiveText(seedSummary));
          if (seed.exitCode !== 0 || opentasksGraphSeedReport?.ok !== true) {
            return envRaw(
              'crash',
              `OpenTasks deterministic graph seed failed: ${opentasksGraphSeedReport?.error ?? (seed.stderr || seed.stdout)}`,
              start,
            );
          }
          await ws.writeFiles([{ path: `${runDir}/prompt.txt`, content: this.mainPromptWithGraphSeed(opentasksGraphSeedReport) }]);
        }

        if (this.opts.opentasksTaskPrelude === true) {
          let preludeReport: OpenTasksTaskPreludeReport | undefined;
          let sanitizedPrelude: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } | undefined;
          const attemptReports: OpenTasksTaskPreludeReport[] = [];
          const maxAttempts = this.opentasksTaskPreludeMaxAttempts();
          let aggregateUsage = ZERO_USAGE;
          let aggregateTrajectory: TraceEvent[] = [];

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const prelude = await this.runInContainer(ws, container, this.opentasksTaskPreludeCommand(cell, runDir, attempt), {
              timeoutMs: this.opentasksTaskPreludeTimeoutMs(),
              cwd: '/workspace',
              env: this.agentEnv(cell),
              user: this.opts.agentUser,
            });
            sanitizedPrelude = {
              ...prelude,
              stdout: redactSensitiveText(prelude.stdout),
              stderr: redactSensitiveText(prelude.stderr),
            };
            const attemptReport = this.opentasksTaskPreludeReport(cell, sanitizedPrelude, { attempt, maxAttempts });
            attemptReports.push(attemptReport);
            aggregateUsage = addUsage(aggregateUsage, attemptReport.usage);
            aggregateTrajectory = [...aggregateTrajectory, ...attemptReport.trajectory];

            await ws.writeFiles([
              { path: `${runDir}/opentasks-task-prelude-attempt-${attempt}.jsonl`, content: sanitizedPrelude.stdout },
              {
                path: `${runDir}/opentasks-task-prelude-attempt-${attempt}-report.json`,
                content: `${JSON.stringify(attemptReport, null, 2)}\n`,
              },
            ]);
            await writeLocalArtifact(`opentasks-task-prelude-attempt-${attempt}.jsonl`, sanitizedPrelude.stdout);
            await writeLocalArtifact(`opentasks-task-prelude-attempt-${attempt}-stderr.log`, sanitizedPrelude.stderr);
            await writeLocalArtifact(`opentasks-task-prelude-attempt-${attempt}-report.json`, `${JSON.stringify(attemptReport, null, 2)}\n`);

            preludeReport = attemptReport;
            if (attemptReport.ok === true || !this.shouldRetryOpenTasksTaskPrelude(attemptReport)) break;
          }

          if (!preludeReport || !sanitizedPrelude) {
            return envRaw('crash', 'OpenTasks task prelude did not run', start);
          }

          preludeReport = {
            ...preludeReport,
            usage: aggregateUsage,
            trajectory: aggregateTrajectory,
            attempts: attemptReports.map(compactOpenTasksPreludeAttempt),
          };
          const preludeSummary = this.opentasksTaskPreludeSummary(preludeReport);
          opentasksPreludeTrajectory = preludeReport.trajectory;
          opentasksPreludeUsage = preludeReport.usage;
          await ws.writeFiles([
            { path: `${runDir}/opentasks-task-prelude.jsonl`, content: sanitizedPrelude.stdout },
            { path: `${runDir}/opentasks-task-prelude-report.json`, content: `${JSON.stringify(preludeReport, null, 2)}\n` },
            { path: `${runDir}/opentasks-task-prelude-summary.txt`, content: preludeSummary },
            { path: `${runDir}/prompt.txt`, content: this.mainPromptWithPrelude(preludeReport) },
          ]);
          await writeLocalArtifact('opentasks-task-prelude.jsonl', sanitizedPrelude.stdout);
          await writeLocalArtifact('opentasks-task-prelude-stderr.log', sanitizedPrelude.stderr);
          await writeLocalArtifact('opentasks-task-prelude-report.json', `${JSON.stringify(preludeReport, null, 2)}\n`);
          await writeLocalArtifact('opentasks-task-prelude-summary.txt', preludeSummary);
          await this.copyOpenTasksMcpWrapperLog(ws, runDir);
          if (preludeReport.ok !== true && this.opentasksTaskPreludeFailureMode() === 'fail-fast') {
            return envRaw(
              'crash',
              `OpenTasks task prelude failed: ${preludeReport.failureReason ?? 'unknown failure'}`,
              start,
              preludeReport.usage ?? ZERO_USAGE,
              preludeReport.trajectory ?? [],
            );
          }
        }
      }

      const agent = await this.runInContainer(ws, container, this.agentCommand(cell, runDir, opentasksPreludeUsage), {
        timeoutMs: this.opts.timeoutMs,
        cwd: '/workspace',
        env: this.agentEnv(cell),
        user: this.opts.agentUser,
      });
      const sanitizedAgent = {
        ...agent,
        stdout: redactSensitiveText(agent.stdout),
        stderr: redactSensitiveText(agent.stderr),
      };
      await this.copyOpenTasksMcpWrapperLog(ws, runDir);
      await writeLocalAgentArtifacts(sanitizedAgent.stdout, sanitizedAgent.stderr);
      const liveBudgetReport = await ws.readFile(`${runDir}/agent-live-token-budget.json`);
      if (liveBudgetReport) await writeLocalArtifact('agent-live-token-budget.json', redactSensitiveText(liveBudgetReport));
      const parsed = this.agentHarness.parse(sanitizedAgent.stdout, cell.model.name);
      const trajectory = [
        ...opentasksPreludeTrajectory,
        ...withAgentDiagnostics(withMcpMetrics(parsed.trajectory, parsed.mcpServers), sanitizedAgent),
      ];
      const diagnostics = traceDiagnosticsFromClaudeStream(sanitizedAgent.stdout, sanitizedAgent.stderr);
      const usage = addUsage(opentasksPreludeUsage, parsed.usage);
      await ws.writeFiles([{ path: `${runDir}/trajectory.jsonl`, content: sanitizedAgent.stdout }]);

      const agentEnvErr = this.agentEnvError(parsed, sanitizedAgent);
      if (agentEnvErr && diagnostics.liveTokenBudgetExceeded !== 1) {
        return {
          output: parsed.output || sanitizedAgent.stdout.slice(0, 2000),
          usage,
          trajectory,
          envError: agentEnvErr,
          durationMs: Date.now() - start,
        };
      }

      const evalResult = await this.runInContainer(
        ws,
        container,
        `python_default /utils/eval.py --trajectory_path /eval/${runDir}/trajectory.jsonl --result_path /eval/${runDir}/result.json`,
        {
          timeoutMs: this.opts.evalTimeoutMs,
          cwd: '/workspace',
          env: { DECRYPTION_KEY: this.opts.decryptionKey, ...this.envLlmEnv() },
        },
      );
      await this.writeCommandArtifacts(ws, runDir, 'tac-eval', evalResult);
      if (evalResult.exitCode !== 0) {
        if (diagnostics.liveTokenBudgetExceeded === 1) {
          const budgetScore = scoreFromTacResult(
            { final_score: { total: 1, result: 0 } },
            {
              readGraph: 0,
              ...diagnostics,
              ...taxonomyMetrics(failureTaxonomy(diagnostics)),
            },
          );
          await writeLocalArtifact('failure-taxonomy.json', `${JSON.stringify(failureTaxonomy(diagnostics), null, 2)}\n`);
          return {
            output: parsed.output || sanitizedAgent.stdout.slice(0, 2000),
            usage,
            trajectory,
            selfScore: budgetScore,
            durationMs: Date.now() - start,
          };
        }
        return {
          output: parsed.output || sanitizedAgent.stdout.slice(0, 2000),
          usage,
          trajectory,
          envError: { kind: 'sandbox', message: `TAC eval failed: ${(evalResult.stderr || evalResult.stdout).slice(0, 500)}`, retriable: false },
          durationMs: Date.now() - start,
        };
      }

      const resultText = await ws.readFile(`${runDir}/result.json`);
      if (!resultText) {
        if (diagnostics.liveTokenBudgetExceeded === 1) {
          const budgetScore = scoreFromTacResult(
            { final_score: { total: 1, result: 0 } },
            {
              readGraph: 0,
              ...diagnostics,
              ...taxonomyMetrics(failureTaxonomy(diagnostics)),
            },
          );
          await writeLocalArtifact('failure-taxonomy.json', `${JSON.stringify(failureTaxonomy(diagnostics), null, 2)}\n`);
          return {
            output: parsed.output || sanitizedAgent.stdout.slice(0, 2000),
            usage,
            trajectory,
            selfScore: budgetScore,
            durationMs: Date.now() - start,
          };
        }
        return envRaw('sandbox', 'TAC eval completed but result.json was not found', start, usage, trajectory);
      }
      const resultJson = JSON.parse(resultText) as TacResultJson;
      const seededGraphInitialized = opentasksGraphSeedReport?.ok === true ? 1 : 0;
      const preludeGraphInitialized = hasOpenTasksMcpCall(opentasksPreludeTrajectory) ? 1 : 0;
      const mainGraphInspected = hasOpenTasksMcpCall(parsed.trajectory, ['mcp__opentasks__list_tasks']) ? 1 : 0;
      const mainGraphUpdated = hasOpenTasksMcpCall(parsed.trajectory, [
        'mcp__opentasks__record_attempt',
        'mcp__opentasks__update_task',
      ])
        ? 1
        : 0;
      const explicitOpenTasksServerConnections = parsed.mcpServers.filter((s) => s.name === 'opentasks' && s.status === 'connected').length;
      const observedOpenTasksToolUse = hasOpenTasksMcpCall(parsed.trajectory) || hasOpenTasksMcpCall(opentasksPreludeTrajectory);
      const mcpServersConnected = Math.max(explicitOpenTasksServerConnections, observedOpenTasksToolUse ? 1 : 0);
      const mainReadGraph = mcpServersConnected > 0 || mainGraphInspected === 1;
      const efficiencyMetrics = traceEfficiencyMetrics(parsed.trajectory, {
        seededTaskId: opentasksGraphSeedReport?.taskId,
      });
      const score = scoreFromTacResult(resultJson, {
        readGraph: mainReadGraph ? 1 : 0,
        seededGraphInitialized,
        preludeGraphInitialized,
        mainGraphInspected,
        mainGraphUpdated,
        mcpServersConnected,
        ...efficiencyMetrics,
        ...diagnostics,
        ...taxonomyMetricsForTacResult(resultJson, diagnostics),
      });
      await writeLocalArtifact('failure-taxonomy.json', `${JSON.stringify(failureTaxonomy(diagnostics), null, 2)}\n`);
      return {
        output: parsed.output || sanitizedAgent.stdout.slice(0, 2000),
        usage,
        trajectory,
        selfScore: score,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return envRaw('crash', message, start);
    } finally {
      if (created) await ws.run(`${this.dockerCommand()} rm -f ${shq(container)} >/dev/null 2>&1 || true`, { timeoutMs: 60_000 }).catch(() => undefined);
    }
  }

  private dockerRunCommand(cell: PublicCell, container: string, image: string, workspaceRoot: string): string {
    const args = [
      this.dockerCommand(),
      'run',
      '-d',
      '--name',
      shq(container),
      '--network',
      shq(this.opts.network),
      '-v',
      shq(`${workspaceRoot}:/eval`),
    ];
    if (usesOpenTasks(cell) && this.opts.opentasksMount) {
      args.push('-v', shq(`${path.resolve(this.opts.opentasksMount)}:${this.opentasksDir()}:ro`));
    }
    args.push('--entrypoint', 'tail', shq(image), '-f', '/dev/null');
    return args.join(' ');
  }

  private async runInContainer(
    ws: Workspace,
    container: string,
    command: string,
    opts: {
      timeoutMs: number;
      cwd: string;
      env?: Record<string, string>;
      allowEmpty?: boolean;
      user?: string;
    },
  ) {
    if (opts.allowEmpty && !command.trim()) return { exitCode: 0, stdout: '', stderr: '' };
    const envArgs = Object.entries(opts.env ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
      .join(' ');
    const userArg = opts.user ? `-u ${shq(opts.user)}` : '';
    const cmd = `${this.dockerCommand()} exec ${userArg} -w ${shq(opts.cwd)} ${envArgs} ${shq(container)} sh -lc ${shq(command)}`;
    return ws.run(cmd, { timeoutMs: opts.timeoutMs });
  }

  private agentCommand(cell: PublicCell, runDir: string, priorUsage: TokenUsage = ZERO_USAGE): string {
    const command = this.agentCliCommand({
      cell,
      prompt: `"$(cat /eval/${runDir}/prompt.txt)"`,
      runDir,
      includeSystemPrompt: cell.arm.scaffold.systemPromptAppendix ? `/eval/${runDir}/system.txt` : undefined,
    });
    return this.withLiveTokenMonitor(command, runDir, remainingLiveTokenLimit(this.opts.liveTokenLimit, priorUsage));
  }

  private opentasksMcpSmokeCommand(cell: PublicCell, runDir: string): string {
    const prompt = this.usesSwarmHarnessSwarmMode()
      ? [
          'This is a TAC swarm-harness OpenTasks coordination smoke test.',
          'Call the native swarm task tool task_list once; do not echo or simulate the tool name in Bash.',
          'Then answer exactly: opentasks swarm smoke complete',
          'Do not solve the TAC task.',
        ]
      : [
          'This is a TAC OpenTasks MCP smoke test.',
          'Use the opentasks skill if available.',
          'If the OpenTasks tool is still pending or not visible, use ToolSearch with query select:mcp__opentasks__list_tasks.',
          'Call the native MCP tool mcp__opentasks__list_tasks once; do not echo or simulate the tool name in Bash.',
          'Then answer exactly: opentasks mcp smoke complete',
          'Do not solve the TAC task.',
        ];
    return this.agentCliCommand({
      cell,
      prompt: shq(prompt.join(' ')),
      runDir,
      includeSystemPrompt: cell.arm.scaffold.systemPromptAppendix ? `/eval/${runDir}/system.txt` : undefined,
    });
  }

  private usesSwarmHarnessSwarmMode(): boolean {
    if (this.agentHarness.id !== 'swarm-harness') return false;
    const mode = (this.opts.env?.TAC_SWARM_HARNESS_MODE ?? process.env.TAC_SWARM_HARNESS_MODE ?? 'single').trim();
    return ['swarm', 'swarm-run', 'multi', 'multi-agent'].includes(mode);
  }

  private opentasksGraphSeedCommand(cell: PublicCell, runDir: string): string {
    const cli = `${this.opentasksDir()}/dist/cli.js`;
    const script = [
      'import json',
      'import os',
      'import subprocess',
      'import sys',
      '',
      `run_dir = ${JSON.stringify(runDir)}`,
      `cli = ${JSON.stringify(cli)}`,
      `cell_key = ${JSON.stringify(cell.cellKey)}`,
      `task_id = ${JSON.stringify(cell.task.id)}`,
      `arm_id = ${JSON.stringify(cell.arm.id)}`,
      `model = ${JSON.stringify(cell.model.name)}`,
      `seed = ${JSON.stringify(cell.seed)}`,
      'task_path = "/instruction/task.md"',
      'report_path = f"/eval/{run_dir}/opentasks-graph-seed-report.json"',
      'summary_path = f"/eval/{run_dir}/opentasks-graph-seed-summary.txt"',
      'with open(task_path, "r", encoding="utf-8", errors="replace") as f:',
      '    task_text = f.read().strip()',
      'def compact_title(text, fallback, max_len=180):',
      '    first = next((line.strip() for line in text.splitlines() if line.strip()), "")',
      '    first = " ".join(first.split())',
      '    if not first:',
      '        return fallback',
      '    if len(first) <= max_len:',
      '        return first',
      '    head_len = max_len - 55',
      '    tail = first[-50:]',
      '    return f"{first[:head_len].rstrip()} ... {tail.lstrip()}"',
      'title = compact_title(task_text, f"TAC task {task_id}")',
      'metadata = {',
      '    "tac": {',
      '        "deterministicGraphSeed": True,',
      '        "source": task_path,',
      '        "cellKey": cell_key,',
      '        "taskId": task_id,',
      '        "armId": arm_id,',
      '        "model": model,',
      '        "seed": seed,',
      '    }',
      '}',
      'cmd = [',
      '    "node", cli, "create",',
      '    "--type", "task",',
      '    "--title", title,',
      '    "--status", "open",',
      '    "--content", task_text,',
      '    "--tags", "tac,seeded",',
      '    "--priority", "2",',
      '    "--metadata", json.dumps(metadata, sort_keys=True),',
      ']',
      'proc = subprocess.run(cmd, text=True, capture_output=True)',
      'created = None',
      'error = None',
      'if proc.stdout.strip():',
      '    try:',
      '        created = json.loads(proc.stdout)',
      '    except Exception as exc:',
      '        error = f"could not parse opentasks create output: {exc}"',
      'elif proc.returncode == 0:',
      '    error = "opentasks create succeeded without JSON output"',
      'if proc.returncode != 0 and not error:',
      '    error = (proc.stderr or proc.stdout or "opentasks create failed").strip()',
      'task_node_id = created.get("id") if isinstance(created, dict) else None',
      'report = {',
      '    "ok": proc.returncode == 0 and bool(task_node_id),',
      '    "taskId": task_node_id,',
      '    "taskTitle": title,',
      '    "sourceTaskId": task_id,',
      '    "cellKey": cell_key,',
      '    "idempotencyKey": None,',
      '    "contentBytes": len(task_text.encode("utf-8")),',
      '    "tags": ["tac", "seeded"],',
      '    "created": created,',
      '    "exitCode": proc.returncode,',
      '    "error": error,',
      '    "stdoutHead": proc.stdout[:1000],',
      '    "stderrHead": proc.stderr[:1000],',
      '}',
      'with open(report_path, "w", encoding="utf-8") as f:',
      '    json.dump(report, f, indent=2, sort_keys=True)',
      '    f.write("\\n")',
      'summary = "\\n".join([',
      '    f"status: {\'ok\' if report[\'ok\'] else \'failed\'}",',
      '    f"taskId: {task_node_id or \'none\'}",',
      '    f"title: {title}",',
      '    f"source: {task_path}",',
      ']) + "\\n"',
      'with open(summary_path, "w", encoding="utf-8") as f:',
      '    f.write(summary)',
      'print(json.dumps(report, sort_keys=True))',
      'sys.exit(0 if report["ok"] else 1)',
    ].join('\n');
    return `export OPENTASKS_PROJECT_DIR=${shq(OPENTASKS_PROJECT_DIR)}; python_default -c ${shq(script)}`;
  }

  private opentasksTaskPreludeCommand(cell: PublicCell, runDir: string, attempt = 1): string {
    return this.agentCliCommand({
      cell,
      prompt: shq(
        [
          'This is a mandatory OpenTasks planning prelude for a TAC task.',
          `Prelude attempt ${attempt}.`,
          'Do not implement the TAC task and do not modify GitLab, files, or repositories.',
          'Read /instruction/task.md.',
          'Use the opentasks skill.',
          'If OpenTasks tools are pending or not visible, use ToolSearch with select:mcp__opentasks__create_task and select:mcp__opentasks__record_attempt.',
          'Call native mcp__opentasks__create_task for the top-level TAC task.',
          'Call native mcp__opentasks__record_attempt to record the planned attempt and evidence target.',
          'Call native mcp__opentasks__list_tasks once to verify the graph.',
          'Answer with a concise summary beginning exactly: opentasks task prelude complete',
        ].join(' '),
      ),
      runDir,
      includeSystemPrompt: cell.arm.scaffold.systemPromptAppendix ? `/eval/${runDir}/system.txt` : undefined,
      tools: ['Read', 'Skill', 'ToolSearch', ...(cell.arm.scaffold.extraTools ?? []).filter((tool) => tool.startsWith(OPENTASKS_MCP_TOOL_PREFIX))],
    });
  }

  private agentCliCommand(opts: {
    cell: PublicCell;
    prompt: string;
    runDir: string;
    includeSystemPrompt?: string;
    tools?: string[];
  }): string {
    const tools = opts.tools ?? [...TAC_BASE_TOOLS, ...(opts.cell.arm.scaffold.extraTools ?? [])];
    return this.agentHarness.buildCommand({
      prompt: opts.prompt,
      model: opts.cell.model.name,
      runDir: opts.runDir,
      tools,
      allowedTools: this.opts.allowedTools !== false,
      strictMcpConfig: this.opts.strictMcpConfig !== false,
      includeSystemPrompt: opts.includeSystemPrompt,
    });
  }

  private withLiveTokenMonitor(command: string, runDir: string, tokenLimit: number | undefined): string {
    if (!tokenLimit || tokenLimit <= 0) return command;
    const stdoutPath = `/eval/${runDir}/agent-stream-live.jsonl`;
    const stderrPath = `/eval/${runDir}/agent-stderr-live.log`;
    const markerPath = `/eval/${runDir}/agent-live-token-budget.json`;
    const monitor = [
      'import json, os, signal, sys, time',
      'stdout_path, marker_path, limit_raw, pid_raw = sys.argv[1:5]',
      'limit = int(limit_raw)',
      'pid = int(pid_raw)',
      'def num(value):',
      '    return value if isinstance(value, (int, float)) else 0',
      'def total_tokens():',
      '    total = 0',
      '    final_total = None',
      '    try:',
      '        with open(stdout_path, "r", encoding="utf-8", errors="replace") as f:',
      '            for line in f:',
      '                line = line.strip()',
      '                if not line.startswith("{"):',
      '                    continue',
      '                try:',
      '                    obj = json.loads(line)',
      '                except Exception:',
      '                    continue',
      '                if obj.get("type") == "assistant":',
      '                    usage = ((obj.get("message") or {}).get("usage") or {})',
      '                    total += num(usage.get("input_tokens")) + num(usage.get("output_tokens")) + num(usage.get("cache_read_input_tokens")) + num(usage.get("cache_creation_input_tokens"))',
      '                elif obj.get("type") == "result":',
      '                    model_usage = obj.get("modelUsage") or {}',
      '                    if model_usage:',
      '                        final_total = sum(num(u.get("inputTokens", u.get("input_tokens"))) + num(u.get("outputTokens", u.get("output_tokens"))) + num(u.get("cacheReadInputTokens", u.get("cache_read_input_tokens"))) + num(u.get("cacheCreationInputTokens", u.get("cache_creation_input_tokens"))) for u in model_usage.values())',
      '                    else:',
      '                        usage = obj.get("usage") or {}',
      '                        final_total = num(usage.get("input_tokens")) + num(usage.get("output_tokens")) + num(usage.get("cache_read_input_tokens")) + num(usage.get("cache_creation_input_tokens"))',
      '                elif obj.get("type") == "message_stop":',
      '                    usage = obj.get("usage") or {}',
      '                    final_total = num(usage.get("inputTokens", usage.get("input_tokens"))) + num(usage.get("outputTokens", usage.get("output_tokens"))) + num(usage.get("cacheReadInputTokens", usage.get("cache_read_input_tokens"))) + num(usage.get("cacheCreationInputTokens", usage.get("cache_creation_input_tokens")))',
      '    except FileNotFoundError:',
      '        return 0',
      '    return int(final_total if final_total is not None else total)',
      'while True:',
      '    try:',
      '        os.kill(pid, 0)',
      '    except OSError:',
      '        break',
      '    tokens = total_tokens()',
      '    if tokens > limit:',
      '        report = {"reason": "tokens_live", "tokens": tokens, "limit": limit}',
      '        with open(marker_path, "w", encoding="utf-8") as f:',
      '            json.dump(report, f, sort_keys=True)',
      '            f.write("\\n")',
      '        print("TAC live token budget exceeded: %s > %s" % (tokens, limit), file=sys.stderr)',
      '        for sig in (signal.SIGTERM, signal.SIGKILL):',
      '            try:',
      '                os.kill(pid, sig)',
      '            except OSError:',
      '                pass',
      '            time.sleep(5)',
      '        break',
      '    time.sleep(2)',
    ].join('\n');
    return [
      `rm -f ${shq(stdoutPath)} ${shq(stderrPath)} ${shq(markerPath)}`,
      `${command} >${shq(stdoutPath)} 2>${shq(stderrPath)} &`,
      'agent_pid=$!',
      `python_default -c ${shq(monitor)} ${shq(stdoutPath)} ${shq(markerPath)} ${shq(String(tokenLimit))} "$agent_pid" >&2 &`,
      'monitor_pid=$!',
      'wait "$agent_pid"; agent_status=$?',
      'kill "$monitor_pid" >/dev/null 2>&1 || true',
      'wait "$monitor_pid" >/dev/null 2>&1 || true',
      `cat ${shq(stdoutPath)} 2>/dev/null || true`,
      `cat ${shq(stderrPath)} >&2 2>/dev/null || true`,
      `test ! -f ${shq(markerPath)} || exit 124`,
      'exit "$agent_status"',
    ].join('\n');
  }

  private mainPromptWithGraphSeed(seedReport: OpenTasksGraphSeedReport): string {
    return [
      buildTacAgentPrompt({
        operatingPrompt: this.opts.operatingPrompt,
        appendix: this.opts.agentPromptAppendix,
      }).trimEnd(),
      '',
      'OpenTasks graph has been deterministically seeded for this TAC run.',
      'Use the opentasks skill for the minimal TAC graph protocol.',
      'Required OpenTasks protocol before task-specific Bash exploration:',
      `1. Call native mcp__opentasks__get_task with seeded task id ${seedReport.taskId} and read the full content before any task-specific Bash, curl, git, python, or service API work.`,
      '2. If the native get_task tool is hidden or pending, call ToolSearch with query select:mcp__opentasks__get_task, then call the returned native tool directly.',
      '3. After ToolSearch returns mcp__opentasks__get_task, the next tool call should be mcp__opentasks__get_task with the seeded id.',
      '4. Do not insert Bash status commands such as echo, printf, or logging between ToolSearch and this get_task call.',
      '5. Do not read /instruction/task.md before this get_task call unless get_task is unavailable after one exact ToolSearch attempt.',
      '6. Do not run mcp__opentasks__get_task in Bash, Python, or node; do not fetch OpenTasks over curl; do not ask a subagent to do this read.',
      '7. Use mcp__opentasks__list_tasks only as a fallback if the seeded id is missing or get_task reports not found.',
      `8. Use seeded task id ${seedReport.taskId} for OpenTasks updates. Do not create a duplicate top-level task unless this seeded task is missing.`,
      '9. Use Bash, curl, git, python, and service APIs for the TAC work itself.',
      '10. After verified success or failure, record one final outcome and concrete verification evidence with mcp__opentasks__record_attempt or mcp__opentasks__update_task.',
      'Only add a mid-task OpenTasks update for a material blocker, changed target, or important verification result.',
      'Do not create subtasks for simple single-action TAC tasks. Stop updating the graph after verified success.',
      'Do not echo, shell out, or simulate mcp__opentasks__ tool names.',
      '',
      'Seed summary:',
      this.opentasksGraphSeedSummary(seedReport).trimEnd(),
      '',
    ].join('\n');
  }

  private mainPromptWithPrelude(preludeReport: OpenTasksTaskPreludeReport): string {
    const preludeSummary = this.opentasksTaskPreludeSummary(preludeReport);
    const opentasksInstructions =
      preludeReport.ok === true
        ? [
            'OpenTasks task prelude has already initialized the task graph for this run.',
            'Required OpenTasks protocol before task-specific Bash exploration:',
            '1. Use ToolSearch with select:mcp__opentasks__list_tasks.',
            '2. Call native mcp__opentasks__list_tasks to inspect the existing graph.',
            '3. Use the existing task id for OpenTasks updates; do not create a duplicate top-level task.',
            '4. After verified success or failure, record one final outcome and concrete verification evidence with mcp__opentasks__record_attempt or mcp__opentasks__update_task.',
            'Only add a mid-task OpenTasks update for a material blocker, changed target, or important verification result.',
          ]
        : [
            'OpenTasks task prelude did not successfully initialize the task graph for this run.',
            'Required first step before any Bash, Read, Write, Edit, Glob, or Grep call: try to initialize OpenTasks yourself with native MCP tools.',
            'Use ToolSearch with select:mcp__opentasks__create_task, select:mcp__opentasks__record_attempt, and select:mcp__opentasks__list_tasks, then call those native MCP tools.',
            'If OpenTasks remains unavailable, continue solving the TAC task and record useful evidence in your final answer.',
          ];
    return [
      buildTacAgentPrompt({
        operatingPrompt: this.opts.operatingPrompt,
        appendix: this.opts.agentPromptAppendix,
      }).trimEnd(),
      '',
      ...opentasksInstructions,
      'Do not echo, shell out, or simulate mcp__opentasks__ tool names.',
      '',
      'Prelude summary:',
      preludeSummary.trimEnd(),
      '',
    ].join('\n');
  }

  private agentSetup(): string {
    return this.opts.agentSetupCommand ?? tacDefaultAgentSetupCommand(this.agentHarness, this.opts.agentUser);
  }

  private tacAgentHelperInstallCommand(): string {
    const helper = [
      '#!/usr/bin/env python3',
      'import json',
      'import os',
      'import sys',
      'import urllib.error',
      'import urllib.parse',
      'import urllib.request',
      '',
      'USAGE = """usage: tac-gitlab-api METHOD PATH [JSON_BODY]',
      '',
      'Examples:',
      '  tac-gitlab-api GET projects/root/repo',
      '  tac-gitlab-api GET projects/root/repo/repository/branches/main',
      '  tac-gitlab-api DELETE projects/root/repo/repository/branches/feature/old',
      '  tac-gitlab-api POST projects/root/repo/issues \'{"title":"Done"}\'',
      '',
      'PATH may be a full URL, an /api/v4 path, or shorthand such as projects/root/repo.',
      'The helper adds PRIVATE-TOKEN, redacts root-token, caps output, and encodes common GitLab project paths.',
      '"""',
      '',
      'def main():',
      '    if len(sys.argv) == 2 and sys.argv[1] in {"-h", "--help", "help"}:',
      '        print(USAGE)',
      '        return 0',
      '    if len(sys.argv) < 3:',
      '        print(USAGE, file=sys.stderr)',
      '        return 2',
      '    method = sys.argv[1].upper()',
      '    path = sys.argv[2]',
      '    body_arg = sys.argv[3] if len(sys.argv) > 3 else None',
      '    base_url = os.environ.get("GITLAB_BASE_URL", "http://the-agent-company.com:8929").rstrip("/")',
      '    token = os.environ.get("GITLAB_TOKEN") or os.environ.get("GITLAB_ACCESS_TOKEN") or "root-token"',
      '    max_bytes = int(os.environ.get("TAC_HELPER_MAX_OUTPUT_BYTES", "6000"))',
      '',
      '    if path.startswith("http://") or path.startswith("https://"):',
      '        url = path',
      '    else:',
      '        if not path.startswith("/"):',
      '            path = "/" + path',
      '        path, sep, query = path.partition("?")',
      '        path = normalize_api_path(path) + ((sep + query) if sep else "")',
      '        url = base_url + path',
      '',
      '    data = None',
      '    headers = {"PRIVATE-TOKEN": token, "Accept": "application/json"}',
      '    if body_arg is not None:',
      '        if body_arg == "@-":',
      '            body_arg = sys.stdin.read()',
      '        elif body_arg.startswith("@"):',
      '            with open(body_arg[1:], "r", encoding="utf-8") as f:',
      '                body_arg = f.read()',
      '        data = body_arg.encode("utf-8")',
      '        headers["Content-Type"] = "application/json"',
      '',
      '    req = urllib.request.Request(url, data=data, method=method, headers=headers)',
      '    status = 0',
      '    raw = b""',
      '    content_type = ""',
      '    try:',
      '        with urllib.request.urlopen(req, timeout=30) as resp:',
      '            status = resp.status',
      '            content_type = resp.headers.get("content-type", "")',
      '            raw = resp.read(max_bytes + 1)',
      '    except urllib.error.HTTPError as e:',
      '        status = e.code',
      '        content_type = e.headers.get("content-type", "") if e.headers else ""',
      '        raw = e.read(max_bytes + 1)',
      '    except Exception as e:',
      '        print(json.dumps({"ok": False, "error": str(e), "url": redact(url)}, sort_keys=True))',
      '        return 1',
      '',
      '    truncated = len(raw) > max_bytes',
      '    raw = raw[:max_bytes]',
      '    text = raw.decode("utf-8", errors="replace")',
      '    print(f"HTTP {status} {method} {redact(url)}")',
      '    if "json" in content_type.lower():',
      '        try:',
      '            print(json.dumps(json.loads(text), indent=2, sort_keys=True))',
      '        except Exception:',
      '            print(text)',
      '    else:',
      '        print(text)',
      '    if truncated:',
      '        print(f"\\n[truncated by tac-gitlab-api at {max_bytes} bytes]", file=sys.stderr)',
      '    return 0 if 200 <= status < 300 else 1',
      '',
      'def redact(value):',
      '    return value.replace("root-token", "[REDACTED_TAC_GITLAB_TOKEN]")',
      '',
      'def normalize_api_path(path):',
      '    if path == "/api/v4" or path.startswith("/api/v4/"):',
      '        return path',
      '    first = path.strip("/").split("/", 1)[0]',
      '    api_roots = {',
      '        "application",',
      '        "broadcast_messages",',
      '        "groups",',
      '        "hooks",',
      '        "issues",',
      '        "namespaces",',
      '        "projects",',
      '        "repository",',
      '        "runners",',
      '        "search",',
      '        "snippets",',
      '        "todos",',
      '        "user",',
      '        "users",',
      '    }',
      '    if first in api_roots:',
      '        if first == "projects":',
      '            path = normalize_projects_path(path)',
      '        return "/api/v4" + path',
      '    return path',
      '',
      'PROJECT_SUBRESOURCES = {',
      '    "access_tokens", "approvals", "archive", "badges", "branches", "clusters", "commits",',
      '    "deploy_keys", "deploy_tokens", "environments", "events", "export", "fork", "hooks",',
      '    "issues", "jobs", "labels", "languages", "members", "merge_requests", "milestones",',
      '    "packages", "pages", "pipeline", "pipelines", "protected_branches", "releases",',
      '    "repository", "runners", "search", "services", "share", "snippets", "starrers",',
      '    "statuses", "tags", "triggers", "uploads", "variables", "wikis",',
      '}',
      '',
      'def normalize_projects_path(path):',
      '    parts = path.strip("/").split("/")',
      '    if len(parts) < 2 or parts[0] != "projects":',
      '        return path',
      '    project = parts[1]',
      '    if project.isdigit() or "%" in project:',
      '        suffix = normalize_project_suffix(parts[2:])',
      '        return "/projects/" + project + ("/" + "/".join(suffix) if suffix else "")',
      '    subresource_index = None',
      '    for index in range(2, len(parts)):',
      '        if parts[index] in PROJECT_SUBRESOURCES:',
      '            subresource_index = index',
      '            break',
      '    project_parts = parts[1:subresource_index] if subresource_index is not None else parts[1:]',
      '    suffix = parts[subresource_index:] if subresource_index is not None else []',
      '    encoded_project = urllib.parse.quote("/".join(project_parts), safe="")',
      '    suffix = normalize_project_suffix(suffix)',
      '    return "/projects/" + encoded_project + ("/" + "/".join(suffix) if suffix else "")',
      '',
      'def normalize_project_suffix(suffix):',
      '    if len(suffix) > 3 and suffix[0] == "repository" and suffix[1] == "files" and suffix[-1] == "raw":',
      '        return suffix[:2] + [quote_path_tail(suffix[2:-1]), "raw"]',
      '    if len(suffix) > 2 and suffix[0] == "repository" and suffix[1] in {"branches", "files", "tags"}:',
      '        return suffix[:2] + [quote_path_tail(suffix[2:])]',
      '    if len(suffix) > 1 and suffix[0] in {"protected_branches", "wikis"}:',
      '        return suffix[:1] + [quote_path_tail(suffix[1:])]',
      '    return suffix',
      '',
      'def quote_path_tail(parts):',
      '    # Agents often retry with an already-encoded branch/wiki slug. Decode once',
      '    # before quoting so feature%2Fssl stays feature%2Fssl, not feature%252Fssl.',
      '    return urllib.parse.quote(urllib.parse.unquote("/".join(parts)), safe="")',
      '',
      'if __name__ == "__main__":',
      '    raise SystemExit(main())',
    ].join('\n');
    const protectedBranchHelper = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'usage() {',
      '  cat >&2 <<\'EOF\'',
      'usage: tac-gitlab-protect-branch PROJECT BRANCH PUSH_LEVEL MERGE_LEVEL',
      '',
      'Examples:',
      '  tac-gitlab-protect-branch root/repo main 0 30',
      '  tac-gitlab-protect-branch projects/root/repo main 0 40',
      '',
      'Access levels: 0 no one, 30 developers, 40 maintainers.',
      'This helper delete/recreates a GitLab protected branch and verifies the final state.',
      'EOF',
      '}',
      'if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -ne 4 ]; then',
      '  usage',
      '  [ "$#" -eq 4 ] || exit 2',
      'fi',
      'project="$1"',
      'branch="$2"',
      'push_level="$3"',
      'merge_level="$4"',
      'project="${project#/api/v4/projects/}"',
      'project="${project#api/v4/projects/}"',
      'project="${project#/projects/}"',
      'project="${project#projects/}"',
      'case "$push_level" in ""|*[!0-9]*) echo "push level must be numeric" >&2; exit 2 ;; esac',
      'case "$merge_level" in ""|*[!0-9]*) echo "merge level must be numeric" >&2; exit 2 ;; esac',
      'delete_log="$(mktemp)"',
      'tac-gitlab-api DELETE "projects/${project}/protected_branches/${branch}" >"$delete_log" 2>&1 || true',
      'body="$(printf \'{"name":"%s","push_access_level":%s,"merge_access_level":%s}\' "$branch" "$push_level" "$merge_level")"',
      'tac-gitlab-api POST "projects/${project}/protected_branches" "$body"',
      'tac-gitlab-api GET "projects/${project}/protected_branches/${branch}"',
    ].join('\n');
    return [
      'set -e',
      `cat > /usr/local/bin/tac-gitlab-api <<'PY'\n${helper}\nPY`,
      'chmod +x /usr/local/bin/tac-gitlab-api',
      `cat > /usr/local/bin/tac-gitlab-protect-branch <<'SH'\n${protectedBranchHelper}\nSH`,
      'chmod +x /usr/local/bin/tac-gitlab-protect-branch',
      'command -v tac-gitlab-api >/dev/null',
      'command -v tac-gitlab-protect-branch >/dev/null',
    ].join('\n');
  }

  private initEnv(): Record<string, string> {
    return {
      SERVER_HOSTNAME: this.opts.serverHostname,
      ...this.envLlmEnv(),
    };
  }

  private agentEnv(cell: PublicCell): Record<string, string> {
    return {
      NO_COLOR: '1',
      DISABLE_OMC: '1',
      OMC_SKIP_HOOKS: '1',
      EVAL_TASK_ID: cell.task.id,
      EVAL_ARM_ID: cell.arm.id,
      GITLAB_BASE_URL: `http://${this.opts.serverHostname}:8929`,
      GITLAB_TOKEN: 'root-token',
      GITLAB_USER: 'root',
      GITLAB_PASSWORD: 'theagentcompany',
      TAC_HELPER_MAX_OUTPUT_BYTES: this.opts.env?.TAC_HELPER_MAX_OUTPUT_BYTES ?? '6000',
      ...(this.opts.agentUser ? { HOME: `/home/${this.opts.agentUser}` } : {}),
      ...(usesOpenTasks(cell) ? { OPENTASKS_PROJECT_DIR } : {}),
      ...(usesOpenTasks(cell) && this.usesSwarmHarnessSwarmMode() ? { TAC_SWARM_HARNESS_OPENTASKS: '1' } : {}),
      ...this.opts.env,
      ...(cell.arm.scaffold.env ?? {}),
    };
  }

  private async writeCommandArtifacts(
    ws: Workspace,
    runDir: string,
    prefix: string,
    command: CommandResult,
  ): Promise<void> {
    const stdout = redactSensitiveText(command.stdout);
    const stderr = redactSensitiveText(command.stderr);
    const result = `${JSON.stringify(
      {
        exitCode: command.exitCode,
        timedOut: command.timedOut === true,
        stdoutBytes: command.stdout.length,
        stderrBytes: command.stderr.length,
      },
      null,
      2,
    )}\n`;
    await ws.writeFiles([
      { path: `${runDir}/${prefix}-stdout.log`, content: stdout },
      { path: `${runDir}/${prefix}-stderr.log`, content: stderr },
      { path: `${runDir}/${prefix}-result.json`, content: result },
    ]);
    await writeLocalArtifact(`${prefix}-stdout.log`, stdout);
    await writeLocalArtifact(`${prefix}-stderr.log`, stderr);
    await writeLocalArtifact(`${prefix}-result.json`, result);
  }

  private async taskRequiresGitlab(ws: Workspace, container: string): Promise<boolean> {
    const deps = await this.runInContainer(ws, container, this.gitlabDependencyProbeCommand(), {
      timeoutMs: 30_000,
      cwd: '/workspace',
      env: this.initEnv(),
    });
    return deps.exitCode === 0;
  }

  private gitlabDependencyProbeCommand(): string {
    return "test -f /utils/dependencies.yml && grep -Eq '(^|[^A-Za-z0-9_])gitlab([^A-Za-z0-9_]|$)' /utils/dependencies.yml";
  }

  private async runGitlabAwareTacInit(
    ws: Workspace,
    container: string,
    runDir: string,
    start: number,
  ): Promise<(CommandResult & { gitlabRootTokenRefreshed: boolean }) | { raw: RawRun }> {
    if (this.opts.tacGitlabTokenRefresh === false) {
      const init = await this.runInContainer(ws, container, 'bash /utils/init.sh', {
        timeoutMs: this.opts.initTimeoutMs,
        cwd: '/workspace',
        env: this.initEnv(),
      });
      return { ...init, gitlabRootTokenRefreshed: false };
    }

    const reset = await this.runInContainer(ws, container, this.tacResetWithHostAliasCommand(), {
      timeoutMs: this.opts.initTimeoutMs,
      cwd: '/workspace',
      env: this.initEnv(),
    });
    await this.writeCommandArtifacts(ws, runDir, 'tac-reset', reset);
    if (reset.exitCode !== 0) return { ...reset, gitlabRootTokenRefreshed: false };

    const tokenRefresh = await this.refreshTacGitlabRootToken(ws);
    await this.writeCommandArtifacts(ws, runDir, 'tac-gitlab-token-refresh', tokenRefresh);
    if (!this.tacGitlabRootTokenRefreshOk(tokenRefresh)) {
      return { raw: envRaw('sandbox', `TAC GitLab token refresh failed: ${tokenRefresh.stderr || tokenRefresh.stdout}`, start) };
    }

    const readiness = await this.runInContainer(ws, container, this.tacGitlabApiReadinessCommand(runDir), {
      timeoutMs: Math.min(this.opts.initTimeoutMs, 240_000),
      cwd: '/workspace',
      env: this.initEnv(),
    });
    await this.writeCommandArtifacts(ws, runDir, 'tac-gitlab-api-readiness', readiness);
    const readinessReport = await ws.readFile(`${runDir}/tac-gitlab-api-readiness.json`);
    if (readinessReport) await writeLocalArtifact('tac-gitlab-api-readiness.json', redactSensitiveText(readinessReport));
    if (readiness.exitCode !== 0) {
      return { raw: envRaw('sandbox', `TAC GitLab API readiness failed: ${readiness.stderr || readiness.stdout}`, start) };
    }

    const init = await this.runInContainer(ws, container, this.tacInitWithoutResetCommand(), {
      timeoutMs: this.opts.initTimeoutMs,
      cwd: '/workspace',
      env: this.initEnv(),
    });
    return { ...init, gitlabRootTokenRefreshed: true };
  }

  private tacInitWithoutResetCommand(): string {
    return [
      "python_default - <<'PY'",
      'from pathlib import Path',
      '',
      'source = Path("/utils/init.sh").read_text()',
      'lines = source.splitlines()',
      'out = []',
      'skip_reset_echo = False',
      'removed_reset = False',
      'for line in lines:',
      '    stripped = line.strip()',
      '    if not removed_reset and stripped == \'echo "Resetting services..."\':',
      '        skip_reset_echo = True',
      '        continue',
      '    if skip_reset_echo and stripped == "bash /utils/reset.sh":',
      '        removed_reset = True',
      '        skip_reset_echo = False',
      '        continue',
      '    if skip_reset_echo:',
      '        out.append(\'echo "Resetting services..."\')',
      '        skip_reset_echo = False',
      '    out.append(line)',
      'if not removed_reset:',
      '    raise SystemExit("could not remove reset step from /utils/init.sh")',
      'Path("/tmp/tac-init-without-reset.sh").write_text("\\n".join(out) + "\\n")',
      'PY',
      'bash /tmp/tac-init-without-reset.sh',
    ].join('\n');
  }

  private tacResetWithHostAliasCommand(): string {
    return [
      'SERVICE_IP=$(ping -c 1 ${SERVER_HOSTNAME:-localhost} | grep PING | awk -F"[()]" \'{print $2}\')',
      'echo "$SERVICE_IP the-agent-company.com" >> /etc/hosts',
      'bash /utils/reset.sh',
    ].join('\n');
  }

  private tacGitlabApiReadinessCommand(runDir: string): string {
    const outPath = `/eval/${runDir}/tac-gitlab-api-readiness.json`;
    return [
      `cat > /tmp/tac-gitlab-api-readiness.py <<'PY'`,
      'import datetime',
      'import json',
      'import os',
      'import re',
      'import sys',
      'import time',
      'import urllib.error',
      'import urllib.parse',
      'import urllib.request',
      '',
      'OUT_PATH = sys.argv[1]',
      'HOST = os.environ.get("SERVER_HOSTNAME") or "the-agent-company.com"',
      'BASE = f"http://{HOST}:8929/api/v4"',
      'TOKEN = os.environ.get("GITLAB_ACCESS_TOKEN") or "root-token"',
      'HEADERS = {"PRIVATE-TOKEN": TOKEN}',
      'PROJECT_RE = re.compile(r\'(?:GITLAB_PROJECT_PATH|PROJECT_PATH)\\s*=\\s*f?[\\\'"]\\{GITLAB_USER\\}/([^\\\'"]+)[\\\'"]\')',
      '',
      'def read_text(path):',
      '    try:',
      '        with open(path, "r") as f:',
      '            return f.read()',
      '    except Exception:',
      '        return ""',
      '',
      'def project_candidates():',
      '    candidates = []',
      '    for path in ("/utils/populate_data.py", "/utils/evaluator.py"):',
      '        for match in PROJECT_RE.finditer(read_text(path)):',
      '            project = match.group(1).strip("/")',
      '            if project and "{" not in project and "}" not in project:',
      '                candidates.append(f"root/{project}")',
      '    return sorted(set(candidates))',
      '',
      'def get_json(path):',
      '    req = urllib.request.Request(f"{BASE}{path}", headers=HEADERS)',
      '    with urllib.request.urlopen(req, timeout=20) as resp:',
      '        body = resp.read().decode("utf-8", "replace")',
      '        return resp.status, json.loads(body), body[:1000]',
      '',
      'def validate_once():',
      '    checks = []',
      '    status, user, body = get_json("/user")',
      '    checks.append({"name": "user", "status": status, "ok": isinstance(user, dict) and user.get("username") == "root", "body": body[:300]})',
      '    status, projects, body = get_json("/projects?per_page=1")',
      '    checks.append({"name": "projects-list", "status": status, "ok": isinstance(projects, list), "body": body[:300]})',
      '    for project in project_candidates():',
      '        encoded = urllib.parse.quote(project, safe="")',
      '        status, project_body, body = get_json(f"/projects/{encoded}")',
      '        checks.append({"name": f"project:{project}", "status": status, "ok": isinstance(project_body, dict) and project_body.get("path_with_namespace") == project, "body": body[:300]})',
      '        status, issues, body = get_json(f"/projects/{encoded}/issues?per_page=1")',
      '        checks.append({"name": f"issues:{project}", "status": status, "ok": isinstance(issues, list), "body": body[:300]})',
      '    return checks',
      '',
      'last = []',
      'for attempt in range(1, 121):',
      '    try:',
      '        last = validate_once()',
      '        if all(check.get("ok") for check in last):',
      '            report = {"ok": True, "attempt": attempt, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "checks": last}',
      '            with open(OUT_PATH, "w") as f:',
      '                json.dump(report, f, indent=2, sort_keys=True)',
      '                f.write("\\n")',
      '            print(json.dumps(report, sort_keys=True))',
      '            raise SystemExit(0)',
      '    except Exception as exc:',
      '        last = [{"name": "exception", "ok": False, "error": str(exc)}]',
      '    print(f"waiting for GitLab API readiness attempt {attempt}/120: {last}", file=sys.stderr)',
      '    time.sleep(2)',
      '',
      'report = {"ok": False, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "checks": last}',
      'with open(OUT_PATH, "w") as f:',
      '    json.dump(report, f, indent=2, sort_keys=True)',
      '    f.write("\\n")',
      'print(json.dumps(report, sort_keys=True))',
      'raise SystemExit(2)',
      'PY',
      `python_default /tmp/tac-gitlab-api-readiness.py ${shq(outPath)}`,
    ].join('\n');
  }

  private tacEvalLlmPreflightCommand(runDir: string): string {
    return [
      "cat > /tmp/tac-eval-llm-preflight.py <<'PY'",
      'import json',
      'import os',
      'import sys',
      'sys.path.insert(0, "/utils")',
      'from common import llm_complete',
      '',
      'report = {"ok": False, "model": os.environ.get("LITELLM_MODEL"), "baseUrl": os.environ.get("LITELLM_BASE_URL")}',
      'try:',
      '    response = llm_complete([{"role": "user", "content": "Answer exactly yes."}])',
      '    content = response["choices"][0]["message"]["content"]',
      '    report["ok"] = isinstance(content, str) and len(content.strip()) > 0',
      '    report["contentPreview"] = content[:80] if isinstance(content, str) else ""',
      'except Exception as exc:',
      '    report["error"] = f"{type(exc).__name__}: {exc}"',
      '',
      `os.makedirs('/eval/${runDir}', exist_ok=True)`,
      `with open('/eval/${runDir}/tac-eval-llm-preflight.json', 'w') as f:`,
      '    json.dump(report, f, indent=2)',
      '    f.write("\\n")',
      'print(json.dumps(report))',
      'raise SystemExit(0 if report["ok"] else 1)',
      'PY',
      'PYTHONPATH=/utils python_default /tmp/tac-eval-llm-preflight.py',
    ].join('\n');
  }

  private async refreshTacGitlabRootToken(ws: Workspace): Promise<CommandResult> {
    return ws.run(this.tacGitlabRootTokenRefreshCommand(), { timeoutMs: Math.min(this.opts.initTimeoutMs, 180_000) });
  }

  private tacGitlabRootTokenRefreshOk(command: CommandResult): boolean {
    if (command.exitCode === 0) return true;
    if (command.timedOut) return false;
    if (!command.stdout.includes('root-token refreshed')) return false;
    return !/(recordinvalid|validation failed|exception|fatal|timed out refreshing|traceback|no such container|permission denied)/i.test(
      command.stderr,
    );
  }

  private tacGitlabRootTokenRefreshCommand(): string {
    const rails = [
      "user = User.find_by_username('root')",
      "raise 'root user not found' unless user",
      "user.personal_access_tokens.where(name: 'root-token').delete_all",
      "token = user.personal_access_tokens.create!(scopes: ['api', 'read_user', 'read_api', 'read_repository', 'write_repository', 'sudo', 'admin_mode'], name: 'root-token', expires_at: 364.days.from_now)",
      "token.set_token('root-token')",
      'token.save!',
      "puts 'root-token refreshed'",
    ].join('; ');
    return [
      'set -e',
      'for attempt in $(seq 1 60); do',
      `  if ${this.dockerCommand()} exec gitlab gitlab-rails runner ${shq(rails)}; then`,
      '    exit 0',
      '  fi',
      '  echo "waiting for GitLab Rails token refresh attempt ${attempt}/60" >&2',
      '  sleep 5',
      'done',
      'echo "timed out refreshing GitLab root token" >&2',
      'exit 1',
    ].join('\n');
  }

  private tacEnvPreflightCommand(runDir: string): string {
    const outPath = `/eval/${runDir}/tac-env-preflight.json`;
    return [
      `cat > /tmp/tac-env-preflight.py <<'PY'`,
      'import datetime',
      'import json',
      'import socket',
      'import sys',
      'import urllib.error',
      'import urllib.request',
      '',
      'OUT_PATH = sys.argv[1]',
      '',
      'def request_json(name, url, headers=None, method="GET"):',
      '    entry = {"name": name, "url": url, "ok": False}',
      '    try:',
      '        req = urllib.request.Request(url, headers=headers or {}, method=method)',
      '        with urllib.request.urlopen(req, timeout=30) as resp:',
      '            body = resp.read(4096).decode("utf-8", "replace")',
      '            entry.update({"status": resp.status, "body": body[:1000]})',
      '    except urllib.error.HTTPError as exc:',
      '        body = exc.read(4096).decode("utf-8", "replace")',
      '        entry.update({"status": exc.code, "body": body[:1000], "error": str(exc)})',
      '    except Exception as exc:',
      '        entry.update({"error": str(exc)})',
      '    entry["ok"] = 200 <= int(entry.get("status", 0) or 0) < 300',
      '    return entry',
      '',
      'report = {',
      '    "ok": False,',
      '    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),',
      '    "checks": [],',
      '}',
      '',
      'try:',
      '    host_ip = socket.gethostbyname("the-agent-company.com")',
      '    report["checks"].append({"name": "dns", "ok": True, "host": "the-agent-company.com", "ip": host_ip})',
      'except Exception as exc:',
      '    report["checks"].append({"name": "dns", "ok": False, "host": "the-agent-company.com", "error": str(exc)})',
      '',
      'report["checks"].append(request_json("gitlab-healthcheck", "http://the-agent-company.com:2999/api/healthcheck/gitlab"))',
      'report["checks"].append(request_json("gitlab-root-token-user", "http://the-agent-company.com:8929/api/v4/user", {"PRIVATE-TOKEN": "root-token"}))',
      '',
      'for check in report["checks"]:',
      '    if check["name"] == "gitlab-root-token-user" and check.get("ok"):',
      '        try:',
      '            parsed = json.loads(check.get("body") or "{}")',
      '            check["username"] = parsed.get("username")',
      '            check["ok"] = parsed.get("username") == "root"',
      '        except Exception as exc:',
      '            check["ok"] = False',
      '            check["parseError"] = str(exc)',
      '',
      'report["ok"] = all(check.get("ok") is True for check in report["checks"])',
      'with open(OUT_PATH, "w") as f:',
      '    json.dump(report, f, indent=2, sort_keys=True)',
      '    f.write("\\n")',
      'print(json.dumps(report, sort_keys=True))',
      'sys.exit(0 if report["ok"] else 2)',
      'PY',
      `python_default /tmp/tac-env-preflight.py ${shq(outPath)}`,
    ].join('\n');
  }

  private tacGitlabWikiSmokeCommand(runDir: string): string {
    const outPath = `/eval/${runDir}/tac-gitlab-wiki-smoke.json`;
    return [
      `cat > /tmp/tac-gitlab-wiki-smoke.py <<'PY'`,
      'import datetime',
      'import json',
      'import os',
      'import shlex',
      'import subprocess',
      'import sys',
      'import time',
      'import urllib.error',
      'import urllib.parse',
      'import urllib.request',
      '',
      'OUT_PATH = sys.argv[1]',
      'HOST = os.environ.get("SERVER_HOSTNAME") or "the-agent-company.com"',
      'BASE = f"http://{HOST}:8929/api/v4"',
      'TOKEN = "root-token"',
      'REQUIRE_GIT = os.environ.get("TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT") == "1"',
      'PROJECT_PATH = f"opentasks-wiki-smoke-{int(time.time() * 1000)}-{os.getpid()}"',
      '',
      'def redacted(text):',
      '    return (text or "").replace(TOKEN, "[REDACTED_TAC_GITLAB_TOKEN]")',
      '',
      'def request_json(name, url, headers=None, method="GET", data=None, ok_statuses=None):',
      '    ok_statuses = ok_statuses or set(range(200, 300))',
      '    entry = {"name": name, "url": redacted(url), "ok": False}',
      '    body_bytes = None',
      '    req_headers = {"PRIVATE-TOKEN": TOKEN, **(headers or {})}',
      '    if data is not None:',
      '        body_bytes = urllib.parse.urlencode(data).encode("utf-8")',
      '        req_headers["Content-Type"] = "application/x-www-form-urlencoded"',
      '    try:',
      '        req = urllib.request.Request(url, headers=req_headers, method=method, data=body_bytes)',
      '        with urllib.request.urlopen(req, timeout=30) as resp:',
      '            body = resp.read(8192).decode("utf-8", "replace")',
      '            entry.update({"status": resp.status, "body": redacted(body[:1200])})',
      '            try:',
      '                entry["json"] = json.loads(body or "{}")',
      '            except Exception:',
      '                pass',
      '    except urllib.error.HTTPError as exc:',
      '        body = exc.read(8192).decode("utf-8", "replace")',
      '        entry.update({"status": exc.code, "body": redacted(body[:1200]), "error": redacted(str(exc))})',
      '    except Exception as exc:',
      '        entry.update({"error": redacted(str(exc))})',
      '    entry["ok"] = int(entry.get("status", 0) or 0) in ok_statuses',
      '    return entry',
      '',
      'def run_git_check(project_path):',
      '    repo_url = f"http://root:{TOKEN}@{HOST}:8929/root/{project_path}.wiki.git"',
      '    work = f"/tmp/{project_path}-wiki"',
      '    script = f"""set -e',
      'rm -rf {shlex.quote(work)}',
      'git clone {shlex.quote(repo_url)} {shlex.quote(work)}',
      'cd {shlex.quote(work)}',
      'git config user.email smoke@example.invalid',
      'git config user.name {shlex.quote("TAC Wiki Smoke")}',
      'printf "# Git smoke\\\\n\\\\nCreated by TAC wiki smoke.\\\\n" > git-smoke.md',
      'git add git-smoke.md',
      'git commit -m "Add git smoke wiki page"',
      'git push origin HEAD:master',
      '"""',
      '    try:',
      '        completed = subprocess.run(["bash", "-lc", script], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)',
      '        return {',
      '            "name": "git-wiki-clone-commit-push",',
      '            "ok": completed.returncode == 0,',
      '            "exitCode": completed.returncode,',
      '            "stdout": redacted(completed.stdout[-2000:]),',
      '            "stderr": redacted(completed.stderr[-2000:]),',
      '        }',
      '    except Exception as exc:',
      '        return {"name": "git-wiki-clone-commit-push", "ok": False, "error": redacted(str(exc))}',
      '',
      'report = {',
      '    "ok": False,',
      '    "apiOk": False,',
      '    "gitOk": False,',
      '    "requireGit": REQUIRE_GIT,',
      '    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),',
      '    "scratchProjectPath": PROJECT_PATH,',
      '    "checks": [],',
      '}',
      'project_id = None',
      'try:',
      '    create_project = request_json("create-scratch-project", f"{BASE}/projects", method="POST", data={',
      '        "name": PROJECT_PATH,',
      '        "path": PROJECT_PATH,',
      '        "visibility": "private",',
      '        "initialize_with_readme": "true",',
      '    }, ok_statuses={201})',
      '    report["checks"].append(create_project)',
      '    if create_project.get("ok") and isinstance(create_project.get("json"), dict):',
      '        project_id = create_project["json"].get("id")',
      '',
      '    if project_id is not None:',
      '        create_wiki = request_json("create-wiki-page-api", f"{BASE}/projects/{project_id}/wikis", method="POST", data={',
      '            "title": "Smoke Page",',
      '            "content": "# Smoke Page\\\\n\\\\nCreated by TAC wiki smoke.\\\\n",',
      '            "format": "markdown",',
      '        }, ok_statuses={201})',
      '        report["checks"].append(create_wiki)',
      '        slug = None',
      '        if isinstance(create_wiki.get("json"), dict):',
      '            slug = create_wiki["json"].get("slug") or create_wiki["json"].get("title")',
      '        if slug:',
      "            get_wiki = request_json('read-wiki-page-api', f'{BASE}/projects/{project_id}/wikis/{urllib.parse.quote(str(slug), safe=\"\")}')",
      '            report["checks"].append(get_wiki)',
      '        else:',
      '            report["checks"].append({"name": "read-wiki-page-api", "ok": False, "error": "wiki create response did not include slug"})',
      '',
      '        report["apiOk"] = all(c.get("ok") is True for c in report["checks"] if c.get("name") in {"create-scratch-project", "create-wiki-page-api", "read-wiki-page-api"})',
      '        git_check = run_git_check(PROJECT_PATH)',
      '        report["checks"].append(git_check)',
      '        report["gitOk"] = git_check.get("ok") is True',
      'finally:',
      '    if project_id is not None:',
      '        delete_project = request_json("delete-scratch-project", f"{BASE}/projects/{project_id}", method="DELETE", ok_statuses={202, 204})',
      '        report["checks"].append(delete_project)',
      '',
      'cleanup_ok = any(c.get("name") == "delete-scratch-project" and c.get("ok") is True for c in report["checks"])',
      'report["ok"] = bool(report["apiOk"] and cleanup_ok and (report["gitOk"] or not REQUIRE_GIT))',
      'with open(OUT_PATH, "w") as f:',
      '    json.dump(report, f, indent=2, sort_keys=True)',
      '    f.write("\\n")',
      'print(json.dumps(report, sort_keys=True))',
      'sys.exit(0 if report["ok"] else 2)',
      'PY',
      `python_default /tmp/tac-gitlab-wiki-smoke.py ${shq(outPath)}`,
    ].join('\n');
  }

  private tacGitlabWikiTargetSmokeCommand(runDir: string, projectPath: string): string {
    const outPath = `/eval/${runDir}/tac-gitlab-wiki-target-smoke.json`;
    return [
      `cat > /tmp/tac-gitlab-wiki-target-smoke.py <<'PY'`,
      'import datetime',
      'import json',
      'import os',
      'import shlex',
      'import subprocess',
      'import sys',
      'import time',
      'import urllib.error',
      'import urllib.parse',
      'import urllib.request',
      '',
      'OUT_PATH = sys.argv[1]',
      `PROJECT_PATH = ${JSON.stringify(projectPath)}`,
      'HOST = os.environ.get("SERVER_HOSTNAME") or "the-agent-company.com"',
      'BASE = f"http://{HOST}:8929/api/v4"',
      'TOKEN = "root-token"',
      'REQUIRE_GIT = os.environ.get("TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT") == "1"',
      'RUN_ID = f"opentasks-target-wiki-smoke-{int(time.time() * 1000)}-{os.getpid()}"',
      '',
      'def redacted(text):',
      '    return (text or "").replace(TOKEN, "[REDACTED_TAC_GITLAB_TOKEN]")',
      '',
      'def request_json(name, url, headers=None, method="GET", data=None, ok_statuses=None):',
      '    ok_statuses = ok_statuses or set(range(200, 300))',
      '    entry = {"name": name, "url": redacted(url), "ok": False}',
      '    body_bytes = None',
      '    req_headers = {"PRIVATE-TOKEN": TOKEN, **(headers or {})}',
      '    if data is not None:',
      '        body_bytes = urllib.parse.urlencode(data).encode("utf-8")',
      '        req_headers["Content-Type"] = "application/x-www-form-urlencoded"',
      '    try:',
      '        req = urllib.request.Request(url, headers=req_headers, method=method, data=body_bytes)',
      '        with urllib.request.urlopen(req, timeout=30) as resp:',
      '            body = resp.read(8192).decode("utf-8", "replace")',
      '            entry.update({"status": resp.status, "body": redacted(body[:1200])})',
      '            try:',
      '                entry["json"] = json.loads(body or "{}")',
      '            except Exception:',
      '                pass',
      '    except urllib.error.HTTPError as exc:',
      '        body = exc.read(8192).decode("utf-8", "replace")',
      '        entry.update({"status": exc.code, "body": redacted(body[:1200]), "error": redacted(str(exc))})',
      '    except Exception as exc:',
      '        entry.update({"error": redacted(str(exc))})',
      '    entry["ok"] = int(entry.get("status", 0) or 0) in ok_statuses',
      '    return entry',
      '',
      'def run_git_check(project_path, slug):',
      '    repo_path = urllib.parse.quote(project_path, safe="/")',
      '    repo_url = f"http://root:{TOKEN}@{HOST}:8929/{repo_path}.wiki.git"',
      '    work = f"/tmp/{RUN_ID}-wiki"',
      '    script = f"""set -e',
      'rm -rf {shlex.quote(work)}',
      'git clone {shlex.quote(repo_url)} {shlex.quote(work)}',
      'cd {shlex.quote(work)}',
      'git config user.email smoke@example.invalid',
      'git config user.name {shlex.quote("TAC Target Wiki Smoke")}',
      'printf "# Git target smoke\\\\n\\\\nCreated by TAC target wiki smoke.\\\\n" > {shlex.quote(slug + ".md")}',
      'git add {shlex.quote(slug + ".md")}',
      'git commit -m "Add target git wiki smoke page"',
      'git push origin HEAD:master',
      '"""',
      '    try:',
      '        completed = subprocess.run(["bash", "-lc", script], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)',
      '        return {',
      '            "name": "target-git-wiki-clone-commit-push",',
      '            "ok": completed.returncode == 0,',
      '            "slug": slug,',
      '            "exitCode": completed.returncode,',
      '            "stdout": redacted(completed.stdout[-2000:]),',
      '            "stderr": redacted(completed.stderr[-2000:]),',
      '        }',
      '    except Exception as exc:',
      '        return {"name": "target-git-wiki-clone-commit-push", "ok": False, "error": redacted(str(exc))}',
      '',
      'def delete_wiki(project_id, slug, name):',
      '    return request_json(name, f"{BASE}/projects/{project_id}/wikis/{urllib.parse.quote(str(slug), safe=\'\')}", method="DELETE", ok_statuses={200, 202, 204, 404})',
      '',
      'report = {',
      '    "ok": False,',
      '    "apiOk": False,',
      '    "gitOk": False,',
      '    "cleanupOk": False,',
      '    "requireGit": REQUIRE_GIT,',
      '    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),',
      '    "targetProjectPath": PROJECT_PATH,',
      '    "checks": [],',
      '}',
      'project_id = None',
      'api_slug = RUN_ID',
      'git_slug = f"{RUN_ID}-git"',
      'try:',
      '    encoded_path = urllib.parse.quote(PROJECT_PATH, safe="")',
      '    target_project = request_json("target-project-read", f"{BASE}/projects/{encoded_path}")',
      '    report["checks"].append(target_project)',
      '    if target_project.get("ok") and isinstance(target_project.get("json"), dict):',
      '        project_id = target_project["json"].get("id")',
      '',
      '    if project_id is not None:',
      '        create_wiki = request_json("target-create-wiki-page-api", f"{BASE}/projects/{project_id}/wikis", method="POST", data={',
      '            "title": api_slug,',
      '            "content": "# Target Wiki Smoke\\\\n\\\\nCreated by TAC target wiki smoke.\\\\n",',
      '            "format": "markdown",',
      '        }, ok_statuses={201})',
      '        report["checks"].append(create_wiki)',
      '        if isinstance(create_wiki.get("json"), dict):',
      '            api_slug = create_wiki["json"].get("slug") or api_slug',
      '        read_wiki = request_json("target-read-wiki-page-api", f"{BASE}/projects/{project_id}/wikis/{urllib.parse.quote(str(api_slug), safe=\'\')}")',
      '        report["checks"].append(read_wiki)',
      '        report["apiOk"] = create_wiki.get("ok") is True and read_wiki.get("ok") is True',
      '        git_check = run_git_check(PROJECT_PATH, git_slug)',
      '        report["checks"].append(git_check)',
      '        if git_check.get("ok"):',
      '            read_git_wiki = request_json("target-read-git-wiki-page-api", f"{BASE}/projects/{project_id}/wikis/{urllib.parse.quote(str(git_slug), safe=\'\')}")',
      '            report["checks"].append(read_git_wiki)',
      '            report["gitOk"] = read_git_wiki.get("ok") is True',
      'finally:',
      '    if project_id is not None:',
      '        report["checks"].append(delete_wiki(project_id, api_slug, "target-delete-api-wiki-page"))',
      '        report["checks"].append(delete_wiki(project_id, git_slug, "target-delete-git-wiki-page"))',
      '',
      'cleanup_names = {"target-delete-api-wiki-page", "target-delete-git-wiki-page"}',
      'cleanup_checks = [c for c in report["checks"] if c.get("name") in cleanup_names]',
      'report["cleanupOk"] = len(cleanup_checks) == len(cleanup_names) and all(c.get("ok") is True for c in cleanup_checks)',
      'target_ok = any(c.get("name") == "target-project-read" and c.get("ok") is True for c in report["checks"])',
      'report["ok"] = bool(target_ok and report["apiOk"] and report["cleanupOk"] and (report["gitOk"] or not REQUIRE_GIT))',
      'with open(OUT_PATH, "w") as f:',
      '    json.dump(report, f, indent=2, sort_keys=True)',
      '    f.write("\\n")',
      'print(json.dumps(report, sort_keys=True))',
      'sys.exit(0 if report["ok"] else 2)',
      'PY',
      `python_default /tmp/tac-gitlab-wiki-target-smoke.py ${shq(outPath)}`,
    ].join('\n');
  }

  private agentEnvError(
    parsed: { output: string; isError: boolean; sawResult: boolean },
    agent: { exitCode: number; stderr: string; timedOut?: boolean },
  ): EnvError | undefined {
    if (!parsed.isError && parsed.sawResult && agent.exitCode === 0) return undefined;
    const text = `${parsed.output} ${agent.stderr}`;
    return (
      classifyEnvError(text, agent.timedOut === true) ?? {
        kind: agent.timedOut === true ? 'timeout' : 'crash',
        message: text.trim().slice(0, 200) || `claude exited ${agent.exitCode} without a successful result event`,
        retriable: agent.timedOut === true,
      }
    );
  }

  private envLlmEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of [
      'LITELLM_API_KEY',
      'LITELLM_BASE_URL',
      'LITELLM_MODEL',
      'TAC_GRADER_PROXY',
      'TAC_GRADER_PROXY_HOST',
      'TAC_GRADER_PROXY_PORT',
      'TAC_GRADER_PROXY_MODEL',
      'TAC_GRADER_PROXY_KEY',
      'TAC_GRADER_BEDROCK_MODEL',
      'TAC_GRADER_BEDROCK_REGION',
    ]) {
      const value = this.opts.env?.[key] ?? process.env[key];
      if (value) out[key] = value;
    }
    if (out.TAC_GRADER_PROXY === 'bedrock') {
      const host = out.TAC_GRADER_PROXY_HOST ?? '127.0.0.1';
      const port = out.TAC_GRADER_PROXY_PORT ?? '4000';
      const proxyModel = out.TAC_GRADER_PROXY_MODEL ?? 'tac-grader';
      out.LITELLM_API_KEY ??= out.TAC_GRADER_PROXY_KEY ?? 'sk-tac-grader-local';
      out.LITELLM_BASE_URL ??= `http://${host}:${port}/v1`;
      out.LITELLM_MODEL ??= openAiCompatibleLitellmModel(proxyModel);
    }
    return out;
  }

  private opentasksDir(): string {
    return this.opts.opentasksContainerDir ?? '/opentasks';
  }

  private opentasksInitCommand(cell: PublicCell): string {
    const cli = `${this.opentasksDir()}/dist/cli.js`;
    const name = `tac-${safeId(cell.task.id)}`;
    const init = `[ -d .opentasks ] || node ${shq(cli)} init --name ${shq(name)}`;
    return `export OPENTASKS_PROJECT_DIR=${shq(OPENTASKS_PROJECT_DIR)}; ${init} && node ${shq(cli)} daemon start >/dev/null && node ${shq(cli)} daemon status >/dev/null`;
  }

  private opentasksSkillInstallCommand(runDir: string): string {
    return `mkdir -p .claude/skills/opentasks && cp /eval/${runDir}/opentasks-skill.md .claude/skills/opentasks/SKILL.md`;
  }

  private opentasksMcpPreflightCommand(runDir: string): string {
    const script = `${this.opentasksDir()}/evals/tac/scripts/check-opentasks-mcp.mjs`;
    const cli = `${this.opentasksDir()}/dist/cli.js`;
    return [
      'node',
      shq(script),
      '--arg',
      shq(cli),
      '--arg',
      'mcp',
      '--arg',
      '--scope',
      '--arg',
      'all',
      '--project-dir',
      shq(OPENTASKS_PROJECT_DIR),
      '--required',
      shq(OPENTASKS_REQUIRED_MCP_TOOLS.join(',')),
      '--out',
      shq(`/eval/${runDir}/opentasks-mcp-preflight.json`),
    ].join(' ');
  }

  private opentasksMcpWrapperScript(runDir: string): string {
    const cli = `${this.opentasksDir()}/dist/cli.js`;
    return [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `LOG=${shq(`/eval/${runDir}/opentasks-mcp-wrapper.log`)}`,
      '{',
      '  echo "[opentasks-mcp-wrapper] started_at=$(date -Is)"',
      '  echo "[opentasks-mcp-wrapper] cwd=$PWD"',
      '  echo "[opentasks-mcp-wrapper] user=$(id -un 2>/dev/null || true)"',
      '  echo "[opentasks-mcp-wrapper] node=$(command -v node || true)"',
      '  node --version 2>/dev/null | sed "s/^/[opentasks-mcp-wrapper] node_version=/" || true',
      `  echo "[opentasks-mcp-wrapper] cli=${cli}"`,
      `  ls -l ${shq(cli)} 2>&1 | sed "s/^/[opentasks-mcp-wrapper] cli_stat=/" || true`,
      `  echo "[opentasks-mcp-wrapper] OPENTASKS_PROJECT_DIR=\${OPENTASKS_PROJECT_DIR:-${OPENTASKS_PROJECT_DIR}}"`,
      '} >> "$LOG" 2>&1',
      `export OPENTASKS_PROJECT_DIR="\${OPENTASKS_PROJECT_DIR:-${OPENTASKS_PROJECT_DIR}}"`,
      `exec node ${shq(cli)} mcp --scope all 2>>"$LOG"`,
      '',
    ].join('\n');
  }

  private dockerCommand(): string {
    return this.opts.dockerCommand ?? 'docker';
  }

  private mcpConfig(
    cell: PublicCell,
    runDir = '.tac/debug',
  ): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const server of cell.arm.scaffold.mcpServers ?? []) {
      if (server.name === 'opentasks') {
        const cli = `${this.opentasksDir()}/dist/cli.js`;
        const env = this.opentasksMcpEnv(server.env);
        const variant = this.opts.opentasksMcpCommandVariant ?? 'wrapper';
        if (variant === 'direct') {
          mcpServers[server.name] = {
            command: 'node',
            args: [cli, 'mcp', '--scope', 'all'],
            env,
          };
        } else if (variant === 'sh-lc') {
          mcpServers[server.name] = {
            command: 'sh',
            args: ['-lc', `export OPENTASKS_PROJECT_DIR=${shq(OPENTASKS_PROJECT_DIR)}; exec node ${shq(cli)} mcp --scope all`],
            env,
          };
        } else {
          mcpServers[server.name] = {
            command: '/bin/bash',
            args: [`/eval/${runDir}/opentasks-mcp-wrapper.sh`],
            env,
          };
        }
      } else {
        mcpServers[server.name] = {
          command: server.command,
          args: server.args ?? [],
          env: server.env,
        };
      }
    }
    return { mcpServers };
  }

  private opentasksMcpEnv(serverEnv: Record<string, string> | undefined): Record<string, string> {
    return {
      ...(serverEnv ?? {}),
      OPENTASKS_PROJECT_DIR,
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...(this.opts.agentUser ? { HOME: `/home/${this.opts.agentUser}` } : {}),
    };
  }

  private opentasksMcpSmokeReport(
    cell: PublicCell,
    agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
  ): OpenTasksMcpSmokeReport {
    const parsed = this.agentHarness.parse(agent.stdout, cell.model.name);
    const init = parseClaudeInit(agent.stdout);
    const streamStats = claudeStreamStats(agent.stdout);
    const opentasksToolNames = init.toolNames.filter((name) => name.startsWith(OPENTASKS_MCP_TOOL_PREFIX)).sort();
    const nativeCalls = parsed.trajectory
      .filter((event) => event.type === 'tool' && event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX))
      .map((event) => event.name);
    const usedNativeOpentasksTool = parsed.trajectory.some(
      (event) => event.type === 'tool' && event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX),
    );
    const swarmTaskCalls = parsed.trajectory
      .filter((event) => event.type === 'tool' && event.name.startsWith('task_'))
      .map((event) => event.name);
    const usedSwarmTaskTool = this.usesSwarmHarnessSwarmMode() && swarmTaskCalls.length > 0;
    const connected = parsed.mcpServers.some((server) => server.name === 'opentasks' && server.status === 'connected');
    const exposed = opentasksToolNames.length > 0 || usedNativeOpentasksTool || usedSwarmTaskTool;
    const ok = agent.exitCode === 0 && parsed.sawResult && !parsed.isError && (usedNativeOpentasksTool || usedSwarmTaskTool);
    const failureReason =
      ok === true
        ? undefined
        : smokeFailureReason({
            exitCode: agent.exitCode,
            timedOut: agent.timedOut === true,
            sawResult: parsed.sawResult,
            isError: parsed.isError,
            output: parsed.output,
            connected,
            exposed,
            mcpServers: parsed.mcpServers,
            stderr: agent.stderr,
            harnessId: this.agentHarness.id,
          });
    return {
      ok,
      failureReason,
      harnessId: this.agentHarness.id,
      exitCode: agent.exitCode,
      timedOut: agent.timedOut === true,
      sawResult: parsed.sawResult,
      isError: parsed.isError,
      usage: parsed.usage,
      mcpServers: parsed.mcpServers,
      toolCount: init.toolNames.length,
      opentasksToolCount: opentasksToolNames.length,
      opentasksToolNames,
      skillNames: init.skillNames,
      usedNativeOpentasksTool,
      nativeCalls,
      usedSwarmTaskTool,
      swarmTaskToolCount: swarmTaskCalls.length,
      swarmTaskCalls,
      stdoutHead: agent.stdout.slice(0, 1000),
      stderrHead: agent.stderr.slice(0, 1000),
      streamStats,
      trajectory: parsed.trajectory,
    };
  }

  private opentasksTaskPreludeReport(
    cell: PublicCell,
    agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
    opts: { attempt?: number; maxAttempts?: number } = {},
  ): OpenTasksTaskPreludeReport {
    const parsed = this.agentHarness.parse(agent.stdout, cell.model.name);
    const init = parseClaudeInit(agent.stdout);
    const streamStats = claudeStreamStats(agent.stdout);
    const opentasksToolNames = init.toolNames.filter((name) => name.startsWith(OPENTASKS_MCP_TOOL_PREFIX)).sort();
    const nativeCalls = parsed.trajectory
      .filter((event) => event.type === 'tool' && event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX))
      .map((event) => event.name);
    const required = ['mcp__opentasks__create_task', 'mcp__opentasks__record_attempt', 'mcp__opentasks__list_tasks'];
    const missingRequiredCalls = required.filter((name) => !nativeCalls.includes(name));
    const ok = agent.exitCode === 0 && parsed.sawResult && !parsed.isError && missingRequiredCalls.length === 0;
    const initOnly =
      streamStats.initEvents > 0 &&
      streamStats.assistantEvents === 0 &&
      streamStats.toolUseEvents === 0 &&
      streamStats.resultEvents === 0;
    const initOnlyTimeout = agent.timedOut === true && initOnly;
    const failureReason =
      ok === true
        ? undefined
        : preludeFailureReason({
            exitCode: agent.exitCode,
            timedOut: agent.timedOut === true,
            initOnlyTimeout,
            sawResult: parsed.sawResult,
            isError: parsed.isError,
            output: parsed.output,
            stderr: agent.stderr,
            missingRequiredCalls,
          });
    return {
      ok,
      failureReason,
      attempt: opts.attempt ?? 1,
      maxAttempts: opts.maxAttempts ?? 1,
      exitCode: agent.exitCode,
      timedOut: agent.timedOut === true,
      initOnly,
      initOnlyTimeout,
      sawResult: parsed.sawResult,
      isError: parsed.isError,
      usage: parsed.usage,
      mcpServers: parsed.mcpServers,
      toolCount: init.toolNames.length,
      opentasksToolCount: opentasksToolNames.length,
      opentasksToolNames,
      nativeCalls,
      missingRequiredCalls,
      output: parsed.output,
      stdoutHead: agent.stdout.slice(0, 1000),
      stderrHead: agent.stderr.slice(0, 1000),
      streamStats,
      trajectory: parsed.trajectory,
      attempts: [],
    };
  }

  private opentasksTaskPreludeSummary(report: OpenTasksTaskPreludeReport): string {
    const lines = [
      `status: ${report.ok ? 'ok' : 'failed'}`,
      `attempts: ${report.attempts?.length || 1}/${report.maxAttempts}`,
      `nativeCalls: ${report.nativeCalls.length ? report.nativeCalls.join(', ') : 'none'}`,
      `mcpServers: ${JSON.stringify(report.mcpServers)}`,
    ];
    if (report.failureReason) lines.push(`failureReason: ${report.failureReason}`);
    if (report.initOnlyTimeout) lines.push('diagnostic: timed out after Claude init only; no assistant/tool/result events were observed');
    if (report.output.trim()) lines.push('', report.output.trim());
    return `${lines.join('\n')}\n`;
  }

  private opentasksGraphSeedSummary(report: OpenTasksGraphSeedReport): string {
    const lines = [
      `status: ${report.ok ? 'ok' : 'failed'}`,
      `taskId: ${report.taskId ?? 'none'}`,
      `title: ${report.taskTitle}`,
      `sourceTaskId: ${report.sourceTaskId}`,
      `contentBytes: ${report.contentBytes}`,
    ];
    if (report.error) lines.push(`error: ${report.error}`);
    return `${lines.join('\n')}\n`;
  }

  private async copyOpenTasksMcpWrapperLog(ws: Workspace, runDir: string): Promise<void> {
    const wrapperLog = await ws.readFile(`${runDir}/opentasks-mcp-wrapper.log`);
    if (wrapperLog) await writeLocalArtifact('opentasks-mcp-wrapper.log', redactSensitiveText(wrapperLog));
  }

  private opentasksTaskPreludeMaxAttempts(): number {
    const retries = this.opts.opentasksTaskPreludeRetries ?? 1;
    return Math.max(1, Math.floor(retries) + 1);
  }

  private opentasksTaskPreludeTimeoutMs(): number {
    return this.opts.opentasksTaskPreludeTimeoutMs ?? Math.min(this.opts.initTimeoutMs, 240_000);
  }

  private opentasksTaskPreludeFailureMode(): OpenTasksPreludeFailureMode {
    if (this.opts.opentasksTaskPreludeFailureMode) return this.opts.opentasksTaskPreludeFailureMode;
    return this.opts.opentasksTaskPreludeFailFast === false ? 'degrade' : 'fail-fast';
  }

  private shouldRetryOpenTasksTaskPrelude(report: OpenTasksTaskPreludeReport): boolean {
    return report.attempt < report.maxAttempts && report.ok !== true && report.initOnlyTimeout === true;
  }
}

export function tacDockerAdapterFromEnv(): TacDockerAdapter {
  return new TacDockerAdapter({
    timeoutMs: Number(process.env.EVAL_TIMEOUT ?? 900_000),
    initTimeoutMs: Number(process.env.TAC_INIT_TIMEOUT ?? 600_000),
    evalTimeoutMs: Number(process.env.TAC_EVAL_TIMEOUT ?? 300_000),
    serverHostname: process.env.TAC_SERVER_HOSTNAME ?? 'the-agent-company.com',
    network: process.env.TAC_DOCKER_NETWORK ?? 'host',
    dockerCommand: process.env.TAC_DOCKER_COMMAND,
    env: passEnv(),
    agentSetupCommand: process.env.TAC_AGENT_SETUP_CMD,
    agentHarnessId: process.env.TAC_AGENT_HARNESS ?? process.env.TAC_AGENT_RUNTIME,
    agentUser: process.env.TAC_AGENT_USER,
    opentasksMount: process.env.TAC_OPENTASKS_MOUNT ?? process.cwd(),
    opentasksContainerDir: process.env.TAC_OPENTASKS_CONTAINER_DIR ?? '/opentasks',
    decryptionKey: process.env.TAC_DECRYPTION_KEY ?? 'theagentcompany is all you need',
    operatingPrompt: process.env.TAC_OPERATING_PROMPT === '0' ? false : undefined,
    agentPromptAppendix: process.env.TAC_AGENT_PROMPT_APPENDIX,
    opentasksMcpPreflight: process.env.TAC_OPENTASKS_MCP_PREFLIGHT === '0' ? false : undefined,
    opentasksClaudeMcpSmoke: process.env.TAC_OPENTASKS_CLAUDE_MCP_SMOKE === '0' ? false : undefined,
    opentasksClaudeMcpSmokeFailFast: process.env.TAC_OPENTASKS_CLAUDE_MCP_SMOKE_FAIL_FAST === '0' ? false : undefined,
    strictMcpConfig: process.env.TAC_STRICT_MCP_CONFIG === '0' ? false : undefined,
    allowedTools: process.env.TAC_ALLOWED_TOOLS === '0' ? false : undefined,
    opentasksMcpCommandVariant: parseOpenTasksMcpCommandVariant(process.env.TAC_OPENTASKS_MCP_COMMAND),
    opentasksGraphSeed: parseOptionalBoolean(process.env.TAC_OPENTASKS_GRAPH_SEED),
    opentasksTaskPrelude: parseOptionalBoolean(process.env.TAC_OPENTASKS_TASK_PRELUDE),
    opentasksTaskPreludeFailFast: process.env.TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST === '0' ? false : undefined,
    opentasksTaskPreludeFailureMode: parseOpenTasksPreludeFailureMode(
      process.env.TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE,
      process.env.TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST,
    ),
    opentasksTaskPreludeRetries: parseOptionalNonNegativeInt(process.env.TAC_OPENTASKS_TASK_PRELUDE_RETRIES),
    opentasksTaskPreludeTimeoutMs: parseOptionalPositiveInt(process.env.TAC_OPENTASKS_TASK_PRELUDE_TIMEOUT_MS),
    tacGitlabTokenRefresh: process.env.TAC_GITLAB_TOKEN_REFRESH === '0' ? false : undefined,
    tacEnvPreflight: process.env.TAC_ENV_PREFLIGHT === '0' ? false : undefined,
    tacGitlabWikiSmoke: process.env.TAC_GITLAB_WIKI_SMOKE === '0' ? false : undefined,
    tacGitlabWikiSmokeRequireGit: process.env.TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT === '1',
    tacEvalLlmPreflight: process.env.TAC_EVAL_LLM_PREFLIGHT === '0' ? false : undefined,
    tacGitlabWikiTargetSmokeProject: process.env.TAC_GITLAB_WIKI_TARGET_SMOKE_PROJECT,
    preflightOnly: process.env.TAC_PREFLIGHT_ONLY === '1',
    liveTokenLimit: liveTokenLimitFromEnv(),
  });
}

function passEnv(): Record<string, string> {
  const keys = [
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_REGION',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_AUTH_MODE',
    'AZURE_OPENAI_RESPONSES_PATH',
    'TAC_GRADER_PROXY',
    'TAC_GRADER_PROXY_HOST',
    'TAC_GRADER_PROXY_PORT',
    'TAC_GRADER_PROXY_MODEL',
    'TAC_GRADER_PROXY_KEY',
    'TAC_GRADER_BEDROCK_MODEL',
    'TAC_GRADER_BEDROCK_REGION',
    'TAC_GRADER_PROXY_STATE_DIR',
    'TAC_GRADER_PROXY_START_TIMEOUT_SEC',
    'LITELLM_API_KEY',
    'LITELLM_BASE_URL',
    'LITELLM_MODEL',
    'TAC_SWARM_HARNESS_MODE',
    'TAC_SWARM_HARNESS_CONCURRENCY',
    'TAC_SWARM_HARNESS_MULTIAGENT_PROMPT',
  ];
  const out: Record<string, string> = {};
  for (const key of keys) if (process.env[key]) out[key] = process.env[key]!;
  return out;
}

function openAiCompatibleLitellmModel(model: string): string {
  return model.includes('/') ? model : `openai/${model}`;
}

function withMcpMetrics(trajectory: TraceEvent[], mcpServers: { name: string; status: string }[]): TraceEvent[] {
  if (!mcpServers.length) return trajectory;
  return [
    ...trajectory,
    {
      type: 'tool',
      ts: trajectory.length,
      name: 'tac_mcp_init',
      input: { servers: mcpServers },
    },
  ];
}

function withAgentDiagnostics(
  trajectory: TraceEvent[],
  agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
): TraceEvent[] {
  return [
    ...trajectory,
    {
      type: 'tool',
      ts: trajectory.length,
      name: 'tac_agent_exec',
      input: {
        exitCode: agent.exitCode,
        timedOut: agent.timedOut === true,
        stdoutHead: agent.stdout.slice(0, 1000),
        stderrHead: agent.stderr.slice(0, 1000),
      },
    },
  ];
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheCreationTokens: (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
    perModel: [...(a.perModel ?? []), ...(b.perModel ?? [])],
  };
}

function hasOpenTasksMcpCall(trajectory: TraceEvent[], names?: string[]): boolean {
  const allowed = names ? new Set(names) : undefined;
  return trajectory.some(
    (event) =>
      event.type === 'tool' &&
      event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX) &&
      (!allowed || allowed.has(event.name)),
  );
}

function isTaskWorkTool(event: TraceEvent): boolean {
  return event.type === 'tool' && event.name !== 'ToolSearch' && event.name !== 'Skill' && !event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX);
}

export function traceEfficiencyMetrics(
  trajectory: TraceEvent[],
  opts: { seededTaskId?: string } = {},
): Record<string, number> {
  const toolEvents = trajectory.filter((event) => event.type === 'tool');
  const firstBashIndex = toolEvents.findIndex((event) => event.name === 'Bash');
  const lastBashIndex = findLastIndex(toolEvents, (event) => event.name === 'Bash');
  const firstTaskWorkIndex = toolEvents.findIndex(isTaskWorkTool);
  const openTasksToolCallCounts: Record<string, number> = {};
  let mainBashCallCount = 0;
  let mainReadCallCount = 0;
  let mainToolSearchCallCount = 0;
  let mainToolSearchMultiSelectCallCount = 0;
  let mainOpenTasksCallCount = 0;
  let mainOpenTasksListCallCount = 0;
  let mainOpenTasksGetTaskCallCount = 0;
  let mainOpenTasksUpdateCallCount = 0;
  let openTasksCallsBeforeFirstBash = 0;
  let openTasksCallsAfterLastBash = 0;
  let openTasksGetTaskCallsBeforeFirstBash = 0;
  let openTasksGetTaskCallsBeforeFirstTaskWork = 0;
  let seededTaskGetTaskCallCount = 0;
  let seededTaskGetTaskBeforeFirstBashCallCount = 0;
  let seededTaskGetTaskBeforeFirstTaskWorkCallCount = 0;
  let gitlabHelperCallCount = 0;
  let gitlabHelperApiShorthandCallCount = 0;
  let gitlabProtectedBranchHelperCallCount = 0;
  let rawGitlabApiCurlCallCount = 0;

  toolEvents.forEach((event, index) => {
    if (event.name === 'Bash') {
      mainBashCallCount += 1;
      const command = String((event.input as { command?: unknown } | undefined)?.command ?? '');
      if (/\btac-gitlab-api\b/.test(command)) {
        gitlabHelperCallCount += 1;
        if (isGitlabApiShorthandCommand(command)) gitlabHelperApiShorthandCallCount += 1;
      }
      if (/\btac-gitlab-protect-branch\b/.test(command)) {
        gitlabHelperCallCount += 1;
        gitlabProtectedBranchHelperCallCount += 1;
      }
      if (/\bcurl\b/.test(command) && /\/api\/v4\//.test(command)) rawGitlabApiCurlCallCount += 1;
    }
    if (event.name === 'Read') mainReadCallCount += 1;
    if (event.name === 'ToolSearch') {
      mainToolSearchCallCount += 1;
      const query = String((event.input as { query?: unknown } | undefined)?.query ?? '');
      if (countOpenTasksSelectTargets(query) > 1) mainToolSearchMultiSelectCallCount += 1;
    }
    if (event.name.startsWith(OPENTASKS_MCP_TOOL_PREFIX)) {
      const toolName = event.name.slice(OPENTASKS_MCP_TOOL_PREFIX.length);
      openTasksToolCallCounts[toolName] = (openTasksToolCallCounts[toolName] ?? 0) + 1;
      mainOpenTasksCallCount += 1;
      if (event.name === 'mcp__opentasks__list_tasks') mainOpenTasksListCallCount += 1;
      if (event.name === 'mcp__opentasks__get_task') {
        mainOpenTasksGetTaskCallCount += 1;
        if (firstBashIndex < 0 || index < firstBashIndex) openTasksGetTaskCallsBeforeFirstBash += 1;
        if (firstTaskWorkIndex < 0 || index < firstTaskWorkIndex) openTasksGetTaskCallsBeforeFirstTaskWork += 1;
        if (opts.seededTaskId && String((event.input as { id?: unknown } | undefined)?.id ?? '') === opts.seededTaskId) {
          seededTaskGetTaskCallCount += 1;
          if (firstBashIndex < 0 || index < firstBashIndex) seededTaskGetTaskBeforeFirstBashCallCount += 1;
          if (firstTaskWorkIndex < 0 || index < firstTaskWorkIndex) seededTaskGetTaskBeforeFirstTaskWorkCallCount += 1;
        }
      }
      if (event.name === 'mcp__opentasks__record_attempt' || event.name === 'mcp__opentasks__update_task') {
        mainOpenTasksUpdateCallCount += 1;
      }
      if (firstBashIndex >= 0 && index < firstBashIndex) openTasksCallsBeforeFirstBash += 1;
      if (lastBashIndex >= 0 && index > lastBashIndex) openTasksCallsAfterLastBash += 1;
    }
  });

  const perOpenTasksToolMetrics = Object.fromEntries(
    Object.entries(openTasksToolCallCounts).map(([toolName, count]) => [
      `mainOpenTasks${metricNamePart(toolName)}CallCount`,
      count,
    ]),
  );
  const seededTaskMetrics = opts.seededTaskId
    ? {
        seededTaskGetTaskCallCount,
        seededTaskGetTaskBeforeFirstBashCallCount,
        seededTaskFullContentReadBeforeFirstBash: seededTaskGetTaskBeforeFirstBashCallCount > 0 ? 1 : 0,
        seededTaskGetTaskBeforeFirstTaskWorkCallCount,
        seededTaskFullContentReadBeforeFirstTaskWork: seededTaskGetTaskBeforeFirstTaskWorkCallCount > 0 ? 1 : 0,
      }
    : {};

  return {
    mainToolCallCount: toolEvents.length,
    mainBashCallCount,
    mainReadCallCount,
    mainToolSearchCallCount,
    mainToolSearchMultiSelectCallCount,
    mainOpenTasksCallCount,
    mainOpenTasksListCallCount,
    mainOpenTasksGetTaskCallCount,
    mainOpenTasksUpdateCallCount,
    openTasksCallsBeforeFirstBash,
    openTasksCallsAfterLastBash,
    openTasksGetTaskCallsBeforeFirstBash,
    mainFullTaskContentReadBeforeFirstBash: openTasksGetTaskCallsBeforeFirstBash > 0 ? 1 : 0,
    openTasksGetTaskCallsBeforeFirstTaskWork,
    mainFullTaskContentReadBeforeFirstTaskWork: openTasksGetTaskCallsBeforeFirstTaskWork > 0 ? 1 : 0,
    ...seededTaskMetrics,
    mainOpenTasksDistinctToolCount: Object.keys(openTasksToolCallCounts).length,
    ...perOpenTasksToolMetrics,
    gitlabHelperCallCount,
    gitlabHelperApiShorthandCallCount,
    gitlabProtectedBranchHelperCallCount,
    rawGitlabApiCurlCallCount,
  };
}

function countOpenTasksSelectTargets(query: string): number {
  return query.match(/select:mcp__opentasks__[A-Za-z0-9_:-]*/g)?.length ?? 0;
}

function metricNamePart(name: string): string {
  return name
    .split(/[_\W]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function isGitlabApiShorthandCommand(command: string): boolean {
  const match = command.match(/\btac-gitlab-api\s+\S+\s+(['"]?)(\/?[^'"\s]+)\1/);
  if (!match) return false;
  const pathArg = match[2] ?? '';
  if (/^https?:\/\//.test(pathArg) || pathArg.startsWith('/api/v4') || pathArg.startsWith('api/v4')) return false;
  const first = pathArg.replace(/^\/+/, '').split('/', 1)[0];
  return new Set([
    'application',
    'broadcast_messages',
    'groups',
    'hooks',
    'issues',
    'namespaces',
    'projects',
    'repository',
    'runners',
    'search',
    'snippets',
    'todos',
    'user',
    'users',
  ]).has(first);
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

export interface TraceDiagnostics {
  repeatedToolCallCount: number;
  repeatedBashCommandCount: number;
  toolErrorCount: number;
  http401Count: number;
  http403Count: number;
  http404Count: number;
  http5xxCount: number;
  authFailureSignalCount: number;
  gitlabApiWriteAttempts: number;
  gitlabApiWriteSucceeded: number;
  wikiGitCloneAttempts: number;
  wikiGitPushAttempts: number;
  wikiGitPushSucceeded: number;
  remoteWikiCreated: number;
  pipelineEditorUrlSeen: number;
  liveTokenBudgetExceeded: number;
}

export interface FailureTaxonomyReport {
  primary: string;
  labels: string[];
  signals: TraceDiagnostics;
}

export function traceDiagnosticsFromClaudeStream(stdout: string, stderr: string): TraceDiagnostics {
  const diagnostics: TraceDiagnostics = {
    repeatedToolCallCount: 0,
    repeatedBashCommandCount: 0,
    toolErrorCount: 0,
    http401Count: 0,
    http403Count: 0,
    http404Count: 0,
    http5xxCount: 0,
    authFailureSignalCount: 0,
    gitlabApiWriteAttempts: 0,
    gitlabApiWriteSucceeded: 0,
    wikiGitCloneAttempts: 0,
    wikiGitPushAttempts: 0,
    wikiGitPushSucceeded: 0,
    remoteWikiCreated: 0,
    pipelineEditorUrlSeen: 0,
    liveTokenBudgetExceeded: /TAC live token budget exceeded|tokens_live/i.test(`${stdout}\n${stderr}`) ? 1 : 0,
  };
  const toolCounts = new Map<string, number>();
  const bashCounts = new Map<string, number>();
  const scannedText: string[] = [stderr];
  const openSwarmTools = new Map<string, { name: string; json: string; input?: unknown }>();

  const recordToolUse = (name: string, input: unknown) => {
    const key = `${name}:${stableJson(input ?? {})}`;
    toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1);
    if (canonicalDiagnosticToolName(name) === 'Bash') {
      const command = normalizeCommand((input as { command?: unknown } | undefined)?.command);
      if (command) {
        bashCounts.set(command, (bashCounts.get(command) ?? 0) + 1);
        scannedText.push(command);
      }
    }
  };

  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const event = swarmDiagnosticPayload(obj);

    if (event.type === 'tool_use_start') {
      const id = typeof event.id === 'string' ? event.id : typeof event.toolUseId === 'string' ? event.toolUseId : '';
      const name = typeof event.name === 'string' ? event.name : typeof event.toolName === 'string' ? event.toolName : 'tool';
      if (id) openSwarmTools.set(id, { name, json: '' });
    }

    if (event.type === 'tool_use_input') {
      const id = typeof event.id === 'string' ? event.id : typeof event.toolUseId === 'string' ? event.toolUseId : '';
      const open = openSwarmTools.get(id);
      if (open && typeof event.jsonDelta === 'string') open.json += event.jsonDelta;
    }

    if (event.type === 'tool_use_end') {
      const id = typeof event.id === 'string' ? event.id : typeof event.toolUseId === 'string' ? event.toolUseId : '';
      const open = openSwarmTools.get(id);
      if (open) {
        const input = isRecord(event.input) ? event.input : parseJsonRecord(open.json);
        recordToolUse(canonicalDiagnosticToolName(open.name), input ?? {});
        openSwarmTools.delete(id);
      }
    }

    if (event.type === 'tool_result') {
      if (event.isError === true || event.is_error === true) diagnostics.toolErrorCount += 1;
      const text = textFromContent(event.content);
      if (text) scannedText.push(text);
    }

    if (event.type === 'error' || obj.status === 'failed' || obj.status === 'timeout' || obj.status === 'cancelled') {
      diagnostics.toolErrorCount += 1;
      scannedText.push(textFromContent(obj.error));
    }

    if (obj.type === 'assistant') {
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') continue;
        const tool = block as { name?: unknown; input?: unknown };
        if (typeof tool.name !== 'string') continue;
        recordToolUse(tool.name, tool.input ?? {});
      }
    }

    if (obj.type === 'user') {
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') continue;
        const result = block as { is_error?: unknown; content?: unknown };
        if (result.is_error === true) diagnostics.toolErrorCount += 1;
        const text = textFromContent(result.content);
        if (text) scannedText.push(text);
      }
    }

    if (obj.type === 'result') {
      scannedText.push(textFromContent((obj as { result?: unknown }).result));
      if ((obj as { is_error?: unknown }).is_error === true) diagnostics.toolErrorCount += 1;
    }
  }

  diagnostics.repeatedToolCallCount = repeatedCount(toolCounts);
  diagnostics.repeatedBashCommandCount = repeatedCount(bashCounts);
  const statusCounts = statusSignalCounts(scannedText.join('\n'));
  diagnostics.http401Count = statusCounts.http401Count;
  diagnostics.http403Count = statusCounts.http403Count;
  diagnostics.http404Count = statusCounts.http404Count;
  diagnostics.http5xxCount = statusCounts.http5xxCount;
  diagnostics.authFailureSignalCount = statusCounts.authFailureSignalCount;
  const gitlabSignals = gitlabTaskSignalCounts(scannedText.join('\n'));
  diagnostics.gitlabApiWriteAttempts = gitlabSignals.gitlabApiWriteAttempts;
  diagnostics.gitlabApiWriteSucceeded = gitlabSignals.gitlabApiWriteSucceeded;
  diagnostics.wikiGitCloneAttempts = gitlabSignals.wikiGitCloneAttempts;
  diagnostics.wikiGitPushAttempts = gitlabSignals.wikiGitPushAttempts;
  diagnostics.wikiGitPushSucceeded = gitlabSignals.wikiGitPushSucceeded;
  diagnostics.remoteWikiCreated = gitlabSignals.remoteWikiCreated;
  diagnostics.pipelineEditorUrlSeen = gitlabSignals.pipelineEditorUrlSeen;
  return diagnostics;
}

export function failureTaxonomy(signals: TraceDiagnostics): FailureTaxonomyReport {
  const labels: string[] = [];
  if (signals.liveTokenBudgetExceeded === 1) labels.push('budget_live_tokens');
  if (signals.authFailureSignalCount > 0 || signals.http401Count > 0 || signals.http403Count > 0) labels.push('auth_or_permission');
  if (signals.repeatedBashCommandCount >= 2 || signals.repeatedToolCallCount >= 3) labels.push('repetition_loop');
  if (signals.http404Count > 0) labels.push('not_found_or_wrong_target');
  if (signals.http5xxCount > 0) labels.push('service_unavailable');
  if (!labels.length) labels.push('undifferentiated_task_failure');
  return {
    primary: labels[0]!,
    labels,
    signals,
  };
}

export function taxonomyMetrics(report: FailureTaxonomyReport): Record<string, number> {
  const labels = new Set(report.labels);
  return {
    taxonomyBudgetLiveTokens: labels.has('budget_live_tokens') ? 1 : 0,
    taxonomyAuthOrPermission: labels.has('auth_or_permission') ? 1 : 0,
    taxonomyRepetitionLoop: labels.has('repetition_loop') ? 1 : 0,
    taxonomyNotFoundOrWrongTarget: labels.has('not_found_or_wrong_target') ? 1 : 0,
    taxonomyServiceUnavailable: labels.has('service_unavailable') ? 1 : 0,
    taxonomyUndifferentiatedTaskFailure: labels.has('undifferentiated_task_failure') ? 1 : 0,
  };
}

export function taxonomyMetricsForTacResult(result: TacResultJson, diagnostics: TraceDiagnostics): Record<string, number> {
  return tacResultIsFullSuccess(result) ? taxonomyMetrics({ ...failureTaxonomy(diagnostics), labels: [] }) : taxonomyMetrics(failureTaxonomy(diagnostics));
}

function tacResultIsFullSuccess(result: TacResultJson): boolean {
  const final = result.final_score ?? {};
  if (finiteNonnegative(final.total) && Number(final.total) > 0 && finiteNonnegative(final.result)) {
    return Number(final.result) >= Number(final.total);
  }
  const checkpoints = result.checkpoints ?? [];
  if (!checkpoints.length) return false;
  return checkpoints.every((cp) => {
    const total = finiteNonnegative(cp.total) ? Number(cp.total) : 1;
    const earned = finiteNonnegative(cp.result) ? Number(cp.result) : 0;
    return total > 0 && earned >= total;
  });
}

function finiteNonnegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function liveTokenLimitFromEnv(): number | undefined {
  if (process.env.TAC_CELL_LIVE_TOKEN_KILL === '0') return undefined;
  const raw = process.env.TAC_AGENT_LIVE_MAX_TOKENS ?? process.env.TAC_CELL_MAX_TOKENS;
  if (!raw || raw === '0') return undefined;
  return parseOptionalPositiveInt(raw);
}

function remainingLiveTokenLimit(limit: number | undefined, priorUsage: TokenUsage): number | undefined {
  if (!limit || limit <= 0) return undefined;
  const priorTokens = Math.max(0, Math.floor(priorUsage.totalTokens ?? 0));
  return Math.max(1, limit - priorTokens);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function swarmDiagnosticPayload(obj: Record<string, unknown>): Record<string, unknown> {
  return isRecord(obj.payload) && typeof obj.payload.type === 'string' ? obj.payload : obj;
}

function parseJsonRecord(json: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function canonicalDiagnosticToolName(name: string): string {
  const map: Record<string, string> = {
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    multi_edit: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    tool_search: 'ToolSearch',
    skill: 'Skill',
  };
  return map[name] ?? name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)]));
}

function normalizeCommand(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const command = value.replace(/\s+/g, ' ').trim();
  return command || null;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return '';
}

function repeatedCount(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += Math.max(0, count - 1);
  return total;
}

function statusSignalCounts(text: string): Pick<
  TraceDiagnostics,
  'http401Count' | 'http403Count' | 'http404Count' | 'http5xxCount' | 'authFailureSignalCount'
> {
  const lower = text.toLowerCase();
  return {
    http401Count: matchCount(text, /\b401\b|unauthorized/gi),
    http403Count: matchCount(text, /\b403\b|forbidden/gi),
    http404Count: matchCount(text, /\b404\b|not found/gi),
    http5xxCount: matchCount(text, /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/gi),
    authFailureSignalCount: [
      /\bauthentication\b/g,
      /\bauthorization\b/g,
      /invalid[_ -]?token/g,
      /permission denied/g,
      /not logged in/g,
      /access denied/g,
    ].reduce((sum, pattern) => sum + matchCount(lower, pattern), 0),
  };
}

function gitlabTaskSignalCounts(
  text: string,
): Pick<
  TraceDiagnostics,
  | 'gitlabApiWriteAttempts'
  | 'gitlabApiWriteSucceeded'
  | 'wikiGitCloneAttempts'
  | 'wikiGitPushAttempts'
  | 'wikiGitPushSucceeded'
  | 'remoteWikiCreated'
  | 'pipelineEditorUrlSeen'
> {
  const wikiCurlApiWriteAttempts = matchCount(text, /\b(?:POST|--request\s+POST|-X\s+POST)\b[^\n]*\/api\/v4\/projects\/[^\s'"]+\/wikis\b/gi);
  const wikiPythonApiWriteAttempts =
    /\brequests\.post\s*\(/i.test(text) && /\/api\/v4\/projects\/[^\s'"]+\/wikis\b/i.test(text) ? 1 : 0;
  const wikiApiWriteAttempts = wikiCurlApiWriteAttempts + wikiPythonApiWriteAttempts;
  const wikiApiSuccessText = matchCount(
    text,
    /(?:HTTP\/[0-9.]+\s+201|201\s+Created|"status"\s*:\s*201|status\s+code:\s*201)[\s\S]{0,600}(?:\/api\/v4\/projects\/[^\s'"]+\/wikis|\"slug\"\s*:|\"format\"\s*:\s*\"markdown\"|\bslug\s*:|wiki page created|\/-\/wikis\/)/gi,
  );
  const wikiApiJsonOnlySuccess = wikiApiWriteAttempts > 0 && /"format"\s*:\s*"markdown"/i.test(text)
    && /"slug"\s*:\s*"[^"]+"/i.test(text)
    && /"title"\s*:\s*"[^"]+"/i.test(text)
    && /"content"\s*:\s*"/i.test(text)
    ? 1
    : 0;
  const wikiGitPushSucceeded = matchCount(text, /To\s+https?:\/\/[^\s]+\.wiki\.git[\s\S]{0,300}(?:HEAD\s+->\s+master|\[new branch\])/gi);
  const gitlabApiWriteSucceeded = Math.min(wikiApiWriteAttempts, Math.max(wikiApiSuccessText, wikiApiJsonOnlySuccess));
  return {
    gitlabApiWriteAttempts: wikiApiWriteAttempts,
    gitlabApiWriteSucceeded,
    wikiGitCloneAttempts: matchCount(text, /\bgit\s+clone\b[^\n]+\.wiki\.git\b/gi),
    wikiGitPushAttempts: matchCount(text, /\bgit\s+push\b[^\n]*(?:origin|\.wiki\.git|master|main)/gi),
    wikiGitPushSucceeded,
    remoteWikiCreated: gitlabApiWriteSucceeded > 0 || wikiGitPushSucceeded > 0 ? 1 : 0,
    pipelineEditorUrlSeen: /\/-\/ci\/editor\b/.test(text) ? 1 : 0,
  };
}

function matchCount(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

interface OpenTasksMcpSmokeReport {
  ok: boolean;
  failureReason?: string;
  harnessId: string;
  exitCode: number;
  timedOut: boolean;
  sawResult: boolean;
  isError: boolean;
  usage: TokenUsage;
  mcpServers: { name: string; status: string }[];
  toolCount: number;
  opentasksToolCount: number;
  opentasksToolNames: string[];
  skillNames: string[];
  usedNativeOpentasksTool: boolean;
  nativeCalls: string[];
  usedSwarmTaskTool: boolean;
  swarmTaskToolCount: number;
  swarmTaskCalls: string[];
  stdoutHead: string;
  stderrHead: string;
  streamStats: ClaudeStreamStats;
  trajectory: TraceEvent[];
}

interface OpenTasksTaskPreludeReport {
  ok: boolean;
  failureReason?: string;
  attempt: number;
  maxAttempts: number;
  exitCode: number;
  timedOut: boolean;
  initOnly: boolean;
  initOnlyTimeout: boolean;
  sawResult: boolean;
  isError: boolean;
  usage: TokenUsage;
  mcpServers: { name: string; status: string }[];
  toolCount: number;
  opentasksToolCount: number;
  opentasksToolNames: string[];
  nativeCalls: string[];
  missingRequiredCalls: string[];
  output: string;
  stdoutHead: string;
  stderrHead: string;
  streamStats: ClaudeStreamStats;
  trajectory: TraceEvent[];
  attempts: OpenTasksTaskPreludeAttemptSummary[];
}

interface OpenTasksGraphSeedReport {
  ok: boolean;
  taskId?: string | null;
  taskTitle: string;
  sourceTaskId: string;
  cellKey: string;
  idempotencyKey?: string | null;
  contentBytes: number;
  tags: string[];
  created?: unknown;
  exitCode: number;
  error?: string | null;
  stdoutHead: string;
  stderrHead: string;
}

interface OpenTasksTaskPreludeAttemptSummary {
  attempt: number;
  ok: boolean;
  failureReason?: string;
  exitCode: number;
  timedOut: boolean;
  initOnly: boolean;
  initOnlyTimeout: boolean;
  sawResult: boolean;
  isError: boolean;
  usage: TokenUsage;
  nativeCalls: string[];
  missingRequiredCalls: string[];
  streamStats: ClaudeStreamStats;
  stdoutHead: string;
  stderrHead: string;
}

interface ClaudeStreamStats {
  lineCount: number;
  jsonLineCount: number;
  initEvents: number;
  assistantEvents: number;
  toolUseEvents: number;
  resultEvents: number;
}

function compactOpenTasksPreludeAttempt(report: OpenTasksTaskPreludeReport): OpenTasksTaskPreludeAttemptSummary {
  return {
    attempt: report.attempt,
    ok: report.ok,
    failureReason: report.failureReason,
    exitCode: report.exitCode,
    timedOut: report.timedOut,
    initOnly: report.initOnly,
    initOnlyTimeout: report.initOnlyTimeout,
    sawResult: report.sawResult,
    isError: report.isError,
    usage: report.usage,
    nativeCalls: report.nativeCalls,
    missingRequiredCalls: report.missingRequiredCalls,
    streamStats: report.streamStats,
    stdoutHead: report.stdoutHead,
    stderrHead: report.stderrHead,
  };
}

function parseClaudeInit(stdout: string): { toolNames: string[]; skillNames: string[] } {
  const toolNames = new Set<string>();
  const skillNames = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'system' || obj.subtype !== 'init') continue;
    collectNames(obj.tools, toolNames);
    collectNames(obj.available_tools, toolNames);
    collectNames(obj.skills, skillNames);
    collectNames(obj.available_skills, skillNames);
  }
  return {
    toolNames: [...toolNames].sort(),
    skillNames: [...skillNames].sort(),
  };
}

function collectNames(value: unknown, out: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string') out.add(item);
    else if (item && typeof item === 'object') {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string') out.add(name);
    }
  }
}

function claudeStreamStats(stdout: string): ClaudeStreamStats {
  const stats: ClaudeStreamStats = {
    lineCount: stdout ? stdout.split('\n').filter((line) => line.length > 0).length : 0,
    jsonLineCount: 0,
    initEvents: 0,
    assistantEvents: 0,
    toolUseEvents: 0,
    resultEvents: 0,
  };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    stats.jsonLineCount += 1;
    if (obj.type === 'system' && obj.subtype === 'init') stats.initEvents += 1;
    if (obj.type === 'assistant') {
      stats.assistantEvents += 1;
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use') {
            stats.toolUseEvents += 1;
          }
        }
      }
    }
    if (obj.type === 'result') stats.resultEvents += 1;
  }
  return stats;
}

function smokeFailureReason(opts: {
  exitCode: number;
  timedOut: boolean;
  sawResult: boolean;
  isError: boolean;
  output: string;
  connected: boolean;
  exposed: boolean;
  mcpServers: { name: string; status: string }[];
  stderr: string;
  harnessId: string;
}): string {
  if (opts.timedOut) return `${opts.harnessId} OpenTasks MCP smoke timed out`;
  if (!opts.sawResult) return `${opts.harnessId} OpenTasks MCP smoke did not emit a completed assistant result`;
  if (opts.isError) return `${opts.harnessId} OpenTasks MCP smoke result was marked as an error: ${(opts.output || opts.stderr).slice(0, 200)}`;
  if (opts.exitCode !== 0) return `${opts.harnessId} OpenTasks MCP smoke exited ${opts.exitCode}: ${opts.stderr.slice(0, 200)}`;
  if (opts.exposed) return `${opts.harnessId} exposed OpenTasks tools but did not execute a native mcp__opentasks__ tool`;
  if (!opts.connected) {
    const status = opts.mcpServers.find((server) => server.name === 'opentasks')?.status ?? 'missing';
    return opts.harnessId === 'claude-code'
      ? `opentasks MCP server was not connected in Claude init; status=${status}`
      : `${opts.harnessId} did not report or execute OpenTasks MCP tools; opentasks status=${status}`;
  }
  if (!opts.exposed) return `${opts.harnessId} did not expose or execute native mcp__opentasks__ tools`;
  return 'unknown smoke failure';
}

function preludeFailureReason(opts: {
  exitCode: number;
  timedOut: boolean;
  initOnlyTimeout: boolean;
  sawResult: boolean;
  isError: boolean;
  output: string;
  stderr: string;
  missingRequiredCalls: string[];
}): string {
  if (opts.initOnlyTimeout) return 'OpenTasks task prelude timed out after Claude init only';
  if (opts.timedOut) return 'OpenTasks task prelude timed out';
  if (!opts.sawResult) return 'OpenTasks task prelude did not emit a result event';
  if (opts.isError) return `OpenTasks task prelude result was marked is_error=true: ${(opts.output || opts.stderr).slice(0, 200)}`;
  if (opts.exitCode !== 0) return `OpenTasks task prelude exited ${opts.exitCode}: ${opts.stderr.slice(0, 200)}`;
  if (opts.missingRequiredCalls.length) return `OpenTasks task prelude missed required calls: ${opts.missingRequiredCalls.join(', ')}`;
  return 'unknown OpenTasks task prelude failure';
}

function parseOpenTasksMcpCommandVariant(raw: string | undefined): OpenTasksMcpCommandVariant | undefined {
  if (!raw) return undefined;
  if (raw === 'wrapper' || raw === 'sh-lc' || raw === 'direct') return raw;
  throw new Error(`Invalid TAC_OPENTASKS_MCP_COMMAND=${raw}; expected wrapper, sh-lc, or direct`);
}

function parseOpenTasksPreludeFailureMode(
  raw: string | undefined,
  legacyFailFast: string | undefined,
): OpenTasksPreludeFailureMode | undefined {
  if (raw) {
    if (raw === 'fail-fast' || raw === 'degrade') return raw;
    throw new Error(`Invalid TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=${raw}; expected fail-fast or degrade`);
  }
  if (legacyFailFast === '0') return 'degrade';
  if (legacyFailFast === '1') return 'fail-fast';
  return undefined;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`Expected boolean env value, got ${raw}`);
}

function parseOptionalNonNegativeInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Expected non-negative integer env value, got ${raw}`);
  return value;
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Expected positive integer env value, got ${raw}`);
  return value;
}

function stringMeta(cell: PublicCell, key: string): string | undefined {
  const value = cell.task.publicMetadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function boolMeta(cell: PublicCell, key: string): boolean {
  return cell.task.publicMetadata?.[key] === true;
}

function taskUsesLlmGrader(cell: PublicCell): boolean {
  return boolMeta(cell, 'usesLlmGrader');
}

function usesOpenTasks(cell: PublicCell): boolean {
  return (cell.arm.scaffold.mcpServers ?? []).some((server) => server.name === 'opentasks');
}

async function writeLocalAgentArtifacts(stdout: string, stderr: string): Promise<void> {
  await writeLocalArtifact('agent-stream.jsonl', stdout);
  if (stderr) await writeLocalArtifact('agent-stderr.log', stderr);
}

async function writeLocalArtifact(name: string, content: string): Promise<void> {
  const outDir = process.env.EVAL_OUT_DIR;
  if (!outDir) return;
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, name), content);
  } catch {
    // Artifact capture must never affect benchmark scoring.
  }
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bAWS_BEARER_TOKEN_BEDROCK\s*[=:]\s*\\?"?[^\\\n\r"']+/g, 'AWS_BEARER_TOKEN_BEDROCK=[REDACTED]')
    .replace(/\bANTHROPIC_API_KEY\s*[=:]\s*\\?"?[^\\\n\r"']+/g, 'ANTHROPIC_API_KEY=[REDACTED]')
    .replace(/\bLITELLM_API_KEY\s*[=:]\s*\\?"?[^\\\n\r"']+/g, 'LITELLM_API_KEY=[REDACTED]')
    .replace(/\bAWS_SECRET_ACCESS_KEY\s*[=:]\s*\\?"?[^\\\n\r"']+/g, 'AWS_SECRET_ACCESS_KEY=[REDACTED]')
    .replace(/\bAWS_SESSION_TOKEN\s*[=:]\s*\\?"?[^\\\n\r"']+/g, 'AWS_SESSION_TOKEN=[REDACTED]')
    .replace(/\bABSK[A-Za-z0-9+/=._-]+/g, '[REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/\broot-token\b/g, '[REDACTED_TAC_GITLAB_TOKEN]');
}

function envRaw(kind: EnvError['kind'], message: string, start: number, usage: TokenUsage = ZERO_USAGE, trajectory: TraceEvent[] = []): RawRun {
  return {
    output: '',
    usage,
    trajectory,
    envError: { kind, message: message.slice(0, 500), retriable: false },
    durationMs: Date.now() - start,
  };
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
