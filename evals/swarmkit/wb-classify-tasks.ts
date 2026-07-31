/**
 * Stratify WorkBench tasks by their ground-truth ACTION STRUCTURE — step 1 of Tier 3
 * (`../TIER3-THROUGHPUT.md`), and the reproducible version of the ad-hoc scan behind the Tier-2 result.
 *
 * WHY. Tier 2 showed the coordination effect is invisible on a naive first-N sample and large on the
 * stratum where duplication binds. Both tiers therefore depend on selecting tasks by a property of the
 * sealed answer: how many side-effecting actions the task requires, and how they spread over domains.
 * Doing that by hand is unreproducible and unauditable; this makes it a command.
 *
 * SELECTION ON GROUND TRUTH IS NOT LEAKAGE — but it must be declared. The agents never see any of this;
 * arms are compared within an identical task set. What it does mean is that a headline Δ is an effect
 * size CONDITIONAL on the stratum, never a whole-benchmark improvement. Say so in any write-up.
 *
 * Parsing is delegated to python (WorkBench's own venv) because the `outcome` column is a Python-list
 * literal whose action strings contain commas and quotes — `ast.literal_eval` + `csv` is correct where a
 * hand-rolled TS parse would be subtly wrong. Ids match swarmkit-eval's `wbTaskId` (sha1(task)[:12]), so
 * the emitted lists paste straight into `EVAL_TASK_IDS`.
 *
 *   npx tsx evals/swarmkit/wb-classify-tasks.ts                    # summary + per-stratum id lists
 *   WB_STRATUM=t3-ideal npx tsx evals/swarmkit/wb-classify-tasks.ts  # just that stratum's EVAL_TASK_IDS
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WB_REPO = process.env.WORKBENCH_REPO ?? path.join(process.env.HOME ?? '', 'GitHub', 'WorkBench');
const WB_PYTHON = process.env.WORKBENCH_PYTHON ?? path.join(WB_REPO, '.venv', 'bin', 'python');
const DOMAIN = process.env.EVAL_DOMAIN ?? 'multi_domain';
const OUT_DIR = path.resolve(process.cwd(), 'evals/.wb-strata');
const ONLY = process.env.WB_STRATUM;

const DOMAIN_FILE: Record<string, string> = {
  email: 'email_tasks_and_outcomes.csv',
  calendar: 'calendar_tasks_and_outcomes.csv',
  analytics: 'analytics_tasks_and_outcomes.csv',
  project_management: 'project_management_tasks_and_outcomes.csv',
  crm: 'customer_relationship_manager_tasks_and_outcomes.csv',
  multi_domain: 'multi_domain_tasks_and_outcomes.csv',
};

/** Same id function as swarmkit-eval's `wbTaskId`, so output pastes into EVAL_TASK_IDS unchanged. */
function wbTaskId(task: string): string {
  return createHash('sha1').update(task, 'utf8').digest('hex').slice(0, 12);
}

/** Read the CSV + literal-eval the sealed `outcome` column in WorkBench's own python. */
const PY = `
import ast, csv, json, sys
rows = []
with open(sys.argv[1], newline='', encoding='utf-8') as f:
    for r in csv.DictReader(f):
        task = (r.get('task') or '').strip()
        if not task:
            continue
        raw = (r.get('outcome') or '').strip()
        try:
            actions = ast.literal_eval(raw) if raw else []
            if not isinstance(actions, list):
                actions, bad = [], True
            else:
                bad = False
        except (ValueError, SyntaxError):
            actions, bad = [], True
        rows.append({'task': task, 'domains': r.get('domains') or '', 'actions': [str(a) for a in actions], 'parseFailed': bad})
json.dump(rows, sys.stdout)
`;

