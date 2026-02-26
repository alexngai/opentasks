# Entire: Go CLI → TypeScript Port Gap Analysis

This document catalogs the differences between the Go CLI (`entireio-cli`) and the
TypeScript npm package (`src/entire/`). It's organized by priority to help guide
what to close next.

---

## Legend

| Status | Meaning |
|--------|---------|
| :white_check_mark: | Fully ported |
| :yellow_circle: | Partially ported — functional but missing pieces |
| :red_circle: | Not ported — meaningful gap |
| :no_entry: | Intentionally omitted (CLI-only, not needed in npm library) |

---

## 1. Core Types & Constants

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `checkpoint/checkpoint.go` (types) | `types.ts` | :white_check_mark: |
| `checkpoint/id/id.go` | `types.ts` (`CheckpointID`, `validateCheckpointID`, `checkpointIDPath`) | :white_check_mark: |
| `agent/event.go` | `types.ts` (`EventType`, `Event`) | :white_check_mark: |
| `agent/types.go` (`HookType`, `HookInput`, `TokenUsage`) | `types.ts` | :white_check_mark: |
| `settings/settings.go` | `types.ts` (`EntireSettings`) + `config.ts` | :white_check_mark: |
| `cli/constants.go` | `types.ts` (`ENTIRE_DIR`, etc.) | :white_check_mark: |
| `paths/paths.go` (constants: file names, `MetadataBranchName`) | `types.ts` (`CHECKPOINTS_BRANCH`, etc.) | :white_check_mark: |

---

## 2. Agent System

### 2.1 Agent Interfaces & Registry

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `agent/agent.go` (Agent interface) | `agent/types.ts` | :white_check_mark: |
| `agent/agent.go` (HookSupport, FileWatcher, TranscriptAnalyzer, TokenCalculator) | `agent/types.ts` | :white_check_mark: |
| `agent/agent.go` (`TranscriptPreparer` interface) | `agent/types.ts` (`TranscriptPreparer`) | :white_check_mark: |
| `agent/agent.go` (`SubagentAwareExtractor` interface) | — | :red_circle: |
| `agent/registry.go` | `agent/registry.ts` | :white_check_mark: |

#### ~~Gap: `TranscriptPreparer` interface~~ :white_check_mark: CLOSED
Implemented in `agent/types.ts` + `agent/agents/claude-code.ts`.
Polls transcript tail for "hooks claude-code stop" sentinel with timestamp validation.

#### Gap: `SubagentAwareExtractor` interface
**Go**: Defined in `agent/agent.go` with two methods:
- `ExtractAllModifiedFiles(transcriptData, fromOffset, subagentsDir)` — aggregates files
  modified by the main session *plus* all Task-tool subagent sessions
- `CalculateTotalTokenUsage(transcriptData, fromOffset, subagentsDir)` — aggregates tokens
  from main session + subagents, populating `SubagentTokens` field

Both rely on `ExtractSpawnedAgentIDs()` which parses the transcript to find Task tool
results containing `"agentId: <id>"` and returns a `map[agentID → toolUseID]`.

**TS**: Main-session `extractModifiedFilesFromOffset()` and `calculateTokenUsage()` exist;
subagent aggregation is completely missing. The `SubagentAwareExtractor` interface,
`hasSubagentAwareExtractor()` type guard, and `extractSpawnedAgentIDs()` helper are all absent.

---

### 2.2 Agent Implementations

