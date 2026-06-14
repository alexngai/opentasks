# git-cascade → OpenTasks provenance (caller-side pattern)

How to record **provenance** in the OpenTasks graph from [git-cascade](https://github.com/alexngai/git-cascade)
activity — "this git stream/commit did the work for this task" — so a single
`query` answers *"what implemented task X?"*.

**OpenTasks stays git-cascade-agnostic.** There is no cascade provider, no
cascade handler, and no git-cascade dependency in OpenTasks (runtime *or* dev).
The integration is **caller-side**: whoever already receives git-cascade events
(cc-swarm's MAP sidecar) maps them to OpenTasks edges using the standard client.
The contract is git-cascade's **event format**, not its runtime.

## The flow

1. An agent claims OpenTasks task `t-abc` (e.g. via swarm-dispatch).
2. It works on a git-cascade stream. git-cascade emits `x-cascade/stream.*`
   events; cc-swarm stamps each with `metadata.task_ref = { resource_id, node_id }`
   (the in-progress task — `node_id` is `t-abc`).
3. The consumer maps each event with a `task_ref` to graph edges (below).
4. `query({ edges: { to_id: "t-abc" } })` now returns the stream + commit
   provenance in one call.

## The mapping (the whole integration)

It composes from two existing primitives — `createNode` (an `external`
`cascade://` node) and `link` — so there is nothing to add to OpenTasks:

```ts
// In the event consumer (e.g. cc-swarm's sidecar), per x-cascade/* event:
async function ingestCascadeEvent(client, event, state /* { streamNodeId } */) {
  const taskRef = event.params.metadata?.task_ref;
  if (!taskRef) return; // events without a task_ref carry no link — skip

  if (event.method.endsWith('stream.opened')) {
    const stream = await client.createNode({
      type: 'external',
      title: `stream ${event.params.name}`,
      uri: `cascade://${event.params.stream_id}`,
      source: 'cascade',
    });
    state.streamNodeId = stream.id;
    await client.link({ fromId: stream.id, toId: taskRef.node_id, type: 'implements' });
  } else if (event.method.endsWith('stream.committed')) {
    const commit = await client.createNode({
      type: 'external',
      title: `commit ${event.params.commit.slice(0, 8)}`,
      uri: `cascade://${event.params.stream_id}@${event.params.commit}`,
      source: 'cascade',
    });
    await client.link({ fromId: commit.id, toId: taskRef.node_id, type: 'references' });
    if (state.streamNodeId) {
      await client.link({ fromId: state.streamNodeId, toId: commit.id, type: 'parent-of' });
    }
  }
}
```

Edge conventions: stream `implements` task, commit `references` task, stream
`parent-of` commit. `cascade://<stream-id>` and `cascade://<stream-id>@<sha>` are
stable URIs, so re-ingesting the same event is naturally idempotent if the
consumer dedupes by URI (or you reconcile by it later).

## Querying provenance

```ts
// One call: everything that did work for the task.
const { items } = await client.query({ edges: { to_id: 't-abc' } });
// items: EdgeSummary[] { id, fromId, toId, type }
//   fromId → cascade://<stream> (implements), cascade://<stream>@<sha> (references)
```

(Note the asymmetry: the `edges` *filter* uses `from_id`/`to_id`; the
`EdgeSummary` *result* uses `fromId`/`toId`.)

## Why caller-side (and not a `cascade://` provider)

A live provider would need git-cascade's data, which lives in cc-swarm's sidecar
process (`.swarm/.../cascade/tracker.db`) — reading it couples OpenTasks to
git-cascade's DB schema *and* cc-swarm's layout. The caller-side mapping keeps
OpenTasks a generic substrate that git-cascade is merely a *consumer* of, the
same way a CI hook or any other tracker would be. A `cascade://` provider is a
possible future step **only if** a clean event/feed source appears.

## Proof

`src/client/__tests__/e2e-cascade-provenance.test.ts` runs this end-to-end
against a real daemon: create task → claim → ingest faithful `x-cascade/*`
events → close → assert `task → stream → commit` is queryable in one call, and
that events without a `task_ref` create nothing.
