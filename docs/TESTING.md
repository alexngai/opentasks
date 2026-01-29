# OpenTasks Testing Strategy

This document outlines the current state of testing in OpenTasks, identifies gaps, and proposes a tiered testing strategy for comprehensive coverage.

## Current State

### Test Coverage Summary

| Layer | Test Files | Tests | Coverage Type |
|-------|-----------|-------|---------------|
| Core | 2 | 34 | Unit |
| Schema | 1 | 24 | Unit |
| Storage | 2 | 84 | Unit + File I/O |
| Graph | 6 | 153 | Unit |
| Daemon | 7 | 131 | Unit |
| Tools | 3 | 59 | Unit |
| Client | 1 | 35 | Unit |
| Providers | 5 | 203 | Unit |
| **Total** | **28** | **723** | **Primarily Unit** |

### What's Tested

**Well-tested with unit tests:**
- ID generation and hashing (deterministic, collision-resistant)
- Schema validation (Zod parsing, type guards)
- JSONL and SQLite persistence (file operations, transactions)
- Graph operations (CRUD, queries, validation, cycles)
- Daemon lifecycle, IPC, file watching, flush management
- 3-tool agent interface (link, query, annotate)
- Client library (connection, method calls, error handling)
- Provider interface (URI parsing, type conversion, CRUD)

**File I/O tested with temp directories:**
- JSONL persister writes to real temp files
- SQLite persister uses in-memory databases
- File watcher uses real file system events (with delays)

### Testing Gaps

#### Gap 1: Provider Integration Tests

All provider tests use mocks. No tests verify actual integration with:

| Provider | Mock Strategy | Integration Gap |
|----------|---------------|-----------------|
| **BeadsProvider** | Mocks `child_process.exec` | Never calls real `bd` CLI |
| **ClaudeTasksProvider** | Uses in-memory store | Never interacts with Claude Code task system |
| **NativeProvider** | Mocks GraphStore | N/A (no external system) |

#### Gap 2: End-to-End Agent Workflows

No tests verify complete agent workflows:
- Agent creates spec → links issues → provides feedback
- Multi-agent coordination with blocking dependencies
- Full daemon lifecycle with real IPC communication

#### Gap 3: Cross-System Integration

No tests verify:
- OpenTasks ↔ Beads bidirectional sync
- OpenTasks ↔ Claude Code task materialization
- Multi-location graph operations

#### Gap 4: Performance and Stress Testing

No tests for:
- Large graph operations (10k+ nodes)
- High-frequency flush operations
- Concurrent multi-client access

---

## Tiered Testing Strategy

### Test Flags

Tests are gated by environment flags to control which tests run:

| Flag | Purpose | When to Use |
|------|---------|-------------|
| (none) | Unit tests only | Every commit, CI default |
| `RUN_SLOW_TESTS=1` | + Integration tests | Pre-merge, nightly CI |
| `RUN_FULL_AGENT_TESTS=1` | + E2E agent tests | Release validation, manual |

**Flag behavior:**
- `RUN_SLOW_TESTS` enables storage durability, daemon IPC, and provider integration tests
- `RUN_FULL_AGENT_TESTS` enables full agent workflow tests (implies `RUN_SLOW_TESTS`)
- Tests check flags via `process.env` and skip with descriptive messages

```typescript
// Example usage in tests
const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'
const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'

describe.skipIf(!SLOW_TESTS)('Storage Durability', () => {
  // These tests take 10+ seconds each
})

describe.skipIf(!AGENT_TESTS)('Multi-Agent Coordination', () => {
  // These tests require full system setup
})
```

---

### Tier 1: Unit Tests (Current)

**Status:** ✅ Complete (723 tests)

**Purpose:** Verify individual components work correctly in isolation.

**Characteristics:**
- Fast execution (<5 seconds total)
- No external dependencies
- Mocked collaborators
- Run on every commit

**Location:** `src/**/__tests__/*.test.ts`

**Flag:** None (always run)

