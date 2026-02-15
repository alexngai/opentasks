# OpenTasks Implementation Plans

This directory contains the implementation specifications for OpenTasks, mirrored from sudocode specs.

## Spec Hierarchy

```
CORE-ARCHITECTURE.md (c-9jju)
├── PHASE-1.md (c-9hf5) — Single-Location + Provider URIs [v1]
│   └── Deliverables: core types, storage, 3-tool interface, providers
│
├── PHASE-2.md (c-7es6) — Cross-Location References [v2]
│   ├── depends-on: PHASE-1
│   └── Deliverables: daemon, registry, opentasks:// URIs, redirects
│
└── PHASE-3.md (c-2qms) — Multi-Location Queries [v3]
    ├── depends-on: PHASE-2
    └── Deliverables: discovery, expansion modes, conditional redirects
```

## Quick Links

| Document | Description | Status |
|----------|-------------|--------|
| [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md) | Overall design and decisions | Active |
| [PHASE-1.md](./PHASE-1.md) | v1: Single-location, provider URIs | **Current Focus** |
| [PHASE-2.md](./PHASE-2.md) | v2: Cross-location, daemon | Planned |
| [PHASE-3.md](./PHASE-3.md) | v3: Discovery, expansion | Planned |
| [ENTIRE-INTEGRATION.md](./ENTIRE-INTEGRATION.md) | Entire intent-tracking provider + auto-linker | Planned |
| [MATERIALIZATION-STORES.md](./MATERIALIZATION-STORES.md) | Git-native archival & rematerialization stores | Planned |

## Key Design Decisions

| Decision | Choice |
|----------|--------|
| Core identity | Graph connector (not task replacement) |
| Interface | 3 tools: `link`, `query`, `annotate` |
| Edge storage | Short IDs for local, URIs for external |
| Worktree model | Clone + redirect rules |
| Daemon | Required for Phase 2+ (multi-agent) |

## Sudocode Spec IDs

These plans are mirrored from sudocode specs:

- `c-9jju` — OpenTasks Core Architecture
- `c-9hf5` — Phase 1: Single-Location + Provider URIs
- `c-7es6` — Phase 2: Cross-Location References
- `c-2qms` — Phase 3: Multi-Location Queries

To view specs with relationships and feedback, use:
```bash
sudocode show c-9jju
sudocode list --search "opentasks"
```
