# Linking External Data

Bind non-task artifacts — Slack messages, Google Docs, Notion pages, emails, URLs — to specs and issues in the graph.

## Pattern

Two steps: create an ExternalNode, then link it.

### 1. Create the ExternalNode

```bash
opentasks create --type external \
  --title "Alex: SSO redirect loop after IdP response" \
  --uri "slack://C04ABCD/p1234567890" \
  --source slack \
  --metadata '{"channel_name":"#engineering","permalink":"https://workspace.slack.com/archives/C04ABCD/p1234567890","author":"alex","text":"auth flow is broken for SSO users — getting redirect loop after IdP response"}'
# → { id: "e-k7m2", ... }
```

### 2. Link to the relevant node

```bash
opentasks link --from i-x7k9 --to e-k7m2 --type references \
  --metadata '{"context":"Original bug report from #engineering"}'
```

## URI Conventions

The `uri` field is freeform. Consistent schemes enable deduplication.

| Source | Format | Example |
|--------|--------|---------|
| Slack message | `slack://[channel]/p[ts]` | `slack://C04ABCD/p1234567890` |
| Slack thread | `slack://[channel]/t[thread_ts]` | `slack://C04ABCD/t1234567880` |
| Google Doc | `gdoc://[doc-id]` | `gdoc://1BxiMVs0XRA5nF...` |
| Notion page | `notion://[page-id]` | `notion://a1b2c3d4-e5f6-...` |
| Figma file | `figma://[file-key]` | `figma://abc123DEF456` |
| GitHub PR | `github://[owner]/[repo]/pull/[num]` | `github://org/repo/pull/42` |
| Generic URL | `web://[url]` | `web://example.com/page` |

## Edge Type Selection

| Situation | Edge Type |
|-----------|-----------|
| Bug report, source document | `references` |
| Found during investigation | `discovered-from` |
| Loosely related context | `related` |

Direction: typically `issue → external` or `spec → external`.

## Deduplication

Check before creating:

```bash
opentasks query '{"nodes": {"type": "external", "search": "slack://C04ABCD/p1234567890"}}'
```

If a node with that URI exists, skip creation and link to the existing node.

## Phantom Nodes (URL only)

If the agent only has a URL and can't fetch content:

```bash
opentasks create --type external \
  --title "Related Slack thread" \
  --uri "slack://C04ABCD/t1234567880" \
  --source slack \
  --metadata '{"permalink":"https://workspace.slack.com/archives/C04ABCD/p1234567880"}'
```

An agent with access to the external system can later enrich via `opentasks update`.

## Querying Linked Data

```bash
# All references from an issue
opentasks query '{"edges": {"from_id": "i-x7k9", "type": "references"}}'

# All external nodes from Slack
opentasks query '{"nodes": {"type": "external", "search": "slack"}}'
```

## Complete Example

```
Agent working on "Fix SSO redirect loop":

1. Search Slack via MCP → find 3 relevant messages

2. For each, create ExternalNode:
   opentasks create --type external --title "..." --uri "slack://..." --source slack --metadata '{...}'

3. Link each to the issue:
   opentasks link --from i-x7k9 --to e-k7m2 --type references
   opentasks link --from i-x7k9 --to e-k7m3 --type references
   opentasks link --from i-x7k9 --to e-k7m4 --type discovered-from

4. Later, another agent queries context:
   opentasks query '{"edges": {"from_id": "i-x7k9", "type": ["references", "discovered-from"]}}'
   → Gets back ExternalNodes with Slack content in metadata
```