### Tier 2: Integration Tests

**Status:** ✅ Phases 1-3 Complete (84 tests)

**Purpose:** Verify components work together with real I/O and external systems.

**Characteristics:**
- Slower execution (10-60 seconds per test)
- Real file I/O, process spawning, IPC
- Run before merge, nightly CI

**Location:** `tests/integration/`

**Flag:** `RUN_SLOW_TESTS=1`

#### 2.1 Storage Integration Tests (Priority: High)

**Purpose:** Verify persistence durability and performance under stress.

**Requirements:**
- File system access
- Sufficient disk space for large tests

**Test Cases:**
```typescript
// tests/integration/storage/jsonl-durability.integration.test.ts

const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'

describe.skipIf(!SLOW_TESTS)('JSONL Durability', () => {
  describe('crash recovery', () => {
    it('should recover from incomplete write (simulated crash)', async () => {
      // Write partial line, verify recovery on reload
    })

    it('should handle corrupted trailing entry', async () => {
      // Append garbage, verify load skips bad entry
    })
  })

  describe('compaction', () => {
    it('should compact correctly with 1000+ entries', async () => {
      // Create 1000 nodes, delete 500, compact, verify
    })

    it('should maintain data integrity during compaction', async () => {
      // Verify no data loss during compaction
    })
  })

  describe('concurrent access', () => {
    it('should handle concurrent readers during write', async () => {
      // Spawn multiple read processes while writing
    })
  })
})
```

```typescript
// tests/integration/storage/sqlite-durability.integration.test.ts

describe.skipIf(!SLOW_TESTS)('SQLite Durability', () => {
  describe('crash recovery', () => {
    it('should survive simulated crash during transaction', async () => {
      // Use WAL mode, kill process mid-transaction, verify recovery
    })
  })

  describe('performance', () => {
    it('should handle 10k+ nodes efficiently', async () => {
      // Create 10k nodes, measure insert/query times
      // Assert: bulk insert < 5s, query < 100ms
    })

    it('should handle complex graph queries', async () => {
      // Create deep dependency chains, measure traversal
    })
  })

  describe('WAL mode', () => {
    it('should support concurrent readers and single writer', async () => {
      // Spawn reader processes while writing
    })
  })
})
```

#### 2.2 Daemon Integration Tests (Priority: High)

**Purpose:** Verify daemon lifecycle and IPC with real processes.

**Requirements:**
- Ability to spawn child processes
- IPC socket access
- Process signal handling

**Test Cases:**
```typescript
// tests/integration/daemon/lifecycle.integration.test.ts

describe.skipIf(!SLOW_TESTS)('Daemon Lifecycle', () => {
  let daemonProcess: ChildProcess

  afterEach(async () => {
    if (daemonProcess) {
      daemonProcess.kill('SIGTERM')
      await waitForExit(daemonProcess)
    }
  })

  describe('startup', () => {
    it('should start and create socket file', async () => {
      daemonProcess = spawn('node', ['./dist/daemon.js', '--socket', socketPath])
      await waitForSocket(socketPath, 5000)
      expect(existsSync(socketPath)).toBe(true)
    })

    it('should detect existing daemon and refuse to start', async () => {
      // Start first daemon
      daemonProcess = spawn('node', ['./dist/daemon.js', '--socket', socketPath])
      await waitForSocket(socketPath)

      // Try to start second daemon
      const second = spawn('node', ['./dist/daemon.js', '--socket', socketPath])
      const exitCode = await waitForExit(second)
      expect(exitCode).toBe(1)
    })
  })

  describe('shutdown', () => {
    it('should flush pending writes on SIGTERM', async () => {
      daemonProcess = spawn('node', ['./dist/daemon.js'])
      await waitForSocket(socketPath)

      // Make some writes via IPC
      const client = createIPCClient(socketPath)
      await client.connect()
      await client.createNode({ type: 'spec', title: 'Test' })

      // Send SIGTERM
      daemonProcess.kill('SIGTERM')
      await waitForExit(daemonProcess)

      // Verify data persisted
      const persister = createJSONLPersister(dataPath)
      const data = await persister.load()
      expect(data.nodes).toHaveLength(1)
    })

    it('should clean up socket file on exit', async () => {
      daemonProcess = spawn('node', ['./dist/daemon.js', '--socket', socketPath])
      await waitForSocket(socketPath)

      daemonProcess.kill('SIGTERM')
      await waitForExit(daemonProcess)

      expect(existsSync(socketPath)).toBe(false)
    })
  })
})
```