| Go Method | Claude Code | Cursor | Gemini | OpenCode |
|-----------|:-----------:|:------:|:------:|:--------:|
| Core Agent (detect, dirs, session) | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `installHooks()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `uninstallHooks()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `areHooksInstalled()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `parseHookEvent()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `readTranscript()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `getTranscriptPosition()` | :white_check_mark: | N/A | :white_check_mark: | :white_check_mark: |
| `extractModifiedFilesFromOffset()` | :white_check_mark: | N/A | :white_check_mark: | :white_check_mark: |
| `calculateTokenUsage()` | :white_check_mark: | N/A | :white_check_mark: | :white_check_mark: |
| `chunkTranscript()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `reassembleTranscript()` | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| `extractPrompts()` | :white_check_mark: | N/A | :white_check_mark: | :white_check_mark: |
| `extractSummary()` | :white_check_mark: | N/A | :white_check_mark: | :white_check_mark: |
| `prepareTranscript()` (flush wait) | :white_check_mark: | N/A | N/A | N/A |
| `extractSpawnedAgentIDs()` | :red_circle: | N/A | N/A | N/A |
| `extractAllModifiedFiles()` (+ subagents) | :red_circle: | N/A | N/A | N/A |
| `calculateTotalTokenUsage()` (+ subagents) | :red_circle: | N/A | N/A | N/A |

### 2.3 Transcript Chunking Utilities

| Go Function | TS Equivalent | Status |
|-------------|---------------|--------|
| `ChunkTranscript()` / `ReassembleTranscript()` | Per-agent `chunkTranscript()` / `reassembleTranscript()` | :white_check_mark: |
| `ChunkJSONL()` / `ReassembleJSONL()` | Inline in agent implementations | :yellow_circle: |
| `ChunkFileName()` / `ParseChunkIndex()` / `SortChunkFiles()` | — | :red_circle: |
| `DetectAgentTypeFromContent()` | — | :red_circle: |

#### Gap: Chunk file naming utilities
**Go**: Standalone utilities for generating chunk filenames (`.001`, `.002`),
parsing chunk indices, and sorting chunk files. Uses `ChunkSuffix = ".%03d"`.
**TS**: Chunking logic exists in agents but there are no shared standalone utilities
for naming/parsing/sorting chunk files.

---

### 2.4 Agent Session Type

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `agent/session.go` (`AgentSession`, `SessionEntry`) | — | :red_circle: |

#### Gap: Structured session model
**Go**: `AgentSession` provides a normalized representation of a session
with typed entries (`EntryUser`, `EntryAssistant`, `EntryTool`, `EntrySystem`),
plus convenience methods (`GetLastUserPrompt`, `TruncateAtUUID`, `FindToolResultUUID`).
**TS**: Agents work directly with raw transcript bytes/lines. Each agent has its own
`parseTranscript`/`extractLastUserPrompt` etc. There's no shared normalized session type.
*This is an architectural difference. The TS approach works but makes cross-agent
operations harder to implement.*

---

## 3. Session State Machine

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `session/phase.go` — `Phase` type (Active/Idle/Ended) | `types.ts` `SessionPhase` | :white_check_mark: |
| `session/phase.go` — `Event` type (6 events) | `types.ts` `EventType` | :white_check_mark: |
| `session/phase.go` — `Action` type (6 actions) | — | :red_circle: |
| `session/phase.go` — `TransitionContext` (rebase detection) | — | :red_circle: |
| `session/phase.go` — `TransitionResult` type | — | :red_circle: |
| `session/phase.go` — `Transition()` pure function | — | :red_circle: |
| `session/phase.go` — `ApplyTransition()` | — | :red_circle: |
| `session/phase.go` — `ActionHandler` interface | — | :red_circle: |
| `session/phase.go` — `NoOpActionHandler` | — | :red_circle: |
| `session/phase.go` — `MermaidDiagram()` | — | :red_circle: |
| `session/state.go` — `NormalizeAfterLoad()` (legacy migration) | — | :red_circle: |
| `session/state.go` — `IsStale()` (7-day threshold) | — | :red_circle: |

#### Gap: Formal state machine
**Go**: Session lifecycle is modeled as a pure state machine with explicit transition
tables. `Transition(phase, event, context) → TransitionResult{newPhase, actions}` is a
pure function; `ApplyTransition` executes side effects via the `ActionHandler` interface.
This makes the logic highly testable and the behavior easy to audit.

