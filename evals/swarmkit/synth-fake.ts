/**
 * Deterministic, zero-token fake runners for the synthetic adapter (EVAL_FAKE=1).
 * Plants the known qualitative result — stock races + re-emits, notes less, opentasks
 * race-clean — so the full pipeline (matrix → adapter → self-grade → metric CIs →
 * report) can be validated with no agents/tokens. Seeded by (arm, repeat).
 */

import type { SynthRunner, SynthRunners, SynthRunnerResult } from './synth-adapter.js';
import type { ArmId } from '../types.js';
import { scoreExactlyOnce, type EmitRecord } from '../synthetic/collector.js';

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fakeResult(arm: ArmId, m: number, k: number, repeat: number, withReset: boolean): SynthRunnerResult {
  const rng = mulberry32(hashStr(`${arm}:${repeat}:${m}:${k}`));
  const items = Array.from({ length: m }, (_, i) => `item-${String(i + 1).padStart(3, '0')}`);
  const records: EmitRecord[] = [];
  // Phase-1 / concurrency: every item emitted once; baselines occasionally double-emit (races).
  const raceP = arm === 'stock' ? 0.4 : arm === 'notes' ? 0.15 : 0;
  for (const id of items) {
    records.push({ id, agent: 'agent-1', t: 0 });
    if (rng() < raceP) records.push({ id, agent: 'agent-2', t: 1 });
  }
  // Continuity reset: baselines re-emit already-done items (no durable done-ness).
  let phase2ReEmits = 0;
  if (withReset) {
    const reP = arm === 'stock' ? 0.35 : arm === 'notes' ? 0.12 : 0;
    for (const id of items.slice(0, k)) {
      if (rng() < reP) {
        records.push({ id, agent: 'agent-1', t: 2 });
        phase2ReEmits++;
      }
    }
  }
  const score = scoreExactlyOnce(records, items);
  const base: SynthRunnerResult = {
    score,
    tokenCost: 1000 + Math.floor(rng() * 500),
    durationMs: 100,
    mcpConnected: arm === 'opentasks',
  };
  return withReset ? { ...base, phase2ReEmits } : base;
}

export function makeFakeRunners(): SynthRunners {
  const B: SynthRunner = async (arm, o) => fakeResult(arm, o.m, o.k, o.repeat, false);
  const C: SynthRunner = async (arm, o) => fakeResult(arm, o.m, o.k, o.repeat, true);
  const D: SynthRunner = async (arm, o) => fakeResult(arm, o.m, o.k, o.repeat, true);
  return { B, C, D };
}