```typescript
// tests/integration/daemon/ipc.integration.test.ts

describe.skipIf(!SLOW_TESTS)('Daemon IPC', () => {
  let daemon: ChildProcess
  let client: IPCClient

  beforeAll(async () => {
    daemon = spawn('node', ['./dist/daemon.js', '--socket', socketPath])
    await waitForSocket(socketPath, 5000)
    client = createIPCClient(socketPath)
    await client.connect()
  })

  afterAll(async () => {
    await client.disconnect()
    daemon.kill('SIGTERM')
    await waitForExit(daemon)
  })

  describe('round-trip', () => {
    it('should handle create → get → update → delete cycle', async () => {
      const created = await client.createNode({ type: 'spec', title: 'Test' })
      expect(created.id).toMatch(/^s-/)

      const fetched = await client.getNode(created.id)
      expect(fetched?.title).toBe('Test')

      const updated = await client.updateNode(created.id, { title: 'Updated' })
      expect(updated.title).toBe('Updated')

      await client.deleteNode(created.id)
      const deleted = await client.getNode(created.id)
      expect(deleted).toBeNull()
    })
  })

  describe('concurrent clients', () => {
    it('should handle 10 concurrent clients', async () => {
      const clients = await Promise.all(
        Array.from({ length: 10 }, async () => {
          const c = createIPCClient(socketPath)
          await c.connect()
          return c
        })
      )

      // All clients create nodes concurrently
      const results = await Promise.all(
        clients.map((c, i) => c.createNode({ type: 'issue', title: `Issue ${i}` }))
      )

      expect(results).toHaveLength(10)
      expect(new Set(results.map(r => r.id)).size).toBe(10) // All unique IDs

      await Promise.all(clients.map(c => c.disconnect()))
    })
  })

  describe('error handling', () => {
    it('should return error for invalid node ID', async () => {
      await expect(client.getNode('invalid-id')).rejects.toThrow()
    })

    it('should recover from client disconnect', async () => {
      const tempClient = createIPCClient(socketPath)
      await tempClient.connect()
      await tempClient.createNode({ type: 'spec', title: 'Before disconnect' })

      // Abrupt disconnect (no graceful close)
      tempClient.socket.destroy()

      // Original client should still work
      const result = await client.createNode({ type: 'spec', title: 'After disconnect' })
      expect(result.id).toBeDefined()
    })
  })
})
```

#### 2.3 BeadsProvider Integration Tests (Priority: Medium)

**Purpose:** Verify BeadsProvider works with real `bd` CLI.

**Requirements:**
- Beads (`bd`) CLI installed and configured
- Test Beads directory with fixtures

**Test Fixtures:**
```
tests/fixtures/beads/
├── .beads/          # Beads database directory
│   └── beads.db     # SQLite database
├── bd-test1.md      # Test bead with known content
├── bd-test2.md      # Test bead for update operations
└── bd-temp.md       # For create/delete tests
```

**Test Cases:**