Key Go actions with no TS equivalent:
| Action | Purpose | TS Status |
|--------|---------|-----------|
| `ActionCondense` | Trigger condensation on commit | NOT CALLED |
| `ActionCondenseIfFilesTouched` | Condense only if agent made changes | NOT CALLED |
| `ActionDiscardIfNoFiles` | Discard empty sessions | NOT CALLED |
| `ActionWarnStaleSession` | Warn about stale sessions | NOT CALLED |
| `ActionClearEndedAt` | Clear endedAt on session re-entry | NOT CALLED |
| `ActionUpdateLastInteraction` | Update last interaction timestamp | Done inline (partial) |

**TS**: Phase transitions happen inline in `hooks/lifecycle.ts` event handlers. The
*behavior* is equivalent for the common paths, but:
- There is no standalone `Transition()` function that can be unit tested in isolation
- The `Action` type doesn't exist — actions are executed directly in handlers
- `TransitionContext.IsRebaseInProgress` is not checked — commits during rebase
  will incorrectly trigger condensation
- `NormalizeAfterLoad()` backward compat (legacy `active_committed` phase) is missing
- `IsStale()` stale session cleanup is missing

**Risk**: Medium. The lifecycle handlers work correctly for normal flows, but the
implicit transitions are harder to verify for edge cases (e.g., events arriving
in unexpected phases, rebase in progress, stale sessions).

---

## 4. Strategy Engine

### 4.1 Core Strategy

| Go Method | TS Equivalent | Status |
|-----------|---------------|--------|
| `SaveStep()` | `strategy.saveStep()` | :white_check_mark: |
| `SaveTaskStep()` | `strategy.saveTaskStep()` | :white_check_mark: |
| `PrepareCommitMsg()` | `strategy.prepareCommitMsg()` | :white_check_mark: |
| `CommitMsg()` | `strategy.commitMsg()` | :white_check_mark: |
| `PostCommit()` | `strategy.postCommit()` | :white_check_mark: |
| `PrePush()` | `strategy.prePush()` | :white_check_mark: |
| `CondenseSession()` | `strategy.condense()` | :white_check_mark: |
| `GetRewindPoints()` | `strategy.getRewindPoints()` | :white_check_mark: |
| `Rewind()` | `strategy.rewind()` | :white_check_mark: |
| `CanRewind()` | `strategy.canRewind()` | :white_check_mark: |
| `Reset()` | `reset()` command | :white_check_mark: |
| `FindSessionsForCommit()` | `strategy` internal | :white_check_mark: |
| `migrateShadowBranchIfNeeded()` | `strategy` internal | :white_check_mark: |

### 4.2 Missing Strategy Pieces

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `strategy/messages.go` — `ExtractLastCompletedTodo()` | — | :red_circle: |
| `strategy/messages.go` — `ExtractInProgressTodo()` | — | :red_circle: |
| `strategy/messages.go` — `CountTodos()` | — | :red_circle: |
| `strategy/messages.go` — `FormatIncrementalMessage()` | — | :red_circle: |
| `manual_commit_rewind.go` — `PreviewRewind()` | — | :red_circle: |
| `manual_commit_rewind.go` — `RestoreLogsOnly()` | — | :yellow_circle: |
| `manual_commit_rewind.go` — `ResolveAgentForRewind()` | — | :red_circle: |
| `manual_commit_rewind.go` — `ClassifyTimestamps()` / conflict detection | — | :red_circle: |
| `manual_commit.go` — `ValidateRepository()` | — | :red_circle: |
| `manual_commit.go` — `ListOrphanedItems()` | — | :red_circle: |
| `manual_commit_hooks.go` — `hasTTY()` | — | :red_circle: |
| `manual_commit_hooks.go` — `askConfirmTTY()` | — | :red_circle: |

