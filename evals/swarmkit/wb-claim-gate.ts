/**
 * Claim-gated tool access — an MCP proxy that VALIDATES the claim at the resource.
 *
 * THE PROBLEM IT SOLVES. Tier 2 established that OpenTasks' atomic claim prevents duplicate side effects
 * only in the single-writer configuration (`WB_SEED_MODE=single`), where exactly one agent can win the one
 * claimable unit and the rest have nothing to act on. That is structurally safe but single-writer *by
 * construction*: one effective worker, so it can match a solo agent and never beat one. The parallel
 * configuration (`per-domain`) collapses instead, because a `claimed:false` agent is merely *asked* to
 * stand down — at N=4, 3–4 of 4 haiku agents fired the side effect anyway.
 *
 * THE MISSING PIECE. This is the classic distributed-systems failure: a lease is advisory unless the
 * RESOURCE checks the fence before accepting a write. OpenTasks already mints claims with monotonic fence
 * tokens (`claim_fence`, `src/graph/coordination.ts`), and — like every current agent framework — nothing
 * validates them at the point of effect. The agent is trusted to respect its own claim.
 *
 * This proxy moves enforcement to the resource. It sits between the agent and the WorkBench MCP: read-only
 * calls pass through, and a SIDE-EFFECTING call is forwarded only if the calling agent currently holds a
 * live claim. A non-claiming agent is not asked to stand down — it *cannot* act, because the tool call is
 * rejected before it reaches WorkBench, so the email genuinely is not sent.
 *
 * WHY IT MATTERS FOR THE RESULT. It is the one mechanism that could make a swarm beat a solo agent while
 * staying safe: N agents hold DISTINCT claims and work concurrently (parallelism), and duplication is
 * impossible regardless of model compliance (safety). Single-writer gets safety by giving up parallelism;
 * per-domain gets parallelism by giving up safety. Gating is the design that need not choose.
 *
 * Agent identity is structural, not declared: the marble engine sets `AGENT_ID` per agent and
 * NativeCliAdapter merges it into the spawned CLI's env, which MCP children inherit. The gate never asks
 * the agent who it is — an agent that could name itself could also lie.
 *
 * Spawned as the `opentasks-gated` arm's WorkBench MCP server; see `workbench-marble-run.ts`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** The 14 side-effecting WorkBench tools (sanitized names, no `mcp__workbench__` prefix). */
export const DEFAULT_SIDE_EFFECTS = [
  'email_send_email', 'email_delete_email', 'email_forward_email', 'email_reply_email',
  'calendar_create_event', 'calendar_delete_event', 'calendar_update_event',
  'analytics_create_plot',
  'project_management_create_task', 'project_management_delete_task', 'project_management_update_task',
  'customer_relationship_manager_add_customer', 'customer_relationship_manager_update_customer',
  'customer_relationship_manager_delete_customer',
];

const TERMINAL = new Set(['closed', 'failed', 'abandoned']);

export interface ClaimRow {
  id?: string;
  title?: string;
  status?: string;
  claimed_by?: string;
  lock_until?: string;
  claim_fence?: number;
}

export interface GateDecision {
  allow: boolean;
  /** Machine-readable reason — `ok` when allowed; otherwise why it was denied. */
  reason: 'ok' | 'read-only' | 'no-agent-id' | 'no-claim' | 'claim-expired' | 'claim-lookup-failed';
  nodeId?: string;
  fence?: number;
}

/**
 * The gate decision, as a pure function of (tool, agent, live claim rows) so it is testable without a
 * daemon or a WorkBench checkout.
 *
 * FAILS CLOSED. If the agent cannot be identified, or the claim lookup errored, the side effect is
 * REFUSED. A gate that fails open silently degrades to the ungated arm and would be reported as a
 * mechanism result when it is really an infrastructure failure — the expensive kind of wrong. The distinct
 * `reason` codes are what let the runner tell "the mechanism worked" from "the gate was broken": a cell
 * whose denials are all `no-agent-id` is an infra bug, not a coordination finding.
 */