```typescript
// tests/integration/providers/beads.integration.test.ts

const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'

// Additional check: skip if bd CLI not available
async function checkBdAvailable(): Promise<boolean> {
  try {
    await exec('bd --version')
    return true
  } catch {
    return false
  }
}

describe.skipIf(!SLOW_TESTS)('BeadsProvider Integration', () => {
  beforeAll(async () => {
    if (!(await checkBdAvailable())) {
      console.log('Skipping: bd CLI not installed')
      return
    }
  })

  describe('read operations', () => {
    it('should read existing bead from real Beads directory')
    it('should parse bead frontmatter correctly')
    it('should handle bead with links')
    it('should return null for non-existent bead')
  })

  describe('write operations', () => {
    it('should create new bead via bd CLI')
    it('should update existing bead')
    it('should delete bead')
  })

  describe('search operations', () => {
    it('should search beads by content')
    it('should filter by type/tags')
  })

  describe('URI handling', () => {
    it('should resolve relative beads:// URIs')
    it('should handle workspace-relative paths')
  })
})
```

**Dev Dependencies:**
- None required (uses system `bd` CLI)
- CI skips if `bd` not available

#### 2.4 ClaudeTasksProvider Integration Tests (Priority: Low)

**Purpose:** Verify file-backed task store persistence.

**Challenge:** Claude Code's task system is not directly accessible outside of Claude Code sessions. Integration tests focus on the file-backed store abstraction.

**Test Cases:**
```typescript
// tests/integration/providers/claude-tasks.integration.test.ts

const SLOW_TESTS = process.env.RUN_SLOW_TESTS === '1'

describe.skipIf(!SLOW_TESTS)('ClaudeTasksProvider File Store', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-tasks-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true })
  })

  describe('persistence', () => {
    it('should persist tasks to JSON file', async () => {
      const store = createFileBackedTaskStore(join(tempDir, 'tasks.json'))
      await store.create({ subject: 'Test', description: 'Desc' })

      // Reload from file
      const store2 = createFileBackedTaskStore(join(tempDir, 'tasks.json'))
      const tasks = await store2.list()
      expect(tasks).toHaveLength(1)
    })

    it('should handle concurrent access', async () => {
      const path = join(tempDir, 'tasks.json')
      const stores = Array.from({ length: 5 }, () => createFileBackedTaskStore(path))

      // Concurrent writes
      await Promise.all(
        stores.map((s, i) => s.create({ subject: `Task ${i}`, description: '' }))
      )

      const finalStore = createFileBackedTaskStore(path)
      const tasks = await finalStore.list()
      expect(tasks.length).toBeGreaterThanOrEqual(1) // At least some should persist
    })
  })
})
```

**Recommendation:** Full Claude Tasks integration best tested via E2E tests (Tier 3) running within actual Claude Code sessions.

### Tier 3: End-to-End Tests (Proposed)

**Purpose:** Verify complete workflows from agent perspective.

**Characteristics:**
- Slowest execution (minutes)
- Requires full system setup (daemon, storage, providers)
- Run before release, manual validation

**Location:** `tests/e2e/`

**Flag:** `RUN_FULL_AGENT_TESTS=1` (implies `RUN_SLOW_TESTS=1`)

#### 3.1 Agent Workflow E2E Tests

**Test Harness:**
```typescript
// tests/e2e/harness.ts

interface TestAgent {
  // Simulates an agent making tool calls
  link(params: LinkParams): Promise<LinkResult>
  query(params: QueryParams): Promise<QueryResult>
  annotate(params: AnnotateParams): Promise<AnnotateResult>
}

function createTestAgent(client: OpenTasksClient): TestAgent
```

