/**
 * The synthetic emit-queue 2×2, ported NATIVELY onto swarmkit-eval's multi-agent (`marble`) seam (§4c).
 *
 * This replaces the `placement:'self'` wrapper (synth-adapter.ts): the N-agent fan-out + reset are now
 * the engine's `runMarbleFlow`, the collector is a first-class `ServiceSpec`, the prompts are `PhaseSpec`s,
 * and the per-agent driver is `native-cli`. swarmkit-eval owns the multi-agent machinery; this file is a
 * thin benchmark spec. The three OpenTasks runners (concurrency/continuity/celld) are no longer needed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ServiceSpec,
  ServiceHandle,
  ServiceContext,
  MarbleBenchmarkAdapter,
  MultiAgentRawRun,
  Score,
  PhaseSpec,
  CoordinationAction,
} from 'swarmkit-eval';
import { startCollector, scoreExactlyOnce, type EmitRecord } from '../synthetic/collector.js';
import {
  SYNTH_ARMS,
  makeItems,
  seedOpentasksGraph,
  buildPrompt,
  buildContinuityP1Prompt,
  buildContinuityResumePrompt,
  buildCellDPhase1Prompt,
  buildCellDPhase2Prompt,
} from '../synthetic/emit-queue.js';
import { stopOpentasksDaemon } from '../runner.js';
import type { ArmId } from '../types.js';

export type SynthCell = 'B' | 'C' | 'D';
export interface SynthMarbleOpts {
  cell: SynthCell;
  repeats: number;
  n: number;
  m: number;
  k: number;
}

/** Collector state handed to the grader: emit records + the phase-1/2 split (for p2ReEmits). */
interface CollectorState {
  records: EmitRecord[];
  phase1Count: number;
  phase1Done: string[];
}

/** The emit collector + work substrate as a first-class swarmkit-eval service. */
function collectorService(opts: SynthMarbleOpts): ServiceSpec {
  return {
    id: 'collector',
    async start(ctx: ServiceContext): Promise<ServiceHandle> {
      const arm = SYNTH_ARMS[ctx.armId as ArmId];
      const m = Number(ctx.publicMetadata?.m ?? opts.m);
      const k = Number(ctx.publicMetadata?.k ?? opts.k);
      const items = makeItems(m);
      const collector = await startCollector();
      const seedEnv = { ...process.env } as NodeJS.ProcessEnv;

      // The non-idempotent side-effect: `./emit <id>` POSTs to the collector (no read path).
      const emitPath = path.join(ctx.workspaceRoot, 'emit');
      fs.writeFileSync(
        emitPath,
        [
          '#!/bin/sh',
          `curl -s -X POST "http://127.0.0.1:${collector.port}/emit" --data-urlencode "id=$1" --data-urlencode "agent=\${AGENT_ID:-unknown}" >/dev/null 2>&1`,
          'echo "emitted $1"',
          '',
        ].join('\n'),
      );
      fs.chmodSync(emitPath, 0o755);

      // Work delivery: queue.txt for stock/notes; the task graph for opentasks. Cell D stages the graph
      // across the reset (first K before phase 1, the rest before phase 2) — done in onPhase.
      if (!arm.itemsViaGraph) fs.writeFileSync(path.join(ctx.workspaceRoot, 'queue.txt'), items.join('\n') + '\n');
      if (arm.itemsViaGraph && opts.cell !== 'D') seedOpentasksGraph(ctx.workspaceRoot, items, seedEnv);

      let phase1Count = 0;
      let phase1Done: string[] = [];
      const handle: ServiceHandle = {
        env: { COLLECTOR_URL: `http://127.0.0.1:${collector.port}` }, // for a fake agent; real agents use ./emit
        async onPhase({ index }) {
          if (opts.cell === 'D' && arm.itemsViaGraph) {
            seedOpentasksGraph(ctx.workspaceRoot, index === 0 ? items.slice(0, k) : items.slice(k), seedEnv);
          }
          // Snapshot the phase-1 set at the reset boundary so the grader can detect phase-2 re-emits.
          if (index === 1) {
            phase1Count = collector.records.length;
            phase1Done = [...new Set(collector.records.map((r) => r.id))];
          }
        },
        async readState(): Promise<CollectorState> {
          return { records: collector.records, phase1Count, phase1Done };
        },
        async stop() {
          await collector.close();
          stopOpentasksDaemon(ctx.workspaceRoot, seedEnv);
        },
      };
      return handle;
    },
  };
}

