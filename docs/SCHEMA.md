# OpenTasks Schema

This document defines the core data model for OpenTasks.

**See also:** [DESIGN.md](./DESIGN.md) (vision) · [ARCHITECTURE.md](./ARCHITECTURE.md) (hierarchy, daemon) · [PERSISTENCE.md](./PERSISTENCE.md) (storage) · [PROVIDERS.md](./PROVIDERS.md) (integrations) · [INTERFACE.md](./INTERFACE.md) (API)

---

## Design Principles

1. **Hybrid storage/application model** — Unified storage format (flexible JSONL) with discriminated application types (type-safe TypeScript)
2. **Hash-based IDs** — Collision-resistant for multi-agent/multi-threaded environments
3. **Layered fields** — Core → Context → Coordination → Integration-specific
4. **Extensibility via metadata** — Unknown fields preserved, not rejected
5. **Soft delete with hard delete option** — Archive for recovery, delete for removal

---

## Node Types

OpenTasks has four primary node types:

| Type | Purpose | Example |
|------|---------|---------|
| `spec` | User intent, requirements, context | "Authentication should use OAuth2" |
| `issue` | Actionable work items | "Implement login endpoint" |
| `feedback` | Comments, suggestions, anchored discussion | "This approach won't scale" |
| `external` | References to external systems | Jira ticket, GitHub issue |

---

## Storage Format

All nodes and edges are stored in a unified format within `.opentasks/graph.jsonl`. Type-specific fields are optional at storage level, validated at application level.

### File Structure (Hybrid Model)

```
.opentasks/
├── graph.jsonl           # Local nodes + edges + external refs (source of truth)
├── tombstones.jsonl      # Soft deletes (configurable gitignore)
├── cache.db              # SQLite (queries, external cache, snapshots)
├── config.json           # Configuration
├── specs/                # Optional: markdown expansion
├── issues/               # Optional: markdown expansion
└── daemon.sock           # Daemon socket (when running)
```

See [PERSISTENCE.md](./PERSISTENCE.md) for detailed storage and sync design.

### Node Storage

```typescript
/**
 * Storage format (JSONL)
 * Flexible schema — all fields except core are optional
 */
interface StoredNode {
  // === CORE (required) ===
  id: string                    // hash-based: "i-x7k9", "s-a2b3"
  uuid: string                  // UUID v4 for distributed sync
  type: string                  // "spec" | "issue" | "feedback" | "external" | custom
  title: string                 // human-readable title
  created_at: string            // ISO 8601
  updated_at: string            // ISO 8601

  // === COMMON (optional) ===
  content?: string              // markdown body
  content_hash?: string         // SHA256 of content for dedup
  priority?: number             // 0-4 (0=highest)
  tags?: string[]               // categorization
  parent_id?: string            // hierarchy support

  // === CONTEXT (optional) ===
  location?: string             // opentasks location URI
  branch?: string               // git branch that created this
  merged_from?: string[]        // branches merged into this
  source?: string               // origin system: "local" | "beads" | "jira" | etc.

  // === COORDINATION (optional) ===
  claimed_by?: string           // agent/user ID
  claimed_at?: string           // ISO 8601
  lock_until?: string           // soft lock expiry

  // === LIFECYCLE (optional) ===
  archived?: boolean            // soft delete flag
  archived_at?: string          // when archived
  deleted_at?: string           // hard delete marker (for sync)
  deleted_by?: string           // who deleted

  // === TYPE-SPECIFIC (optional at storage level) ===
  // Issue fields
  status?: string               // workflow status
  assignee?: string             // assigned to
  closed_at?: string            // when closed

  // Feedback fields
  target_id?: string            // what feedback is about
  target_anchor?: Anchor        // location in target
  feedback_type?: string        // comment | suggestion | request
  thread_id?: string            // group related feedback
  reply_to_id?: string          // parent in thread
  resolved?: boolean            // feedback addressed
  dismissed?: boolean           // feedback dismissed

  // External fields
  uri?: string                  // canonical external URI
  materialized?: boolean        // has been fetched
  cached_at?: string            // when last fetched
  stale?: boolean               // needs refresh
  external_data?: Record<string, unknown>

  // === EXTENSIBILITY ===
  metadata?: Record<string, unknown>
}
```

---

## Application Types

