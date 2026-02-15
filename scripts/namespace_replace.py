#!/usr/bin/env python3
"""
Bulk namespace replacement script for OpenTasks documentation.

Replaces old namespace references with new namespace references:
- spec -> context (concept/node type)
- issue -> task (concept/node type)
- ID prefix s- -> c-, i- -> t-
- Directory specs/ -> context/, issues/ -> tasks/
- URI schemes opentasks://specs -> opentasks://context, etc.

Preserves:
- Provider-specific types (SudocodeSpec, SudocodeIssue, BeadsIssue, etc.)
- External system references (.beads/issues.jsonl, GitHub Issues as external system)
- "issue" meaning "problem" (not a node type)
"""

import re
import os
import sys

FILES = [
    "/home/user/opentasks/docs/PROVIDERS.md",
    "/home/user/opentasks/docs/TESTING.md",
    "/home/user/opentasks/docs/DESIGN.md",
    "/home/user/opentasks/docs/INTERFACE.md",
    "/home/user/opentasks/docs/ARCHITECTURE.md",
    "/home/user/opentasks/docs/PERSISTENCE.md",
    "/home/user/opentasks/docs/plans/CORE-ARCHITECTURE.md",
    "/home/user/opentasks/docs/plans/PHASE-1.md",
    "/home/user/opentasks/docs/plans/PHASE-2.md",
    "/home/user/opentasks/docs/plans/PHASE-3.md",
    "/home/user/opentasks/docs/plans/ENTIRE-INTEGRATION.md",
    "/home/user/opentasks/docs/plans/FOLLOWUP-GAPS.md",
    "/home/user/opentasks/docs/plans/README.md",
    "/home/user/opentasks/README.md",
    "/home/user/opentasks/skills/opentasks/spec-to-implementation.md",
    "/home/user/opentasks/skills/opentasks/SKILL.md",
    "/home/user/opentasks/skills/opentasks/dependency-management.md",
    "/home/user/opentasks/skills/opentasks/feedback-and-review.md",
    "/home/user/opentasks/skills/opentasks/linking-external-data.md",
]