#### ~~Gap: `commit-msg` hook~~ CLOSED
Now all 4 git hooks are implemented: `prepare-commit-msg`, `commit-msg`, `post-commit`,
`pre-push`. The `commit-msg` hook strips the Entire trailer if there's no user content.

#### ~~Gap: Shadow branch migration~~ CLOSED
`migrateShadowBranchIfNeeded()` now detects when HEAD changes mid-session and migrates
the shadow branch. Called automatically by `saveStep()` and `saveTaskStep()`.

#### Gap: Todo extraction from tool input
**Go**: `ExtractLastCompletedTodo()`, `ExtractInProgressTodo()`, `CountTodos()` parse
the `TodoWrite` tool_input JSON to generate meaningful incremental checkpoint messages
(e.g., "Implementing authentication" instead of "Task checkpoint #3").
Wrapper functions `ExtractTodoContentFromToolInput()`, `ExtractLastCompletedTodoFromToolInput()`,
`CountTodosFromToolInput()` handle unwrapping the outer tool_input object.
**TS**: `formatSubagentEndMessage()` and `formatIncrementalSubject()` exist in
`strategy/types.ts`, but the underlying todo-parsing functions are missing.

#### Gap: Rewind conflict detection
**Go**: `ClassifyTimestamps()` compares local agent transcript timestamps with
checkpoint timestamps to detect conflicts. `PromptOverwriteNewerLogs()` prompts
the user before overwriting newer local logs. `ResolveAgentForRewind()` maps
agent types to agent instances for transcript restoration.
**TS**: Basic rewind works, but no timestamp-based conflict detection or
interactive confirmation for log overwrites.

#### Gap: ValidateRepository / ListOrphanedItems
**Go**: `ValidateRepository()` ensures the git repository is suitable for the strategy
(proper worktree, not bare, etc.). `ListOrphanedItems()` finds orphaned shadow branches
and session states for the `clean` command.
**TS**: Not implemented — the `clean` command exists but doesn't call strategy-level
orphan detection.

#### Gap: TTY interaction (hasTTY / askConfirmTTY)
**Go**: `hasTTY()` detects if a controlling terminal is available (respects `ENTIRE_TEST_TTY`
and `GEMINI_CLI` env vars). `askConfirmTTY()` prompts via `/dev/tty` for yes/no
confirmation, working even when stdin is redirected (important for git hooks).
**TS**: Not implemented. Git hooks that need user confirmation cannot prompt interactively.

---

### 4.3 Strategy Infrastructure (common.go)

| Go Function | TS Equivalent | Status |
|-------------|---------------|--------|
| `EnsureSetup()` | — | :red_circle: |
| `IsEmptyRepository()` | — | :red_circle: |
| `IsAncestorOf()` | — | :red_circle: |
| `EnsureMetadataBranch()` | — | :red_circle: |
| `ListCheckpoints()` (from metadata branch) | — | :red_circle: |
| `ReadCheckpointMetadata()` | — | :red_circle: |
| `GetMetadataBranchTree()` | — | :red_circle: |
| `ExtractFirstPrompt()` | — | :red_circle: |
| `ReadSessionPromptFromTree()` | — | :red_circle: |
| `ReadAgentTypeFromTree()` | — | :red_circle: |
| `ReadAllSessionPromptsFromTree()` | — | :red_circle: |
| `GetRemoteMetadataBranchTree()` | — | :red_circle: |
| `HardResetWithProtection()` | — | :red_circle: |
| `IsInsideWorktree()` | — | :red_circle: |
| `GetMainRepoRoot()` | — | :red_circle: |

#### Gap: Strategy infrastructure functions
**Go `common.go`** is a large file (~700+ lines) containing foundational utilities:
- **`EnsureSetup()`** — creates metadata branch, installs git hooks, ensures .gitignore.
  This is the strategy initialization entry point.
