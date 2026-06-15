/**
 * OpenTasks evaluation harness — core types.
 *
 * Design (see docs/evaluations/2026-06-14-P6-evaluation-design.md):
 * we run a STANDARD benchmark's tasks and score on its scale; OpenTasks is a
 * *harness ablation* (the arm), never the benchmark. Scoring is ground-truth
 * (checkpoints run against the work dir), NEVER the agent's self-reported state.
 *
 * Inspired by skill-tree's eval runner (headless `claude -p` per cell on
 * Bedrock, model-swappable, JSON token accounting, hidden post-hoc verifier).
 */

export type ArmId = 'stock' | 'notes' | 'opentasks';

export interface McpConfig {
  name: string;
  command: string;
  args: string[];
}

/** An experimental arm = the same runner+model with a different state mechanism. */
export interface EvalArm {
  id: ArmId;
  label: string;
  /** Appended to the agent's system prompt (the per-arm state-management instruction). */
  systemPromptAppendix: string;
  /** Extra allowed tool patterns beyond the base set (e.g. OpenTasks MCP tools). */
  extraTools: string[];
  /** If set, written to a temp .mcp.json and passed via --mcp-config. */
  mcp?: McpConfig;
}

export type Check =
  | { type: 'fileExists'; path: string }
  | { type: 'fileContains'; path: string; pattern: string }
  | { type: 'cmd'; cmd: string }; // exit 0 = passed

/** A ground-truth checkpoint (TheAgentCompany-style partial credit). */
export interface Checkpoint {
  id: string;
  weight: number;
  check: Check;
}

export interface EvalTask {
  id: string;
  prompt: string;
  /** Files seeded into the throwaway work dir before the agent runs. */
  setupFiles?: { path: string; content: string }[];
  /** Ground-truth checkpoints scored AFTER the agent finishes. Never graph state. */
  checkpoints: Checkpoint[];
}

export interface ToolCallEvent {
  name: string;
  input: unknown;
}

/**
 * Per-phase summary for the cross-session continuity (reset) variant. Phase 2 is
 * the headline: how cheaply a fresh-context agent RE-ORIENTS after a reset given
 * its arm's durable state (graph / NOTES.md / nothing).
 */
export interface PhaseSummary {
  tokenCost: number;
  durationMs: number;
  numToolCalls: number;
  redundantExplorationOps: number;
  readGraph: boolean;
  timedOut: boolean;
  /** Reached a final `result` event. False = interrupted (phase 1 hitting its cap). */
  completedCleanly: boolean;
  /** S_partial measured against ground-truth checkpoints at the END of this phase. */
  sPartial: number;
  sFull: boolean;
}

export interface RunResult {
  taskId: string;
  armId: ArmId;
  repeat: number;
  model: string;

  // scoring (ground-truth)
  checkpointResults: { id: string; passed: boolean; weight: number }[];
  /** S_partial = 0.5·(earned/total) + 0.5·S_full (TheAgentCompany). */
  sPartial: number;
  sFull: boolean;

  // cost
  tokenCost: number;
  durationMs: number;

  /** MCP servers the agent reported at init (confirms the OpenTasks MCP connected). */
  mcpServers: { name: string; status: string }[];

  // diagnostics from the tool-call trace
  toolCalls: ToolCallEvent[];
  /** Repeat reads/greps of already-seen paths/patterns (re-exploration proxy; refined to tokens later). */
  redundantExplorationOps: number;
  /** Did the agent actually consult the graph (an opentasks query/get_context/...)? */
  readGraph: boolean;

  // infra
  timedOut: boolean;
  infraFailure: boolean;
  error?: string;

  /**
   * Set only by the cross-session continuity (reset) runner. The top-level
   * cost/diagnostic fields are the COMBINED phase1+phase2 totals; `phases` breaks
   * them out. Phase 2 is the re-orientation-after-reset measurement.
   */
  phases?: { phase1: PhaseSummary; phase2: PhaseSummary };
}