At the application layer, nodes are validated and typed via discriminated union.

### Base Node

```typescript
/**
 * Common fields shared by all node types
 */
interface BaseNode {
  // Identity
  id: string                    // hash-based: prefix + base36 hash
  uuid: string                  // UUID v4

  // Core
  title: string
  content?: string              // markdown
  content_hash?: string         // SHA256 for dedup

  // Timestamps
  created_at: string            // ISO 8601
  updated_at: string

  // Organization
  priority?: number             // 0 (highest) to 4 (lowest)
  tags?: string[]
  parent_id?: string            // for hierarchies

  // Context
  location?: string             // opentasks:// URI
  branch?: string
  merged_from?: string[]
  source?: string               // "local" | integration name

  // Coordination
  claimed_by?: string
  claimed_at?: string
  lock_until?: string

  // Lifecycle
  archived?: boolean
  archived_at?: string

  // Extensibility
  metadata?: Record<string, unknown>
}
```

### Spec

```typescript
/**
 * Captures user intent, requirements, and context
 */
interface Spec extends BaseNode {
  type: 'spec'

  /**
   * Optional status for specs
   * - draft: work in progress, not ready for implementation
   * - active: current, ready for implementation
   * - archived: superseded or no longer relevant
   */
  status?: 'draft' | 'active' | 'archived' | string
}
```

**Spec characteristics:**
- Represents "what" and "why", not "how"
- Content is primary (requirements, context, decisions)
- Status is optional (specs can simply exist)
- Issues implement specs (via edges)
- Receives feedback from implementation

### Issue

```typescript
/**
 * Actionable work item with status workflow
 */
interface Issue extends BaseNode {
  type: 'issue'

  /**
   * Workflow status (required for issues)
   * - open: not started
   * - in_progress: actively being worked on
   * - blocked: waiting on dependency
   * - closed: completed or won't do
   */
  status: 'open' | 'in_progress' | 'blocked' | 'closed' | string

  /** Who is responsible for this issue */
  assignee?: string

  /** When the issue was closed */
  closed_at?: string
}
```

**Issue characteristics:**
- Represents actionable work
- Always has a status
- Can be assigned
- Implements specs (via edges)
- Can provide feedback on specs
- Can block/be blocked by other issues

### Feedback

```typescript
/**
 * Anchored comment, suggestion, or request on a node
 */
interface Feedback extends BaseNode {
  type: 'feedback'

  /**
   * What this feedback is about
   * Can be a spec, issue, or another feedback (for threading)
   */
  target_id: string

  /**
   * Optional anchor for line/text-specific feedback
   */
  target_anchor?: Anchor

  /**
   * Type of feedback
   * - comment: general observation
   * - suggestion: proposed change
   * - request: action needed
   */
  feedback_type: 'comment' | 'suggestion' | 'request' | string

  /**
   * Threading support
   */
  thread_id?: string            // groups related feedback
  reply_to_id?: string          // parent feedback in thread

  /**
   * Resolution
   */
  resolved?: boolean            // feedback has been addressed
  resolved_at?: string
  dismissed?: boolean           // feedback was dismissed (not addressed)
  dismissed_at?: string
}

/**
 * Anchor for locating feedback within content
 */
interface Anchor {
  /** Line number (1-indexed) */
  line?: number

  /** Text snippet for fuzzy matching if line moves */
  text?: string

  /** Section heading */
  section?: string

  /** Context for relocation */
  context_before?: string       // text before anchor
  context_after?: string        // text after anchor

  /**
   * Anchor validity status
   * - valid: anchor location confirmed
   * - relocated: moved but found
   * - stale: could not relocate
   */
  anchor_status?: 'valid' | 'relocated' | 'stale'
}
```

**Feedback characteristics:**
- Always targets something (spec, issue, or another feedback)
- Can be anchored to specific location in content
- Supports threading via `thread_id` and `reply_to_id`
- Has resolution lifecycle (open → resolved/dismissed)
- Created by issues (implementation feedback) or users/agents directly

### External Node

