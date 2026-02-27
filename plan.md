# Migration: Entire Provider — Go CLI → TS Dependency

## Status: IMPLEMENTED

All changes have been made and tests pass (117/117 across changed files).

## What Changed

### Package: `entire-cli@^0.0.3` added as a direct dependency

The `entire-cli` npm package (https://github.com/alexngai/entire-cli) provides a native
TypeScript implementation with zero production dependencies. It exports `createNativeEntireStore(cwd)`
which implements the exact same `EntireStore` interface opentasks already used, making it a
drop-in replacement.

### Files Modified

| File | Change |
|---|---|
| `package.json` | Added `"entire-cli": "^0.0.3"` to dependencies |
| `src/providers/entire.ts` | Replaced 150-line `createEntireCliStore` (child_process.exec + JSON parsing) with 3-line wrapper around `createNativeEntireStore` from entire-cli. Re-exported types from entire-cli instead of redefining them locally. |
| `src/providers/from-config.ts` | Removed `isCliAvailable(entireConfig.executable)` check for entire provider. Provider now always creates successfully since the TS module is a direct import. |
| `src/config/schema.ts` | Removed `executable` field from `EntireProviderConfigSchemaInner`. Outer schema still accepts `executable` for backward compat with existing config files. |
| `src/config/__tests__/schema.test.ts` | Updated expected defaults to no longer include `executable: 'entire'`. |
| `src/providers/__tests__/entire.test.ts` | Replaced `child_process` mocks with `vi.mock('entire-cli')`. Tests now mock `createNativeEntireStore` directly. |

### Files NOT changed (by design)

- `src/daemon/entire-watcher.ts` — Already reads `.git/entire-sessions/*.json` from disk
- `src/daemon/entire-linker.ts` — Uses GraphStore API directly
- `src/providers/index.ts` — Re-exports unchanged, signatures match
- In-memory store, node conversion, URI parsing — All decoupled from store implementation

## What This Eliminates

| Before (Go CLI) | After (TS dep) |
|---|---|
| `brew install entire` or `go install` | `npm install` (automatic) |
| PATH detection + `--version` check | Always available (direct import) |
| Silent skip if CLI missing | Feature always works |
| `child_process.exec` string commands | Direct typed function calls |
| JSON stdout parsing | Typed return values |
| `NO_COLOR=1` env hack | Not needed |
| Shell injection risk | Eliminated |
| Platform-specific install (Homebrew = macOS) | Cross-platform via npm |

## Key API from entire-cli

```ts
import { createNativeEntireStore } from 'entire-cli';
import type { EntireStore, EntireSession, EntireCheckpoint } from 'entire-cli';

const store: EntireStore = createNativeEntireStore('/path/to/repo');
await store.listSessions();      // EntireSession[]
await store.getSession(id);      // EntireSession | null
await store.listCheckpoints();   // EntireCheckpoint[]
await store.getCheckpoint(id);   // EntireCheckpoint | null
await store.search(query);       // (EntireSession | EntireCheckpoint)[]
```

The `EntireStore` interface is identical to what opentasks already defined locally —
same 5 methods, same signatures, same types. The local type definitions were replaced
with re-exports from the package.