- **`EnsureMetadataBranch()`** — creates the `entire/checkpoints/v1` orphan branch with
  an initial empty-tree commit if it doesn't exist yet.
- **`ListCheckpoints()` / `ReadCheckpointMetadata()`** — scans the sharded checkpoint
  tree (`<id[:2]>/<id[2:]>/metadata.json`) on the metadata branch.
- **`IsAncestorOf()`** — walks git history with `MaxCommitTraversalDepth` safety limit.
- **`HardResetWithProtection()`** — hard reset that protects `.git/`, `.entire/`, and
  agent config directories from deletion.

**TS**: Most of these are either handled at the command level (e.g., `enable.ts` does
setup), done inline, or not yet needed because the checkpoint store abstracts some of
this. However, the lack of `EnsureMetadataBranch()` and `ListCheckpoints()` means that
lower-level checkpoint operations must go through the store abstraction — there's no
way for consumers to query the metadata branch directly.

---

### 4.4 Checkpoint Tree Manipulation

| Go Function | TS Equivalent | Status |
|-------------|---------------|--------|
| `checkpoint/parse_tree.go` — `UpdateSubtree()` | — | :red_circle: |
| `checkpoint/parse_tree.go` — `ApplyTreeChanges()` | — | :red_circle: |
| `checkpoint/parse_tree.go` — `TreeChange` type | — | :red_circle: |
| `checkpoint/parse_tree.go` — `MergeMode` enum | — | :red_circle: |

#### Gap: Git tree manipulation
**Go**: `UpdateSubtree()` replaces or creates a subtree at a given path with configurable
merge modes (`ReplaceAll`, `MergeKeepExisting`). `ApplyTreeChanges()` batches multiple
file-level changes into a single tree update. These are used internally by the checkpoint
store for efficient tree construction.
**TS**: The checkpoint store uses `git mktree` and `git hash-object` directly via shell.
The tree manipulation is less structured but functionally equivalent for current usage.

---

## 5. Git Hooks

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `strategy/hooks.go` — `prepare-commit-msg` | `hooks/git-hooks.ts` | :white_check_mark: |
| `strategy/hooks.go` — `commit-msg` | `hooks/git-hooks.ts` | :white_check_mark: |
| `strategy/hooks.go` — `post-commit` | `hooks/git-hooks.ts` | :white_check_mark: |
| `strategy/hooks.go` — `pre-push` | `hooks/git-hooks.ts` | :white_check_mark: |

---

## 6. Path Utilities

| Go Function | TS Equivalent | Status |
|-------------|---------------|--------|
| `WorktreeRoot()` | `git-operations.ts` `getWorktreeRoot()` | :white_check_mark: |
| `GetWorktreeID()` | `utils/worktree.ts` | :white_check_mark: |
| `CheckpointPath()` | `types.ts` `checkpointIDPath()` | :white_check_mark: |
| `SanitizePathForClaude()` | In `claude-code.ts` locally | :white_check_mark: |
| `GetClaudeProjectDir()` | In `claude-code.ts` `getSessionDir()` | :white_check_mark: |
| `HashWorktreeID()` | Inline in `checkpoint-store.ts` | :yellow_circle: |
| `ShadowBranchNameForCommit()` | Inline in `checkpoint-store.ts` | :yellow_circle: |
| `AbsPath()` | — | :red_circle: |
| `IsInfrastructurePath()` | — | :red_circle: |
| `ToRelativePath()` | — | :red_circle: |
| `SessionMetadataDirFromSessionID()` | — | :red_circle: |
| `ExtractSessionIDFromTranscriptPath()` | — | :red_circle: |

#### Gap: Path classification helpers
**Go**: `IsInfrastructurePath()` checks if a path is inside `.entire/` — used to
filter out infrastructure files from diff outputs and attribution calculations.
`ToRelativePath()` converts absolute paths to repository-relative paths.
**TS**: These operations are done inline where needed. Extracting them would improve
consistency and prevent bugs where `.entire/` paths leak into user-facing output.