/** Per-cell phases (B = concurrency; C = continuity 1-agent reset; D = swarm × reset). */
function phasesFor(opts: SynthMarbleOpts): PhaseSpec[] {
  const sa = (id: string) => SYNTH_ARMS[id as ArmId];
  const items = makeItems(opts.m);
  if (opts.cell === 'C') {
    return [
      { id: 'p1', width: 1, prompt: ({ arm, agentId }) => buildContinuityP1Prompt(sa(arm.id), { m: opts.m, k: opts.k, agentId }) },
      { id: 'p2', width: 1, reset: true, prompt: ({ arm, agentId }) => buildContinuityResumePrompt(sa(arm.id), { m: opts.m, agentId }) },
    ];
  }
  if (opts.cell === 'D') {
    return [
      { id: 'p1', prompt: ({ arm, agentId }) => buildCellDPhase1Prompt(sa(arm.id), { m: opts.m, k: opts.k, agentId }) },
      { id: 'p2', reset: true, prompt: ({ arm, agentId }) => buildCellDPhase2Prompt(sa(arm.id), { m: opts.m, k: opts.k, agentId }) },
    ];
  }
  return [{ id: 'p1', prompt: ({ arm, agentId }) => buildPrompt(sa(arm.id), { items, agentId, m: opts.m }) }];
}

/** A swarmkit-eval `marble` benchmark backed by the synthetic emit-queue. */
export function syntheticMarbleBenchmark(opts: SynthMarbleOpts): MarbleBenchmarkAdapter {
  const id = `synth-${opts.cell}`;
  const items = makeItems(opts.m);
  return {
    id,
    execution: 'marble',
    grader: { kind: 'self' },
    swarm: { width: opts.n, phases: phasesFor(opts), services: [collectorService(opts)] },
    async load() {
      return Array.from({ length: opts.repeats }, (_, i) => ({
        id: `rep${i}`,
        benchmark: id,
        prompt: `[synthetic emit-queue cell ${opts.cell} · trial ${i}]`,
        publicMetadata: { repeat: i, m: opts.m, k: opts.k, cell: opts.cell },
      }));
    },
    score(raw: MultiAgentRawRun): Score {
      const st = (raw.services.collector ?? { records: [], phase1Count: 0, phase1Done: [] }) as CollectorState;
      const s = scoreExactlyOnce(st.records, items);
      const phase2 = st.records.slice(st.phase1Count);
      const done = new Set(st.phase1Done);
      const p2ReEmits = phase2.filter((r) => done.has(r.id)).length;
      return {
        full: s.correct,
        partial: s.m > 0 ? s.exactlyOnce / s.m : 0,
        earned: s.exactlyOnce,
        total: s.m,
        checkpoints: [],
        metrics: { doubleEmits: s.doubleEmits, missed: s.missed, exactlyOnce: s.exactlyOnce, p2ReEmits },
      };
    },
    coordination(call): CoordinationAction | null {
      const cmd = (call.input as { command?: string; file_path?: string } | undefined) ?? {};
      // ./emit <id> = productive work (the redundancy key is the item id).
      if (call.name === 'Bash' && typeof cmd.command === 'string') {
        const m = cmd.command.match(/\.\/emit\s+(\S+)/);
        if (m) return { kind: 'work', ref: m[1] };
        if (/claims\.txt|done\.txt/.test(cmd.command)) return { kind: 'coordination' };
      }
      // opentasks coordination primitives + notes' shared-file writes.
      if (call.name?.startsWith('mcp__opentasks__')) return { kind: 'coordination' };
      if ((call.name === 'Write' || call.name === 'Edit') && /claims\.txt|done\.txt/.test(String(cmd.file_path ?? ''))) {
        return { kind: 'coordination' };
      }
      return null;
    },
  };
}