```typescript
/**
 * Reference to an entity in an external system
 * Can be phantom (just a reference) or materialized (fetched data)
 */
interface ExternalNode extends BaseNode {
  type: 'external'

  /** Canonical URI: "jira://PROJ-123", "bd://bd-x7k9" */
  uri: string

  /** Source system identifier */
  source: string                // "jira" | "linear" | "github" | "beads" | etc.

  /** Whether data has been fetched from external system */
  materialized: boolean

  /** When data was last fetched (if materialized) */
  cached_at?: string

  /** Whether cached data is known to be stale */
  stale?: boolean

  /** Status from external system (their semantics, not ours) */
  external_status?: string

  /** Raw data from external system */
  external_data?: Record<string, unknown>
}
```

**External node characteristics:**
- Represents something outside opentasks
- URI is canonical identifier
- Starts as phantom (materialized: false)
- Materializes on demand (fetches external data)
- Cached data has TTL (stale flag)
- Can participate in graph like any other node

### Node Union

```typescript
/**
 * Discriminated union of all node types
 */
type Node = Spec | Issue | Feedback | ExternalNode

/**
 * Type guard helpers
 */
function isSpec(node: Node): node is Spec {
  return node.type === 'spec'
}

function isIssue(node: Node): node is Issue {
  return node.type === 'issue'
}

function isFeedback(node: Node): node is Feedback {
  return node.type === 'feedback'
}

function isExternal(node: Node): node is ExternalNode {
  return node.type === 'external'
}
```

---

## Edges

Edges represent relationships between nodes.

```typescript
interface Edge {
  // Identity
  id: string                    // hash-based for dedup
  uuid: string                  // UUID v4

  // Endpoints
  from_id: string               // source node ID
  to_id: string                 // target node ID or external URI

  // Relationship
  type: EdgeType

  // Metadata
  created_at: string
  created_by?: string           // agent/user who created

  // For bidirectional sync
  source?: string               // "local" | integration name

  // Extensibility
  metadata?: Record<string, unknown>
}

/**
 * Core relationship types
 */
type CoreEdgeType =
  | 'blocks'                    // from blocks to (dependency)
  | 'implements'                // issue implements spec
  | 'references'                // general reference
  | 'related'                   // loose association

/**
 * Extended relationship types (optional, for richer semantics)
 */
type ExtendedEdgeType =
  | 'parent-of'                 // hierarchical (alternative to parent_id)
  | 'child-of'                  // inverse of parent-of
  | 'duplicates'                // marks duplicate
  | 'supersedes'                // replaces another node
  | 'depends-on'                // softer than blocks
  | 'discovered-from'           // found while working on

/**
 * All edge types (extensible via string)
 */
type EdgeType = CoreEdgeType | ExtendedEdgeType | string
```

### Edge Semantics

| Type | Meaning | Example |
|------|---------|---------|
| `blocks` | `from` must complete before `to` can start | i-123 blocks i-456 |
| `implements` | `from` (issue) implements `to` (spec) | i-123 implements s-789 |
| `references` | `from` mentions/links to `to` | s-abc references s-def |
| `related` | Loose association | i-123 related i-789 |
| `parent-of` | Hierarchical containment | s-parent parent-of s-child |
| `duplicates` | `from` is duplicate of `to` | i-dup duplicates i-original |
| `supersedes` | `from` replaces `to` | s-v2 supersedes s-v1 |
| `depends-on` | Softer dependency (informational) | i-123 depends-on i-456 |
| `discovered-from` | `from` was found while working on `to` | i-new discovered-from i-original |

### External Edge Targets

Edges can target external URIs directly:

```typescript
// Edge to local node
{ from_id: "i-x7k9", to_id: "s-a2b3", type: "implements" }

// Edge to external URI (creates phantom node on traversal)
{ from_id: "i-x7k9", to_id: "jira://PROJ-123", type: "references" }
```

---

## ID Generation

### Hash-Based IDs

IDs are generated using a hash-based approach for collision resistance:

```typescript
interface IDConfig {
  /** Prefix for the node type */
  prefix: 'i' | 's' | 'f' | 'e' | 'x'  // issue, spec, feedback, external, edge

  /** Minimum hash length (adaptive based on entity count) */
  minLength: number

  /** Character set for hash (base36: 0-9, a-z) */
  charset: string
}

/**
 * ID generation algorithm:
 * 1. Generate UUID v4
 * 2. SHA256 hash the UUID
 * 3. Convert to base36
 * 4. Take adaptive length based on entity count
 * 5. Prepend type prefix
 *
 * Result: "i-x7k9", "s-a2b3f", "f-m4n5p", etc.
 */
function generateId(type: NodeType, existingCount: number): string {
  const uuid = generateUUID()
  const hash = sha256(uuid)
  const base36 = toBase36(hash)
  const length = adaptiveLength(existingCount)
  const prefix = typePrefix(type)
  return `${prefix}-${base36.slice(0, length)}`
}

/**
 * Adaptive length based on birthday paradox collision probability
 * Target: <1% collision probability
 */
function adaptiveLength(count: number): number {
  if (count < 980) return 4        // i-x7k9
  if (count < 5900) return 5       // i-x7k9p
  if (count < 35000) return 6      // i-x7k9pm
  if (count < 212000) return 7     // i-x7k9pmq
  return 8                          // i-x7k9pmqr
}
```

### ID Prefixes

| Prefix | Type | Example |
|--------|------|---------|
| `s-` | Spec | `s-a2b3` |
| `i-` | Issue | `i-x7k9` |
| `f-` | Feedback | `f-m4n5` |
| `e-` | External | `e-p6q7` |
| `x-` | Edge | `x-r8s9` |

---

## Content Hashing

Content hashes enable deduplication on merge.

```typescript
/**
 * Fields included in content hash (substantive content only)
 * Excludes: id, uuid, timestamps, coordination fields, metadata
 */
function computeContentHash(node: StoredNode): string {
  const substantive = {
    type: node.type,
    title: node.title,
    content: node.content,
    status: node.status,
    priority: node.priority,
    tags: node.tags?.sort(),
    parent_id: node.parent_id,
    // Type-specific substantive fields
    ...(node.type === 'issue' && { assignee: node.assignee }),
    ...(node.type === 'feedback' && {
      target_id: node.target_id,
      target_anchor: node.target_anchor,
      feedback_type: node.feedback_type,
    }),
    ...(node.type === 'external' && { uri: node.uri, source: node.source }),
  }

  return sha256(JSON.stringify(substantive, Object.keys(substantive).sort()))
}
```

---

## Lifecycle Operations

### Soft Delete (Archive)

```typescript
// Archive a node (reversible)
function archive(node: Node): Node {
  return {
    ...node,
    archived: true,
    archived_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// Restore from archive
function restore(node: Node): Node {
  return {
    ...node,
    archived: false,
    archived_at: undefined,
    updated_at: new Date().toISOString(),
  }
}
```

### Hard Delete

```typescript
// Hard delete markers (for sync)
// Node is removed from active storage but marker persists for sync
interface DeleteMarker {
  id: string
  uuid: string
  deleted_at: string
  deleted_by?: string
  reason?: string
}

// After retention period, markers can be purged
```

---

## Validation

Application-level validation per node type:

```typescript
interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

interface ValidationError {
  field: string
  message: string
  code: string
}

function validateNode(stored: StoredNode): ValidationResult {
  const errors: ValidationError[] = []

  // Core validation (all types)
  if (!stored.id) errors.push({ field: 'id', message: 'Required', code: 'REQUIRED' })
  if (!stored.uuid) errors.push({ field: 'uuid', message: 'Required', code: 'REQUIRED' })
  if (!stored.type) errors.push({ field: 'type', message: 'Required', code: 'REQUIRED' })
  if (!stored.title) errors.push({ field: 'title', message: 'Required', code: 'REQUIRED' })

  // Type-specific validation
  switch (stored.type) {
    case 'issue':
      if (!stored.status) {
        errors.push({ field: 'status', message: 'Required for issues', code: 'REQUIRED' })
      }
      break

    case 'feedback':
      if (!stored.target_id) {
        errors.push({ field: 'target_id', message: 'Required for feedback', code: 'REQUIRED' })
      }
      if (!stored.feedback_type) {
        errors.push({ field: 'feedback_type', message: 'Required for feedback', code: 'REQUIRED' })
      }
      break

    case 'external':
      if (!stored.uri) {
        errors.push({ field: 'uri', message: 'Required for external nodes', code: 'REQUIRED' })
      }
      if (!stored.source) {
        errors.push({ field: 'source', message: 'Required for external nodes', code: 'REQUIRED' })
      }
      break

    case 'spec':
      // No additional required fields
      break

    default:
      // Unknown type — allow but warn
      break
  }

  return { valid: errors.length === 0, errors }
}
```