#### Note: HashWorktreeID / ShadowBranchNameForCommit
These exist in TS but are inline in `checkpoint-store.ts` rather than exported as
standalone utilities. The Go versions are exported from the `checkpoint` package.
Functionally equivalent but not reusable outside the store.

---

## 7. Utilities

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `stringutil/` (`CollapseWhitespace`, `TruncateRunes`, `CapitalizeFirst`) | `utils/string-utils.ts` | :white_check_mark: |
| `textutil/` (`StripIDEContextTags`) | `utils/ide-tags.ts` | :white_check_mark: |
| `trailers/trailers.go` | `utils/trailers.ts` | :white_check_mark: |
| `transcript/parse.go` | `utils/transcript-parse.ts` | :white_check_mark: |
| `validation/validators.go` | `utils/validation.ts` | :white_check_mark: |
| `jsonutil/` (`MarshalIndentWithNewline`) | `JSON.stringify()` + `"\n"` inline | :white_check_mark: |

---

## 8. Commands

| Go Command | TS Equivalent | Status |
|------------|---------------|--------|
| `enable` | `commands/enable.ts` | :white_check_mark: |
| `disable` | `commands/disable.ts` | :white_check_mark: |
| `status` | `commands/status.ts` | :white_check_mark: |
| `doctor` | `commands/doctor.ts` | :white_check_mark: |
| `explain` | `commands/explain.ts` | :white_check_mark: |
| `reset` | `commands/reset.ts` | :white_check_mark: |
| `resume` | `commands/resume.ts` | :white_check_mark: |
| `rewind` | `commands/rewind.ts` | :white_check_mark: |
| `clean` | `commands/clean.ts` | :white_check_mark: |

---

## 9. Stores

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| Session state store | `store/session-store.ts` | :white_check_mark: |
| Checkpoint store | `store/checkpoint-store.ts` | :white_check_mark: |
| Native store (direct FS) | `store/native-store.ts` | :white_check_mark: |

---

## 10. Security

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| Redaction (entropy + pattern) | `security/redaction.ts` | :white_check_mark: |
| Input validation | `utils/validation.ts` | :white_check_mark: |

---

## 11. Summarization

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `summarize/summarize.go` | `summarize/summarize.ts` | :white_check_mark: |
| `summarize/claude.go` | `summarize/claude-generator.ts` | :white_check_mark: |

---

## 12. Configuration

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| `settings/settings.go` | `config.ts` | :white_check_mark: |
| `cli/config.go` | `config.ts` | :white_check_mark: |
| `.gitignore` management | `config.ts` `ensureGitignore()` | :white_check_mark: |

---

## 13. Hooks / Lifecycle

| Go Source | TS Equivalent | Status |
|-----------|---------------|--------|
| Lifecycle event dispatch | `hooks/lifecycle.ts` | :white_check_mark: |
| Git hook installation | `hooks/git-hooks.ts` | :white_check_mark: |
| Hook manager detection | `utils/hook-managers.ts` | :white_check_mark: |
| Hook manager warnings | `utils/hook-managers.ts` | :white_check_mark: |

---

## 14. Intentionally Omitted (CLI-Only)

These exist in Go but are deliberately excluded from the npm library:

| Go Source | Reason |
|-----------|--------|
| `cli/root.go` (Cobra command tree) | CLI framework wiring — consumers build their own CLI |
| `logging/logger.go` (structured file logging) | Consumers use their own logging |
| `telemetry/` (PostHog analytics) | CLI-specific analytics |
| `versioncheck/` (GitHub release checking) | CLI auto-update feature |
| `versioninfo/` (build-time ldflags) | CLI binary metadata |
| `benchutil/` (benchmark helpers) | Internal tooling |
| `testutil/` + `agent/testutil/` (test helpers) | Different test framework (vitest) |
| Interactive terminal UI (spinners, prompts) | CLI presentation layer |
| `session/gen_state_diagram.go` | Code generation utility |

