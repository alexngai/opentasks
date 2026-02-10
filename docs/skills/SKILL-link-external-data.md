# Skill: Link External Data

Bind non-task artifacts — Slack messages, Google Docs, Notion pages, emails, URLs — to specs and issues in the OpenTasks graph.

## When to Use

- An agent discovers a relevant Slack thread while working on a task
- A user says "this design doc is relevant to spec s-a2b3"
- An agent wants to capture the source of a bug report (support ticket, Slack message, etc.)
- Linking meeting notes, Figma files, or any external resource to a work item

## Pattern: Create ExternalNode + Link It

This requires **two API layers**: `graph.create` (to create the node) and `tools.link` (to connect it).

### Step 1: Create the ExternalNode

```json
// RPC: graph.create
{
  "type": "external",
  "title": "Alex: auth flow is broken for SSO users",
  "uri": "slack://C04ABCD/p1234567890",
  "source": "slack",
  "metadata": {
    "channel_name": "#engineering",
    "permalink": "https://workspace.slack.com/archives/C04ABCD/p1234567890",
    "author": "alex",
    "timestamp": "2026-02-10T14:30:00Z",
    "text": "auth flow is broken for SSO users — getting redirect loop after IdP response"
  }
}
// Returns: { id: "e-k7m2", uuid: "...", type: "external", ... }
```

### Step 2: Link to the relevant spec/issue

```json
// RPC: tools.link
{
  "fromId": "i-x7k9",
  "toId": "e-k7m2",
  "type": "references",
  "metadata": {
    "context": "Original bug report from #engineering"
  }
}
// Returns: { success: true, edgeId: "x-p3q4" }
```

## URI Conventions

There are no strict rules for external URIs — the `uri` field is a freeform string. But consistent conventions make deduplication and querying work better.

| Source | Recommended URI Format | Example |
|--------|----------------------|---------|
| Slack message | `slack://[channel-id]/p[timestamp]` | `slack://C04ABCD/p1234567890` |
| Slack thread | `slack://[channel-id]/t[thread-ts]` | `slack://C04ABCD/t1234567880` |
| Google Doc | `gdoc://[doc-id]` | `gdoc://1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms` |
| Notion page | `notion://[page-id]` | `notion://a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Figma file | `figma://[file-key]` | `figma://abc123DEF456` |
| Email | `email://[message-id]` | `email://CABx+XJ2@mail.gmail.com` |
| Generic URL | `web://[url]` | `web://example.com/page` |
| GitHub PR | `github://[owner]/[repo]/pull/[num]` | `github://org/repo/pull/42` |

The `uri` field is used for deduplication — two ExternalNodes with the same `uri` represent the same thing.

## Choosing an Edge Type

| Situation | Edge Type | Direction |
|-----------|-----------|-----------|
| "This Slack message is the bug report for this issue" | `references` | issue → slack |
| "This design doc is the source for this spec" | `references` | spec → doc |
| "We discovered this issue from a support thread" | `discovered-from` | issue → thread |
| "This meeting notes page is loosely related" | `related` | either direction |

## With Materialized Data

If the agent has access to the external system (MCP server, CLI, API), it can fetch and cache the content:

```json
// RPC: graph.create
{
  "type": "external",
  "title": "Design Review: Auth Flow v2",
  "uri": "gdoc://1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "source": "google-docs",
  "metadata": {
    "url": "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
    "last_modified": "2026-02-09T16:00:00Z",
    "owner": "alex@company.com",
    "snippet": "This document outlines the revised auth flow for SSO integration..."
  }
}
```

The `metadata` field is `Record<string, unknown>` — store whatever the agent can retrieve. This is a point-in-time snapshot; without a formal provider, it won't auto-refresh.

## Without Materialized Data (Phantom Nodes)

If the agent only has a URL, it can still create a lightweight reference:

```json
// RPC: graph.create
{
  "type": "external",
  "title": "Related Slack thread",
  "uri": "slack://C04ABCD/t1234567880",
  "source": "slack",
  "metadata": {
    "permalink": "https://workspace.slack.com/archives/C04ABCD/p1234567880"
  }
}
```

This creates a node in the graph that can be linked and queried, even without fetching the full content. An agent with Slack access can later enrich it via `graph.update`.

## Deduplication

Before creating, check if the URI already exists:

```json
// RPC: graph.query
{
  "filter": {
    "type": "external",
    "search": "slack://C04ABCD/p1234567890"
  }
}
```

If a node with that URI already exists, skip creation and link to the existing node.

## Querying Linked External Data

### All references for an issue

```json
// RPC: tools.query
{
  "edges": {
    "from_id": "i-x7k9",
    "type": "references"
  }
}
// Returns edges pointing to ExternalNodes (and other nodes)
```

### All external nodes from a specific source

```json
// RPC: graph.query
{
  "type": "external",
  "filter": {
    "search": "slack"
  }
}
```

## Updating Cached Data

When an agent re-accesses the external system, it can refresh the cached data:

```json
// RPC: graph.update
{
  "id": "e-k7m2",
  "metadata": {
    "text": "updated message text after edit",
    "last_fetched": "2026-02-10T18:00:00Z"
  }
}
```

## Complete Example: Agent Binds Slack Context to a Bug

```
Agent receives task: "Fix the SSO redirect loop"

1. Agent searches Slack via MCP for related messages
   → Finds 3 relevant messages in #engineering

2. For each message, agent creates ExternalNode:
   graph.create({
     type: "external",
     title: "Alex: SSO redirect loop after IdP response",
     uri: "slack://C04ABCD/p1234567890",
     source: "slack",
     metadata: { text: "...", author: "alex", channel: "#engineering" }
   })

3. Agent links each to the issue:
   tools.link({ fromId: "i-x7k9", toId: "e-k7m2", type: "references" })
   tools.link({ fromId: "i-x7k9", toId: "e-k7m3", type: "references" })
   tools.link({ fromId: "i-x7k9", toId: "e-k7m4", type: "discovered-from" })

4. Later, another agent picks up the issue and queries context:
   tools.query({ edges: { from_id: "i-x7k9", type: ["references", "discovered-from"] } })
   → Gets back the 3 ExternalNodes with Slack message content in metadata
```
