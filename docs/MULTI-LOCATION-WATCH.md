# Scoping: Multi-Location Watch & Per-Location Event Stream (fix 6a)

**Status:** Scoped, not implemented. Surfaced by the P3 multi-agent review (finding M1).
**Owner:** TBD · **Estimated effort:** ~1–2 days · **Likely phase:** P4.

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

## Work items

- [ ] Per-location `cachedHashes` map + per-location activation (replace `watchActive` latch).
- [ ] On activation, iterate `locationResolver.list()` → hook each `locState.watcher` + seed per-location.
- [ ] Add `location` to `StampedEvent` + the `watch.event` payload (additive); decide uri policy.
- [ ] `WatchFilter.locations?` + `eventMatchesFilter` support; thread through `client.subscribe`.
- [ ] Hook location add/remove so runtime-added worktrees are watched and removed ones stop.
- [ ] Confirm single-location path payload shape is unchanged (location optional, defaults to primary).

## Acceptance criteria

- [ ] In a multi-location daemon, a subscriber receives an event after a mutation in a **non-primary** location (integration test).
- [ ] Events carry a `location` discriminator; `subscribe({ filter: { locations: [...] } })` delivers only matching locations.
- [ ] A location added at runtime gets watched (its mutations emit); a removed one stops.
- [ ] Single-location behavior and payload shape unchanged (regression).
- [ ] `events.since` backfill includes non-primary-location events within the buffer window.

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