**Test Cases:**
```typescript
// tests/e2e/workflows/spec-driven-development.e2e.test.ts

const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'

describe.skipIf(!AGENT_TESTS)('Spec-Driven Development Workflow', () => {
  let agent: TestAgent

  it('should complete full spec→issue→implementation cycle', async () => {
    // 1. Create spec
    const specResult = await agent.link({
      action: 'create',
      type: 'spec',
      title: 'Test Feature',
      content: 'Feature requirements...',
    })
    expect(specResult.id).toMatch(/^s-/)

    // 2. Create implementing issue
    const issueResult = await agent.link({
      action: 'create',
      type: 'issue',
      title: 'Implement Test Feature',
      implements: specResult.id,
    })

    // 3. Query ready work
    const readyResult = await agent.query({ type: 'ready' })
    expect(readyResult.nodes).toContainEqual(
      expect.objectContaining({ id: issueResult.id })
    )

    // 4. Provide feedback
    await agent.annotate({
      target_id: specResult.id,
      feedback_type: 'comment',
      content: 'Implementation complete',
    })

    // 5. Close issue
    await agent.link({
      action: 'update',
      id: issueResult.id,
      status: 'closed',
    })

    // 6. Verify issue no longer ready
    const finalReady = await agent.query({ type: 'ready' })
    expect(finalReady.nodes).not.toContainEqual(
      expect.objectContaining({ id: issueResult.id })
    )
  })
})
```

#### 3.2 Multi-Agent Coordination E2E Tests

```typescript
// tests/e2e/workflows/multi-agent.e2e.test.ts

const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'

describe.skipIf(!AGENT_TESTS)('Multi-Agent Coordination', () => {
  let agent1: TestAgent
  let agent2: TestAgent

  it('should coordinate via blocking dependencies', async () => {
    // Agent 1 creates foundation issue
    const foundationIssue = await agent1.link({
      action: 'create',
      type: 'issue',
      title: 'Foundation Work',
    })

    // Agent 1 creates dependent issue
    const dependentIssue = await agent1.link({
      action: 'create',
      type: 'issue',
      title: 'Dependent Work',
      blocked_by: [foundationIssue.id],
    })

    // Agent 2 sees only foundation as ready
    const agent2Ready = await agent2.query({ type: 'ready' })
    expect(agent2Ready.nodes).toHaveLength(1)
    expect(agent2Ready.nodes[0].id).toBe(foundationIssue.id)

    // Agent 1 completes foundation
    await agent1.link({
      action: 'update',
      id: foundationIssue.id,
      status: 'closed',
    })

    // Agent 2 now sees dependent as ready
    const agent2ReadyAfter = await agent2.query({ type: 'ready' })
    expect(agent2ReadyAfter.nodes[0].id).toBe(dependentIssue.id)
  })
})
```

#### 3.3 Provider Sync E2E Tests

```typescript
// tests/e2e/workflows/provider-sync.e2e.test.ts

const AGENT_TESTS = process.env.RUN_FULL_AGENT_TESTS === '1'

describe.skipIf(!AGENT_TESTS)('Provider Synchronization', () => {
  describe('OpenTasks ↔ Beads', () => {
    it('should materialize Beads reference on first access')
    it('should refresh stale materialized nodes')
    it('should sync changes back to Beads')
  })

  describe('OpenTasks ↔ Claude Tasks', () => {
    it('should bridge Claude task to OpenTasks issue')
    it('should update Claude task when issue closes')
  })
})
```

---

## Test Infrastructure

### Test Configuration

```typescript
// vitest.config.ts additions

export default defineConfig({
  test: {
    // Unit tests (fast, no external deps)
    include: ['src/**/__tests__/*.test.ts'],

    // Integration tests (separate config)
    // Run with: vitest --config vitest.integration.config.ts
  },
})
```

```typescript
// vitest.integration.config.ts

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for external calls
    hookTimeout: 60000, // 60 seconds for setup/teardown
  },
})
```

```typescript
// vitest.e2e.config.ts

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120000, // 2 minutes per test
    hookTimeout: 300000, // 5 minutes for full setup
    maxConcurrency: 1,   // Run sequentially
  },
})
```

### npm Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:slow": "RUN_SLOW_TESTS=1 vitest run",
    "test:slow:watch": "RUN_SLOW_TESTS=1 vitest",
    "test:e2e": "RUN_FULL_AGENT_TESTS=1 vitest run",
    "test:all": "RUN_FULL_AGENT_TESTS=1 vitest run"
  }
}
```

**Usage:**
```bash
# Fast unit tests only (CI default)
npm test

# Include integration tests (slower, real I/O)
npm run test:slow

