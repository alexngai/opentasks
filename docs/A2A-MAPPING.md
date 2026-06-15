# OpenTasks ↔ A2A Task Lifecycle Mapping

[A2A](https://a2a-protocol.org/) (Agent2Agent, now under the Linux Foundation,
v1.0.0) is the one widely-adopted agent protocol with first-class **task
lifecycle** semantics. This document maps OpenTasks's status model onto A2A's
`TaskState`, in both directions, so OpenTasks can federate A2A tasks (surface
them as graph nodes, the way the MAP provider does for `map://` tasks) and so an
A2A agent acting on an OpenTasks task reports consistent state.

It is a positioning + design artifact, not (yet) a shipped provider.

## The two state models

**OpenTasks** (`src/providers/native.ts` — `statusModel` + `TASK_ACTIONS`):

- Statuses: `open`, `in_progress`, `blocked`, `closed`, `failed`, `abandoned`
  (plus arbitrary custom strings; the six above are the canonical model).
- Actions → status: `start`→`in_progress`, `complete`/`close`→`closed`,
  `block`→`blocked`, `reopen`→`open`, `fail`→`failed`, `abandon`→`abandoned`.
- Terminal: `closed`, `failed`, `abandoned`.
- **Dependencies are graph edges**, not a status: `blocked` reflects an
  unresolved `blocks` edge, and "ready" is computed (open + no active blocker).

**A2A** (`TaskState`, v1.0.0):

- `submitted`, `working`, `input-required`, `auth-required`, `completed`,
  `canceled`, `failed`, `rejected`, `unknown`.
- Terminal: `completed`, `canceled`, `failed`, `rejected`.
- A flat per-task lifecycle. No dependency graph; `input-required` /
  `auth-required` are pauses waiting on the **caller**, not on another task.

## OpenTasks → A2A (surfacing an OpenTasks task to an A2A peer)

| OpenTasks status | A2A `TaskState` | Notes |
|------------------|-----------------|-------|
| `open`        | `submitted` | created, not yet started |
| `in_progress` | `working`   | actively being worked |
| `blocked`     | `working` * | A2A has no dependency-blocked state — see *Gaps* |
| `closed`      | `completed` | terminal success |
| `failed`      | `failed`    | terminal failure |
| `abandoned`   | `canceled`  | terminal, intentionally dropped |

\* `blocked` is surfaced as `working` (still the agent's task, just waiting). The
blocker structure is carried in the OpenTasks graph, which A2A cannot represent;
exposing it would require A2A extension metadata.

## A2A → OpenTasks (ingesting an A2A task as a node)

| A2A `TaskState`  | OpenTasks status | Action to reach it | Notes |
|------------------|------------------|--------------------|-------|
| `submitted`      | `open`        | (create)   | |
| `working`        | `in_progress` | `start`    | |
| `input-required` | `blocked`     | `block`    | nearest "waiting" status (waiting on caller, not a dep) |
| `auth-required`  | `blocked`     | `block`    | same |
| `completed`      | `closed`      | `complete` | |
| `canceled`       | `abandoned`   | `abandon`  | |
| `failed`         | `failed`      | `fail`     | |
| `rejected`       | `abandoned`   | `abandon`  | agent declined → not-attempted; `abandoned` over `failed` |
| `unknown`        | *(no change)* | —          | leave status as-is |

This mirrors the MAP provider's lossy-but-honest convention
(`src/providers/map.ts`): `completed`↔`closed`, `failed`↔`failed`, and
non-1:1 terminal states fold to the nearest OpenTasks terminal.

## Gaps & design notes

1. **`blocked` ↔ dependencies.** The sharpest mismatch. OpenTasks's `blocked`
   means "an upstream `blocks` edge is unresolved"; A2A's waiting states
   (`input-required`/`auth-required`) mean "waiting on the caller." The reverse
   map (A2A waiting → `blocked`) is therefore a convenience, not a faithful
   round-trip — an A2A task paused for user input isn't graph-blocked. The
   dependency graph is OpenTasks's value-add over A2A's flat lifecycle.
2. **`rejected` has no OpenTasks status.** It folds to `abandoned` (closest:
   terminal, not-completed, not-an-error). If the distinction matters, stamp
   `metadata.a2a_state = "rejected"` on the node so it survives the fold.
3. **Round-trip terminal states are stable** for the common path:
   `closed↔completed`, `failed↔failed`, `abandoned↔canceled`. The lossy edges are
   `rejected→abandoned` and the two `*-required`→`blocked` maps.
4. **Federation, not replacement.** The intended shape is an A2A provider
   (`a2a://`) analogous to the MAP provider: A2A tasks appear as graph nodes,
   editable through the unified `tools.task` interface, with state translated on
   read/write via the tables above. OpenTasks adds the cross-system edge layer
   (link an `a2a://` task to a `native://` task with `implements`/`blocks`) that
   A2A has no concept of.

## Reference

- OpenTasks status model + actions: [`src/providers/native.ts`](../src/providers/native.ts) (`validActionsForStatus`, `statusMap`, `statusModel`).
- Action list of record: [`src/providers/traits/TaskManageable.ts`](../src/providers/traits/TaskManageable.ts) (`TASK_ACTIONS`).
- Precedent lossy mapping (MAP): [`src/providers/map.ts`](../src/providers/map.ts).
- A2A spec: <https://a2a-protocol.org/>.
