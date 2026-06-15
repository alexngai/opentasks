import type { EvalTask } from '../types.js';

/**
 * A multi-step, interdependent build task — the regime where an external
 * task/plan structure (the OpenTasks arm) should help vs freeform notes vs
 * nothing: ~6 components that depend on each other, with ground-truth
 * checkpoints (files + content + the tests actually passing + the CLI actually
 * running). Stdlib-only (unittest, argparse, json) so scoring is deterministic
 * with no pip installs.
 */
export const BUILD_TODO_TASK: EvalTask = {
  id: 'build-todo',
  prompt: [
    'Build a small Python package named `todo` (a command-line todo manager) in the current',
    'directory. Use ONLY the Python standard library — do NOT pip install anything.',
    'Complete ALL of the following; they depend on each other, so work in dependency order and',
    'keep track of what is done and what remains:',
    '',
    '1. `todo/__init__.py` (may be empty) and `todo/models.py` defining a `Task` dataclass with',
    '   fields: id (int), title (str), done (bool, default False), priority (int, default 0).',
    '2. `todo/store.py` defining a `Store` class that persists tasks to a JSON file `tasks.json`',
    '   in the current directory and supports: add(title, priority=0) -> Task, list() -> list,',
    '   complete(id), delete(id).',
    '3. `todo/cli.py` with an argparse CLI exposing subcommands: `add <title>`, `list`, `done <id>`,',
    '   `rm <id>`, each backed by Store. It must be runnable as `python3 -m todo.cli ...`.',
    '4. `tests/test_store.py` with `unittest` tests (stdlib) covering add, list, complete, and',
    '   delete on Store. `python3 -m unittest discover -s tests` must pass.',
    '5. `README.md` documenting each CLI subcommand (add, list, done, rm) with an example.',
    '6. A `Makefile` with a `test` target (runs the unittest tests) and a `run` target.',
    '',
    'Verify it actually works before finishing: `python3 -m unittest discover -s tests` passes,',
    'and `python3 -m todo.cli add "buy milk"` followed by `python3 -m todo.cli list` shows',
    '"buy milk". Do not stop until every component exists and the tests pass.',
  ].join('\n'),
  checkpoints: [
    { id: 'models-task', weight: 1, check: { type: 'fileContains', path: 'todo/models.py', pattern: 'class\\s+Task' } },
    { id: 'store-class', weight: 1, check: { type: 'fileContains', path: 'todo/store.py', pattern: 'class\\s+Store' } },
    { id: 'cli-argparse', weight: 1, check: { type: 'fileContains', path: 'todo/cli.py', pattern: 'add_parser|add_subparsers|ArgumentParser' } },
    { id: 'tests-exist', weight: 1, check: { type: 'fileExists', path: 'tests/test_store.py' } },
    // The two checkpoints that prove it actually works (weighted higher).
    { id: 'tests-pass', weight: 2, check: { type: 'cmd', cmd: 'python3 -m unittest discover -s tests >/dev/null 2>&1' } },
    { id: 'cli-works', weight: 2, check: { type: 'cmd', cmd: 'python3 -m todo.cli add "buy milk" >/dev/null 2>&1 && python3 -m todo.cli list 2>/dev/null | grep -qi "buy milk"' } },
    // Order-independent: README documents each subcommand (rm may be written as remove/delete).
    { id: 'readme-docs', weight: 1, check: { type: 'cmd', cmd: 'grep -qi "add" README.md && grep -qi "list" README.md && grep -qi "done" README.md && grep -qiE "(\\brm\\b|remove|delete)" README.md' } },
    { id: 'makefile', weight: 1, check: { type: 'fileContains', path: 'Makefile', pattern: 'test:' } },
  ],
};