---

## Priority Ranking for Closing Gaps

### P0 — Correctness :white_check_mark: CLOSED

All P0 gaps have been closed:

1. ~~**Shadow branch migration**~~ — `migrateShadowBranchIfNeeded()` in `manual-commit.ts`
2. ~~**`commit-msg` hook**~~ — 4th hook in `git-hooks.ts` + `commitMsg()` strategy method
3. ~~**`prepareTranscript()` flush sentinel**~~ — `TranscriptPreparer` in `claude-code.ts`

### P1 — Feature Completeness :white_check_mark: CLOSED

All P1 gaps have been closed:

4. ~~**Session state machine formalization**~~ — `session/state-machine.ts`
   - Pure `transition()` function, `Action` enum (6 actions), `TransitionContext`
   - `ActionHandler` interface + `applyTransition()` executor
   - `normalizeAfterLoad()`, `isStale()` (7-day threshold), `mermaidDiagram()`

5. ~~**Todo extraction from tool input**~~ — `utils/todo-extract.ts`
   - `extractLastCompletedTodo()`, `extractInProgressTodo()`, `countTodos()`
   - Wrapper functions for TodoWrite tool_input JSON unwrapping

6. ~~**`FormatIncrementalMessage()`**~~ — `utils/todo-extract.ts`
   - Formats meaningful checkpoint messages from todo content
   - Truncates to 60 chars with `(<tool-use-id>)` suffix

7. ~~**Rewind conflict detection**~~ — `utils/rewind-conflict.ts`
   - `classifyTimestamps()`, `statusToText()`, `hasConflicts()`, `partitionConflicts()`
   - `resolveAgentForRewind()` maps agent types to instances

8. ~~**Subagent-aware extraction**~~ — `agent/types.ts` + `agent/agents/claude-code.ts`
   - `SubagentAwareExtractor` interface + `hasSubagentAwareExtractor()` type guard
   - `extractSpawnedAgentIDs()` parses Task tool results for agentIds
   - `extractAllModifiedFiles()` + `calculateTotalTokenUsage()` aggregate subagent data
   - Fixed `calculateTokenUsage()` to deduplicate by message ID (streaming support)

### P2 — Polish :white_check_mark: CLOSED

All P2 gaps have been closed:

9. ~~**Chunk file naming utilities**~~ — `utils/chunk-files.ts`
   - `chunkFileName()`, `parseChunkIndex()`, `sortChunkFiles()`

10. ~~**Path classification helpers**~~ — `utils/paths.ts`
    - `isInfrastructurePath()`, `toRelativePath()`, `absPath()`
    - `extractSessionIDFromPath()`, `sessionMetadataDir()`

11. ~~**`DetectAgentTypeFromContent()`**~~ — `utils/detect-agent.ts`
    - Detects Gemini JSON format from transcript content

12. ~~**`PreviewRewind()`**~~ — `utils/preview-rewind.ts`
    - Shows files to restore and untracked files to delete

13. ~~**`MermaidDiagram()`**~~ — included in `session/state-machine.ts`
    - Generates Mermaid state diagram from transition table

14. ~~**TTY interaction**~~ — `utils/tty.ts`
    - `hasTTY()` with `ENTIRE_TEST_TTY` and `GEMINI_CLI` env var support
    - `askConfirmTTY()` prompts via `/dev/tty` for git hook confirmation

15. ~~**ValidateRepository / ListOrphanedItems**~~ — `strategy/types.ts` + `strategy/manual-commit.ts`
    - Added to `Strategy` interface, implemented on manual-commit strategy
    - `OrphanedItem` type for cleanup reporting

