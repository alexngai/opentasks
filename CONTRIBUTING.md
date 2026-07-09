# Contributing to OpenTasks

Thanks for your interest in contributing! OpenTasks is a cross-system task graph —
it links Claude Tasks, Beads, and other task systems via a shared edge layer.

## Getting started

```bash
git clone https://github.com/alexngai/opentasks.git
cd opentasks
npm install
npm run build
npm test
```

Node >= 18 is required.

## Development workflow

| Task | Command |
|------|---------|
| Build (TypeScript) | `npm run build` |
| Type-check only | `npx tsc --noEmit` |
| Unit tests (single run) | `npm test` |
| Unit tests (watch) | `npm run test:watch` |
| Slow/integration tests | `npm run test:slow` |
| End-to-end tests | `npm run test:e2e` |
| Lint | `npm run lint` |
| Auto-fix lint | `npm run lint:fix` |
| Format | `npm run format` |

Tests are **co-located** with the code they cover (e.g.
`src/providers/__tests__/map-event-bridge.test.ts`). Add tests alongside the
module you change.

## Project layout

See [CLAUDE.md](./CLAUDE.md) for a map of the source tree (graph store, providers,
daemon, client, MCP server, config) and the key architectural concepts.

## Pull requests

1. Fork and create a topic branch from `main`.
2. Keep changes focused; one logical change per PR.
3. Ensure `npm run lint`, `npm run build`, and `npm test` all pass locally.
4. Add or update tests for any behavior change.
5. Update the relevant docs (`README.md`, `docs/*.md`) when behavior or the public
   API changes.
6. Write a clear PR description explaining the *why*, not just the *what*.

CI runs lint, build, and tests on Node 20 and 22 — PRs must be green to merge.

## Commit messages

Short, imperative subject lines. Conventional-commit prefixes (`feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`) are appreciated but not required.

## Reporting bugs / requesting features

Open an issue using the provided templates. For security issues, please follow
[SECURITY.md](./SECURITY.md) instead of filing a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