def apply_replacements(content: str) -> str:
    """Apply all namespace replacements to the content."""

    # ==========================================
    # STEP 0: Protect strings that should NOT change
    # ==========================================

    # Protect provider-specific type names
    protections = {}
    protection_counter = [0]

    def protect(match):
        key = f"__PROTECT_{protection_counter[0]}__"
        protection_counter[0] += 1
        protections[key] = match.group(0)
        return key

    # Protect provider-specific names (case-sensitive)
    # SudocodeSpec, SudocodeIssue, BeadsIssue, etc.
    content = re.sub(r'Sudocode(?:Spec|Issue|Issues|Specs)', protect, content)
    content = re.sub(r'Beads(?:Issue|Issues|Spec|Specs)(?!Provider)', protect, content)

    # Protect external system paths like .beads/issues.jsonl
    content = re.sub(r'\.beads/issues\.jsonl', protect, content)
    content = re.sub(r'\.beads/issues/', protect, content)

    # Protect "GitHub Issues" as an external system name
    content = re.sub(r'GitHub [Ii]ssues?(?! implementing| that| which| is | are | was )', protect, content)

    # Protect "GitHub issue" as a service reference
    content = re.sub(r'github://\[owner\]/\[repo\]/\[num\]\s*#\s*GitHub issue', protect, content)

    # Protect Jira issue/Linear issue as external system references in URI comment contexts
    # e.g., "# Jira issue", "# Linear issue", "# Beads issue" in URI scheme comments
    content = re.sub(r'#\s*(?:Jira|Linear|Beads|GitHub)\s+issue\b', protect, content)

    # Protect Claude Code task system references (these are external, not OpenTasks concepts)
    content = re.sub(r'Claude Code task system', protect, content)
    content = re.sub(r"Claude's built-in tasks", protect, content)
    content = re.sub(r"Claude's Tasks", protect, content)
    content = re.sub(r"Claude Tasks", protect, content)
    content = re.sub(r"Claude subtask", protect, content)
    content = re.sub(r"Claude task", protect, content)

    # Protect "Claude Code task" references
    content = re.sub(r'Claude Code task(?! system)', protect, content)

    # Protect bd CLI references that mention "issue"
    # "Beads issue" in descriptive text about the external system
    content = re.sub(r'Beads issue(?! implementing| that| which)', protect, content)

    # Protect "Distributed issue tracker" - describes Beads externally
    content = re.sub(r'Distributed issue tracker', protect, content)

    # Protect createIssue/getIssue/updateIssue in Adapter interface (external system interface)
    content = re.sub(r'(?:create|get|update|delete)Issue\b', protect, content)

    # Protect "Jira ticket" and similar external references
    content = re.sub(r'Jira ticket', protect, content)

    # Protect "issue operations" when talking about Beads adapter
    # "all issue operations go through `bd` CLI"
    content = re.sub(r'all issue operations go through', protect, content)

    # Protect "sudocode issues" (external system)
    content = re.sub(r'sudocode issues', protect, content)

    # Protect TaskCreate/TaskUpdate/TaskGet/TaskList (Claude's built-in)
    content = re.sub(r'Task(?:Create|Update|Get|List)\b', protect, content)

    # Protect the word "task" in "Taskmaster"
    # (Taskmaster is already a compound word, but we need to be careful)

    # ==========================================
    # STEP 1: Specific multi-word phrases first (most specific -> least specific)
    # ==========================================

    # --- Type names and interfaces ---
    content = content.replace('SpecsQueryParams', 'ContextQueryParams')
    content = content.replace('ImplementersQueryParams', 'TasksQueryParams')

    # --- Method/function names ---
    content = content.replace('implementers()', 'tasks()')
    content = content.replace("'implementers'", "'tasks'")
    content = content.replace('"implementers"', '"tasks"')
    content = content.replace('find: \'implementers\'', 'find: \'tasks\'')

    # specs() method -> context()
    # Be careful: only replace specs() as a method call, not in other contexts
    content = re.sub(r"\bspecs\(\)", "context()", content)
    content = content.replace("'specs'", "'context'")
    content = content.replace('"specs"', '"context"')
    content = content.replace('find: \'specs\'', 'find: \'context\'')

    # --- Type guard functions ---
    content = content.replace('isSpec(', 'isContext(')
    content = content.replace('isSpec ', 'isContext ')
    content = content.replace('isIssue(', 'isTask(')
    content = content.replace('isIssue ', 'isTask ')

    # --- URI schemes ---
    content = content.replace('opentasks://specs', 'opentasks://context')
    content = content.replace('opentasks://issues', 'opentasks://tasks')

    # --- Directory names in paths ---
    # specs/ -> context/ and issues/ -> tasks/ in file path contexts
    content = re.sub(r'(?<![.\w])specs/', 'context/', content)
    content = re.sub(r'(?<![.\w])issues/', 'tasks/', content)
    # Also handle these in path patterns like ├── specs/ or └── issues/
    content = re.sub(r'(├── |└── )specs/', r'\1context/', content)
    content = re.sub(r'(├── |└── )issues/', r'\1tasks/', content)
    # Handle specs/*.md and issues/*.md
    content = content.replace('specs/*.md', 'context/*.md')
    content = content.replace('issues/*.md', 'tasks/*.md')

    # --- ID prefix patterns ---
    # s-a2b3 -> c-a2b3 style IDs (specific known examples)
    content = re.sub(r'\bs-a2b3\b', 'c-a2b3', content)
    content = re.sub(r'\bs-c4d5\b', 'c-c4d5', content)
    content = re.sub(r'\bs-789\b', 'c-789', content)
    content = re.sub(r'\bi-x7k9\b', 't-x7k9', content)
    content = re.sub(r'\bi-e6f7\b', 't-e6f7', content)
    content = re.sub(r'\bi-123\b', 't-123', content)
    content = re.sub(r'\bi-setup\b', 't-setup', content)
    content = re.sub(r'\bi-impl\b', 't-impl', content)

    # Generic ID prefix patterns: s- followed by hash-like chars in ID contexts
    # Match s- prefix IDs like s-xxxx where xxxx is alphanumeric (not followed by word boundary issues)
    content = re.sub(r"(?<!')(?<!\")(?<=[\s(,\[`/])s-([a-z0-9]{2,8})(?=[\s),\]`'\"\.:}])", r'c-\1', content)
    content = re.sub(r"(?<!')(?<!\")(?<=[\s(,\[`/])i-([a-z0-9]{2,8})(?=[\s),\]`'\"\.:}])", r't-\1', content)

    # ID prefixes at start of line
    content = re.sub(r'^s-([a-z0-9]{2,8})\b', r'c-\1', content, flags=re.MULTILINE)
    content = re.sub(r'^i-([a-z0-9]{2,8})\b', r't-\1', content, flags=re.MULTILINE)

    # ID prefixes in quotes
    content = re.sub(r"'s-([a-z0-9]{2,8})'", r"'c-\1'", content)
    content = re.sub(r"'i-([a-z0-9]{2,8})'", r"'t-\1'", content)
    content = re.sub(r'"s-([a-z0-9]{2,8})"', r'"c-\1"', content)
    content = re.sub(r'"i-([a-z0-9]{2,8})"', r'"t-\1"', content)

    # --- SPEC- and ISSUE- prefixed IDs ---
    content = re.sub(r'\bSPEC-', 'CONTEXT-', content)
    content = re.sub(r'\bISSUE-', 'TASK-', content)

    # ==========================================
    # STEP 2: Type field values in code/config
    # ==========================================

    # type: 'spec' -> type: 'context' and type: 'issue' -> type: 'task'
    content = re.sub(r"type:\s*'spec'", "type: 'context'", content)
    content = re.sub(r"type:\s*'issue'", "type: 'task'", content)
    content = re.sub(r'type:\s*"spec"', 'type: "context"', content)
    content = re.sub(r'type:\s*"issue"', 'type: "task"', content)

    # 'spec' | 'issue' type unions
    content = content.replace("'spec' | 'issue'", "'context' | 'task'")
    content = content.replace("'issue' | 'spec'", "'task' | 'context'")
    content = content.replace('"spec" | "issue"', '"context" | "task"')

    # nodeTypes arrays
    content = re.sub(r"nodeTypes:\s*\[\s*'spec'\s*\]", "nodeTypes: ['context']", content)
    content = re.sub(r"nodeTypes:\s*\[\s*'issue'\s*\]", "nodeTypes: ['task']", content)
    content = re.sub(r"nodeTypes:\s*\[\s*'spec'\s*,\s*'issue'\s*\]", "nodeTypes: ['context', 'task']", content)
    content = re.sub(r"nodeTypes:\s*\(\s*'spec'\s*\|\s*'issue'\s*\)", "nodeTypes: ('context' | 'task')", content)

    # ==========================================
    # STEP 3: Concept-level replacements (natural language)
    # ==========================================

    # "Issue Providers" -> "Task Providers" etc.
    content = content.replace('Issue Providers', 'Task Providers')
    content = content.replace('Issue providers', 'Task providers')
    content = content.replace('Spec Providers', 'Context Providers')
    content = content.replace('Spec providers', 'Context providers')

    # "Native Issue Provider" -> "Native Task Provider"
    content = content.replace('Native Issue Provider', 'Native Task Provider')
    content = content.replace('Native Spec Provider', 'Native Context Provider')
    content = content.replace('NativeIssueProvider', 'NativeTaskProvider')
    content = content.replace('NativeSpecProvider', 'NativeContextProvider')

    # "issue implements spec" -> "task implements context"
    content = content.replace('issue implements spec', 'task implements context')
    content = content.replace('issue implements a spec', 'task implements a context')
    content = content.replace('Issue implements Spec', 'Task implements Context')
    content = content.replace('issues implementing', 'tasks implementing')
    content = content.replace('Issues implementing', 'Tasks implementing')

    # "implementers" as a concept (not method call)
    content = re.sub(r'\bimplementers\b(?!\()', 'tasks', content)

    # "Specs" and "Issues" as section headers / concept names
    # Be very careful here - only in OpenTasks contexts

    # "Native specs/issues" -> "Native context/tasks"
    content = content.replace('Native specs/issues', 'Native context/tasks')
    content = content.replace('native specs/issues', 'native context/tasks')
    content = content.replace('native specs', 'native context')
    content = content.replace('Native specs', 'Native context')

    # "specs and issues" / "issues and specs"
    content = content.replace('specs and issues', 'context and tasks')
    content = content.replace('issues and specs', 'tasks and context')

    # "spec and issue" / "issue and spec"
    content = content.replace('spec and issue', 'context and task')
    content = content.replace('issue and spec', 'task and context')

    # Specific phrases
    content = content.replace('creates spec', 'creates context')
    content = content.replace('creates a spec', 'creates a context')
    content = content.replace('create a spec', 'create a context')
    content = content.replace('Create spec', 'Create context')
    content = content.replace('links issues', 'links tasks')
    content = content.replace('link issues', 'link tasks')

    # "lightweight specs/issues" -> "lightweight context/tasks"
    content = content.replace('lightweight specs/issues', 'lightweight context/tasks')
    content = content.replace('simple specs/issues', 'simple context/tasks')

    # "Spec (s-a2b3)" -> "Context (c-a2b3)" - already handled by ID replacement above

    # "Local nodes (specs, issues)" -> "Local nodes (context, tasks)"
    content = content.replace('(specs, issues)', '(context, tasks)')
    content = content.replace('(spec, issue)', '(context, task)')

    # ==========================================
    # STEP 4: Capitalized forms in headers and descriptions
    # ==========================================

    # "Spec" as a standalone capitalized concept -> "Context"
    # Need to be very careful here - only replace when it's an OpenTasks node type

    # Table entries like | **Spec** | or | Spec |
    content = re.sub(r'\*\*Spec\*\*', '**Context**', content)
    content = re.sub(r'\*\*Issue\*\*', '**Task**', content)
    content = re.sub(r'\*\*Specs\*\*', '**Context**', content)
    content = re.sub(r'\*\*Issues\*\*', '**Tasks**', content)

    # "External Issue Content" -> "External Task Content"
    content = content.replace('External Issue Content', 'External Task Content')
    content = content.replace('External Spec Content', 'External Context Content')

    # "Issue Provider" -> "Task Provider" (already done above in compound forms)
    content = content.replace('Issue Provider', 'Task Provider')
    content = content.replace('Spec Provider', 'Context Provider')

    # Section headers like "#### Specs (Intent/Requirements)"
    content = content.replace('#### Specs (Intent/Requirements)', '#### Context (Intent/Requirements)')
    content = content.replace('#### Issues (Actionable Work)', '#### Tasks (Actionable Work)')

    # "Spec (Intent/Requirements)" without ####
    content = content.replace('Specs (Intent', 'Context (Intent')
    content = content.replace('Issues (Actionable', 'Tasks (Actionable')

    # ==========================================
    # STEP 5: In-text concept references
    # ==========================================

    # "the spec" -> "the context", "a spec" -> "a context"
    content = re.sub(r'\bthe spec\b', 'the context', content)
    content = re.sub(r'\ba spec\b', 'a context', content)
    content = re.sub(r'\bthe issue\b', 'the task', content)
    content = re.sub(r'\ban issue\b', 'a task', content)
    content = re.sub(r'\ba issue\b', 'a task', content)

    # "this spec" / "this issue"
    content = re.sub(r'\bthis spec\b', 'this context', content)
    content = re.sub(r'\bthis issue\b', 'this task', content)
    content = re.sub(r'\bthat spec\b', 'that context', content)
    content = re.sub(r'\bthat issue\b', 'that task', content)

    # "each spec" / "each issue"
    content = re.sub(r'\beach spec\b', 'each context', content)
    content = re.sub(r'\beach issue\b', 'each task', content)

    # "one spec" / "one issue"
    content = re.sub(r'\bone spec\b', 'one context', content)
    content = re.sub(r'\bone issue\b', 'one task', content)

    # "local issue" -> "local task", "local spec" -> "local context"
    content = content.replace('local issue', 'local task')
    content = content.replace('local spec', 'local context')
    content = content.replace('Local Issue', 'Local Task')
    content = content.replace('Local Spec', 'Local Context')
    content = content.replace('Local issue', 'Local task')
    content = content.replace('Local spec', 'Local context')

    # "Native OpenTasks spec" -> "Native OpenTasks context"
    content = content.replace('Native OpenTasks spec', 'Native OpenTasks context')
    content = content.replace('native OpenTasks spec', 'native OpenTasks context')
    content = content.replace('Native OpenTasks issue', 'Native OpenTasks task')

    # "native://s-" -> "native://c-"
    content = re.sub(r'native://s-', 'native://c-', content)
    content = re.sub(r'native://i-', 'native://t-', content)

    # ==========================================
    # STEP 6: code-level identifiers
    # ==========================================

    # "Spec" and "Issue" in type contexts within code blocks
    # Node = Spec | Issue -> Node = Context | Task
    content = content.replace('Node = Spec |', 'Node = Context |')
    content = content.replace('| Issue |', '| Task |')

    # interface Spec { -> interface Context {
    content = content.replace('interface Spec {', 'interface Context {')
    content = content.replace('interface Spec\n', 'interface Context\n')
    content = content.replace('interface Issue {', 'interface Task {')
    content = content.replace('interface Issue\n', 'interface Task\n')

    # "Spec node" / "Issue node" -> "Context node" / "Task node"
    content = content.replace('Spec node', 'Context node')
    content = content.replace('Issue node', 'Task node')
    content = content.replace('spec node', 'context node')
    content = content.replace('issue node', 'task node')

    # ==========================================
    # STEP 7: Comments and descriptions
    # ==========================================

    # "// issue, spec, feedback" -> "// task, context, feedback"
    content = content.replace('// issue, spec, feedback', '// task, context, feedback')
    content = content.replace('// spec, issue, feedback', '// context, task, feedback')
    content = content.replace('// spec, issue', '// context, task')
    content = content.replace('// issue, spec', '// task, context')

    # "Issues implementing a spec" -> "Tasks implementing a context"
    content = content.replace('issues implementing a spec', 'tasks implementing a context')
    content = content.replace('Issues implementing a spec', 'Tasks implementing a context')
    content = content.replace('issues implementing one spec', 'tasks implementing one context')

    # "// Specs that an issue implements" -> "// Context that a task implements"
    content = content.replace('Specs that an issue implements', 'Context that a task implements')
    content = content.replace('specs that an issue implements', 'context that a task implements')

    # ==========================================
    # STEP 8: Diagram/table references
    # ==========================================

    # In ASCII diagrams: "Spec (s-a2b3)" -> "Context (c-a2b3)"
    # Already handled by ID replacements above, but handle the word too
    content = re.sub(r'Spec \(c-', 'Context (c-', content)  # After ID replacement
    content = re.sub(r'Issue \(t-', 'Task (t-', content)  # After ID replacement

    # In provider boxes: "Issue Providers" already handled
    # "Spec Providers" already handled

    # spec concept from sudocode: "Derived from sudocode's spec concept"
    # This should become "Derived from sudocode's context concept"
    content = content.replace("sudocode's spec concept", "sudocode's context concept")

    # ==========================================
    # STEP 9: More in-text replacements for remaining patterns
    # ==========================================

    # "spec data" / "issue data"
    content = content.replace('spec data', 'context data')
    content = content.replace('issue data', 'task data')
    content = content.replace('spec and issue data', 'context and task data')

    # "spec content" / "issue content"
    content = content.replace('spec content', 'context content')
    content = content.replace('issue content', 'task content')

    # "specs for" / "issues for"
    content = re.sub(r'\bspecs for\b', 'context for', content)
    content = re.sub(r'\bissues for\b', 'tasks for', content)

    # "Unblocked open issues" -> "Unblocked open tasks"
    content = content.replace('Unblocked open issues', 'Unblocked open tasks')
    content = content.replace('unblocked open issues', 'unblocked open tasks')

    # "open issues" -> "open tasks"
    content = content.replace('open issues', 'open tasks')
    content = content.replace('Open issues', 'Open tasks')

    # "task and spec systems" -> already handled by spec->context
    content = content.replace('task and spec systems', 'task and context systems')
    content = content.replace('task and context systems', 'task and context systems')  # idempotent

    # ==========================================
    # STEP 10: Remaining specific patterns
    # ==========================================

    # "implements" edge description: "issue implements spec" already handled

    # "| 'implements' | issue implements spec |"
    content = content.replace("| 'implements'       // issue implements spec",
                              "| 'implements'       // task implements context")
    content = content.replace("// issue implements spec", "// task implements context")

    # "spec-kit" - this might be a tool name, check context
    # Leave spec-kit as-is since it appears to be an external tool

    # "createTestSpec" / "createTestIssue" -> "createTestContext" / "createTestTask"
    content = content.replace('createTestSpec', 'createTestContext')
    content = content.replace('createTestIssue', 'createTestTask')

    # "testSpec" / "testIssue" -> "testContext" / "testTask"
    content = content.replace('testSpec', 'testContext')
    content = content.replace('testIssue', 'testTask')

    # ==========================================
    # STEP 11: Restore protected strings
    # ==========================================

    for key, value in protections.items():
        content = content.replace(key, value)

    return content


def main():
    """Process all files."""
    for filepath in FILES:
        if not os.path.exists(filepath):
            print(f"SKIP (not found): {filepath}")
            continue

        with open(filepath, 'r') as f:
            original = f.read()

        modified = apply_replacements(original)

        if modified != original:
            with open(filepath, 'w') as f:
                f.write(modified)

            # Count changes
            import difflib
            diff = list(difflib.unified_diff(
                original.splitlines(),
                modified.splitlines(),
                lineterm=''
            ))
            changes = sum(1 for line in diff if line.startswith('+') and not line.startswith('+++'))
            print(f"UPDATED ({changes} lines changed): {filepath}")
        else:
            print(f"NO CHANGES: {filepath}")


if __name__ == '__main__':
    main()
