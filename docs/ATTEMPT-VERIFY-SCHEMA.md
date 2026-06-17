# Attempt + Verify Schema (design spec, 2026-06-16)

**Status:** IMPLEMENTED 2026-06-16 on branch `feat/attempt-verify-schema` — §8 steps 1–5 green (31 new tests, full typecheck clean, no regressions, build OK). Decision A → **attempt is a node type**. Not yet committed.
**Why:** [E6 CooperBench eval](./evaluations/2026-06-16-cooperbench-coordination-eval-design.md) §5 needs two coordination primitives whose absence drives **74% of CooperBench's measured failure causes** — *Expectation* (42%, "can't model the partner's in-progress changes") and *Commitment* (32%, "unverifiable claims"). This spec makes both first-class and queryable. It is also the schema half of the [coding-vs-research flexible-graph discussion](./evaluations/2026-06-14-P6-evaluation-design.md) — `attempt`/`verifies` are domain-agnostic, so the same primitives serve code (patch + test-run) and research (experiment + replication).

---

## 0. Design principle

OpenTasks keeps **node types a small closed set** but **edges and metadata open** ([`graph/types.ts:17`](../src/graph/types.ts), [`EdgeTypeRegistry.ts`](../src/graph/EdgeTypeRegistry.ts), open `metadata: Record<string, unknown>`). This spec stays inside that grain: it adds **one edge type, one metadata convention, and (Decision A) at most one node type** — reusing the existing claim/lease, status lifecycle, and `discovered-from`/`supersedes`/`implements` edges unchanged.

The conceptual shift is small and universal:

> A **task** is the *intent*. An **attempt** is *one agent's effort at it*, carrying an *outcome* + *evidence*. A **`verifies` edge** is *an independent check* of an attempt. Negative results are *attempts closed with `outcome: failure`* — recorded, not buried.

```
        ┌─────────── task ───────────┐         (intent — stays open until a
        │  status, claim, assignee   │          successful, verified attempt)
        └──────────────┬─────────────┘
            target_id   │   (1 task → N attempts; concurrent attempts are legal)
        ┌───────────────┼───────────────┐
   ┌────▼─────┐    ┌────▼─────┐         …
   │ attempt  │    │ attempt  │   each: claimed by one agent, own status,
   │ outcome  │    │ outcome  │   metadata.attempt = { outcome, evidence, … }
   └────┬─────┘    └────┬─────┘
        │ verifies (verdict, evidence)
   ┌────▼─────────────┐
   │ verification     │  (an independent check: a test run, a second agent)
   └──────────────────┘
```

---

## 1. Decision A — SETTLED (2026-06-16): an attempt is a node type

An **`attempt` is its own node type** (new `NodeType` `'attempt'`), modeled like the existing subordinate `feedback` type (`target_id` → its task) but with task-like lifecycle (status, assignee, claim). The `feedback` type already proves OpenTasks accepts subordinate, target-attached node types with their own lifecycle, so this stays in-grain.

**Why node, not `task.metadata.attempts[]`** — the decision turns on one observation: *the forces that force nodehood are exactly the multi-agent properties OpenTasks exists for.*

- **Link target** — `verifies` / `reproduces` / `discovered-from` must reference *a specific attempt*; the edge layer cannot traverse into a metadata array.
- **Concurrent independent writes** — two agents updating their own attempts of one task would both write the *task node* (contention + last-write-wins clobber of the array); separate nodes = separate writes.
- **Independent claim** — the atomic claim operates on node rows, not sub-fields. You cannot claim an array element, and claiming the parent task would block all sibling attempts (killing concurrency / best-of-N).

In a single-agent, sequential world none of these fire and metadata would be simpler — but that is the case OpenTasks does not need to exist for. **The eval-validity clincher:** nesting attempts/verifications into one node's JSON turns the task into a document store, collapsing the `opentasks` arm toward the `notes` arm — at which point the E6/E2′ "graph beats shared doc" thesis is untestable (it is secretly doc-vs-doc). Graph-native primitives keep the comparison honest.

