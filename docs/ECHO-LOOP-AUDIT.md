# Echo-loop audit: native ↔ OpenTasks ↔ MAP (P5 5.3)

When all bridges are active, the same logical task exists in up to three layers:

- **Native Claude tasks** (`TaskCreate`/`TaskUpdate`) → enter the graph as
  `claude://` nodes via the `claude-tasks` provider's filesystem watcher.
- **OpenTasks** — the graph of record (`native://`, `claude://`, `map://`, … nodes).
- **MAP** — remote tasks surfaced as `map://` nodes (inbound) and OpenTasks graph
  changes emitted as MAP `task.*`/`context.*` events (outbound, via the MAP event
  bridge).

The risk: a change loops — OpenTasks change → MAP event → comes back as a `map://`
node change → MAP event → … — amplifying forever and/or spawning duplicate nodes.
This audits that it can't, and pins the invariant with tests.

## Echo-prevention mechanisms (the three guards)

1. **Skip `map`-provider changes (the loop breaker).** The MAP event bridge's
   `handleProviderChange(providerName, event)` returns immediately when
   `providerName === 'map'` (`src/providers/map-event-bridge.ts`). So a change
   that *entered* OpenTasks from MAP (a `map://` node) is **never re-emitted to
   MAP** — the inbound→outbound hop that would close the loop is cut.

2. **`_origin` stamping.** Outbound events are stamped with the emitter's
   `agentId` (`data._origin`). A receiver filters events bearing its own origin,
   so even across systems a node doesn't re-process its own emission.

3. **Ephemeral MAP provider.** `map://` tasks are pass-through — **no local
   cache** (`src/providers/map.ts`). An inbound MAP task is resolved on access,
   not stored, so re-observing it cannot create duplicate graph nodes.

Edge events are not bridged at all (only `node` events), and deletes are not
bridged outbound — further narrowing the surface.

## What's intentional vs. a bug

A task that exists in two systems legitimately has **two nodes** — e.g. a
`native://` node and a `map://` node — linked by edges. That is federation, not
duplication. "Zero duplicate nodes" means **no spurious copies produced by
echo**, which guard 3 ensures (the MAP side is never materialized).

## Audit conclusion

The round-trip **terminates** and **does not amplify**. Verified deterministically
in `src/providers/__tests__/map-event-bridge.test.ts` ("echo-loop audit") — the
standing substitute for the literal "1-hour soak" acceptance:

- **Round-trip terminates:** a native change emits once; the same task coming
  back as a `map://` change emits **zero** more (guard 1).
- **No amplification at scale:** 250 native + 250 interleaved map-origin changes
  → **exactly 250** emissions, all native, **no `map://` id leaks out**, and **no
  node emitted twice**.
- **Same logical id doesn't echo:** the native representation bridges once; the
  `map://` representation of the same id never bridges.

## Consumers (cc-swarm)

cc-swarm's hooks emit observability events through MAP SDK primitives and rely on
this bridge for the OpenTasks↔MAP direction; their own dedup is `_origin`-based
plus MAP's delivery semantics. No cc-swarm hook re-injects MAP-origin task
changes back into OpenTasks (native tasks enter via the `claude-tasks` provider's
watcher, not via a hook), so the cc-swarm layer adds no new loop edge beyond the
three guards above.

## Residual notes

- The guards are **provenance-based** (who originated the change), not
  content-based. They depend on `providerName` being correctly attributed at the
  change site — which it is, because changes are dispatched per provider.
- If a future provider ever re-exposed MAP data under a *non-`map`* scheme, guard
  1 would not catch it; such a provider must carry its own origin check. Flag for
  any new federating provider.