# Full test suite including E2E (slowest)
npm run test:e2e

# Watch mode with integration tests
npm run test:slow:watch
```

### CI Pipeline

```yaml
# .github/workflows/test.yml

name: Tests

on: [push, pull_request]

jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test

  integration:
    name: Integration Tests (RUN_SLOW_TESTS)
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build  # Need compiled daemon
      - name: Run integration tests
        run: npm run test:slow
        env:
          RUN_SLOW_TESTS: '1'

  e2e:
    name: E2E Tests (RUN_FULL_AGENT_TESTS)
    runs-on: ubuntu-latest
    needs: integration
    if: github.ref == 'refs/heads/main' || github.event_name == 'release'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Run E2E tests
        run: npm run test:e2e
        env:
          RUN_FULL_AGENT_TESTS: '1'
```

**Note:** Beads integration tests will skip automatically if `bd` CLI is not installed. To run Beads tests in CI, add a step to install the CLI.

---

## Implementation Roadmap

### Phase 1: Integration Test Infrastructure ✅ COMPLETE

1. ✅ Create `tests/integration/` directory structure
2. ✅ Add `vitest.integration.config.ts`
3. ✅ Add npm scripts with flag support
4. ✅ Create test helper utilities (process spawning, temp dirs, wait helpers)

**Deliverables:**
- ✅ `tests/integration/helpers/` - shared utilities (flags, process, wait, temp)
- ✅ `vitest.integration.config.ts`
- ✅ Updated `package.json` scripts

### Phase 2: Storage Integration Tests (RUN_SLOW_TESTS) ✅ COMPLETE

**Priority: High** - Foundation for all persistence

1. ✅ Create JSONL durability tests (16 tests)
   - Crash recovery (partial writes, corrupted entries)
   - Compaction with 1000+ entries
   - Concurrent readers
   - Performance baselines
2. ✅ Create SQLite durability tests (17 tests)
   - Transaction crash recovery
   - 10k+ node performance baselines (insert <1s, query <500ms)
   - WAL mode concurrent access
   - Complex graph queries
3. ✅ Add performance assertions

**Deliverables:**
- ✅ `tests/integration/storage/jsonl-durability.integration.test.ts`
- ✅ `tests/integration/storage/sqlite-durability.integration.test.ts`

### Phase 3: Daemon Integration Tests (RUN_SLOW_TESTS) ✅ COMPLETE

**Priority: High** - Foundation for client-server architecture

1. ✅ Create daemon spawn/lifecycle helpers
2. ✅ Write lifecycle tests (19 tests: startup, shutdown, lock, registry)
3. ✅ Write IPC round-trip tests (21 tests: request/response, error handling)
4. ✅ Write concurrent client tests
5. ✅ Write connection tracking tests

**Deliverables:**
- ✅ `tests/integration/daemon/helpers.ts`
- ✅ `tests/integration/daemon/lifecycle.integration.test.ts`
- ✅ `tests/integration/daemon/ipc.integration.test.ts`

### Phase 4: Provider Integration Tests (RUN_SLOW_TESTS) ✅ COMPLETE (BeadsProvider)

**Priority: Medium** - External system integration

1. ✅ BeadsProvider integration (17 tests)
   - CRUD operations (create, get, list, update, delete)
   - Search operations
   - URI handling
   - Error handling
   - Concurrent operations (5 creates, 10 reads)
   - Workspace isolation
   - Uses temp directories with git init + bd init
2. ClaudeTasksProvider file store
   - File-backed persistence tests (future work)

**Deliverables:**
- ✅ `tests/integration/providers/beads.integration.test.ts`
- `tests/integration/providers/claude-tasks.integration.test.ts` (future)

**Provider Fixes Made:**
- Fixed shell escaping for arguments with spaces
- Fixed "not found" detection to handle bd error messages
- Fixed bd show/update returning arrays instead of single objects

### Phase 5: E2E Test Infrastructure (RUN_FULL_AGENT_TESTS)

1. Create `tests/e2e/` directory structure
2. Add `vitest.e2e.config.ts`
3. Create TestAgent harness wrapping client
4. Create full system setup/teardown helpers

**Deliverables:**
- `tests/e2e/harness.ts`
- `tests/e2e/setup.ts`
- `vitest.e2e.config.ts`

### Phase 6: Agent Workflow E2E Tests (RUN_FULL_AGENT_TESTS)

**Priority: High** - Core value proposition validation

1. Spec-driven development workflow (create spec → create issue → close)
2. Multi-agent coordination (blocking dependencies, ready queue)
3. Feedback loop tests (annotate specs, close issues)

**Deliverables:**
- `tests/e2e/workflows/spec-driven.e2e.test.ts`
- `tests/e2e/workflows/multi-agent.e2e.test.ts`
- `tests/e2e/workflows/feedback-loop.e2e.test.ts`

### Phase 7: Provider Sync E2E Tests (RUN_FULL_AGENT_TESTS)

**Priority: Low** - Advanced features

1. OpenTasks ↔ Beads materialization
2. Background sync lifecycle
3. Cross-system reference resolution

**Deliverables:**
- `tests/e2e/workflows/provider-sync.e2e.test.ts`

---

## Dev Dependencies to Consider

| Package | Purpose | Decision Criteria |
|---------|---------|-------------------|
| `execa` | Better child process handling | If spawn tests become complex |
| `tempy` | Temp directory management | If current approach insufficient |
| `wait-for-expect` | Async assertion helpers | If timeout handling needed |
| `msw` | Mock Service Worker | Only if HTTP mocking needed |

**Current recommendation:** Start without additional dependencies, add as needed.

---

## Success Metrics

### Coverage Targets

| Tier | Target | Current |
|------|--------|---------|
| Unit | >90% | 723 tests ✅ |
| Integration | >70% of external interfaces | 101 tests (Phases 1-4) ✅ |
| E2E | >80% of documented workflows | 0% |

### Performance Baselines

| Operation | Target | Measured |
|-----------|--------|----------|
| Unit test suite | <10s | 2.7s ✅ |
| Integration test suite | <2min | ~1s ✅ |
| E2E test suite | <10min | TBD |
| Create 1000 nodes (JSONL) | <1s | <500ms ✅ |
| Load 1000 nodes (JSONL) | <500ms | <100ms ✅ |
| Insert 10k nodes (SQLite) | <5s | ~650ms ✅ |
| Query 10k nodes (SQLite) | <1s | ~15ms ✅ |

---

## Next Steps

1. ~~**Immediate:** Implement Phase 1 (test infrastructure, helpers, config)~~ ✅ DONE
2. ~~**Short-term:** Implement Phases 2-3 (storage + daemon integration tests)~~ ✅ DONE
3. **Medium-term:** Implement Phase 4 (provider integration) and Phase 5 (E2E infrastructure)
4. **Long-term:** Implement Phases 6-7 (agent workflow and provider sync E2E)

The testing strategy prioritizes system-level tests (storage, daemon) first as they:
- Have no external dependencies (no `bd` CLI needed)
- Test the foundation that all other features rely on
- Can be gated with `RUN_SLOW_TESTS` for fast CI cycles

## Progress Summary

| Phase | Status | Tests |
|-------|--------|-------|
| Phase 1: Infrastructure | ✅ Complete | 11 helper tests |
| Phase 2: Storage | ✅ Complete | 33 tests (JSONL + SQLite) |
| Phase 3: Daemon | ✅ Complete | 40 tests (lifecycle + IPC) |
| Phase 4: Providers | ✅ Complete (BeadsProvider) | 17 tests |
| Phase 5: E2E Infrastructure | Not started | - |
| Phase 6: Agent Workflows | Not started | - |
| Phase 7: Provider Sync | Not started | - |

**Total Tests:** 824 (723 unit + 101 integration)
