#!/usr/bin/env bash
#
# Exercises coop_task_opentasks.py (the OpenTasks-backed coop-task-* CLI) as two
# agents against a live host daemon — the same shell interface CooperBench's
# agents use, but backed by OpenTasks's real atomic claim + attempt/verify.
#
set -uo pipefail
cd "$(dirname "$0")/../../.."  # repo root
[ -f dist/cli.js ] || { echo "build first: npm run build"; exit 1; }

DIR=$(mktemp -d)
export OPENTASKS_PROJECT_DIR="$DIR"
cleanup() { node dist/cli.js daemon stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

node dist/cli.js init >/dev/null 2>&1 || true
node dist/cli.js daemon start >/dev/null 2>&1 || true
[ -S "$DIR/daemon.sock" ] || { echo "daemon socket not bound"; exit 1; }

export CB_OPENTASKS_SOCKET="$DIR/daemon.sock"
CLI="python3 evals/cooperbench/integration/coop_task_opentasks.py"
fail() { echo "FAIL: $1"; exit 1; }

# create (agent-a) -> prints t-id
TID=$(CB_TEAM_AGENT_ID=agent-a $CLI create "feature-1")
rc=$?
{ [ $rc -eq 0 ] && [[ "$TID" == t-* ]]; } || fail "create rc=$rc id=$TID"
echo "create -> $TID"

# agent-a claims it
CB_TEAM_AGENT_ID=agent-a $CLI claim "$TID" >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] || fail "agent-a claim rc=$rc"

# agent-b tries to claim the same task -> exit 2 (THE atomic guard)
CB_TEAM_AGENT_ID=agent-b $CLI claim "$TID" >/dev/null 2>&1; rc=$?
[ $rc -eq 2 ] || fail "agent-b claim expected rc=2 (atomic) got=$rc"
echo "atomic claim: agent-b rejected (rc=2) OK"

# agent-b can't update a task it doesn't own -> exit 3
CB_TEAM_AGENT_ID=agent-b $CLI update "$TID" done >/dev/null 2>&1; rc=$?
[ $rc -eq 3 ] || fail "agent-b update expected rc=3 got=$rc"

# agent-a updates -> 0; list reflects owner/status/note
CB_TEAM_AGENT_ID=agent-a $CLI update "$TID" in_progress -n "wip" >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] || fail "agent-a update rc=$rc"
LIST=$(CB_TEAM_AGENT_ID=agent-a $CLI list)
echo "$LIST" | grep -q "\"id\": \"$TID\"" || fail "list missing $TID"
echo "$LIST" | grep -q "\"owner\": \"agent-a\"" || fail "list owner != agent-a"
echo "$LIST" | grep -q "\"status\": \"in_progress\"" || fail "list status != in_progress"
echo "$LIST" | grep -q "\"last_note\": \"wip\"" || fail "list note != wip"
echo "update + list (owner/status/note) OK"

# done -> list shows 'done' (mapped from OpenTasks 'closed')
CB_TEAM_AGENT_ID=agent-a $CLI update "$TID" done >/dev/null 2>&1; rc=$?
[ $rc -eq 0 ] || fail "agent-a done rc=$rc"
CB_TEAM_AGENT_ID=agent-a $CLI list | grep -q "\"status\": \"done\"" || fail "status not mapped to done"
echo "status done<->closed mapping OK"

# attempt-record + attempt-list (the OpenTasks differentiator)
AID=$(CB_TEAM_AGENT_ID=agent-a $CLI attempt-record "$TID" --outcome success --evidence '{"kind":"test","ref":"suiteX"}')
rc=$?
{ [ $rc -eq 0 ] && [[ "$AID" == a-* ]]; } || fail "attempt-record rc=$rc id=$AID"
CB_TEAM_AGENT_ID=agent-a $CLI attempt-list "$TID" | grep -q "\"$AID\"" || fail "attempt-list missing $AID"
echo "attempt-record/list -> $AID OK"

echo
echo "COOP-TASK OPENTASKS CLI: ALL CHECKS PASSED"
