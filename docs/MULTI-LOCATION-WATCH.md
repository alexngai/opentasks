# Multi-Location Watch & Per-Location Event Stream (fix 6a)

**Status:** ✅ Implemented (2026-06-13). Surfaced by the P3 multi-agent review (finding M1).
Chosen design: **one global event stream, location-tagged events**.

## Problem

The P3 event stream (M1–M2) works correctly for the **single-location** daemon
(`createDaemon`). In the **multi-location** daemon (`createMultiLocationDaemon` —
the worktree/swarm topology this project exists to serve), the watch stream only
covers **one** location:

- `registerWatchMethods` is called once per daemon with one shared `eventManager`
  and the multi-location `LocationResolver` ([lifecycle.ts](../src/daemon/lifecycle.ts), path 2).
- The file-watcher hook is installed exactly once, on the **first** `watch.subscribe`,
  bound to that call's `location` (defaulting to primary), then `watchActive`
  latches `true` ([watch.ts:300-313](../src/daemon/methods/watch.ts)). A later
  `subscribe({ location: <other-hash> })` is a no-op for wiring.
- Result: graph changes in any **non-primary** worktree never trigger
  `diffAndBroadcast`, so they emit no `watch.event` and **buffer nothing** — a
  subscriber filtering for that worktree gets silence, with no signal it's blind.

Two structural shortfalls compound it:

1. **Single diff cache.** `cachedHashes` is one flat `Map<nodeId, hash>`
   ([watch.ts:153](../src/daemon/methods/watch.ts)), not keyed by location.
2. **No location dimension on events.** Event `uri` is hardcoded `global://${id}`
   ([watch.ts:221-271](../src/daemon/methods/watch.ts)) and `StampedEvent`
   ([events.ts](../src/daemon/events.ts)) carries no location/hash — so even if
   multiple watchers fed one stream, a backfilled event couldn't tell a
   subscriber **which** worktree it came from.

The single-location path is unaffected (one location, primary). The infrastructure
already exists to build on: each location owns its own `FileWatcher`
(`locState.watcher`) and the resolver exposes `list()` / `resolve(hash)` / `add()`
([location-state.ts:94-106](../src/daemon/location-state.ts)).

## Proposed design

Keep **one global event stream** (one `eventManager`, one monotonic `seq`/`epoch`)
and **tag each event with its location**. This is simpler than per-location seq
spaces and per-location cursors, and sufficient: subscribers filter by location;
the cursor stays global.

1. **Per-location diff state + multi-watcher wiring.** Replace the single
   `cachedHashes` with `Map<locationHash, Map<nodeId, hash>>` and the `watchActive`
   one-way latch with a per-location activation set. On first subscribe, hook
   `onchange` + seed a cache for **every** location in `locationResolver.list()`
   (not just the first). `diffAndBroadcast(location)` and `seedCache(location)`
   already take a location param — they just need to read/write the per-location cache.
2. **Location on the payload.** Add an optional `location` (hash) field to the
   `watch.event` payload and `StampedEvent`. Keep `uri` additive/compatible — set
   it from the owning provider/location rather than hardcoded `global://`, OR add a
   separate `location` field and leave `uri` as-is to avoid breaking consumers that
   key off `uri` (e.g. the MAP event bridge). **Decision needed:** new field vs uri
   change (lean: new field, additive).
3. **Filter by location.** Extend `WatchFilter` ([watch.ts:50](../src/daemon/methods/watch.ts))
   with optional `locations?: string[]`; `eventMatchesFilter` gates on it. (Delete
   events still pass — same rule as type/status.)
4. **Dynamic locations.** Locations can be added/removed at runtime
   (`registerLocationMethods` supports `add`). Wire a newly-added location's watcher
   + seed its cache when it joins, and stop on removal. This is the trickiest part —
   needs a hook into the location lifecycle, not just a one-shot `list()` at first
   subscribe.

## Work items — done

- [x] Per-location `cachedHashes` (`Map<hash, Map<nodeId, hash>>`) + per-location `watched` set + per-location debounce timers (replaced the `watchActive` latch). [watch.ts](../src/daemon/methods/watch.ts)
- [x] On subscribe, iterate `locationResolver.list()` → `watchLocation()` hooks each `state.watcher` + seeds per-location (idempotent).
- [x] Added `location` to `ProviderNodeChangeEvent` (additive — rides on the `watch.event` payload + `StampedEvent.event`); kept `uri` as `global://${id}` to avoid breaking consumers (chose **new field**, not a uri change).
- [x] `WatchFilter.locations?` + `eventMatchesFilter` (location applies to all event types incl. deletes; type/status still bypass for deletes); `client.subscribe` passes it through unchanged.
- [x] `LocationResolver.onLocationAdded` / `onLocationRemoved` hooks (multi-location resolver fires them on `add`/`remove`); watch methods `watchLocation` newly-added worktrees and `unwatchLocation` removed ones.
- [x] Single-location path unchanged: `hash: 'primary'`, events tagged `location: 'primary'`, payload otherwise identical (additive field).

## Acceptance criteria — met

- [x] A subscriber receives an event after a mutation in a **non-primary** location. **Evidence:** `watch.test.ts` "emits events tagged with their originating non-primary location" (multi-location mock resolver, deterministic).
- [x] Events carry a `location` discriminator; `subscribe({ filter: { locations: [...] } })` delivers only matching locations. **Evidence:** `watch.test.ts` "filters events by location" + single-location location-filter cases + real-daemon `e2e-subscribe.test.ts` asserts `created.location === 'primary'`.
- [x] A location added at runtime gets watched; a removed one stops. **Evidence:** `watch.test.ts` "watches a location added at runtime" + "stops emitting for a removed location".
- [x] Single-location behavior and payload shape unchanged. **Evidence:** existing `watch.test.ts` / `e2e-watch.test.ts` / `e2e-subscribe.test.ts` all green (`objectContaining` assertions unaffected by the additive field).
- [x] `events.since` backfill carries the location dimension (it lives on the event, so backfilled events include it automatically).

Implementation note: per-location independent debounce (a change in one worktree doesn't reset another's timer) is also covered (`watch.test.ts` "debounces each location independently").

## Risks / watch-outs

- **Resource:** N file-watchers diffing per change — bounded by worktree count; acceptable.
- **Backward compat:** adding `location` is additive (optional); existing single-location consumers ignore it. Changing `uri` format is **not** safe without auditing consumers (MAP bridge, OpenHive spec classifier) — prefer a new field.
- **Cursor semantics:** one global stream means a busy non-primary worktree can evict another worktree's events from the shared 1024 ring buffer → more frequent `resync`. If this bites, make the buffer size configurable (already a noted P3 limitation) before considering per-location streams.
- **Activation ordering:** the current `watchActive` latch assumes one location; the per-location rewrite must avoid double-hooking a location across concurrent first-subscribes.

## Interim / alternative (not chosen)

**6b — document + guard.** Declare multi-location watch primary-only and
reject/warn on `subscribe` with a non-primary `location`, so it fails loudly
instead of silently. Cheap; preserves correctness-by-honesty until 6a lands. Worth
doing as a stopgap if 6a slips.