/** Public \`domains\` cell ("['email', 'calendar']") → string[]. */
function parseDomains(s: string): string[] {
  try {
    const v = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** `email.send_email.func(...)` → `email`. Returns null when the shape is unrecognised, so a WorkBench
 *  format change surfaces as `parseFailed` rather than silently mis-stratifying every task. */
function actionDomain(action: string): string | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\./.exec(action);
  return m ? m[1]! : null;
}

interface Row { task: string; domains: string; actions: string[]; parseFailed: boolean }

interface Classified {
  id: string;
  k: number;
  publicDomains: string[];
  actionDomains: string[];
  /** No domain contributes >1 action → no intra-domain create→update ordering dependency. */
  oneActionPerDomain: boolean;
  /** The public split (what per-domain seeding can legally use) equals the true action split. */
  splitAligned: boolean;
  stratum: string;
  parseFailed: boolean;
}

/**
 * Strata. The Tier-3 question needs k ≥ 2 INDEPENDENT actions — below that, parallelism is impossible and
 * no arm can show a speedup (Amdahl's serial fraction is 1). `t3-ideal` is the cleanest test: one action
 * per domain AND the public domain list equals the action domains, so per-domain seeding coincides with
 * the ideal partition WITHOUT consulting the answer. `t3-serial` is excluded from the main run — multiple
 * actions inside one domain are likely ordering-dependent, which caps speedup for reasons unrelated to
 * coordination.
 */
function classify(r: Row): Classified {
  const publicDomains = parseDomains(r.domains);
  const mapped = r.actions.map(actionDomain);
  const parseFailed = r.parseFailed || (r.actions.length > 0 && mapped.some((d) => d === null));
  const actionDomains = mapped.filter((d): d is string => d !== null);
  const uniq = [...new Set(actionDomains)];
  const k = r.actions.length;
  const oneActionPerDomain = k > 0 && uniq.length === k;
  const splitAligned = uniq.length > 0 && uniq.length === publicDomains.length && uniq.every((d) => publicDomains.includes(d));

  let stratum: string;
  if (parseFailed) stratum = 'unparsed';
  else if (k === 0) stratum = 'query-only';
  else if (k === 1) stratum = 'single'; // the Tier-2 stratum (duplication binds; parallelism impossible)
  else if (uniq.length < 2) stratum = 't3-serial'; // k≥2 but same domain → likely dependent
  else if (oneActionPerDomain && splitAligned) stratum = 't3-ideal';
  else stratum = 't3-multi';

  return { id: `wb-${DOMAIN}-${wbTaskId(r.task)}`, k, publicDomains, actionDomains, oneActionPerDomain, splitAligned, stratum, parseFailed };
}

function main(): void {
  const csvPath = path.join(WB_REPO, 'data', 'processed', 'tasks_and_outcomes', DOMAIN_FILE[DOMAIN] ?? DOMAIN_FILE.multi_domain!);
  if (!fs.existsSync(csvPath)) throw new Error(`WorkBench tasks CSV not found: ${csvPath}\nSet WORKBENCH_REPO (currently ${WB_REPO}).`);
  if (!fs.existsSync(WB_PYTHON)) throw new Error(`WorkBench python not found: ${WB_PYTHON}\nSet WORKBENCH_PYTHON, or run \`uv sync\` in ${WB_REPO}.`);

  const rows = JSON.parse(execFileSync(WB_PYTHON, ['-c', PY, csvPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Row[];
  const classified = rows.map(classify);

  const byStratum = new Map<string, Classified[]>();
  for (const c of classified) {
    if (!byStratum.has(c.stratum)) byStratum.set(c.stratum, []);
    byStratum.get(c.stratum)!.push(c);
  }

  if (ONLY) {
    const ids = (byStratum.get(ONLY) ?? []).map((c) => c.id);
    if (!ids.length) throw new Error(`stratum "${ONLY}" is empty (have: ${[...byStratum.keys()].join(', ')})`);
    console.log(`EVAL_TASK_IDS=${ids.join(',')}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${DOMAIN}.json`);
  fs.writeFileSync(outPath, JSON.stringify(classified, null, 2));

  console.log(`WorkBench ${DOMAIN}: ${classified.length} tasks → ${path.relative(process.cwd(), outPath)}\n`);
  console.log('  stratum      n    meaning');
  console.log('  ---------- ----  --------------------------------------------------------------');
  const meaning: Record<string, string> = {
    'query-only': 'no side effects — both arms pass; hides any coordination effect',
    single: 'k=1 side effect — Tier-2 stratum (duplication binds, no parallelism possible)',
    't3-ideal': 'k≥2, one action per domain, public split == action split — THE Tier-3 stratum',
    't3-multi': 'k≥2 across ≥2 domains, split imperfect — Tier-3 secondary',
    't3-serial': 'k≥2 within one domain — likely ordering-dependent; excluded',
    unparsed: 'outcome/action shape unrecognised — INVESTIGATE before trusting any stratum',
  };
  for (const s of ['query-only', 'single', 't3-ideal', 't3-multi', 't3-serial', 'unparsed']) {
    const n = byStratum.get(s)?.length ?? 0;
    if (n || s === 't3-ideal') console.log(`  ${s.padEnd(10)} ${String(n).padStart(4)}  ${meaning[s]}`);
  }

  const unparsed = byStratum.get('unparsed')?.length ?? 0;
  if (unparsed) console.warn(`\n⚠️  ${unparsed} task(s) failed to parse — every stratum count below is suspect until that is explained.`);

  const t3 = [...(byStratum.get('t3-ideal') ?? []), ...(byStratum.get('t3-multi') ?? [])];
  console.log(`\nTier-3 candidate pool (ideal + multi): ${t3.length} tasks, before the solo-correct filter.`);
  if (t3.length < 15) {
    console.warn('⚠️  Below the n≥15 the paired CI needs. See the "thin stratum" mitigation in evals/TIER3-THROUGHPUT.md.');
  }
  console.log('\nPaste-ready id lists:');
  for (const s of ['t3-ideal', 't3-multi', 'single']) {
    const ids = (byStratum.get(s) ?? []).map((c) => c.id);
    if (ids.length) console.log(`\n# ${s} (n=${ids.length})\nEVAL_TASK_IDS=${ids.join(',')}`);
  }
  console.log('\nNext: run N=1 solo over the Tier-3 pool per model, and keep only solo-correct tasks (ceiling 1.00)\nso any drop is attributable to coordination rather than task difficulty.');
}

main();
