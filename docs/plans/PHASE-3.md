# Phase 3: Multi-Location Queries

> Spec ID: s-2qms | Tags: phase-3, v3, discovery, expansion
>
> Implements: [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md)
> Depends on: [PHASE-2.md](./PHASE-2.md)

## Scope

Enable queries that span multiple OpenTasks locations, with automatic discovery and expansion.

## Prerequisites

- Phase 1 complete
- Phase 2 complete (daemon, cross-location URIs)

## What's Included

### Location Discovery

Find `.opentasks/` directories in the filesystem:
```typescript
interface DiscoveryOptions {
  from: string                    // Starting path
  direction: 'ancestors' | 'descendants' | 'siblings' | 'all'
  maxDepth?: number               // Default: 10
  includeInactive?: boolean       // Include locations without running daemon
  skip?: string[]                 // Default: ['node_modules', '.git', 'vendor']
}

const locations = await discover({
  from: '~/projects/myapp/.opentasks/',
  direction: 'ancestors'
})
// Returns:
// - opentasks://~/projects/.opentasks/
// - opentasks://~/.opentasks/
```

### Query Expansion Modes

```typescript
type ExpansionMode =
  | 'none'           // Only current location (default)
  | 'follow-refs'    // Follow outbound edge references
  | 'ancestors'      // Include parent locations (upward)
  | 'descendants'    // Include child locations (downward)
  | 'siblings'       // Include sibling locations
  | 'all'            // Full hierarchy traversal
```

**Usage**:
```typescript
// Default: isolated query
const issues = await query({ find: 'ready' })

// Expand to follow references (resolve external URIs)
const issues = await query({ find: 'ready' }, { expand: 'follow-refs' })

// Expand to include ancestor locations
const specs = await query({ find: 'specs' }, { expand: 'ancestors' })
```

### Conditional Redirect Rules

Advanced redirect configuration:
```json
{
  "redirects": [
    {
      "operations": ["write"],
      "pattern": "i-*",
      "target": "opentasks://../main-worktree/.opentasks/",
      "when": {
        "branch": "feature-*",
        "worktree": true
      }
    },
    {
      "operations": ["read"],
      "pattern": "s-*",
      "target": "opentasks://~/.opentasks/",
      "when": {
        "agent": "sub-agent-*"
      }
    }
  ]
}
```

### Cross-Location Ready Query

Find ready items across multiple locations:
```typescript
const ready = await query(
  { find: 'ready' },
  { expand: 'descendants' }  // Check all child locations
)

// Returns nodes from:
// - Current location
// - All discovered child locations
// - With blockers resolved across locations
```

### Worktree Detection

Automatic detection of git worktree context:
```typescript
interface WorktreeContext {
  isWorktree: boolean
  mainWorktreePath?: string
  worktreeName?: string
  branch?: string
}

function detectWorktreeContext(): WorktreeContext
```

## Deliverables

### Discovery Package (`@opentasks/discovery`)
- [ ] Location scanner (filesystem traversal)
- [ ] Worktree detection
- [ ] Location hierarchy builder
- [ ] Connection detection (which locations have edges to current)

### Expansion Package (`@opentasks/expansion`)
- [ ] Expansion mode handler
- [ ] Multi-daemon query coordinator
- [ ] Result aggregation and deduplication

### Advanced Redirects
- [ ] Conditional rule matching
- [ ] Pattern-based redirects
- [ ] Agent/branch/worktree conditions

## Technical Design

### Multi-Daemon Query Flow
```
1. Query with expand: 'descendants'
2. Discover child locations via filesystem scan
3. For each location:
   a. Find/start daemon
   b. Send query via IPC
   c. Collect results
4. Aggregate results
5. Resolve cross-location blockers
6. Return unified result set
```

### Expansion Result Format
```typescript
interface ExpandedResult {
  local: Node[]                           // Results from current location
  external: Map<string, Node[]>           // Results by location URI
  crossLocationEdges: Edge[]              // Edges spanning locations
  queriedLocations: string[]              // All locations queried
}
```

## Success Criteria

Phase 3 is complete when:
1. Location discovery finds .opentasks/ in ancestors/descendants/siblings
2. Queries with expansion modes return results from multiple locations
3. Cross-location blockers are correctly resolved in ready queries
4. Conditional redirect rules match on branch/worktree/agent
5. Worktree context is automatically detected