export function decide(toolName: string, agentId: string | undefined, rows: ClaimRow[] | null, sideEffects: Set<string>, now = Date.now()): GateDecision {
  if (!sideEffects.has(toolName)) return { allow: true, reason: 'read-only' };
  if (!agentId) return { allow: false, reason: 'no-agent-id' };
  if (rows === null) return { allow: false, reason: 'claim-lookup-failed' };

  const mine = rows.filter((r) => r.claimed_by === agentId && !TERMINAL.has(r.status ?? ''));
  if (mine.length === 0) return { allow: false, reason: 'no-claim' };

  // A lease that has run out is not a claim. Without this check a slow agent could act on work the reaper
  // has already handed to someone else — the duplicate a lease exists to prevent.
  const live = mine.filter((r) => !r.lock_until || Date.parse(r.lock_until) > now);
  if (live.length === 0) return { allow: false, reason: 'claim-expired' };

  const held = live[0]!;
  return { allow: true, reason: 'ok', ...(held.id ? { nodeId: held.id } : {}), ...(held.claim_fence !== undefined ? { fence: held.claim_fence } : {}) };
}

/** Query the LIVE daemon for current claims. Returns null on any failure → the gate denies (fails closed). */
function readClaims(otNode: string, otCli: string, otHome: string): ClaimRow[] | null {
  try {
    const out = execFileSync(otNode, [otCli, 'list', '--all', '--json'], {
      env: { ...process.env, OPENTASKS_PROJECT_DIR: otHome },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as ClaimRow[]) : null;
  } catch {
    return null;
  }
}

function audit(logPath: string | undefined, entry: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch { /* diagnostics are best-effort; never break the run */ }
}

async function main(): Promise<void> {
  const childSpec = JSON.parse(process.env.WB_GATE_CHILD ?? '{}') as { command?: string; args?: string[]; env?: Record<string, string> };
  if (!childSpec.command) throw new Error('wb-claim-gate: WB_GATE_CHILD must be JSON {command,args,env} for the real WorkBench MCP');

  const agentId = process.env.AGENT_ID;
  const logPath = process.env.WB_GATE_LOG;
  const sideEffects = new Set((process.env.WB_GATE_SIDE_EFFECTS ?? DEFAULT_SIDE_EFFECTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean));

  // The per-cell daemon's socket is published to ws.root/.ot_sock by the marble service; its parent dir is
  // the OPENTASKS_PROJECT_DIR home. cwd is the agent's cell, the same convention the opentasks MCP wrapper
  // uses (`cat .ot_sock`).
  const otCli = process.env.WB_GATE_OT_CLI ?? '';
  const otNode = process.env.WB_GATE_OT_NODE ?? process.execPath;
  let otHome = '';
  try {
    otHome = path.dirname(fs.readFileSync(process.env.WB_GATE_SOCK_FILE ?? '.ot_sock', 'utf8').trim());
  } catch { /* no socket → readClaims fails → gate denies, loudly, via the audit log */ }

  const child = new Client({ name: 'wb-claim-gate-client', version: '1.0.0' });
  await child.connect(new StdioClientTransport({
    command: childSpec.command,
    args: childSpec.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(childSpec.env ?? {}) },
  }));

  const server = new Server({ name: 'workbench', version: '1.0.0' }, { capabilities: { tools: {} } });

  // Tool list passes through untouched: the agent must see exactly the WorkBench surface, or the gated arm
  // would differ from the others in what it can attempt rather than only in what it may commit.
  server.setRequestHandler(ListToolsRequestSchema, async () => await child.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const rows = sideEffects.has(name) && otCli ? readClaims(otNode, otCli, otHome) : [];
    const decision = decide(name, agentId, rows, sideEffects);
    audit(logPath, { ts: Date.now(), agentId: agentId ?? null, tool: name, ...decision, input: req.params.arguments ?? {} });

    if (!decision.allow) {
      // Refused BEFORE forwarding — the side effect genuinely does not happen, and never reaches
      // WorkBench's action log. Phrased so a compliant agent stops rather than retrying in a loop.
      return {
        isError: true,
        content: [{
          type: 'text',
          text:
            `REFUSED by the coordination layer (${decision.reason}). You do not hold a claim covering this ` +
            `action, so it was NOT performed. Another agent owns this work. Do not retry, and do not try a ` +
            `different tool to achieve the same effect — claim work with mcp__opentasks__claim_next first, ` +
            `or stop if nothing is claimable.`,
        }],
      };
    }
    return await child.callTool({ name, arguments: req.params.arguments ?? {} });
  });

  await server.connect(new StdioServerTransport());
}

// Entrypoint only when run directly — importing for tests must not start a server.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