---

## Schema Evolution

### Version Tracking

```typescript
interface SchemaVersion {
  major: number    // breaking changes
  minor: number    // new optional fields
  patch: number    // bug fixes
}

// Current schema version
const SCHEMA_VERSION: SchemaVersion = { major: 1, minor: 0, patch: 0 }

// Stored in graph metadata
interface GraphMetadata {
  schema_version: SchemaVersion
  created_at: string
  last_compacted_at?: string
}
```

### Migration Strategy

1. **Forward compatible**: New optional fields ignored by old readers
2. **Backward compatible**: Old data readable by new code
3. **Explicit migrations**: Breaking changes require migration scripts

```typescript
interface Migration {
  from: SchemaVersion
  to: SchemaVersion
  description: string
  migrate: (node: StoredNode) => StoredNode
  rollback?: (node: StoredNode) => StoredNode
}
```

---

## Open Questions

- [ ] **Priority semantics**: Should 0 be highest (like beads) or lowest?
- [ ] **Tag namespacing**: Should tags support namespaces (`type:bug`, `area:auth`)?
- [ ] **Feedback anchoring**: How sophisticated should the relocation algorithm be?
- [ ] **Edge content**: Should some edges carry content (for lightweight comments)?
- [ ] **Enum extensibility**: How to handle custom status/type values from integrations?

---

## Examples

### Minimal Spec

```json
{
  "id": "s-a2b3",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "type": "spec",
  "title": "User authentication requirements",
  "content": "## Overview\n\nUsers should be able to log in with OAuth2...",
  "created_at": "2025-01-26T10:00:00Z",
  "updated_at": "2025-01-26T10:00:00Z"
}
```

### Issue with Assignment

```json
{
  "id": "i-x7k9",
  "uuid": "550e8400-e29b-41d4-a716-446655440001",
  "type": "issue",
  "title": "Implement OAuth2 login endpoint",
  "content": "Create POST /auth/login endpoint...",
  "status": "in_progress",
  "priority": 1,
  "assignee": "agent-claude-1",
  "claimed_by": "agent-claude-1",
  "claimed_at": "2025-01-26T11:00:00Z",
  "tags": ["auth", "api"],
  "created_at": "2025-01-26T10:30:00Z",
  "updated_at": "2025-01-26T11:00:00Z"
}
```

### Anchored Feedback

```json
{
  "id": "f-m4n5",
  "uuid": "550e8400-e29b-41d4-a716-446655440002",
  "type": "feedback",
  "title": "Consider rate limiting",
  "content": "The login endpoint should include rate limiting to prevent brute force attacks.",
  "target_id": "s-a2b3",
  "target_anchor": {
    "line": 15,
    "text": "Users should be able to log in",
    "anchor_status": "valid"
  },
  "feedback_type": "suggestion",
  "created_at": "2025-01-26T12:00:00Z",
  "updated_at": "2025-01-26T12:00:00Z"
}
```

### External Node (Materialized)

```json
{
  "id": "e-p6q7",
  "uuid": "550e8400-e29b-41d4-a716-446655440003",
  "type": "external",
  "title": "PROJ-123: Legacy auth migration",
  "uri": "jira://PROJ-123",
  "source": "jira",
  "materialized": true,
  "cached_at": "2025-01-26T09:00:00Z",
  "external_status": "In Progress",
  "external_data": {
    "assignee": "john@example.com",
    "sprint": "Sprint 42"
  },
  "created_at": "2025-01-26T09:00:00Z",
  "updated_at": "2025-01-26T09:00:00Z"
}
```

### Edge Examples

```json
[
  {
    "id": "x-r8s9",
    "uuid": "550e8400-e29b-41d4-a716-446655440010",
    "from_id": "i-x7k9",
    "to_id": "s-a2b3",
    "type": "implements",
    "created_at": "2025-01-26T10:30:00Z"
  },
  {
    "id": "x-t1u2",
    "uuid": "550e8400-e29b-41d4-a716-446655440011",
    "from_id": "i-x7k9",
    "to_id": "jira://PROJ-123",
    "type": "references",
    "created_at": "2025-01-26T10:30:00Z"
  }
]
```
