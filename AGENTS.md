# Agent Instructions

OpenTasks is a cross-system task graph: it links Claude Tasks, Beads, Jira, Linear, MAP,
and other task systems via a shared edge layer, with a CLI, a local Unix-socket daemon,
and an MCP server for agent access.

## Working in this repo

- Build: `npm run build` (TypeScript compile; also serves as the type-check)
- Test: `npm test` (single run), `npm run test:watch`, `npm run test:slow`, `npm run test:e2e`
- Lint/format: `npm run lint`, `npm run lint:fix`, `npm run format`
- Tests are co-located with the modules they cover under `src/` (`__tests__/` dirs).
- Node >= 18 required.

See [CLAUDE.md](./CLAUDE.md) for the full guide (project structure, key concepts, module-level
context), and [README.md](./README.md) for usage.
