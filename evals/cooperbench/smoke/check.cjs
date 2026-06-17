/**
 * Verify the cross-container exactly-once property: the two agents (in separate
 * containers) drained the shared queue with NO double-claim and NO lost task.
 * This is the §8 must-pass gate for the sidecar topology.
 */
const { readFileSync, existsSync } = require('node:fs');

const n = Number(process.env.OT_TASKS || '6');
const fileA = '/srv/ot/claimed-agent-a.txt';
const fileB = '/srv/ot/claimed-agent-b.txt';

function idsFrom(file) {
  if (!existsSync(file)) return null; // agent did not complete
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[1]);
}

const a = idsFrom(fileA);
const b = idsFrom(fileB);

if (a === null || b === null) {
  console.error(`FAIL: an agent did not complete (missing claim file: a=${a !== null}, b=${b !== null})`);
  process.exit(1);
}

const all = [...a, ...b];
const unique = new Set(all);
const dupes = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];

console.log(
  `agent-a=${a.length}, agent-b=${b.length}, total=${all.length}, unique=${unique.size}, expected=${n}`,
);

let ok = true;
if (dupes.length) {
  console.error(`FAIL: ${dupes.length} task(s) double-claimed across containers: ${dupes.join(', ')}`);
  ok = false;
}
if (unique.size !== n) {
  console.error(`FAIL: expected ${n} unique claims, got ${unique.size}`);
  ok = false;
}
if (a.length === 0 || b.length === 0) {
  // Not a failure (the claim is correct either way), but flag a non-contended run.
  console.log(`NOTE: one agent claimed nothing (split ${a.length}/${b.length}) — claim was correct but not contended this run`);
}

if (ok) {
  console.log('PASS: exactly-once across containers — no double-claim, every task claimed by exactly one agent');
  process.exit(0);
}
process.exit(1);