16. ~~**Exported shadow branch utilities**~~ — `utils/shadow-branch.ts`
    - `hashWorktreeID()`, `shadowBranchNameForCommit()`, `parseShadowBranchName()`
    - `isShadowBranch()`, `listShadowBranches()`, `deleteShadowBranches()`

### P3 — Architectural :white_check_mark: CLOSED

All P3 gaps have been closed:

17. ~~**Normalized `AgentSession` type**~~ — `agent/session-types.ts`
    - `AgentSession` with `SessionEntry` typed entries (`User`, `Assistant`, `Tool`, `System`)
    - `getLastUserPrompt()`, `getUserPrompts()`, `truncateAtUUID()`, `findToolResultByUUID()`

18. ~~**Strategy `common.go` infrastructure**~~ — `strategy/common.ts`
    - `validateRepository()`, `isEmptyRepository()`, `isAncestorOf()`
    - `ensureMetadataBranch()`, `readCheckpointMetadata()`, `readSessionPromptFromTree()`
    - `readAgentTypeFromTree()`, `extractFirstPrompt()`, `ensureSetup()`
    - `isInsideWorktree()`, `getMainRepoRoot()`

19. ~~**Git tree manipulation**~~ — `utils/tree-ops.ts`
    - `updateSubtree()` with `MergeMode` (`ReplaceAll`, `MergeKeepExisting`)
    - `applyTreeChanges()` for batch file-level tree modifications
    - `createTreeFromMap()` for building trees from file content

---

## Gap Summary

| Priority | Open Gaps | Closed |
|----------|:---------:|:------:|
| **P0 — Correctness** | 0 | 3 |
| **P1 — Feature Completeness** | 0 | 5 |
| **P2 — Polish** | 0 | 8 |
| **P3 — Architectural** | 0 | 3 |
| **Total** | **0** | **19** |

---

## Test Coverage Summary

| Test File | Tests | Covers |
|-----------|:-----:|--------|
| `types.test.ts` | 12 | Core types, checkpoint ID validation |
| `redaction.test.ts` | 18 | Secret detection, redaction |
| `utils.test.ts` | 42 | String utils, trailers, transcript parsing, IDE tags |
| `summarize.test.ts` | 22 | Condensed transcripts, prompt building, JSON extraction |
| `agent-registry.test.ts` | 11 | Agent registration, detection, resolution |
| `session-store.test.ts` | 7 | Session CRUD, normalization |
| `cursor-agent.test.ts` | 23 | Cursor agent hooks, detection |
| `gemini-agent.test.ts` | 29 | Gemini agent hooks, transcripts, tokens |
| `opencode-agent.test.ts` | 31 | OpenCode agent hooks, transcripts, tokens |
| `validation.test.ts` | 18 | Input validation, path traversal |
| `hook-managers.test.ts` | 13 | Hook manager detection, warnings |
| `worktree.test.ts` | 6 | Worktree ID detection |
| `transcript-timestamp.test.ts` | 14 | JSONL timestamp extraction |
| `claude-generator.test.ts` | 4 | Claude CLI generator |
| `commit-msg.test.ts` | 11 | commit-msg hook helpers |
| `flush-sentinel.test.ts` | 5 | Transcript flush sentinel |
| `git-hooks.test.ts` | 5 | Git hook installation (4 hooks) |
| **Total** | **271** | |

### Test Gaps

Tests exist for utilities and agents but **not** for:
- Strategy engine (`manual-commit.ts`) — requires git repo fixtures
- Commands (`enable.ts`, `disable.ts`, etc.) — requires git repo fixtures
- Lifecycle handler (`lifecycle.ts`) — requires agent + store mocking
- Checkpoint store (`checkpoint-store.ts`) — requires git repo fixtures
- Content overlap (`content-overlap.ts`) — requires git repo fixtures
- Attribution (`attribution.ts`) — requires diff fixtures

These would require an integration test harness with real/mock git repositories,
similar to Go's `testutil` package.
