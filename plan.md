# Plan: Migrate Entire Provider from Go CLI to TS Dependency

## Context

Currently the Entire integration shells out to a Go binary (`entire status --json`, `entire rewind --list`) via `child_process.exec`. This requires users to independently install the Go CLI via Homebrew or `go install`. If the binary isn't on PATH, the entire provider is silently skipped.

**Goal**: Replace the external Go CLI dependency with a direct npm dependency (TS port), so `npm install` is the only setup step and the integration always works.

## Scope of Changes

### What currently touches the Go CLI (only 2 files):

1. **`src/providers/entire.ts`** — `createEntireCliStore()` (lines 134-285): shells out to `entire status --json` and `entire rewind --list`, parses JSON stdout
2. **`src/providers/from-config.ts`** — `isCliAvailable()` check (lines 55-66) and conditional skip logic for entire (lines 162-187)

### What does NOT need to change:

- **`src/daemon/entire-watcher.ts`** — Already reads `.git/entire-sessions/*.json` directly from disk (no CLI involved)
- **`src/daemon/entire-linker.ts`** — Uses GraphStore API directly (no CLI involved)
- **Provider interface, URI parsing, node conversion** — All in `entire.ts` but decoupled from the CLI store; the `EntireStore` interface, `createEntireProvider()`, `createInMemoryEntireStore()`, and all `*ToProviderNode()` functions remain unchanged
- **Config schema fields** — `autoLink`, `autoLinkMinConfidence`, `timeout` still relevant

## Steps

### 1. Add the TS port as a dependency

```bash
npm install entire-cli
```

Add to `dependencies` in `package.json`. The exact package name needs to be confirmed — likely `entire-cli`, `@entire/cli`, or the fork's name.

### 2. Replace `createEntireCliStore` in `src/providers/entire.ts`

**Before** (lines 134-285): Spawns `child_process.exec` to run CLI commands, parses raw JSON stdout.

**After**: Import the TS port's API and call it directly.

```ts
import { EntireCli } from 'entire-cli'; // or whatever the package exports

export function createEntireCliStore(config: EntireConfig = {}): EntireStore {
  const timeout = config.timeout ?? 30000;
  const cwd = config.cwd ?? process.cwd();
  const cli = new EntireCli({ cwd, timeout });

  return {
    async getSession(id) {
      const sessions = await cli.status(); // returns typed objects directly
      return sessions.find(s => s.id === id) ?? null;
    },
    async listSessions() {
      return cli.status();
    },
    async getCheckpoint(id) {
      const checkpoints = await cli.listCheckpoints();
      return checkpoints.find(c => c.id === id) ?? null;
    },
    async listCheckpoints() {
      return cli.listCheckpoints();
    },
    async search(query) { /* same logic, uses listSessions/listCheckpoints */ },
  };
}
```

Key changes:
- Remove `child_process` import and `execEntire()` helper
- Remove `parseSessionJson()` / `parseCheckpointJson()` — the TS port returns typed objects, no raw JSON parsing needed
- Keep the `EntireStore` interface unchanged (consumers are unaffected)
- Keep error handling try/catch pattern (return `null` / `[]` on failure)

### 3. Simplify provider creation in `src/providers/from-config.ts`

**Before** (lines 162-187):
```ts
if (config.providers.entire.enabled) {
  const isAvailable = await isCliAvailable(entireConfig.executable);
  if (isAvailable) {
    // create provider
  } else {
    skipped.push('entire'); // silently skip
  }
}
```

**After**:
```ts
if (config.providers.entire.enabled) {
  try {
    const entireProvider = createEntireProvider({ timeout: entireConfig.timeout });
    registry.register(entireProvider);
    providers.push(entireProvider);
  } catch (error) {
    failed.push({ name: 'entire', error: ... });
  }
}
```

- Remove the `isCliAvailable(entireConfig.executable)` check for `entire` — the TS module is always importable since it's a direct dependency
- No more silent skip path for "enabled but not available"
- The `isCliAvailable` helper itself stays (still used by `beads` and `sudocode` providers)

### 4. Update config schema in `src/config/schema.ts`

- **Remove** the `executable` field from `EntireProviderConfigSchemaInner` (lines 172-187) — no longer needed since there's no external binary to locate
- Keep `enabled`, `timeout`, `autoLink`, `autoLinkMinConfidence`

For backward compatibility, the outer schema should still accept (and silently ignore) `executable` so existing `.opentasks/config.json` files don't break on parse:
```ts
const EntireProviderConfigSchemaInner = z.object({
  enabled: z.boolean().default(true),
  timeout: z.number().min(1000).default(30000),
  autoLink: z.boolean().default(true),
  autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
```

### 5. Update `EntireConfig` interface in `src/providers/entire.ts`

```ts
export interface EntireConfig {
  // Remove: executable?: string;
  timeout?: number;
  cwd?: string;
}
```

### 6. Update tests in `src/providers/__tests__/entire.test.ts`

**CLI store tests** (lines 614-958): Currently mock `child_process.exec` to simulate CLI output. Replace with:
- Mock the TS port module (`vi.mock('entire-cli')`)
- Or: test against the actual TS port (if it's fast enough for unit tests)
- The mocks become simpler: return typed objects instead of JSON strings
- Remove `mockExecResponse` / `mockExecError` helpers
- Test error cases by having the mock throw instead of simulating exec errors

**Provider tests** (lines 92-608): No changes needed — they use the in-memory store and are already decoupled from the CLI.

### 7. Update defaults in `src/config/defaults.ts`

Remove `executable: 'entire'` from the entire provider defaults (if present).

## What This Eliminates

| Before (Go CLI) | After (TS dep) |
|---|---|
| `brew install entire` or `go install` | `npm install` (automatic) |
| PATH detection + `--version` check | Always available (direct import) |
| Silent skip if CLI missing | Feature always works |
| `child_process.exec` with string commands | Direct function calls with type safety |
| JSON stdout parsing (`parseSessionJson`) | Typed return values from TS API |
| `NO_COLOR=1` env hack | Not needed |
| Shell injection risk (command string interpolation) | Eliminated |
| Platform-specific install (Homebrew = macOS only) | Cross-platform via npm |

## Risk Assessment

- **Low risk**: The `EntireStore` interface is the boundary. Everything above it (provider, linker, watcher) is unchanged.
- **Dependency**: Need to confirm the TS port's API surface matches what we need (`status()` returning sessions, `listCheckpoints()` returning checkpoints).
- **Backward compat**: Existing config files with `executable` field should be silently accepted (not error). Handle with `.passthrough()` or by keeping the field as optional/ignored in the outer schema.

## Open Question

What is the exact npm package name / import path for the TS port? Need to confirm the API surface to finalize step 2.