*Escape hatch (not taken):* a lightweight single-agent attempt log can still use the existing `tracking.attempts` counter + an `outcome` on the task, promoting to an attempt node when a second actor / verification / concurrency appears. We do **not** build both representations up front.

---

## 2. The `attempt` node

Subordinate to a task, parallel to `feedback`. Reuses the existing claim/lease and status machinery.

| Field | Source | Notes |
|---|---|---|
| `type` | new `'attempt'` | the only `NodeType` addition |
| `target_id` | like `feedback` | the **task** this attempts |
| `assignee` / claim fields | existing (`claimed_by`, `claimed_at`, `lock_until`, `claim_fence`) | one agent owns an attempt; **atomic claim already ships** ([`coordination.ts`](../src/graph/coordination.ts)) |
| `status` | existing enum, **unchanged** | `open` → `in_progress` → `closed`/`blocked`. *No new status value* (see §4) |
| `content` | existing | optional: what was tried / the approach |
| `metadata.attempt` | **new convention** (§3) | outcome + evidence + failure reason |

A task→attempt link is carried by `target_id` (mirrors `feedback`), so **no `attempt-of` edge is required** — a task's attempts are found by `target_id`.

**Concurrency falls out for free.** Because a task can have N attempts, both the collaborative-dedup case (don't start a 2nd attempt while one is `in_progress` — enforce with the atomic claim on the *task*) and the best-of-N case (deliberately spawn N attempts, select one) are the *same* structure, differing only in orchestration policy — exactly the unification from the schema discussion.

---

## 3. Metadata conventions

### `metadata.attempt` (on the attempt node)

```ts
interface AttemptMetadata {
  outcome: 'pending' | 'success' | 'failure' | 'abandoned' | 'inconclusive';
  summary?: string;          // short what-happened (human/agent readable)
  evidence?: EvidenceRef;    // pointer to an INDEPENDENTLY checkable artifact
  failureReason?: string;    // the negative result — why it failed / was abandoned
  selected?: boolean;        // best-of-N: this attempt was chosen (paired with `supersedes`)
  // startedAt / completedAt reuse the existing `metadata.execution` convention
}
```

`outcome` is **not** a status. `pending` while working; `success`/`failure`/`inconclusive`/`abandoned` when done. A failed attempt is `status: closed` + `outcome: failure` + `failureReason` — the **negative-result record** that stops the swarm (or a future session) re-running a dead end. This is the single highest-value transfer from MACC and CooperBench, and it works identically for a non-compiling patch and a refuted hypothesis.

### `EvidenceRef` (shared by attempts and `verifies` edges)

```ts
interface EvidenceRef {
  kind: 'test' | 'command' | 'commit' | 'context' | 'external' | 'url';
  ref: string;        // test-suite id / command line / git sha / context node id / uri
  detail?: string;    // exit code, "12/12 passed", metric value
  hash?: string;      // content hash for tamper-evidence (cf. provider_content_hash)
}
```

**Evidence is a pointer to something a *partner can check*, never the agent's prose.** That is the structural answer to CooperBench's Commitment failures (*"unverifiable claims… trust was all they had"*). For coding, the gold case is `kind: 'test'` referencing the real test result; `kind: 'context'` can point at an existing file-backed context node (OpenTasks already resolves those from the worktree / a pinned commit).

---

## 4. What is reused **unchanged** (no schema change)

- **Status enum** (`open | in_progress | blocked | closed`, [`validation.ts:29`](../src/graph/validation.ts)). We deliberately **do not add `failed`** — failure is an *outcome*, not a *workflow position*. Keeping status stable avoids touching every status code path, and cleanly models "one failed attempt, retry with a new one": attempt-1 `closed`/`failure`, **task still `open`**, attempt-2 created.
- **Atomic claim / lease + fence tokens** — attempts are claimed like any node; the at-most-one-winner guarantee is the dedup primitive (already shipped, proven race-clean in synthetic cell-B/D).
- **`discovered-from`** edge — a follow-up attempt links to what it learned from a prior (failed) attempt: research provenance + "don't re-derive."
- **`supersedes` / `duplicates`** — best-of-N selection (the chosen attempt supersedes the rest) and dedup marking. *Already in the registry.*
- **`implements`** — an attempt or task `implements` a shared **spec/`context` node** = the "explicit insertion-point contract" that targets CooperBench's *divergent-architecture* failures (29.7%). *Edge already exists; only the usage pattern is new.*

---

## 5. The one new edge: `verifies`

Register in [`EdgeTypeRegistry`](../src/graph/EdgeTypeRegistry.ts) (the registry is open — runtime `register()`):

```ts
{
  name: 'verifies',
  description: 'An independent check of an attempt (or task) and its verdict',
  inverseOf: 'verified-by',
  affectsReady: false,         // a "done gate" can consult it without blocking ready
  direction: 'directed',       // verification → attempt|task
  providers: ['native'],
}
```

Edge `metadata` (edges already carry metadata, [`CreateEdgeInput.metadata`](../src/graph/types.ts)):

```ts
interface VerifiesMetadata {
  verdict: 'pass' | 'fail' | 'inconclusive';
  verifier: string;          // agent id or system that checked
  evidence?: EvidenceRef;    // the independent check's result
  verifiedAt: string;        // ISO
}
```

One edge type carries all three verdicts (a *failed* verification is still valuable signal — Commitment failures are about *no* check, not a failed one). The primary safety query (§6) needs only the edge's existence + type; `verdict` refines it. We keep a single `verifies` type rather than `verifies`/`refutes` because **edge queries filter by type cheaply, but verdict-as-metadata needs a scan** — and the load-bearing query only needs the type.

**Research extension (register, but off the CooperBench critical path):** `reproduces` (inverse `reproduced-by`) — a *second independent attempt* re-deriving the same result. This is MACC's both-parties-rewarded reproduction primitive and the natural home for [ReplicationBench](https://arxiv.org/pdf/2510.24591)-style replication. Distinct from `verifies` (a check) because it's a full independent re-attempt.

---

## 6. The queries this unlocks (the payoff — safety properties as queries)

Each maps to a measured CooperBench failure and to an eval metric (E6 §4):

| Query | Definition (edge/metadata layer) | Kills | E6 metric |
|---|---|---|---|
| **"What is every agent doing right now?"** | attempts with `status: in_progress` | Expectation (42%) — partner state is *observed*, not inferred from chat | work-overlap rate |
| **"Unevidenced completions"** | `success` attempts whose `evidence` is absent/uncheckable (stronger: no incoming `verifies`/`verdict:pass` edge) | Commitment (32%) — completion must ship with a checkable artifact | evidenced-completion rate |
| **"Dead ends — don't retry"** | attempts `closed` + `outcome: failure` (+ `failureReason`) | redundant re-exploration; research negative-result burial | redundant-exploration |
| **"Best-of-N select"** | attempts sharing one `target_id`; pick the `verifies/pass` one; `supersedes` the rest | wasted divergent work | redundancy `R` |

The "unevidenced completions" query *is* the "substrate = safety" thesis made executable: a structural, queryable guarantee that nothing is silently declared done without a checkable artifact.

---

## 7. Scoring boundary (non-negotiable)

Graph evidence is a **coordination signal, never the score.** The `verifies` edge + `EvidenceRef` tell a *partner* (and the orchestrator) that work is done and checkable — but eval pass/fail still runs **CooperBench's real merged-test suite** against the worktree (P6 §1.4: *"never score by graph state; an agent that can write `status: closed` is in the reward-hacking threat model"*). An agent that fabricates a `verifies/pass` edge gains nothing on the score — it only (briefly) misleads its partner, which the trace then exposes. E5's job is to confirm no completion signal is self-attestable into the *score*.

---

## 8. Build sequence (design-first; each step independently testable, vitest co-located)

The `opentasks` eval arm can run after step 4.

1. **Node type + validation** — add `'attempt'` to `NodeType` ([`graph/types.ts`](../src/graph/types.ts)) and node validation ([`validation.ts`](../src/graph/validation.ts)): require `target_id` (must resolve to a task), allow `metadata.attempt`. *Tests:* create/reject; target-must-be-task.
2. **Edges** — register `verifies` (+ `reproduces`) in [`EdgeTypeRegistry`](../src/graph/EdgeTypeRegistry.ts) with inverses `verified-by` / `reproduced-by`, `affectsReady: false`. *Tests:* lookup + inverse; `link(from, to, 'verifies', {verdict, evidence})` round-trips edge metadata (no new MCP tool needed for the edge).
3. **Query helpers** — `inProgressAttempts(taskId?)` and `unverifiedCompletions()` (success attempts with no incoming `verifies`/`verdict:pass`), plus a `completable` predicate (§9.3). *Tests:* the §6 truth table.
4. **MCP surface** ([`mcp/server.ts`](../src/mcp/server.ts)) — new opt-in `attempts` scope: `record_attempt` + `list_attempts` (full signatures in §10); `verifies` edges via the existing `link`. Reuses `claim_*` + `link`; no task-tool changes. *Tests:* tool-level create / list, incl. the `inProgress` + `unverified` filters.
5. **Eval wiring** ([`evals/arms.ts`](../evals/arms.ts)) — the `opentasks` arm's system-prompt nudge: *create an attempt before editing; mark outcome + attach test-result evidence before declaring done; query in-progress attempts before starting new work.* Diagnostics read the graph directly (work-overlap, verified-completion rate). No new scoring.

---

## 9. Decisions

**Settled (2026-06-16):**
1. **Decision A** — `attempt` is a node type (§1).
2. **Attempt-creation MCP** — a dedicated `record_attempt` tool (mirrors `annotate`, which already creates the subordinate `feedback` type), not an overload of `create_task`. More ergonomic for the agent nudge; reversible.
3. **`verifies` does not affect ready** — `affectsReady: false`. "Done" is a separate `completable` predicate (a `success` attempt with a passing `verifies` edge), not an overload of dependency-`ready`.
4. **Register `reproduces` now** — cheap, future-proofs research mode; documented as off the CooperBench critical path.

**Open:** none blocking. Next is execution of the §8 build sequence.

---

## 10. MCP tool surface (settled 2026-06-16)

New opt-in **`attempts` scope** (mirrors the `context` scope's shape). Reuses existing infrastructure heavily — *claiming, edges, and terminal transitions already exist* — so the new surface is **1 write tool + 1 list tool** (verification reuses the existing `link`).

**Reused as-is (no new tool):**
- **Claiming** an attempt *or* a task → existing `claim_task` / `claim_next` / `release_task` / `renew_claim` (tasks scope; operate on any native node id). `record_attempt` is **claim-free** — claiming work for exclusivity stays a task-level decision (keeps "log my effort" separate from "reserve this work").
- **`verifies` / `reproduces` edges** → the existing `link` tool: `link(verifierAttemptId, verifiedAttemptId, 'verifies', {verdict, verifier, evidence})`. **No dedicated `record_verification`** (dropped 2026-06-16 to keep the surface tight). The edge connects the *verifier's attempt → the verified attempt* — verification is itself an act of work (an attempt with its own evidence), the lightweight end of the reproduction spectrum (§5). For CooperBench's first-order Commitment fix the lighter lever is the attempt's own `evidence` field (checkable completion); the `verifies` edge is the stronger *independent-confirmation* layer, off the critical path.
- **Terminal vocabulary already exists** — `update_task`'s `transition` enum carries `fail` / `abandon` (*"terminal outcomes distinct from complete/close"*, [`server.ts:155`](../src/mcp/server.ts)); the attempt `outcome` states mirror it.

Shared evidence schema (used by both write tools):
```ts
const evidenceRef = z.object({
  kind: z.enum(['test','command','commit','context','external','url']),
  ref: z.string().describe('test-suite id / command / git sha / context node id / uri'),
  detail: z.string().optional().describe('exit code, "12/12 passed", metric value'),
  hash: z.string().optional().describe('content hash for tamper-evidence'),
});
```

### `record_attempt` — upsert one agent's effort at a task
```ts
server.tool('record_attempt',
  "Record (create or update) an attempt at a task — one agent's effort, with outcome + evidence. " +
  "Omit `id` to start a new attempt; pass `id` to update. A terminal outcome closes the attempt; " +
  "the parent task is untouched (retry = a new attempt).",
  {
    taskId: z.string().describe('The task being attempted (the attempt\'s target)'),
    agent: z.string().describe('Agent making the attempt'),
    id: z.string().optional().describe('Existing attempt ID to update; omit to create'),
    outcome: z.enum(['pending','success','failure','abandoned','inconclusive']).optional()
      .describe('Result (default: pending on create). Terminal values close the attempt.'),
    summary: z.string().optional()
      .describe('What was tried / what happened — name the files/areas touched so partners see overlap before duplicating'),
    evidence: evidenceRef.optional()
      .describe('Pointer to an independently checkable artifact — the Commitment lever: makes completion checkable'),
    failureReason: z.string().optional().describe('Why it failed/was abandoned — the negative-result record'),
    fromId: z.string().optional().describe('Prior attempt this follows (creates a discovered-from link, like annotate)'),
  }, handler)
```
Returns the attempt node. Create → `status: in_progress`, `outcome: pending`; a terminal outcome → `status: closed`. **The tool owns the status side-effect so the agent reasons only in outcomes.**

### `list_attempts` — observe partner state (the Expectation/Commitment killers)
```ts
server.tool('list_attempts',
  'List attempts and their verification state — the coordination read: what every agent is doing now, ' +
  'and which completions are unverified.',
  {
    taskId: z.string().optional().describe('Only attempts of this task'),
    agent: z.string().optional().describe("Only this agent's attempts"),
    status: z.enum(['in_progress','closed']).optional(),
    outcome: z.enum(['pending','success','failure','abandoned','inconclusive']).optional(),
    inProgress: z.boolean().optional()
      .describe('Shortcut for status=in_progress — "what is everyone doing right now"'),
    unverified: z.boolean().optional()
      .describe('Only success attempts with no passing `verifies` edge — the "unverified completions" safety query'),
    includeVerifications: z.boolean().optional().describe("Attach each attempt's verifies edges (default: true)"),
  }, handler)
```

**Coverage of the eval nudge:** `list_attempts({inProgress:true})` before editing (read partner summaries → overlap, kills Expectation 42%) · `record_attempt` to log effort + outcome + test `evidence` (checkable completion → kills Commitment 32%) · `list_attempts({unverified:true})` for the safety check · `link(...,'verifies',...)` for the optional independent-confirmation layer.

**On `scope` (decided against a structured field, 2026-06-16):** "which files an attempt touches" lives in `summary` prose, not a structured field. Walking the scenarios: (a) a partner checking overlap reads the *handful* of in-progress attempts — an LLM extracts files from prose fine, no fast-query need; (b) the eval's work-overlap metric reads *real diffs*, not declared scope; (c) there's no orchestrator consumer (peer agents). Matches the codebase rule — structure a field only when a *non-LLM* consumer needs it precisely (`tags`→filter, feedback `anchor`→display, context `file_path`→resolver); descriptive "about" info lives in content/title. Kicker: metadata isn't indexed in SQLite (`search` covers only title/content), so a structured `scope` wouldn't be a fast filter anyway without promotion to `tags`/a column. If coarse-area filtering is ever needed, reuse the existing `tags` field (attempts are nodes — already tag-filterable), no new schema.
