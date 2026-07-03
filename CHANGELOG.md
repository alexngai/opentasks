# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE` file, `CONTRIBUTING.md`, `SECURITY.md`, and this changelog.
- GitHub Actions CI (lint + build + test on Node 20 and 22) and issue/PR templates.

### Changed

- Documentation refreshed to match the shipped product: MCP server now documented
  as 22 tools across 5 scopes (`tasks`, `graph`, `annotate`, `context`, `attempts`),
  daemon auto-start / change events / idempotent writes marked as shipped, and the
  full node- and edge-type lists corrected.
- `package.json` description and keywords expanded for discoverability.

### Fixed

- `skills/` CLI examples used invalid node types (`--type issue`/`--type spec`);
  corrected to `task`/`context`.
- README Programmatic API example rewritten against the real API
  (`createStoreForLocation`, `store.createNode`, `store.query.ready`).

### Removed

- Internal research/eval artifacts and broken `references/` submodule gitlinks that
  are not relevant to consumers of the package.

## [0.1.4]

- Baseline release prior to the public-launch preparation above. See the git
  history for changes in `0.0.x`–`0.1.4`.

[Unreleased]: https://github.com/alexngai/opentasks/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/alexngai/opentasks/releases/tag/v0.1.4
